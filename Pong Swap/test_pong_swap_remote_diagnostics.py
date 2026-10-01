"""CPU-only, synthetic-frame tests for optional bounded remote diagnostics."""
import os
import unittest
from unittest.mock import patch

import numpy as np

from pong_swap_remote import MAX_FRAME_DIAGNOSTIC_RECORDS, RemoteSessionManager
from test_pong_swap_remote import FakeEngine


class EvidenceEngine(FakeEngine):
    def _select_compatible_identity_for_frame(self, frame, candidates, config,
                                               evidence, cancel, manual_target):
        evidence.detection_attempted = True
        evidence.detections = ((1.0, np.zeros((5, 2), dtype=np.float32), None),)
        evidence.recognition_complete = True
        result = super()._select_compatible_identity_for_frame(
            frame, candidates, config, evidence, cancel, manual_target,
        )
        if result is not None:
            evidence.selected_target_embedding = result.target.embedding
        return result

    def _process_frame_to_rgb(self, frame, embedding, anchor, **kwargs):
        evidence = kwargs["frame_evidence"]
        evidence.detection_attempted = True
        evidence.detections = ((1.0, np.zeros((5, 2), dtype=np.float32), None),)
        if kwargs["verify_identity"]:
            evidence.recognition_complete = True
        temporal = kwargs.get("temporal_context")
        if temporal is not None:
            key = "exactFrames" if temporal.get("forceExact") else "reusedFrames"
            temporal[key] = int(temporal.get(key, 0)) + 1
        return super()._process_frame_to_rgb(frame, embedding, anchor, **kwargs)


class RemoteDiagnosticTests(unittest.TestCase):
    @staticmethod
    def frame():
        return np.zeros((16, 16, 3), dtype=np.uint8).tobytes()

    def make_manager(self, enabled):
        engine = EvidenceEngine()
        engine._config["parameters"].update(RestorerSwitch=True,
                                             RestorerTypeTextSel="GPEN512")
        engine._config["runtime"]["adaptiveRestorer"] = True
        with patch.dict(os.environ, {"PONG_REMOTE_FRAME_DIAGNOSTICS": "1" if enabled else "0"}):
            manager = RemoteSessionManager(engine)
        session = manager.create("approved-a", 16, 16)
        self.addCleanup(manager.delete, session.id)
        return manager, session

    def test_default_path_has_no_status_records(self):
        manager, session = self.make_manager(False)
        manager.render(session.id, 1, self.frame())
        self.assertNotIn("frameDiagnostics", session.public())
        self.assertEqual(session.frame_diagnostics, [])

    def test_first_steady_and_pts_reset_records_are_bounded_and_numeric(self):
        manager, session = self.make_manager(True)
        manager.render(session.id, 1, self.frame(), timestamp_ms=1000)
        manager.render(session.id, 2, self.frame(), timestamp_ms=1040)
        manager.render(session.id, 3, self.frame(), timestamp_ms=2000)
        records = session.public()["frameDiagnostics"]["records"]
        self.assertEqual(len(records), 3)
        first, steady, gap = records
        self.assertTrue(first["firstFrame"])
        self.assertTrue(first["acquisitionAttempted"])
        self.assertTrue(first["selectionAccepted"])
        self.assertGreaterEqual(first["selectionMs"], 0.0)
        self.assertGreaterEqual(first["processingMs"], 0.0)
        self.assertGreaterEqual(first["totalMs"], first["selectionMs"])
        self.assertEqual(first["detections"], 1)
        self.assertTrue(first["recognitionComplete"])
        self.assertTrue(first["matchSelected"])
        self.assertEqual(first["exactDelta"], 1)
        self.assertTrue(first["temporalEnabled"])
        self.assertTrue(first["forceExactRequested"])
        self.assertFalse(steady["firstFrame"])
        self.assertFalse(steady["acquisitionAttempted"])
        self.assertEqual(steady["selectionMs"], 0.0)
        self.assertEqual(steady["ptsGapMs"], 40.0)
        self.assertEqual(steady["reuseDelta"], 1)
        self.assertFalse(steady["forceExactRequested"])
        self.assertTrue(gap["ptsDiscontinuity"])
        self.assertTrue(gap["reset"])
        self.assertEqual(gap["ptsGapMs"], 960.0)
        self.assertEqual(gap["exactDelta"], 1)
        for record in records:
            self.assertTrue(all(isinstance(value, (int, float, bool))
                                for value in record.values()))
        records[0]["detections"] = 99
        self.assertEqual(session.public()["frameDiagnostics"]["records"][0]["detections"], 1)

        for sequence in range(4, 40):
            manager.render(session.id, sequence, self.frame(), timestamp_ms=2000 + (sequence - 3) * 40)
        public = session.public()["frameDiagnostics"]
        self.assertEqual(public["maxRecords"], MAX_FRAME_DIAGNOSTIC_RECORDS)
        self.assertEqual(len(public["records"]), MAX_FRAME_DIAGNOSTIC_RECORDS)
        self.assertEqual(public["records"][0]["frameIndex"], 7)
        self.assertEqual(public["records"][-1]["frameIndex"], 38)

    def test_delete_clears_records(self):
        manager, session = self.make_manager(True)
        manager.render(session.id, 1, self.frame())
        self.assertEqual(len(session.frame_diagnostics), 1)
        self.assertTrue(manager.delete(session.id))
        self.assertEqual(session.frame_diagnostics, [])


if __name__ == "__main__":
    unittest.main()
