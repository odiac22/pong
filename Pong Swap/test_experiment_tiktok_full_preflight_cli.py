"""CPU-only contracts for the disposable preflight comparison runner."""

import hashlib
from pathlib import Path
import sys
import types
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError

import numpy as np

from experiment_tiktok_full_preflight_cli import (
    require_renderer_stopped, select_approved_frame,
)


class _Face:
    id = "approved-private-id"
    files = (Path("private-approved-image.png"),)


class _Engine:
    def __init__(self):
        self.calls = []

    def scan_faces(self):
        return [_Face()]

    def embedding_for_face(self, face_id, config):
        self.calls.append((face_id, config))
        return np.ones(512, dtype=np.float32)


class PreflightCliTests(unittest.TestCase):
    def test_reachable_renderer_rejected_even_when_idle(self):
        with mock.patch(
            "experiment_tiktok_full_preflight_cli.urlopen",
            return_value=mock.MagicMock(),
        ):
            with self.assertRaisesRegex(RuntimeError, "reachable"):
                require_renderer_stopped()
        with mock.patch(
            "experiment_tiktok_full_preflight_cli.urlopen",
            side_effect=HTTPError("http://localhost", 503, "busy", None, None),
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                require_renderer_stopped()

    def test_unreachable_renderer_allowed(self):
        with mock.patch(
            "experiment_tiktok_full_preflight_cli.urlopen",
            side_effect=URLError("connection refused"),
        ):
            require_renderer_stopped()

    def test_catalog_embedding_api_and_private_id_hash(self):
        engine = _Engine()
        bgr = np.zeros((240, 320, 3), dtype=np.uint8)
        fake_cv2 = types.SimpleNamespace(
            IMREAD_COLOR=1, COLOR_BGR2RGB=2,
            imread=mock.Mock(return_value=bgr),
            cvtColor=lambda image, _code: image[:, :, ::-1],
        )
        with mock.patch.dict(sys.modules, {"cv2": fake_cv2}):
            frame, embedding, digest = select_approved_frame(
                engine, {"profile": "test"}, 0, 480,
            )
        self.assertEqual(frame.shape, (240, 320, 3))
        self.assertTrue(frame.flags.c_contiguous)
        self.assertEqual(embedding.shape, (512,))
        self.assertEqual(engine.calls, [("approved-private-id", {"profile": "test"})])
        self.assertEqual(digest, hashlib.sha256(b"approved-private-id").hexdigest())
        self.assertNotIn("approved-private-id", digest)

    def test_invalid_index_never_reads_image_or_embedding(self):
        engine = _Engine()
        reader = mock.Mock()
        with mock.patch.dict(sys.modules, {"cv2": types.SimpleNamespace(imread=reader)}):
            with self.assertRaisesRegex(ValueError, "out of range"):
                select_approved_frame(engine, {}, 1, 480)
            reader.assert_not_called()
        self.assertEqual(engine.calls, [])


if __name__ == "__main__":
    unittest.main()
