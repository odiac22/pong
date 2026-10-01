"""Capability-link, chunked local upload inbox. Media is staged, not auto-approved."""
from __future__ import annotations
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("PONG_SWAP_FACE_UPLOAD_PORT", "8794"))
TOKEN = os.environ.get("PONG_SWAP_FACE_UPLOAD_TOKEN", "")
LOCAL_CONFIG = ROOT / "face_upload_config.json"
CONFIG = json.loads(LOCAL_CONFIG.read_text(encoding="utf-8")) if LOCAL_CONFIG.is_file() else {}
INBOX = Path(os.environ.get("PONG_SWAP_FACE_UPLOAD_INBOX") or CONFIG.get("inbox") or ROOT / "approved-faces-inbox")
GROUPS = json.loads((ROOT / "approved_face_groups.json").read_text(encoding="utf-8"))["groups"]
GROUP_MAP = {g["id"]: g for g in GROUPS}
CHUNK_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024**3
MAX_INBOX_BYTES = 100 * 1024**3
MIN_FREE_BYTES = 5 * 1024**3
LOCK = threading.RLock()
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".mp4", ".mov", ".m4v", ".webm"}

def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)

def valid_magic(suffix, header):
    if suffix in {".jpg", ".jpeg"}: return header.startswith(b"\xff\xd8\xff")
    if suffix == ".png": return header.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix == ".webp": return header[:4] == b"RIFF" and header[8:12] == b"WEBP"
    if suffix == ".webm": return header.startswith(b"\x1a\x45\xdf\xa3")
    if suffix in {".heic", ".heif", ".mp4", ".mov", ".m4v"}:
        # ISO container header, not a full codec/decodability check. Actual
        # decoding and face selection happen during review, not on upload.
        return len(header) >= 12 and header[4:8] in {b"ftyp", b"wide", b"mdat"}
    return False

