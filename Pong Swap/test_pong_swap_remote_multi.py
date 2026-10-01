"""CPU-only multi-source contract for raw remote sessions."""
import threading
import unittest
from types import SimpleNamespace

import numpy as np
from pydantic import ValidationError

from pong_swap_identity import FacePresentation
from pong_swap_remote import MAX_MULTI_FACES, RemoteSessionError, RemoteSessionManager
from test_pong_swap_remote import FakeEngine


class ChoosingEngine(FakeEngine):
    def __init__(self):
        super().__init__()
        self.seen_choices = []

    def _select_compatible_identity_for_frame(self, frame, candidates, config,
                                               evidence, cancel, manual_target):
        self.seen_choices.append(tuple(candidate.face_id for candidate in candidates))
        if frame[0, 0, 0] == 1:
            return None
        chosen = next((candidate for candidate in candidates
                       if candidate.face_id == "approved-b"), candidates[0])
        target = SimpleNamespace(
            embedding=np.full(512, 3, dtype=np.float32),
            presentation=FacePresentation("unknown", 0),
        )
        return SimpleNamespace(candidate=chosen, target=target)


class RemoteMultiTests(unittest.TestCase):
    def setUp(self):
        self.engine = ChoosingEngine()
        self.manager = RemoteSessionManager(self.engine)
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            self.manager.delete(session.id)

    def create(self, **kwargs):
        session = self.manager.create("approved-a", 16, 16, **kwargs)
        self.sessions.append(session)
        return session

    @staticmethod
    def frame(value=0):
        return np.full((16, 16, 3), value, dtype=np.uint8).tobytes()

    def test_default_single_face_and_status_ownership(self):
        session = self.create()
        self.assertEqual(session.public()["faceId"], "approved-a")
        self.assertEqual(session.public()["faceIds"], ["approved-a"])
        self.assertIsNone(session.public()["selectedFaceId"])
        self.manager.render(session.id, 1, self.frame())
        self.assertEqual(self.engine.seen_choices, [("approved-a",)])
        self.assertEqual(session.public()["selectedFaceId"], "approved-a")

    def test_multi_selects_best_once_and_pins_across_cuts(self):
        session = self.create(face_ids=["approved-a", "approved-b"])
        self.assertEqual(len(self.engine.warm_restorer_models), 1)
        self.manager.render(session.id, 1, self.frame())
        self.assertEqual(self.engine.seen_choices, [("approved-a", "approved-b")])
        self.assertEqual(self.engine.render_calls[-1]["face"], 2)
        self.assertEqual(session.public()["faceId"], "approved-a")
        self.assertEqual(session.public()["faceIds"], ["approved-a", "approved-b"])
        self.assertEqual(session.public()["selectedFaceId"], "approved-b")
        self.manager.render(session.id, 2, self.frame(), cut=True)
        self.assertEqual(self.engine.seen_choices[-1], ("approved-b",))
        self.assertEqual(session.public()["selectedFaceId"], "approved-b")

    def test_initial_mismatch_does_not_lock_wrong_face(self):
        session = self.create(face_ids=["approved-a", "approved-b"])
        output, meta = self.manager.render(session.id, 1, self.frame(1))
        self.assertEqual(output, self.frame(1))
        self.assertFalse(meta["transformed"])
        self.assertIsNone(session.public()["selectedFaceId"])
        self.manager.render(session.id, 2, self.frame())
        self.assertEqual(session.public()["selectedFaceId"], "approved-b")

    def test_invalid_set_and_missing_member_release_lease(self):
        cases = [[], ["approved-b"], ["approved-a", "approved-a"],
                 ["approved-a", ""], ["approved-a", "missing"],
                 ["approved-a"] + [f"other-{i}" for i in range(MAX_MULTI_FACES)]]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(RemoteSessionError) as caught:
                self.create(face_ids=value)
            self.assertIn(caught.exception.status_code, (404, 422))
        self.assertEqual(self.engine._frame_preview_render_leases, 0)
        self.assertFalse(self.manager._restorer_leases._leases)

    def test_removed_face_fails_closed_and_delete_purges_references(self):
        session = self.create(face_ids=["approved-a", "approved-b"])
        self.manager.render(session.id, 1, self.frame())
        self.engine.faces.remove("approved-b")
        with self.assertRaises(RemoteSessionError) as caught:
            self.manager.render(session.id, 2, self.frame())
        self.assertEqual(caught.exception.status_code, 410)
        self.assertTrue(self.manager.delete(session.id))
        self.assertEqual(session.candidates, ())
        self.assertIsNone(session.candidate)
        self.assertEqual(self.engine._frame_preview_render_leases, 0)

    def test_approved_face_deletion_purges_only_referencing_sessions(self):
        affected = self.create(face_ids=["approved-a", "approved-b"])
        other = self.manager.create("approved-a", 16, 16)
        self.sessions.append(other)
        self.assertEqual(self.manager.purge_face("approved-b"), 1)
        self.assertTrue(affected.closed)
        self.assertEqual(affected.candidates, ())
        self.assertIsNone(affected.candidate)
        self.assertFalse(other.closed)
        self.assertEqual(self.engine._frame_preview_render_leases, 1)
        self.assertEqual(self.manager.purge_face("approved-b"), 0)
        self.assertEqual(self.manager.purge_face("approved-a"), 1)
        self.assertEqual(self.engine._frame_preview_render_leases, 0)

    def test_purge_during_pending_create_cannot_publish_stale_face(self):
        started, finish = threading.Event(), threading.Event()
        original_warm = self.engine.warm

        def blocked_warm(**kwargs):
            started.set()
            self.assertTrue(finish.wait(2))
            return original_warm(**kwargs)

        self.engine.warm = blocked_warm
        result = []

        def create():
            try:
                result.append(self.manager.create("approved-a", 16, 16,
                                                  face_ids=["approved-a", "approved-b"]))
            except RemoteSessionError as exc:
                result.append(exc)

        worker = threading.Thread(target=create)
        worker.start()
        self.assertTrue(started.wait(2))
        try:
            self.assertEqual(self.manager.purge_face("approved-b"), 0)
        finally:
            finish.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], RemoteSessionError)
        self.assertEqual(result[0].status_code, 410)
        self.assertEqual(self.engine._frame_preview_render_leases, 0)
        self.assertEqual(self.manager._pending_face_sets, {})

    def test_purge_during_change_cannot_publish_deleted_candidate(self):
        session = self.create()
        started, finish = threading.Event(), threading.Event()
        original_warm = self.engine.warm

        def blocked_warm(**kwargs):
            started.set()
            self.assertTrue(finish.wait(2))
            return original_warm(**kwargs)

        self.engine.warm = blocked_warm
        changes = []

        def change():
            try:
                changes.append(self.manager.change_face(session.id, "approved-b"))
            except RemoteSessionError as exc:
                changes.append(exc)

        worker = threading.Thread(target=change)
        worker.start()
        self.assertTrue(started.wait(2))
        purged = []
        purge = threading.Thread(target=lambda: purged.append(self.manager.purge_face("approved-b")))
        purge.start()
        try:
            # The purge registers the pending target before waiting on the
            # session's render/change lock.
            for _ in range(1000):
                with self.manager._lock:
                    marked = session.id in self.manager._purged_changes
                    removed = session.id not in self.manager._sessions
                if marked or removed:
                    break
                threading.Event().wait(.001)
            self.assertTrue(marked or removed)
        finally:
            finish.set()
            worker.join(2)
            purge.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(purge.is_alive())
        self.assertEqual(purged, [1])
        self.assertEqual(len(changes), 1)
        self.assertIsInstance(changes[0], RemoteSessionError)
        self.assertEqual(changes[0].status_code, 410)
        self.assertTrue(session.closed)
        self.assertIsNone(session.candidate)
        self.assertEqual(self.engine._frame_preview_render_leases, 0)
        self.assertFalse(self.manager._pending_changes)

    def test_change_face_collapses_set_even_when_primary_unchanged(self):
        session = self.create(face_ids=["approved-a", "approved-b"])
        self.manager.render(session.id, 1, self.frame())
        self.manager.change_face(session.id, "approved-a")
        self.assertEqual(session.public()["faceIds"], ["approved-a"])
        self.assertIsNone(session.public()["selectedFaceId"])
        self.assertFalse(session.public()["identityLocked"])
        self.manager.render(session.id, 2, self.frame())
        self.assertEqual(self.engine.seen_choices[-1], ("approved-a",))

    def test_change_face_rejects_inflight_render(self):
        session = self.create(face_ids=["approved-a", "approved-b"])
        started, finish = threading.Event(), threading.Event()
        self.engine.block_render = (started, finish)
        worker = threading.Thread(target=lambda: self.manager.render(session.id, 1, self.frame()))
        worker.start()
        self.assertTrue(started.wait(2))
        try:
            with self.assertRaises(RemoteSessionError) as caught:
                self.manager.change_face(session.id, "approved-a")
            self.assertEqual(caught.exception.status_code, 429)
            self.assertEqual(session.public()["faceIds"], ["approved-a", "approved-b"])
        finally:
            finish.set()
            worker.join(2)

    def test_service_request_strict_face_set_validation(self):
        # Importing the model does not start the ASGI service or GPU worker.
        from pong_swap_service import RemoteSessionRequest

        base = {"faceId": "approved-a", "width": 16, "height": 16}
        self.assertIsNone(RemoteSessionRequest(**base).faceIds)
        self.assertEqual(RemoteSessionRequest(**base,
            faceIds=["approved-a", "approved-b"]).faceIds,
            ["approved-a", "approved-b"])
        invalid = [
            {**base, "faceId": True},
            {**base, "faceIds": []},
            {**base, "faceIds": ["approved-b"]},
            {**base, "faceIds": ["approved-a", "approved-a"]},
            {**base, "faceIds": ["approved-a", True]},
            {**base, "faceIds": ["approved-a", 2]},
            {**base, "faceIds": ["approved-a", ""]},
            {**base, "faceIds": ["approved-a"] +
                [f"extra-{i}" for i in range(MAX_MULTI_FACES)]},
        ]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                RemoteSessionRequest(**values)


if __name__ == "__main__":
    unittest.main()
