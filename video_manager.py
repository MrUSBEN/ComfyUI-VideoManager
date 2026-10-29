import os
import re
import io
import json
import time
import uuid
import shutil
import zipfile
import tempfile
import subprocess
import wave

import numpy as np
from PIL import Image
import torch

import folder_paths
from aiohttp import web
from server import PromptServer

try:
    from comfy_api.input_impl import VideoFromFile
except Exception:
    try:
        from comfy_api.latest._input_impl.video_types import VideoFromFile
    except Exception:
        VideoFromFile = None
        print("[VideoManager] WARNING: could not import VideoFromFile from comfy_api; "
              "the 'video' output will fall back to a plain path string instead of a VIDEO object.")

# ---------------------------------------------------------------------------
# Storage layout:
#   <ComfyUI output dir>/video_manager_store/<bucket>/
#       manifest.json
#       videos/<id>.<ext>
#       frames/<id>.png
# ---------------------------------------------------------------------------

BASE_DIR = os.path.join(folder_paths.get_output_directory(), "video_manager_store")
os.makedirs(BASE_DIR, exist_ok=True)

FORMATS = {
    "mp4 (h264)":       {"ext": ".mp4",  "vcodec": "libx264",    "acodec": "aac",     "kind": "video"},
    "webm (vp9)":       {"ext": ".webm", "vcodec": "libvpx-vp9", "acodec": "libopus", "kind": "video"},
    "gif":              {"ext": ".gif",  "vcodec": None,         "acodec": None,      "kind": "gif"},
    "webp (animated)":  {"ext": ".webp", "vcodec": "libwebp",    "acodec": None,      "kind": "webp"},
}


def sanitize_bucket(name):
    """Keep bucket names filesystem-safe and prevent path traversal."""
    name = (name or "").strip()
    name = re.sub(r"[^A-Za-z0-9_\-. ]", "", name)
    name = name.strip(". ")
    return name or "default"


def bucket_dir(bucket):
    bucket = sanitize_bucket(bucket)
    d = os.path.join(BASE_DIR, bucket)
    os.makedirs(os.path.join(d, "videos"), exist_ok=True)
    os.makedirs(os.path.join(d, "frames"), exist_ok=True)
    return d


def list_buckets():
    buckets = []
    if os.path.isdir(BASE_DIR):
        for name in sorted(os.listdir(BASE_DIR), key=str.lower):
            if os.path.isdir(os.path.join(BASE_DIR, name)):
                buckets.append(name)
    if "default" not in buckets:
        buckets.insert(0, "default")
    return buckets


def manifest_path(bucket):
    return os.path.join(bucket_dir(bucket), "manifest.json")


def load_manifest(bucket):
    p = manifest_path(bucket)
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r") as f:
            return json.load(f)
    except Exception:
        return []


def save_manifest(bucket, entries):
    with open(manifest_path(bucket), "w") as f:
        json.dump(entries, f, indent=2)


def tensor_to_pil(img_tensor):
    if img_tensor.dim() == 4:
        img_tensor = img_tensor[0]
    arr = (img_tensor.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def pil_to_tensor(img):
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ]


def save_audio_wav(audio, path):
    waveform = audio["waveform"]
    sr = int(audio["sample_rate"])
    if waveform.dim() == 3:
        waveform = waveform[0]  # -> [channels, samples]
    wf = waveform.cpu().numpy()
    wf = np.clip(wf, -1.0, 1.0)
    pcm = (wf * 32767.0).astype(np.int16)
    pcm = pcm.T  # -> [samples, channels]
    with wave.open(path, "wb") as f:
        f.setnchannels(pcm.shape[1])
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def encode_video(images, fps, fmt_name, crf, pix_fmt, audio, out_path_no_ext):
    fmt = FORMATS.get(fmt_name, FORMATS["mp4 (h264)"])
    tmp_dir = tempfile.mkdtemp(prefix="vm_")
    try:
        for i, img in enumerate(images):
            tensor_to_pil(img).save(os.path.join(tmp_dir, f"{i:06d}.png"))

        out_path = out_path_no_ext + fmt["ext"]
        cmd = ["ffmpeg", "-y", "-framerate", str(fps), "-i", os.path.join(tmp_dir, "%06d.png")]

        audio_path = None
        if audio is not None and fmt["kind"] == "video":
            audio_path = os.path.join(tmp_dir, "audio.wav")
            try:
                save_audio_wav(audio, audio_path)
                cmd += ["-i", audio_path]
            except Exception:
                audio_path = None

        if fmt["kind"] == "gif":
            cmd += ["-vf", f"fps={fps},scale=-1:-1:flags=lanczos"]
        elif fmt["kind"] == "webp":
            cmd += ["-loop", "0", "-c:v", "libwebp", "-q:v", str(max(0, 100 - crf * 2))]
        else:
            cmd += ["-c:v", fmt["vcodec"], "-pix_fmt", pix_fmt]
            if fmt["vcodec"] == "libvpx-vp9":
                cmd += ["-crf", str(crf), "-b:v", "0"]
            else:
                cmd += ["-crf", str(crf)]
            if audio_path:
                cmd += ["-c:a", fmt["acodec"], "-shortest"]

        cmd += [out_path]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='ignore')[-2000:]}")
        return out_path
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


