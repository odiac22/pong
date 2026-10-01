"""Persistent TikTok media resolver for the Pong helper.

Keeps yt-dlp imported and one impersonating session open, so each video only
pays for its page extraction instead of a Python start-up, module import and
TLS/impersonation set-up. Protocol: one JSON request per stdin line
{"id": ..., "url": "https://www.tiktok.com/@user/video/123"}; one JSON reply
per stdout line {"id", "ok", "url", "headers", "cookies", "filesize", "ms"}.
The media URL and cookies are returned to the parent in memory only and are
never logged or written to disk here.
"""
from __future__ import annotations

import json
import sys
import time

import yt_dlp

FORMAT = "best[vcodec^=h264][ext=mp4]/best[vcodec^=avc1][ext=mp4]/download/best[ext=mp4]/best"


def main() -> None:
    options = {
        "quiet": True, "no_warnings": True, "noplaylist": True, "format": FORMAT,
        "impersonate": yt_dlp.networking.impersonate.ImpersonateTarget.from_str("chrome"),
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            started = time.perf_counter()
            request_id = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                url = str(request.get("url") or "")
                if not url.startswith("https://www.tiktok.com/"):
                    raise ValueError("not a TikTok page")
                info = ydl.extract_info(url, download=False)
                chosen = info.get("requested_downloads", [None])[0] or info
                media_url = chosen.get("url") or info.get("url")
                headers = dict(chosen.get("http_headers") or info.get("http_headers") or {})
                cookies = ydl.cookiejar.get_cookie_header(media_url) if media_url else ""
                reply = {"id": request_id, "ok": bool(media_url), "url": media_url, "headers": headers,
                         "cookies": cookies, "filesize": chosen.get("filesize") or chosen.get("filesize_approx"),
                         "vcodec": chosen.get("vcodec"), "ms": round((time.perf_counter() - started) * 1000, 1)}
            except Exception as exc:  # report the type only; messages can contain URLs
                reply = {"id": request_id, "ok": False, "error": type(exc).__name__,
                         "ms": round((time.perf_counter() - started) * 1000, 1)}
            print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
