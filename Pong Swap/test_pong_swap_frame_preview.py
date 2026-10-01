from __future__ import annotations

import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import cv2

from pong_swap_engine import FramePreview, PongSwapEngine
from pong_swap_identity import FacePresentation


class _FakeTensor:
    def __init__(self, value: np.ndarray) -> None:
        self._value = value

    def cpu(self):
        return self

    def numpy(self) -> np.ndarray:
        return self._value


class FramePreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = PongSwapEngine()

    def test_create_caches_one_ephemeral_source_frame(self) -> None:
        frame = np.full((24, 16, 3), 80, dtype=np.uint8)
        self.engine.face = Mock()
        with patch.object(
            self.engine,
            "_decode_frame_preview_source",
            return_value=frame,
        ) as decode:
            preview = self.engine.create_frame_preview(
                source_url="https://example.invalid/video.mp4",
                face_id="approved-face",
                start_seconds=3.25,
            )

        decode.assert_called_once_with("https://example.invalid/video.mp4", 3.25)
        self.assertIs(self.engine.frame_preview(preview.id).frame, frame)
        self.assertEqual(preview.public()["width"], 16)
        self.assertTrue(self.engine.delete_frame_preview(preview.id))

    def test_create_accepts_the_browser_captured_frame_without_reopening_source(self) -> None:
        bgr = np.full((20, 14, 3), 120, dtype=np.uint8)
        ok, encoded = cv2.imencode(".jpg", bgr)
        self.assertTrue(ok)
        self.engine.face = Mock()

        preview = self.engine.create_frame_preview_from_encoded(
            encoded=encoded.tobytes(),
            source_url="https://temporary.invalid/one-use.mp4",
            face_id="approved-face",
            start_seconds=2.0,
        )

        self.assertEqual(preview.frame.shape, (20, 14, 3))
        self.assertEqual(preview.source_url, "https://temporary.invalid/one-use.mp4")

    def test_preview_rejects_pathological_decoded_dimensions(self) -> None:
        with self.assertRaisesRegex(ValueError, "4096x4096"):
            self.engine._validate_frame_preview(
                np.zeros((8, 4097, 3), dtype=np.uint8)
            )

    def test_preview_cache_prunes_oldest_frames_to_byte_budget(self) -> None:
        first = FramePreview(
            id="1" * 32,
            source_url="https://example.invalid/first.mp4",
            face_id="face",
            start_seconds=0.0,
            frame=np.zeros((10, 10, 3), dtype=np.uint8),
            last_used_at=1.0,
        )
        second = FramePreview(
            id="2" * 32,
            source_url="https://example.invalid/second.mp4",
            face_id="face",
            start_seconds=0.0,
            frame=np.zeros((10, 10, 3), dtype=np.uint8),
            last_used_at=2.0,
        )
        self.engine._frame_previews = {first.id: first, second.id: second}

        self.engine._prune_frame_previews(
            maximum=6,
            maximum_bytes=second.frame.nbytes,
            ttl_seconds=float("inf"),
        )

        self.assertNotIn(first.id, self.engine._frame_previews)
        self.assertIn(second.id, self.engine._frame_previews)

    def test_detect_score_change_invalidates_cached_preview_tracking(self) -> None:
        baseline = deepcopy(self.engine.config)
        changed = deepcopy(baseline)
        changed["parameters"]["DetectScoreSlider"] = (
            float(baseline["parameters"]["DetectScoreSlider"]) + 1
        )

        self.assertNotEqual(
            self.engine._frame_preview_tracking_profile(baseline),
            self.engine._frame_preview_tracking_profile(changed),
        )

    def test_original_preview_returns_the_untouched_source_frame(self) -> None:
        frame = np.zeros((22, 18, 3), dtype=np.uint8)
        frame[:, :] = (17, 93, 211)  # RGB, deliberately asymmetric by channel.
        preview = FramePreview(
            id="o" * 32,
            source_url="https://example.invalid/original.mp4",
            face_id="approved-face",
            start_seconds=4.0,
            frame=frame.copy(),
        )
        self.engine._frame_previews[preview.id] = preview

        encoded, media_type = self.engine.frame_preview_original(preview.id)

        decoded_bgr = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        decoded_rgb = cv2.cvtColor(decoded_bgr, cv2.COLOR_BGR2RGB)
        self.assertEqual(media_type, "image/webp")
        self.assertEqual(decoded_rgb.shape, frame.shape)
        self.assertLess(float(np.abs(decoded_rgb.astype(float) - frame.astype(float)).mean()), 2.0)

    def test_detected_face_carries_a_stable_identity_descriptor(self) -> None:
        frame = np.full((100, 80, 3), 90, dtype=np.uint8)
        preview = FramePreview(
            id="i" * 32,
            source_url="https://example.invalid/identity.mp4",
            face_id="approved-face",
            start_seconds=1.25,
            frame=frame,
        )
        self.engine._frame_previews[preview.id] = preview
        keypoints = np.asarray(
            [[24, 32], [40, 32], [32, 42], [26, 52], [38, 52]],
            dtype=np.float32,
        )
        embedding = np.linspace(-0.5, 0.5, 32, dtype=np.float32)
        self.engine._run_gpu_work = Mock(
            side_effect=lambda _callable, *_args, **kwargs: (
                [(400.0, keypoints, embedding)]
                if kwargs.get("work_label") == "frame-preview-face-detect"
                else {"ok": True}
            )
        )
        self.engine._presentation_classifier.classify = Mock(
            return_value=FacePresentation("female", 0.97, (0.4, 0.5))
        )

        faces = self.engine.frame_preview_faces(preview.id)

        self.assertEqual(len(faces), 1)
        self.assertEqual(faces[0]["identityEmbedding"], embedding.tolist())
        self.assertEqual(faces[0]["presentation"]["label"], "female")
        self.assertEqual(faces[0]["presentation"]["confidence"], 0.97)

    def test_geometry_only_never_returns_identity_or_runs_presentation_classifier(self):
        preview = FramePreview(id='g' * 32, source_url='', face_id='face', start_seconds=0,
                               frame=np.zeros((100, 80, 3), np.uint8), geometry_only=True)
        self.engine._frame_previews[preview.id] = preview
        points = np.asarray([[24,32],[40,32],[32,42],[26,52],[38,52]], np.float32)
        self.engine._run_gpu_work = Mock(side_effect=lambda fn, **kw:
            [(400., points, None)] if kw.get('work_label') == 'frame-preview-face-detect' else {})
        self.engine._presentation_classifier.classify = Mock()
        faces = self.engine.frame_preview_faces(preview.id)
        self.assertTrue(faces[0]['geometryOnly'])
        self.assertFalse(faces[0]['learningSupported'])
        self.assertEqual(faces[0]['identityEmbedding'], [])
        self.engine._presentation_classifier.classify.assert_not_called()
        with self.assertRaises(ValueError):
            self.engine.confirm_detected_face(preview.id, 0)
        with self.assertRaises(ValueError):
            self.engine.render_frame_preview(preview.id, self.engine.config)

    def test_same_frozen_frame_uses_cached_detections_but_config_change_invalidates(self):
        preview = FramePreview(id='c' * 32, source_url='https://stock.test/1', face_id='face',
                               start_seconds=0, frame=np.zeros((100, 80, 3), np.uint8))
        self.engine._frame_previews[preview.id] = preview
        self.engine._frame_preview_faces_uncached = Mock(return_value=[{'index':0, 'identityEmbedding':[.2]}])
        first = self.engine.frame_preview_faces(preview.id)
        first[0]['identityEmbedding'][0] = 999
        self.assertEqual(self.engine.frame_preview_faces(preview.id)[0]['identityEmbedding'], [.2])
        self.engine._frame_preview_faces_uncached.assert_called_once()
        self.engine._config['parameters']['DetectInputSizeTextSel'] = 640
        self.engine.frame_preview_faces(preview.id)
        self.assertEqual(self.engine._frame_preview_faces_uncached.call_count, 2)

    def test_detection_feedback_requires_the_original_cached_index(self):
        preview = FramePreview(id='f' * 32, source_url='https://stock.test/1', face_id='face',
                               start_seconds=0, frame=np.zeros((100,80,3),np.uint8))
        self.engine._frame_previews[preview.id] = preview
        self.engine._detection_calibration = Mock()
        with self.assertRaises(ValueError):
            self.engine.confirm_detected_face(preview.id, 0)
        preview.detected_faces = [{'index':3, 'identityEmbedding':[.2]}]
        preview.detection_token = 't' * 32
        preview.recovered_indices = {3}
        with self.assertRaises(ValueError):
            self.engine.confirm_detected_face(preview.id, 0)
        with self.assertRaises(ValueError):
            self.engine.confirm_detected_face(preview.id, 3, 'old')
        self.engine.confirm_detected_face(preview.id, 3, preview.detection_token)
        self.engine._detection_calibration.confirm.assert_called_once_with('https://stock.test/1', recovered=True)

    def test_render_uses_pending_visual_controls_without_mutating_global_config(self) -> None:
        frame = np.full((24, 16, 3), 80, dtype=np.uint8)
        preview = FramePreview(
            id="p" * 32,
            source_url="https://example.invalid/video.mp4",
            face_id="approved-face",
            start_seconds=1.0,
            frame=frame,
        )
        self.engine._frame_previews[preview.id] = preview
        self.engine.face = Mock()
        proposed = deepcopy(self.engine.config)
        proposed["parameters"]["OccluderSlider"] += 7
        observed = {}

        def process(_frame, _embedding, anchor, **kwargs):
            observed["config"] = kwargs["config"]
            return _FakeTensor(frame.copy()), np.ones(512, dtype=np.float32)

        self.engine.embedding_for_face = Mock(return_value=np.ones(512, dtype=np.float32))
        self.engine.source_frame_for_face = Mock(return_value=None)
        self.engine.presentation_for_face = Mock(return_value=SimpleNamespace(label="female"))
        target = SimpleNamespace(
            keypoints=np.asarray(
                [[4, 5], [11, 5], [8, 9], [5, 14], [10, 14]],
                dtype=np.float32,
            ),
            presentation=SimpleNamespace(label="female"),
        )
        candidate = SimpleNamespace(
            embedding=np.ones(512, dtype=np.float32),
            presentation=SimpleNamespace(label="female"),
            source_frame=None,
        )
        self.engine._select_compatible_identity_for_frame = Mock(
            return_value=SimpleNamespace(target=target, candidate=candidate)
        )
        self.engine.warm = Mock(return_value={"ok": True})
        self.engine.process_frame = Mock(side_effect=process)
        baseline = self.engine.config

        encoded, media_type, elapsed_ms = self.engine.render_frame_preview(
            preview.id,
            proposed,
            "alternate-approved-face",
        )

        self.assertGreater(len(encoded), 20)
        self.assertEqual(media_type, "image/webp")
        self.assertGreaterEqual(elapsed_ms, 0)
        self.assertEqual(
            observed["config"]["parameters"]["OccluderSlider"],
            proposed["parameters"]["OccluderSlider"],
        )
        self.assertEqual(
            observed["config"]["runtime"]["backend"],
            baseline["runtime"]["backend"],
        )
        self.assertEqual(self.engine.config, baseline)
        self.assertEqual(preview.face_id, "alternate-approved-face")
        self.engine.warm.assert_called_once_with(
            config=proposed,
            allow_create_selected=True,
        )

    def test_render_returns_original_when_live_compatibility_rejects(self) -> None:
        frame = np.zeros((22, 18, 3), dtype=np.uint8)
        frame[:, :] = (19, 87, 203)
        preview = FramePreview(
            id="r" * 32,
            source_url="https://example.invalid/rejected.mp4",
            face_id="approved-face",
            start_seconds=2.5,
            frame=frame.copy(),
        )
        self.engine._frame_previews[preview.id] = preview
        self.engine.face = Mock()
        self.engine.embedding_for_face = Mock(return_value=np.ones(512, dtype=np.float32))
        self.engine.source_frame_for_face = Mock(return_value=None)
        self.engine.presentation_for_face = Mock(return_value=SimpleNamespace(label="female"))
        self.engine._select_compatible_identity_for_frame = Mock(return_value=None)
        self.engine.warm = Mock(return_value={"ok": True})
        self.engine.process_frame = Mock(side_effect=AssertionError("must not swap"))

        encoded, media_type, _elapsed_ms = self.engine.render_frame_preview(
            preview.id,
            deepcopy(self.engine.config),
            preview.face_id,
            manual_target_x=0.5,
            manual_target_y=0.5,
        )

        decoded_bgr = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        decoded_rgb = cv2.cvtColor(decoded_bgr, cv2.COLOR_BGR2RGB)
        self.assertEqual(media_type, "image/webp")
        self.assertLess(float(np.abs(decoded_rgb.astype(float) - frame.astype(float)).mean()), 2.0)
        self.engine.process_frame.assert_not_called()
        self.assertIsNone(preview.anchor)


if __name__ == "__main__":
    unittest.main()
