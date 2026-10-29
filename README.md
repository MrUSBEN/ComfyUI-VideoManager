# ComfyUI-VideoManager

A ComfyUI node that encodes your generated frames into videos and keeps a browsable library of them, so you can review, pick favorites and feed them into a second pass.

## Features

- Encodes incoming frames (and optional audio) to `mp4 (h264)`, `webm (vp9)`, `gif` or `webp (animated)`.
- Saves each video with its first frame and prompt into a named bucket.
- In-node gallery with inline playback and a checkmark on each video you want to keep.
- Multi-select, bulk delete, select all, drag-and-drop video upload and ZIP export.
- Create and delete buckets to organize different projects.

## Inputs

`bucket`, `format`, `fps`, `crf`, `pix_fmt`; optional `images`, `first_frame`, `audio`, `prompt`.

## Outputs

Parallel lists for every checked video: `video`, `video_path`, `first_frame`, `prompt`.

## Requirements

`ffmpeg` must be installed and on your PATH.

## Install

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI. Find the node under `USBEN > Video Manager`.

Videos are stored in `ComfyUI/output/video_manager_store/<bucket>/`, outside this folder.
