"""Byte-exact public-route smoke test; archives only its own random QA upload."""
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from PIL import Image
from face_upload import ROOT, INBOX

state = json.loads((ROOT / "logs/grouped-face-upload-state.json").read_text(encoding="utf-8-sig"))
url = state["Url"]
def request(action, body=None, method=None, **params):
    address = url + "?" + urlencode({"action": action, **params})
    if isinstance(body, dict): body = json.dumps(body).encode()
    with urlopen(Request(address, data=body, method=method), timeout=40) as response:
        return json.load(response)

buffer = io.BytesIO()
Image.new("RGB", (8, 8), "blue").save(buffer, "PNG")
payload = buffer.getvalue() + bytes(5 * 1024 * 1024)
group = "approved-8"
upload = request("begin", {"group": group, "name": "PONG-HTTPS-QA-NOT-A-REFERENCE.png", "size": len(payload)}, "POST")
key = {"group": group, "id": upload["id"]}
for offset in range(0, len(payload), 4 * 1024 * 1024):
    request("chunk", payload[offset:offset+4*1024*1024], "PUT", offset=offset, **key)
request("finish", method="POST", **key)
source = (INBOX / group / upload["id"]).resolve()
if source.parent != (INBOX / group).resolve(): raise RuntimeError("Unsafe QA source")
receipt = json.loads((source / "receipt.json").read_text(encoding="utf-8"))
assert receipt["originalName"] == "PONG-HTTPS-QA-NOT-A-REFERENCE.png"
assert receipt["sha256"] == hashlib.sha256(payload).hexdigest()
archive = (INBOX.parent / "upload-qa-public" / upload["id"]).resolve()
archive.parent.mkdir(exist_ok=True)
if archive.parent != (INBOX.parent / "upload-qa-public").resolve(): raise RuntimeError("Unsafe QA destination")
source.rename(archive)  # only this test's checksum-verified, random-ID directory
groups = request("groups")
result = {"httpsUploadPassed": True, "bytesVerified": len(payload), "chunks": 2,
          "qaArchivedOutsideInbox": str(archive), "groups": groups["groups"]}
(ROOT / "logs/grouped-face-upload-https-test.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
