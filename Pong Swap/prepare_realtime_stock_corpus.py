"""Build a silent, licensed stock-video corpus for Pong's real-time gate.

The corpus is intentionally separate from production caches.  Every source is
an adult portrait clip published under the Pexels license.  Only the first six
seconds are retained, audio is removed, and source attribution plus hashes are
written to the manifest so a benchmark result is reproducible.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import subprocess
from pathlib import Path

from curl_cffi import requests


ROOT = Path(__file__).resolve().parent
OUTPUT_ROOT = ROOT / "benchmarks" / "realtime-stock-corpus"
INPUT_ROOT = OUTPUT_ROOT / "input"
MANIFEST_PATH = OUTPUT_ROOT / "manifest.json"

PAGES = (
    "https://www.pexels.com/video/outdoor-portrait-of-a-woman-in-sunlight-37925409/",
    "https://www.pexels.com/video/a-woman-with-a-beautiful-smile-8729490/",
    "https://www.pexels.com/video/close-up-portrait-of-woman-with-flowing-hair-34528669/",
    "https://www.pexels.com/video/a-woman-in-a-white-jacket-is-looking-at-the-camera-18400987/",
    "https://www.pexels.com/video/close-up-footage-of-a-woman-fixing-her-hair-while-looking-at-camera-8381494/",
    "https://www.pexels.com/video/beautiful-woman-looking-at-camera-8496259/",
    "https://www.pexels.com/video/a-woman-with-curly-hair-is-looking-at-the-camera-20073487/",
    "https://www.pexels.com/video/a-woman-showing-her-blond-hair-7281027/",
    "https://www.pexels.com/video/woman-using-her-mobile-phone-8154857/",
    "https://www.pexels.com/video/woman-wearing-beach-hat-posing-for-the-camera-8055997/",
    "https://www.pexels.com/video/young-woman-taking-selfie-with-pink-smartphone-31850412/",
    "https://www.pexels.com/video/attractive-woman-looking-at-camera-8956116/",
    "https://www.pexels.com/video/a-woman-with-freckles-and-piercings-looking-at-the-camera-4777847/",
    "https://www.pexels.com/video/serene-portrait-of-woman-in-yellow-blouse-33213475/",
    "https://www.pexels.com/video/stylish-woman-with-sunglasses-gazing-outdoors-34582163/",
    "https://www.pexels.com/video/woman-putting-on-makeup-8956146/",
    "https://www.pexels.com/video/young-woman-enjoying-sunny-day-outdoors-32081471/",
    "https://www.pexels.com/video/contemplative-woman-in-yellow-shirt-portrait-33213470/",
    "https://www.pexels.com/video/closeup-video-of-a-woman-8348784/",
    "https://www.pexels.com/video/close-up-shot-of-the-freckled-woman-8055996/",
    "https://www.pexels.com/video/confident-woman-in-vibrant-urban-setting-33213478/",
    "https://www.pexels.com/video/blonde-woman-smiling-at-camera-6767558/",
    "https://www.pexels.com/video/woman-smiling-at-camera-6767564/",
    "https://www.pexels.com/video/a-woman-smiling-at-the-camera-5228667/",
    "https://www.pexels.com/video/a-woman-smiling-and-looking-at-the-camera-8627757/",
    "https://www.pexels.com/video/woman-smiling-and-looking-at-the-camera-8202010/",
    "https://www.pexels.com/video/woman-looking-at-camera-and-smiling-6322408/",
    "https://www.pexels.com/video/woman-smiling-at-the-camera-7586533/",
    "https://www.pexels.com/video/close-up-face-of-a-woman-7477538/",
    "https://www.pexels.com/video/close-up-view-of-a-woman-s-face-5978692/",
    "https://www.pexels.com/video/young-woman-smiling-looking-at-camera-5337114/",
    "https://www.pexels.com/video/close-up-video-of-a-woman-face-6452576/",
)

VIDEO_FILE_PATTERN = re.compile(
    r'\{"file_type":"video/mp4","quality":"(?P<quality>[^"]+)",'
    r'"width":(?P<width>\d+),"height":(?P<height>\d+),'
    r'"fps":(?P<fps>[0-9.]+),"link":"(?P<link>[^"]+)"'
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration:stream=codec_type,width,height,avg_frame_rate,nb_frames",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return json.loads(completed.stdout)


def page_metadata(page_url: str) -> tuple[dict, dict]:
    response = requests.get(page_url, impersonate="chrome131", timeout=30)
    response.raise_for_status()
    text = response.text
    files = []
    for match in VIDEO_FILE_PATTERN.finditer(text):
        item = match.groupdict()
        item.update(width=int(item["width"]), height=int(item["height"]), fps=float(item["fps"]))
        item["link"] = html.unescape(item["link"]).replace("\\u0026", "&")
        files.append(item)
    if not files:
        raise RuntimeError("Pexels page exposed no downloadable MP4 variants")
    # Prefer the same 720x1280 class commonly seen by Pong. If unavailable,
    # choose the smallest HD file rather than hiding performance behind 360p.
    hd = [item for item in files if item["quality"] in {"hd", "uhd"}]
    candidates = hd or files
    selected = min(
        candidates,
        key=lambda item: (
            abs(max(item["width"], item["height"]) - 1280),
            abs(min(item["width"], item["height"]) - 720),
        ),
    )
    schema_match = re.search(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', text)
    schema = {}
    if schema_match:
        try:
            schema = json.loads(html.unescape(schema_match.group(1)))
        except json.JSONDecodeError:
            schema = {}
    return selected, {
        "pageUrl": page_url,
        "title": schema.get("name", ""),
        "creator": (schema.get("creator") or {}).get("name", ""),
        "license": schema.get("license", "https://www.pexels.com/license/"),
        "published": schema.get("datePublished", ""),
    }


def download(url: str, destination: Path) -> None:
    response = requests.get(url, impersonate="chrome131", timeout=90, stream=True)
    try:
        response.raise_for_status()
        with destination.open("wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)
    finally:
        response.close()


def transcode(source: Path, destination: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(source), "-t", "6.0", "-an",
            "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
            "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "19", "-b:v", "0",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(destination),
        ],
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def run() -> None:
    INPUT_ROOT.mkdir(parents=True, exist_ok=True)
    rows = []
    for page_url in PAGES:
        if len(rows) >= 24:
            break
        ordinal = len(rows) + 1
        destination = INPUT_ROOT / f"clip-{ordinal:02d}.mp4"
        try:
            variant, attribution = page_metadata(page_url)
            temporary = INPUT_ROOT / f".clip-{ordinal:02d}.download.mp4"
            if not destination.is_file():
                temporary.unlink(missing_ok=True)
                download(variant["link"], temporary)
                transcode(temporary, destination)
                temporary.unlink(missing_ok=True)
            media = probe(destination)
            duration = float(media.get("format", {}).get("duration") or 0.0)
            streams = media.get("streams") or []
            video = next((item for item in streams if item.get("codec_type") == "video"), {})
            if duration < 5.0 or not video:
                destination.unlink(missing_ok=True)
                continue
            row = {
                "ordinal": ordinal,
                "path": str(destination.relative_to(OUTPUT_ROOT)),
                "sha256": sha256(destination),
                "durationSeconds": duration,
                "width": int(video.get("width") or 0),
                "height": int(video.get("height") or 0),
                "fps": str(video.get("avg_frame_rate") or ""),
                "audioRemoved": True,
                "sourceVariant": variant,
                **attribution,
            }
            rows.append(row)
            print(f"[{len(rows):02d}/24] {destination.name} {duration:.2f}s", flush=True)
        except Exception as exc:
            print(f"[skip] {page_url}: {type(exc).__name__}: {exc}", flush=True)
    manifest = {
        "schema": "pong-realtime-stock-corpus-v1",
        "minimumRequired": 20,
        "count": len(rows),
        "silent": True,
        "clips": rows,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if len(rows) < 20:
        raise SystemExit(f"Only {len(rows)} valid clips were prepared")


if __name__ == "__main__":
    run()