def reference_bytes(group):
    path = ROOT / "approved-faces" / group["name"] / group["reference"]
    with Image.open(path) as image:
        small = ImageOps.contain(ImageOps.exif_transpose(image).convert("RGB"), (320, 360))
        output = io.BytesIO()
        small.save(output, "JPEG", quality=88)  # no EXIF/location metadata
        return output.getvalue()

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_message(self, _format, *_args):
        pass  # never log private capability URLs or filenames

    def allowed(self):
        return len(TOKEN) >= 32 and secrets.compare_digest(urlparse(self.path).path, f"/{TOKEN}")

    def send_bytes(self, status, data, content_type):
        self.send_response(status)
        for key, value in {
            "Content-Type": content_type, "Content-Length": str(len(data)),
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            "Permissions-Policy": "camera=(), microphone=(), autoplay=()",
        }.items(): self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, value):
        self.send_bytes(status, json.dumps(value).encode(), "application/json; charset=utf-8")

    def query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def read_body(self, maximum):
        if self.headers.get("Transfer-Encoding"): raise ValueError("Content-Length required")
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= maximum: raise ValueError("Invalid request size")
        data = self.rfile.read(length)
        if len(data) != length: raise ValueError("Incomplete request")
        return data

    def upload_paths(self, query):
        group, key = query.get("group"), query.get("id", "")
        if group not in GROUP_MAP or not re.fullmatch(r"[0-9a-f]{32}", key): raise ValueError("Unknown upload")
        directory = INBOX / group / key
        meta_path = directory / "receipt.json"
        if not meta_path.is_file(): raise ValueError("Upload not found")
        return directory, meta_path, json.loads(meta_path.read_text(encoding="utf-8"))

    def do_GET(self):
        if not self.allowed():
            self.send_error(404); return
        query = self.query()
        if query.get("asset") in {"js", "css"}:
            suffix = query["asset"]
            self.send_bytes(200, (ROOT / f"face-upload.{suffix}").read_bytes(), "text/javascript" if suffix == "js" else "text/css")
        elif query.get("action") == "groups":
            groups = []
            for group in GROUPS:
                receipts = (INBOX / group["id"]).glob("*/receipt.json")
                complete = sum(json.loads(p.read_text(encoding="utf-8")).get("complete", False) for p in receipts)
                groups.append({**group, "received": complete})
            self.send_json(200, {"groups": groups, "chunkBytes": CHUNK_BYTES, "maxFileBytes": MAX_FILE_BYTES})
        elif query.get("action") == "reference" and query.get("group") in GROUP_MAP:
            self.send_bytes(200, reference_bytes(GROUP_MAP[query["group"]]), "image/jpeg")
        elif not query:
            self.send_bytes(200, (ROOT / "face-upload.html").read_bytes(), "text/html; charset=utf-8")
        else: self.send_error(404)

    def do_POST(self):
        if not self.allowed():
            self.send_error(404); return
        try:
            query = self.query()
            action = query.get("action")
            if action == "begin":
                data = json.loads(self.read_body(4096))
                group = data.get("group")
                original = str(data.get("name", ""))[:240]
                suffix = Path(original).suffix.lower()
                size = int(data.get("size", 0))
                if group not in GROUP_MAP or suffix not in EXTENSIONS or not 0 < size <= MAX_FILE_BYTES:
                    raise ValueError("Unsupported photo/video, size or group")
                with LOCK:
                    INBOX.mkdir(parents=True, exist_ok=True)
                    reserved = sum(int(json.loads(p.read_text(encoding="utf-8"))["size"]) for p in INBOX.glob("approved-*/*/receipt.json"))
                    if reserved + size > MAX_INBOX_BYTES or shutil.disk_usage(INBOX).free < size + MIN_FREE_BYTES:
                        self.send_json(507, {"error": "Inbox is full; ask to archive/review received files"}); return
                    key = secrets.token_hex(16)
                    directory = INBOX / group / key
                    directory.mkdir(parents=True, exist_ok=False)
                    (directory / "media.part").touch(exist_ok=False)
                    atomic_json(directory / "receipt.json", {
                        "id": key, "group": group, "approvedName": GROUP_MAP[group]["name"],
                        "originalName": original, "suffix": suffix, "size": size,
                        "receivedAt": datetime.now(timezone.utc).isoformat(), "complete": False,
                    })
                self.send_json(201, {"id": key, "offset": 0})
            elif action == "finish":
                with LOCK:
                    directory, meta_path, meta = self.upload_paths(query)
                    target = directory / ("media" + meta["suffix"])
                    if meta["complete"]:
                        self.send_json(200, {"ok": True, "name": meta["originalName"], "size": meta["size"]}); return
                    part = directory / "media.part"
                    source = part if part.exists() else target  # recover rename/receipt interruption
                    if source.stat().st_size != meta["size"]: raise ValueError("Incomplete upload")
                    with source.open("rb") as stream:
                        if not valid_magic(meta["suffix"], stream.read(64)): raise ValueError("Invalid media header")
                        stream.seek(0)
                        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
                    if source == part: os.replace(part, target)
                    meta.update(complete=True, sha256=checksum, file=target.name, completedAt=datetime.now(timezone.utc).isoformat())
                    atomic_json(meta_path, meta)
                self.send_json(200, {"ok": True, "name": meta["originalName"], "size": meta["size"]})
            else: raise ValueError("Unknown action")
        except (ValueError, OSError, KeyError, TypeError):
            self.send_json(400, {"error": "Upload request failed; check the file and retry"})

    def do_PUT(self):
        if not self.allowed():
            self.send_error(404); return
        try:
            query = self.query()
            if query.get("action") != "chunk": raise ValueError("Unknown action")
            data = self.read_body(CHUNK_BYTES)
            offset = int(query.get("offset", "-1"))
            with LOCK:
                directory, _, meta = self.upload_paths(query)
                if meta["complete"] or offset < 0 or offset + len(data) > meta["size"]: raise ValueError("Invalid chunk offset")
                part = directory / "media.part"
                current = part.stat().st_size
                if offset < current:
                    with part.open("rb") as stream:
                        stream.seek(offset)
                        if stream.read(len(data)) != data: raise ValueError("Retried chunk differs")
                elif offset == current:
                    if shutil.disk_usage(INBOX).free < len(data) + MIN_FREE_BYTES:
                        self.send_json(507, {"error": "PC storage is full"}); return
                    with part.open("ab") as stream:
                        stream.write(data); stream.flush(); os.fsync(stream.fileno())
                else: raise ValueError("Out-of-order chunk")
            self.send_json(200, {"ok": True, "offset": offset + len(data)})
        except (ValueError, OSError, KeyError, TypeError):
            self.send_json(400, {"error": "Chunk could not be saved; retry the file"})

if __name__ == "__main__":
    if len(TOKEN) < 32: raise SystemExit("A private token of at least 32 characters is required")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
