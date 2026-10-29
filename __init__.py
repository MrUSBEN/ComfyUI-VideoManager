from .video_manager import VideoManager

NODE_CLASS_MAPPINGS = {
    "VideoManager": VideoManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoManager": "Video Manager",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
