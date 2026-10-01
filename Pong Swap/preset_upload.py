from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = int(os.environ.get("PONG_SWAP_UPLOAD_PORT", "8793"))
TOKEN = os.environ["PONG_SWAP_UPLOAD_TOKEN"]
IMPORT_DIR = Path(__file__).resolve().parent / "presets" / "imports"
MAX_BYTES = 5 * 1024 * 1024

PAGE = """<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<title>Pong Swap preset upload</title><style>
body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 18px;background:#070b0f;color:#eef2ff}
.box{padding:20px;border:1px solid #283343;border-radius:16px;background:#0d141c;box-shadow:0 24px 70px #0008}
input,button{box-sizing:border-box;width:100%;margin-top:12px;padding:13px;font:inherit;border-radius:10px}
input{border:1px solid #334155;background:#111827;color:#e5e7eb}button{border:0;background:#7e22ce;color:white;font-weight:800}
.note{color:#94a3b8;font-size:13px;line-height:1.45}.ok{color:#86efac}.bad{color:#fda4af}
</style></head><body><div class=box><h2>Pong Swap preset</h2>
<p class=note>Select your Rope Pearl or VisoMaster JSON export. Only valid JSON is accepted. Machine paths and credentials will be ignored during import.</p>
<input id=file type=file accept=".json,application/json"><button id=send type=button disabled>Upload preset JSON</button><p id=status class=note>Select a JSON file.</p></div>
<script>(()=>{'use strict';
const fileInput=document.getElementById('file');
const uploadButton=document.getElementById('send');
const status=document.getElementById('status');
const setStatus=(kind,message)=>{status.className=kind;status.textContent=message};
fileInput.addEventListener('change',()=>{const selected=fileInput.files&&fileInput.files[0];uploadButton.disabled=!selected;
setStatus('note',selected?`${selected.name} (${Math.max(1,Math.ceil(selected.size/1024))} KB) ready.`:'Select a JSON file.');});
uploadButton.addEventListener('click',async()=>{const selected=fileInput.files&&fileInput.files[0];
if(!selected){setStatus('bad','Choose a JSON file first.');return}
uploadButton.disabled=true;setStatus('note','Validating and uploading…');
try{const text=await selected.text();JSON.parse(text);
const endpoint=new URL(window.location.href);endpoint.search='';endpoint.searchParams.set('name',selected.name);
const response=await fetch(endpoint.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:text,cache:'no-store'});
const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||`Upload failed (HTTP ${response.status})`);
setStatus('ok','Uploaded successfully. You can close this page.');fileInput.disabled=true;uploadButton.textContent='Uploaded';}
catch(error){setStatus('bad',error&&error.message?error.message:String(error));uploadButton.disabled=false;}});
})();</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return

    def allowed(self) -> bool:
        return urlparse(self.path).path == f"/{TOKEN}"

    def send_bytes(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status: int, payload: dict) -> None:
        self.send_bytes(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        if not self.allowed():
            self.send_error(404)
            return
        self.send_bytes(200, PAGE.encode(), "text/html; charset=utf-8")

    def do_POST(self) -> None:
        if not self.allowed():
            self.send_error(404)
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"ok": False, "error": "Only JSON is accepted"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BYTES:
            self.send_json(413, {"ok": False, "error": "JSON must be between 1 byte and 5 MB"})
            return
        try:
            raw = self.rfile.read(length)
            parsed = json.loads(raw.decode("utf-8-sig"))
        except Exception:
            self.send_json(400, {"ok": False, "error": "That file is not valid JSON"})
            return
        requested = urlparse(self.path).query
        match = re.search(r"(?:^|&)name=([^&]+)", requested)
        original_name = match.group(1) if match else "preset.json"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", original_name)[:100]
        if not safe_name.lower().endswith(".json"):
            safe_name += ".json"
        IMPORT_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        destination = IMPORT_DIR / f"{stamp}-{safe_name}"
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(json.dumps(parsed, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, destination)
        receipt = IMPORT_DIR / "latest-upload.json"
        receipt.write_text(json.dumps({
            "receivedAt": datetime.now(timezone.utc).isoformat(),
            "file": destination.name,
            "bytes": destination.stat().st_size,
        }, indent=2), encoding="utf-8")
        self.send_json(200, {"ok": True, "file": destination.name})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
