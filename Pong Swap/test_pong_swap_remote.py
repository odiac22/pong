"""Synthetic RGB only; no emulator, TikTok, GPU, or production service."""
import contextlib
from copy import deepcopy
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from pong_swap_identity import FacePresentation
from pong_swap_engine import PongSwapEngine
from pong_swap_remote import RemoteSessionError, RemoteSessionManager, authorized_loopback
from pong_tiktok_restorer import restorer_models


class FakeEngine:
    _session_restorers = PongSwapEngine._session_restorers
    _model_configuration_in_use = PongSwapEngine._model_configuration_in_use

    @staticmethod
    def _thread_is_alive(thread):
        return bool(thread and thread.is_alive())

    def _active_session_count(self):
        return sum(not session.stop.is_set() and not session.complete
                   for session in self._sessions.values())

    def __init__(self):
        self._config_lock = threading.RLock()
        self._sessions_lock = threading.RLock()
        self._frame_previews_lock = threading.RLock()
        self._frame_preview_render_leases = 0
        self._sessions = {}
        self._config = {
            "parameters": {"RestorerSwitch": False},
            "runtime": {"identityCheckIntervalFrames": 12,
                        "temporalFullAnchorHz": 5.0,
                        "temporalRestorerAnchorHz": 3.0,
                        "temporalMaxPtsGapSeconds": .25},
        }
        self.faces = {"approved-a", "approved-b"}
        self.render_calls = []
        self.warm_restorer_models = []
        self.warm_error = None
        self.block_render = None

    def _config_snapshot(self):
        return {section: dict(value) for section, value in self._config.items()}, 7

    def face(self, face_id):
        if face_id not in self.faces:
            raise KeyError(face_id)
        return face_id

    def _run_gpu_work(self, callback, *args, **kwargs):
        cancel = kwargs.pop("queue_cancel_event", None)
        cancelled_value = kwargs.pop("cancelled_value", None)
        kwargs.pop("priority", None)
        kwargs.pop("work_label", None)
        if cancel is not None and cancel.is_set():
            return cancelled_value
        return callback(*args, **kwargs)

    def warm(self, **kwargs):
        self.warm_restorer_models.append(restorer_models(kwargs["config"]))
        if self.warm_error is not None:
            raise self.warm_error
        return None

    def _foreground_embedding_priority(self):
        return contextlib.nullcontext()

    def embedding_for_face(self, face_id, config):
        return np.full(512, 1 if face_id == "approved-a" else 2, dtype=np.float32)

    def source_frame_for_face(self, face_id, config):
        return None

    def presentation_for_face(self, face_id, config):
        return FacePresentation("unknown", 0)

    def _select_compatible_identity_for_frame(self, frame, candidates, config,
                                               evidence, cancel, manual_target):
        if frame[0, 0, 0] == 1:
            return None
        target = SimpleNamespace(
            embedding=np.full(512, 3, dtype=np.float32),
            presentation=FacePresentation("unknown", 0),
        )
        return SimpleNamespace(candidate=candidates[0], target=target)

    def _process_frame_to_rgb(self, frame, embedding, anchor, **kwargs):
        if self.block_render is not None:
            started, finish = self.block_render
            started.set()
            finish.wait(2)
        tracking = kwargs["tracking_state"]
        tracking["syntheticCount"] = tracking.get("syntheticCount", 0) + 1
        self.render_calls.append({
            "face": int(embedding[0]),
            "count": tracking["syntheticCount"],
            "delta": tracking["frameDeltaSeconds"],
            "config": kwargs["config"],
            "verify": kwargs["verify_identity"],
        })
        output = frame.copy()
        output[0, 0, 0] = (int(output[0, 0, 0]) + 1) % 256
        return output, anchor


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.manager = RemoteSessionManager(self.engine)
        self.session = self.manager.create("approved-a", 16, 16)

    def tearDown(self):
        self.manager.delete(self.session.id)

    @staticmethod
    def frame(value=0):
        return bytearray(np.full((16, 16, 3), value, dtype=np.uint8).tobytes())

    def test_exact_rgb_sequence_and_persistent_tracking(self):
        self.assertEqual(self.engine._frame_preview_render_leases, 1)
        one, meta = self.manager.render(self.session.id, 1, self.frame())
        two, _ = self.manager.render(self.session.id, 2, self.frame())
        self.assertEqual(len(one), 16 * 16 * 3)
        self.assertEqual(one, two)
        self.assertTrue(meta["transformed"])
        self.assertEqual([item["count"] for item in self.engine.render_calls], [1, 2])
        self.assertIs(self.engine.render_calls[0]["config"], self.session.config)
        self.assertEqual(self.session.transformed_frames, 2)
        self.assertEqual(self.session.resets, 0)

    def test_mismatch_passthrough_and_rejections(self):
        original = self.frame(1)
        output, meta = self.manager.render(self.session.id, 1, original)
        self.assertEqual(output, original)
        self.assertFalse(meta["transformed"])
        self.assertFalse(self.session.public()["identityLocked"])
        with self.assertRaises(RemoteSessionError) as stale:
            self.manager.render(self.session.id, 1, self.frame())
        self.assertEqual(stale.exception.status_code, 409)
        with self.assertRaises(RemoteSessionError) as shape:
            self.manager.render(self.session.id, 2, b"short")
        self.assertEqual(shape.exception.status_code, 422)
        self.session.lock.acquire()
        try:
            with self.assertRaises(RemoteSessionError) as busy:
                self.manager.render(self.session.id, 2, self.frame())
            self.assertEqual(busy.exception.status_code, 429)
        finally:
            self.session.lock.release()

    def test_face_change_and_cut_reset_identity_history(self):
        self.manager.render(self.session.id, 1, self.frame())
        self.manager.change_face(self.session.id, "approved-b")
        self.assertFalse(self.session.public()["identityLocked"])
        self.assertEqual(self.session.tracking.get("syntheticCount"), None)
        self.manager.render(self.session.id, 2, self.frame())
        self.assertEqual(self.engine.render_calls[-1]["face"], 2)
        self.assertEqual(self.engine.render_calls[-1]["count"], 1)
        _, meta = self.manager.render(self.session.id, 3, self.frame(), cut=True)
        self.assertTrue(meta["reset"])
        self.assertEqual(self.engine.render_calls[-1]["count"], 1)
        self.assertEqual(self.session.resets, 2)

    def test_scene_cut_and_capture_gap_reset(self):
        self.manager.render(self.session.id, 1, self.frame(), timestamp_ms=1000)
        self.manager.render(self.session.id, 2, self.frame(), timestamp_ms=1040)
        self.assertAlmostEqual(self.engine.render_calls[-1]["delta"], .04)
        _, scene = self.manager.render(self.session.id, 3, self.frame(200), timestamp_ms=1080)
        self.assertTrue(scene["reset"])
        _, gap = self.manager.render(self.session.id, 4, self.frame(200), timestamp_ms=2000)
        self.assertTrue(gap["reset"])
        self.assertEqual(self.session.resets, 2)

    def test_delete_waits_for_inflight_render_and_releases_lease(self):
        started, finish = threading.Event(), threading.Event()
        self.engine.block_render = (started, finish)
        result = []
        worker = threading.Thread(target=lambda: self._render_and_store(result))
        worker.start()
        self.assertTrue(started.wait(2))
        deleted = threading.Event()
        closer = threading.Thread(target=lambda: (self.manager.delete(self.session.id), deleted.set()))
        closer.start()
        self.assertFalse(deleted.wait(.05))
        self.assertEqual(self.engine._frame_preview_render_leases, 1)
        self.assertIn(self.session.id, self.manager._restorer_leases._leases)
        finish.set()
        worker.join(2)
        closer.join(2)
        self.assertTrue(deleted.is_set())
        self.assertEqual(self.engine._frame_preview_render_leases, 0)
        self.assertNotIn(self.session.id, self.manager._restorer_leases._leases)
        self.assertEqual(result[0].status_code, 410)

    def _render_and_store(self, result):
        try:
            self.manager.render(self.session.id, 1, self.frame())
        except RemoteSessionError as exc:
            result.append(exc)

    def test_invalid_face_and_dimensions_do_not_leak_lease(self):
        before = self.engine._frame_preview_render_leases
        with self.assertRaises(RemoteSessionError):
            self.manager.create("missing", 16, 16)
        with self.assertRaises(RemoteSessionError):
            self.manager.create("approved-a", 6000, 16)
        self.assertEqual(self.engine._frame_preview_render_leases, before)

    def test_default_profile_keeps_existing_snapshot_behavior(self):
        public = self.session.public()
        self.assertEqual(public["restorationProfile"], "default")
        self.assertEqual(public["adaptiveRestoration"], {})
        self.assertNotIn("tiktokRestorerProfile", self.session.config["runtime"])
        self.assertTrue(self.engine._model_configuration_in_use())
        self.manager.delete(self.session.id)
        self.assertFalse(self.engine._model_configuration_in_use())

    def test_adapter_preserves_original_query_without_leases_and_does_not_stack(self):
        engine = FakeEngine()
        engine._config["parameters"].update(RestorerSwitch=True,
                                             RestorerTypeTextSel="GPEN1024")
        original = engine._session_restorers(engine._config)
        first = RemoteSessionManager(engine)
        wrapped = engine._session_restorers
        second = RemoteSessionManager(engine)
        self.assertIs(first._restorer_leases, second._restorer_leases)
        self.assertIs(engine._session_restorers, wrapped)
        self.assertEqual(engine._session_restorers(engine._config), original)

    def test_tiktok_profile_is_session_local_and_warms_both_models(self):
        self.engine._config["parameters"].update(
            RestorerSwitch=True, RestorerTypeTextSel="GPEN1024",
        )
        saved = deepcopy(self.engine._config)
        session = self.manager.create(
            "approved-a", 16, 16, restoration_profile="tiktok-face-size",
        )
        try:
            self.assertEqual(self.engine._config, saved)
            self.assertIsNot(session.config, self.engine._config)
            self.assertEqual(session.config["runtime"]["tiktokRestorerProfile"], "tiktok-face-size")
            self.assertEqual(self.engine.warm_restorer_models[-1], ("GPEN512", "GPEN1024"))
            self.assertEqual(session.public()["restorerModels"], ["GPEN512", "GPEN1024"])
            self.assertEqual(self.engine._session_restorers(self.engine._config),
                             ("GPEN1024", "GPEN512"))
            session.config["runtime"]["tiktokRestorerState"]["GPEN512Frames"] = 1
            self.assertEqual(session.public()["adaptiveRestoration"]["GPEN512Frames"], 1)
            session.config["runtime"]["tiktokRestorerState"]["model"] = "GPEN512"
            session.reset("synthetic-scene-cut")
            self.assertNotIn("model", session.public()["adaptiveRestoration"])
            self.assertEqual(session.public()["adaptiveRestoration"]["GPEN512Frames"], 1)
            self.assertEqual(self.engine._config, saved)
        finally:
            self.manager.delete(session.id)
        self.assertEqual(self.engine._frame_preview_render_leases, 1)
        self.assertEqual(self.engine._session_restorers(self.engine._config), ("GPEN1024",))

    def test_raw_and_ordinary_session_restorers_are_union_until_exact_release(self):
        self.engine._config["parameters"].update(RestorerSwitch=True,
                                                 RestorerTypeTextSel="GPEN1024")
        ordinary = SimpleNamespace(
            config=deepcopy(self.engine._config), stop=threading.Event(), complete=False,
        )
        ordinary.config["parameters"]["RestorerTypeTextSel"] = "GPEN256"
        self.engine._sessions["ordinary"] = ordinary
        raw = self.manager.create(
            "approved-a", 16, 16, restoration_profile="tiktok-face-size",
        )
        self.assertEqual(self.engine._session_restorers(self.engine._config),
                         ("GPEN1024", "GPEN256", "GPEN512"))
        ordinary.stop.set()
        self.assertEqual(self.engine._session_restorers(self.engine._config),
                         ("GPEN1024", "GPEN512"))
        self.manager.delete(raw.id)
        self.assertEqual(self.engine._session_restorers(self.engine._config), ("GPEN1024",))
        self.assertEqual(self.engine._frame_preview_render_leases, 1)

    def test_concurrent_status_waits_for_coherent_render_state(self):
        started, finish = threading.Event(), threading.Event()
        self.engine.block_render = (started, finish)
        rendered = threading.Thread(target=lambda: self.manager.render(self.session.id, 1, self.frame()))
        rendered.start()
        self.assertTrue(started.wait(2))
        status = []
        done = threading.Event()
        reader = threading.Thread(target=lambda: (status.append(self.session.public()), done.set()))
        reader.start()
        self.assertFalse(done.wait(.05))
        finish.set()
        rendered.join(2)
        reader.join(2)
        self.assertTrue(done.is_set())
        self.assertEqual(status[0]["frames"], 1)
        self.assertEqual(status[0]["lastSequence"], 1)

    def test_idle_expiry_releases_exact_restorer_lease(self):
        self.engine._config["parameters"].update(RestorerSwitch=True,
                                                 RestorerTypeTextSel="GPEN1024")
        raw = self.manager.create(
            "approved-a", 16, 16, restoration_profile="tiktok-face-size",
        )
        self.assertIn(raw.id, self.manager._restorer_leases._leases)
        raw.last_used -= 121
        self.manager.prune_idle()
        self.assertNotIn(raw.id, self.manager._restorer_leases._leases)
        self.assertEqual(self.engine._session_restorers(self.engine._config), ("GPEN1024",))

    def test_unknown_profile_or_failed_profile_warm_releases_lease(self):
        before = self.engine._frame_preview_render_leases
        with self.assertRaises(RemoteSessionError) as invalid:
            self.manager.create("approved-a", 16, 16, restoration_profile="unknown")
        self.assertEqual(invalid.exception.status_code, 422)
        self.assertEqual(self.engine._frame_preview_render_leases, before)
        self.engine.warm_error = RuntimeError("synthetic warm failed")
        with self.assertRaisesRegex(RuntimeError, "synthetic warm failed"):
            self.manager.create(
                "approved-a", 16, 16, restoration_profile="tiktok-face-size",
            )
        self.assertEqual(self.engine._frame_preview_render_leases, before)
        self.assertEqual(len(self.manager._restorer_leases._leases), 1)

    def test_loopback_bearer_required(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "token"
            path.write_text("s" * 48, encoding="utf-8")
            request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"),
                                      headers={"authorization": "Bearer " + "s" * 48})
            authorized_loopback(request, path)
            request.headers["authorization"] = "Bearer wrong"
            with self.assertRaises(RemoteSessionError) as wrong:
                authorized_loopback(request, path)
            self.assertEqual(wrong.exception.status_code, 401)
            request.client.host = "192.0.2.1"
            with self.assertRaises(RemoteSessionError) as remote:
                authorized_loopback(request, path)
            self.assertEqual(remote.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
