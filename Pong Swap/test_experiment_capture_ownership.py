"""CPU-only source and fake-class guards for isolated capture ownership."""

import unittest
from pathlib import Path
import sys

import experiment_capture_ownership as ownership


class _FakeVideoManager:
    pass


class _NoCapture:
    def capture(self):
        return 1


class CaptureOwnershipTests(unittest.TestCase):
    def test_fake_video_manager_is_not_patched(self):
        self.assertFalse(ownership.install(_FakeVideoManager))
        self.assertFalse(hasattr(_FakeVideoManager, "_isolated_capture_ownership_installed"))

    def test_missing_capture_contract_fails_without_replacing_method(self):
        original = _NoCapture.capture
        with self.assertRaisesRegex(RuntimeError, "capture contract changed"):
            ownership._replace_method(
                _NoCapture, "capture", ownership._VM_CAPTURE, ownership._VM_LOCAL,
            )
        self.assertIs(_NoCapture.capture, original)

    def test_real_source_contract_is_single_and_thread_local_after_install(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent / "engine" / "Rope"))
        from rope.VideoManager import VideoManager
        from rope.gpen_runtime import GPENRuntime

        self.assertTrue(ownership.install(VideoManager))
        self.assertIn("thread_local", VideoManager._match_color.__code__.co_consts)
        self.assertIn("thread_local", GPENRuntime.prepare.__code__.co_consts)
        first_vm = VideoManager._match_color
        first_gpen = GPENRuntime.prepare
        self.assertTrue(ownership.install(VideoManager))
        self.assertIs(VideoManager._match_color, first_vm)
        self.assertIs(GPENRuntime.prepare, first_gpen)


if __name__ == "__main__":
    unittest.main()
