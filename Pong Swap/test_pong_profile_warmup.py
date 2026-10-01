"""CPU-only contract tests for optional TikTok profile warmup."""

from copy import deepcopy
import threading
import unittest

from pong_profile_warmup import ProfileWarmup


class FakeEngine:
    def __init__(self):
        self.config = {
            "runtime": {"backend": "cuda", "tiktokRestorerProfile": "default"},
            "parameters": {"RestorerSwitch": True, "RestorerTypeTextSel": "GPEN1024"},
        }
        self.revision = 7
        self.active = 0
        self.installed = True
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.ready_512 = True

    def health(self):
        return {"exactAcceleration": {"acceleration": {"installed": self.installed}}}

    def _active_session_count(self):
        return self.active

    def _config_snapshot(self):
        return deepcopy(self.config), self.revision

    def _model_lifecycle_changed(self, before, after):
        return before["runtime"]["backend"] != after["runtime"]["backend"]

    def warm(self, *, config, allow_create_selected):
        self.calls.append((deepcopy(config), allow_create_selected))
        self.entered.set()
        self.release.wait(timeout=3)
        return {"ready": True, "restorers": {
            "512": {"ready": self.ready_512}, "1024": {"ready": True},
        }}


class ProfileWarmupTests(unittest.TestCase):
    def test_different_profiles_never_share_a_ready_receipt(self):
        engine = FakeEngine()
        engine.release.clear()
        original = deepcopy(engine.config)
        helper = ProfileWarmup(engine, qualified=True)
        adaptive = helper.request()
        self.assertTrue(engine.entered.wait(2))
        fixed = helper.request('tiktok-gpen512')
        self.assertIsNot(adaptive, fixed)
        self.assertIs(fixed, helper.request('tiktok-gpen512'))
        engine.release.set()
        self.assertEqual(adaptive.result(timeout=2)['restorers'], ('GPEN512', 'GPEN1024'))
        self.assertEqual(fixed.result(timeout=2)['restorers'], ('GPEN512',))
        self.assertEqual(fixed.result()['profile'], 'tiktok-gpen512')
        self.assertEqual(engine.config, original)

    def test_single_flight_profile_copy_and_reentry(self):
        engine = FakeEngine()
        engine.release.clear()
        original = deepcopy(engine.config)
        helper = ProfileWarmup(engine, qualified=True)
        first = helper.request()
        self.assertTrue(engine.entered.wait(2))
        self.assertIs(first, helper.request())
        self.assertEqual(len(engine.calls), 1)
        self.assertEqual(engine.config, original)
        self.assertTrue(engine.calls[0][1])
        self.assertEqual(engine.calls[0][0]["runtime"]["tiktokRestorerProfile"], "tiktok-face-size")
        self.assertEqual(engine.calls[0][0]["parameters"], original["parameters"])
        engine.release.set()
        self.assertEqual(first.result(timeout=2)["restorers"], ("GPEN512", "GPEN1024"))
        self.assertEqual(engine.config, original)
        # A completed warm is not cached forever: idle unload may evict it.
        self.assertTrue(helper.request().result(timeout=2)["ready"])
        self.assertEqual(len(engine.calls), 2)

    def test_fail_closed_on_qualification_session_and_missing_restorer(self):
        engine = FakeEngine()
        with self.assertRaisesRegex(RuntimeError, "qualified caller"):
            ProfileWarmup(engine)
        helper = ProfileWarmup(engine, qualified=True)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            helper.request("default")
        engine.installed = False
        with self.assertRaisesRegex(RuntimeError, "not installed"):
            helper.request().result(timeout=2)
        self.assertEqual(engine.calls, [])
        engine.installed = True
        engine.active = 1
        with self.assertRaisesRegex(RuntimeError, "no active sessions"):
            helper.request().result(timeout=2)
        self.assertEqual(engine.calls, [])
        engine.active = 0
        engine.ready_512 = False
        with self.assertRaisesRegex(RuntimeError, "GPEN512 is not ready"):
            helper.request().result(timeout=2)

    def test_revision_change_during_warm_is_not_claimed_ready(self):
        engine = FakeEngine()
        engine.release.clear()
        helper = ProfileWarmup(engine, qualified=True)
        pending = helper.request()
        self.assertTrue(engine.entered.wait(2))
        engine.revision += 1
        engine.release.set()
        with self.assertRaisesRegex(RuntimeError, "changed during"):
            pending.result(timeout=2)
        self.assertNotIn("tiktokRestorerState", engine.config["runtime"])


if __name__ == "__main__":
    unittest.main()
