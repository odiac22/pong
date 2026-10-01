from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from pong_swap_engine import PongSwapEngine


class FaceDeletionTests(unittest.TestCase):
    def test_delete_face_removes_only_its_images_and_keeps_unrelated_files(self) -> None:
        engine = PongSwapEngine()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = root / "Test One"
            identity.mkdir()
            image_path = identity / "approved.png"
            Image.new("RGB", (8, 8), (120, 80, 60)).save(image_path)
            note_path = identity / "keep.txt"
            note_path.write_text("not an approved image", encoding="utf-8")
            other_path = root / "other.png"
            Image.new("RGB", (8, 8), (30, 50, 70)).save(other_path)

            with patch("pong_swap_engine.FACES_DIR", root):
                engine._embedding_cache_dir = root / "embedding-cache"
                engine._embedding_cache_dir.mkdir()
                faces = engine.scan_faces()
                target = next(face for face in faces if face.name == "Test One")
                result = engine.delete_face(target.id)

                self.assertEqual(result["deletedFiles"], 1)
                self.assertFalse(image_path.exists())
                self.assertTrue(note_path.exists())
                self.assertTrue(other_path.exists())
                self.assertNotIn(target.id, {face.id for face in engine.scan_faces()})


if __name__ == "__main__":
    unittest.main()