class VideoManager:
    """Encodes and manages your own video library. Feed it frames (+ optional
    audio, + prompt) as your loop runs; it saves and catalogs each video.
    Open the node any time to browse everything you've ever generated,
    preview inline, checkmark favorites, and delete failed generations.
    Selected items come out as parallel lists for a second-pass loop."""

    CATEGORY = "USBEN"
    FUNCTION = "run"
    RETURN_TYPES = ("VIDEO", "STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("video", "video_path", "first_frame", "prompt")
    OUTPUT_IS_LIST = (True, True, True, True)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bucket": ("STRING", {"default": "default"}),
                "format": (list(FORMATS.keys()), {"default": "mp4 (h264)"}),
                "fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 60.0, "step": 0.5}),
                "crf": ("INT", {"default": 19, "min": 0, "max": 51}),
                "pix_fmt": (["yuv420p", "yuv444p"], {"default": "yuv420p"}),
            },
            "optional": {
                "images": ("IMAGE",),
                "first_frame": ("IMAGE",),
                "audio": ("AUDIO",),
                "prompt": ("STRING", {"default": "", "forceInput": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, bucket="default", **kwargs):
        p = manifest_path(bucket)
        return os.path.getmtime(p) if os.path.exists(p) else time.time()

    def run(self, bucket="default", format="mp4 (h264)", fps=16.0, crf=19,
             pix_fmt="yuv420p", images=None, first_frame=None, audio=None, prompt=None):
        entries = load_manifest(bucket)

        if images is not None and len(images) > 0:
            entry_id = uuid.uuid4().hex[:12]
            out_no_ext = os.path.join(bucket_dir(bucket), "videos", entry_id)
            video_path = encode_video(images, fps, format, crf, pix_fmt, audio, out_no_ext)

            # Prefer an explicitly supplied first_frame (e.g. the original
            # source image) over the encoded/decoded video's first frame,
            # since the latter can be a lower-fidelity round trip.
            source_frame = first_frame if first_frame is not None else images
            frame_img = tensor_to_pil(source_frame[0] if hasattr(source_frame, "__getitem__") else source_frame)
            dst_frame = os.path.join(bucket_dir(bucket), "frames", entry_id + ".png")
            frame_img.save(dst_frame)

            entries.append({
                "id": entry_id,
                "video_file": os.path.basename(video_path),
                "frame_file": os.path.basename(dst_frame),
                "prompt": prompt or "",
                "created_at": time.time(),
                "selected": False,
            })
            save_manifest(bucket, entries)

        selected = [e for e in entries if e.get("selected")]
        selected.sort(key=lambda e: e["created_at"])

        out_videos, out_paths, out_frames, out_prompts = [], [], [], []
        for e in selected:
            vpath = os.path.join(bucket_dir(bucket), "videos", e["video_file"])
            out_paths.append(vpath)
            out_videos.append(VideoFromFile(vpath) if VideoFromFile is not None else vpath)
            fpath = os.path.join(bucket_dir(bucket), "frames", e["frame_file"])
            out_frames.append(pil_to_tensor(Image.open(fpath)))
            out_prompts.append(e.get("prompt", ""))

        if not out_paths:
            out_paths = [""]
            out_videos = [""]
            out_frames = [torch.zeros(1, 64, 64, 3)]
            out_prompts = [""]

        return (out_videos, out_paths, out_frames, out_prompts)


# ---------------------------------------------------------------------------
# API routes backing the in-node gallery/player widget
# ---------------------------------------------------------------------------

routes = PromptServer.instance.routes


@routes.get("/video_manager/buckets")
async def vm_buckets(request):
    return web.json_response({"buckets": list_buckets()})


@routes.post("/video_manager/create_bucket")
async def vm_create_bucket(request):
    data = await request.json()
    bucket = sanitize_bucket(data.get("bucket", ""))
    bucket_dir(bucket)  # creates the folders on disk
    return web.json_response({"ok": True, "bucket": bucket, "buckets": list_buckets()})


@routes.post("/video_manager/delete_bucket")
async def vm_delete_bucket(request):
    data = await request.json()
    bucket = sanitize_bucket(data.get("bucket", ""))
    d = os.path.join(BASE_DIR, bucket)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    return web.json_response({"ok": True, "buckets": list_buckets()})


@routes.get("/video_manager/list")
async def vm_list(request):
    bucket = request.query.get("bucket", "default")
    entries = load_manifest(bucket)
    entries.sort(key=lambda e: e["created_at"])
    return web.json_response(entries)


@routes.get("/video_manager/media/{bucket}/{kind}/{filename}")
async def vm_media(request):
    bucket = request.match_info["bucket"]
    kind = request.match_info["kind"]
    filename = request.match_info["filename"]
    folder = "videos" if kind == "video" else "frames"
    path = os.path.join(bucket_dir(bucket), folder, filename)
    if not os.path.exists(path):
        return web.Response(status=404)
    return web.FileResponse(path)


@routes.post("/video_manager/toggle")
async def vm_toggle(request):
    data = await request.json()
    bucket = data.get("bucket", "default")
    entry_id = data["id"]
    entries = load_manifest(bucket)
    new_state = None
    for e in entries:
        if e["id"] == entry_id:
            e["selected"] = not e.get("selected", False)
            new_state = e["selected"]
    save_manifest(bucket, entries)
    return web.json_response({"ok": True, "selected": new_state})


@routes.post("/video_manager/delete")
async def vm_delete(request):
    data = await request.json()
    bucket = data.get("bucket", "default")
    entry_id = data["id"]
    entries = load_manifest(bucket)
    remaining = []
    for e in entries:
        if e["id"] == entry_id:
            for folder, fname in (("videos", e["video_file"]), ("frames", e["frame_file"])):
                p = os.path.join(bucket_dir(bucket), folder, fname)
                if os.path.exists(p):
                    os.remove(p)
        else:
            remaining.append(e)
    save_manifest(bucket, remaining)
    return web.json_response({"ok": True})


VIDEO_UPLOAD_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".gif", ".webp", ".m4v"}


def extract_first_frame(video_path, frame_path):
    """Grab a thumbnail for a video that wasn't encoded by this node
    (e.g. dropped in manually or dragged onto the gallery)."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vframes", "1", frame_path],
            capture_output=True,
        )
        if result.returncode == 0 and os.path.exists(frame_path):
            return
    except Exception:
        pass
    # Fallback: a plain placeholder so the tile still renders something.
    Image.new("RGB", (320, 180), color=(40, 40, 40)).save(frame_path)


@routes.post("/video_manager/upload")
async def vm_upload(request):
    bucket = sanitize_bucket(request.query.get("bucket", "default"))
    dest_dir = bucket_dir(bucket)

    reader = await request.multipart()
    added = []
    async for field in reader:
        if field.name != "files":
            continue

        orig_name = field.filename or "upload"
        ext = os.path.splitext(orig_name)[1].lower()
        if ext not in VIDEO_UPLOAD_EXTS:
            ext = ext or ".mp4"

        entry_id = uuid.uuid4().hex[:12]
        video_path = os.path.join(dest_dir, "videos", entry_id + ext)
        with open(video_path, "wb") as f:
            while True:
                chunk = await field.read_chunk(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        frame_path = os.path.join(dest_dir, "frames", entry_id + ".png")
        extract_first_frame(video_path, frame_path)

        added.append({
            "id": entry_id,
            "video_file": os.path.basename(video_path),
            "frame_file": os.path.basename(frame_path),
            "prompt": "",
            "created_at": time.time(),
            "selected": False,
        })

    if added:
        entries = load_manifest(bucket)
        entries.extend(added)
        save_manifest(bucket, entries)

    return web.json_response({"ok": True, "added": len(added), "bucket": bucket})


@routes.post("/video_manager/select_all")
async def vm_select_all(request):
    data = await request.json()
    bucket = data.get("bucket", "default")
    value = bool(data.get("value", True))
    entries = load_manifest(bucket)
    for e in entries:
        e["selected"] = value
    save_manifest(bucket, entries)
    return web.json_response({"ok": True})


@routes.post("/video_manager/export_zip")
async def vm_export_zip(request):
    data = await request.json()
    bucket = data.get("bucket", "default")
    ids = data.get("ids")
    entries = load_manifest(bucket)
    if ids:
        idset = set(ids)
        entries = [e for e in entries if e["id"] in idset]

    if not entries:
        return web.Response(status=404, text="No videos to export")

    buf = io.BytesIO()
    used_names = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for e in entries:
            vpath = os.path.join(bucket_dir(bucket), "videos", e["video_file"])
            if not os.path.exists(vpath):
                continue
            arcname = e["video_file"]
            base, ext = os.path.splitext(arcname)
            n = 1
            while arcname in used_names:
                arcname = f"{base}_{n}{ext}"
                n += 1
            used_names.add(arcname)
            zf.write(vpath, arcname)
    buf.seek(0)

    safe_bucket = sanitize_bucket(bucket)
    headers = {"Content-Disposition": f'attachment; filename="{safe_bucket}_export.zip"'}
    return web.Response(body=buf.getvalue(), headers=headers, content_type="application/zip")
