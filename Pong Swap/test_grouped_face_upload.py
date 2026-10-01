import hashlib
import http.client
import io
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode
from PIL import Image
import face_upload as upload
from consolidate_approved_faces import consolidate


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pong-upload-test-")
        self.inbox = Path(self.temp.name) / "inbox"
        self.patches = [patch.object(upload, "TOKEN", "t" * 40), patch.object(upload, "INBOX", self.inbox),
                        patch.object(upload, "MIN_FREE_BYTES", 0)]
        for p in self.patches: p.start()
        self.server = upload.ThreadingHTTPServer(("127.0.0.1", 0), upload.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        buffer = io.BytesIO(); Image.new("RGB", (8, 8), "blue").save(buffer, "PNG")
        self.image = buffer.getvalue()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def request(self, method="GET", query=None, body=None, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        if isinstance(body, dict): body = json.dumps(body).encode()
        conn.request(method, "/" + (token or upload.TOKEN) + ("?" + urlencode(query) if query else ""), body=body)
        response = conn.getresponse(); raw = response.read(); status = response.status
        headers = dict(response.getheaders()); conn.close()
        return status, json.loads(raw) if headers.get("Content-Type", "").startswith("application/json") else raw, headers

    def begin(self, name="test.png", group="approved-2", size=None):
        status, value, _ = self.request("POST", {"action": "begin"}, {"name": name, "group": group, "size": size or len(self.image)})
        self.assertEqual(status, 201)
        return {"group": group, "id": value["id"]}

    def test_private_page_and_five_correct_destinations(self):
        self.assertEqual(self.request(token="wrong")[0], 404)
        status, page, headers = self.request()
        self.assertEqual(status, 200)
        self.assertIn(b"29.02", page)
        self.assertNotIn(b"<video", page)
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        groups = self.request(query={"action": "groups"})[1]["groups"]
        self.assertEqual([g["members"] for g in groups], [[2,4,5],[8],[19,22,21],[13,14,15,16,7,6],[3,10,9,11,12]])

    def test_upload_retry_duplicate_finish_and_checksum(self):
        key = self.begin()
        first = self.image[:25]
        q = {**key, "action": "chunk", "offset": 0}
        self.assertEqual(self.request("PUT", q, first)[0], 200)
        self.assertEqual(self.request("PUT", q, first)[0], 200)
        self.assertEqual(self.request("PUT", q, b"x" * 25)[0], 400)
        self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 400)
        self.assertEqual(self.request("PUT", {**q, "offset": 25}, self.image[25:])[0], 200)
        self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 200)
        self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 200)
        target = self.inbox / key["group"] / key["id"]
        self.assertEqual((target / "media.png").read_bytes(), self.image)
        receipt = json.loads((target / "receipt.json").read_text())
        self.assertEqual(receipt["sha256"], hashlib.sha256(self.image).hexdigest())
        self.assertEqual(self.request(query={"action": "groups"})[1]["groups"][0]["received"], 1)

    def test_destination_isolation_and_path_traversal(self):
        key = self.begin(name="../../evil.png")
        for group in ["approved-8", "../../approved-faces", "unknown"]:
            self.assertEqual(self.request("PUT", {**key, "group": group, "action": "chunk", "offset": 0}, self.image)[0], 400)
        self.assertEqual(self.request("PUT", {**key, "action": "chunk", "offset": 0}, self.image)[0], 200)
        self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 200)
        self.assertFalse((Path(self.temp.name) / "evil.png").exists())
        self.assertEqual(self.request(query={"action": "reference", "group": "../../x"})[0], 404)

    def test_type_size_offset_and_header_rejection(self):
        for name, group, size in [("x.exe", "approved-2", 30), ("x.png", "bad", 30), ("x.png", "approved-2", upload.MAX_FILE_BYTES+1)]:
            self.assertEqual(self.request("POST", {"action": "begin"}, {"name": name, "group": group, "size": size})[0], 400)
        key = self.begin(size=30)
        self.assertEqual(self.request("PUT", {**key, "action": "chunk", "offset": 1}, b"x")[0], 400)
        self.assertEqual(self.request("PUT", {**key, "action": "chunk", "offset": 0}, b"x" * 30)[0], 200)
        self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 400)
        with patch.object(upload, "MAX_INBOX_BYTES", 1):
            self.assertEqual(self.request("POST", {"action": "begin"}, {"name": "x.png", "group": "approved-2", "size": 30})[0], 507)

    def test_video_container_upload_all_groups(self):
        video = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 20
        for group in upload.GROUPS:
            key = self.begin("clip.mp4", group["id"], len(video))
            self.assertEqual(self.request("PUT", {**key, "action": "chunk", "offset": 0}, video)[0], 200)
            self.assertEqual(self.request("POST", {**key, "action": "finish"})[0], 200)
        self.assertTrue(all(g["received"] == 1 for g in self.request(query={"action": "groups"})[1]["groups"]))

    def test_references_and_assets_have_no_public_bypass(self):
        for group in upload.GROUPS:
            status, content, _ = self.request(query={"action": "reference", "group": group["id"]})
            self.assertEqual(status, 200)
            with Image.open(io.BytesIO(content)) as picture:
                self.assertLessEqual(max(picture.size), 360)
                self.assertFalse(picture.getexif())
        for asset in ("css", "js"):
            self.assertEqual(self.request(query={"asset": asset})[0], 200)
            self.assertEqual(self.request(query={"asset": asset}, token="wrong")[0], 404)


class ConsolidationTests(unittest.TestCase):
    def test_lossless_merge_archive_and_idempotency(self):
        with tempfile.TemporaryDirectory(prefix="pong-merge-test-") as name:
            root = Path(name)
            shutil.copy2(upload.ROOT / "approved_face_groups.json", root)
            for group in upload.GROUPS:
                for number in group["members"]:
                    directory = root / "approved-faces" / f"Approved {number}"
                    directory.mkdir(parents=True)
                    (directory / "source.jpg").write_bytes(f"fixture {number}".encode())
            untouched = root / "approved-faces" / "Approved 23"
            untouched.mkdir(); (untouched / "source.jpg").write_bytes(b"untouched")
            report = consolidate(root)
            for group in upload.GROUPS:
                files = list((root / "approved-faces" / group["name"]).rglob("*.jpg"))
                self.assertEqual(len(files), len(group["members"]))
            self.assertEqual((untouched / "source.jpg").read_bytes(), b"untouched")
            self.assertEqual(consolidate(root), report)
            self.assertEqual(len(report["copies"]), 13)
            self.assertTrue(Path(report["archive"]).is_dir())

if __name__ == "__main__": unittest.main()
