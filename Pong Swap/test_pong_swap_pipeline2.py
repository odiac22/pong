from __future__ import annotations

import inspect
import unittest

from pong_swap_config import default_config
from pong_swap_engine import PongSwapEngine, SwapSession
from rope.Models import Models


class Pipeline2ConfigTests(unittest.TestCase):
    def test_pipeline2_is_enabled_without_dynamic_quality(self) -> None:
        runtime = default_config()["runtime"]
        self.assertIs(runtime["pipeline2Enabled"], True)
        self.assertIs(runtime["adaptivePrefetchEnabled"], True)
        self.assertIs(runtime["dynamicQualityEnabled"], False)
        self.assertEqual(runtime["browserStartupBytes"], 48 * 1024)
        self.assertEqual(runtime["browserStartupMediaSeconds"], 0.5)
        self.assertEqual(runtime["transportMinimumFragmentBytes"], 2048)
        self.assertEqual(runtime["transportPaddingIntervalFragments"], 8)

    def test_browser_startup_requires_fragment_and_measured_byte_floor(self) -> None:
        session = SwapSession(
            id="session",
            channel="test",
            source_url="https://media.example/video.mp4",
            face_id="face",
            start_seconds=0,
            media_fragment_ready=True,
            bytes_written=30_661,
            config={"runtime": {"browserStartupBytes": 48 * 1024}},
        )
        self.assertFalse(session.browser_startup_ready())
        session.bytes_written = 48 * 1024
        self.assertTrue(session.browser_startup_ready())
        session.media_fragment_ready = False
        self.assertFalse(session.browser_startup_ready())

    def test_browser_startup_padding_cannot_replace_real_media_time(self) -> None:
        session = SwapSession(
            id="session",
            channel="test",
            source_url="https://media.example/video.mp4",
            face_id="face",
            start_seconds=0,
            media_fragment_ready=True,
            bytes_written=64 * 1024,
            transport_padding_bytes=60 * 1024,
            frames=10,
            fps=20,
            complete_fragments=10,
            fragment_frame_target=1,
            config={
                "runtime": {
                    "browserStartupBytes": 48 * 1024,
                    "browserStartupMediaSeconds": 1.0,
                }
            },
        )
        self.assertFalse(session.browser_startup_ready())
        session.frames = 20
        session.complete_fragments = 20
        self.assertTrue(session.browser_startup_ready())

    def test_finalized_short_stream_bypasses_unattainable_byte_floor(self) -> None:
        session = SwapSession(
            id="session",
            channel="test",
            source_url="https://media.example/video.mp4",
            face_id="face",
            start_seconds=0,
            media_fragment_ready=True,
            bytes_written=12_000,
            complete=True,
            config={"runtime": {"browserStartupBytes": 48 * 1024}},
        )
        self.assertTrue(session.browser_startup_ready())

    def test_fragment_cadence_is_independent_from_prebuffer(self) -> None:
        config = default_config()
        runtime = config["runtime"]
        runtime.update(
            foregroundFragmentSeconds=0.50,
            prefetchFragmentSeconds=0.75,
            seekFragmentSeconds=0.40,
        )
        self.assertEqual(
            PongSwapEngine._fragment_seconds_for_session(False, "foreground", config),
            0.50,
        )
        self.assertEqual(
            PongSwapEngine._fragment_seconds_for_session(True, "prefetch", config),
            0.75,
        )
        self.assertEqual(
            PongSwapEngine._fragment_seconds_for_session(True, "seek", config),
            0.40,
        )

    def test_mux_readiness_uses_one_sample_fragments_not_the_longer_gop(self) -> None:
        self.assertEqual(PongSwapEngine._mux_fragment_frame_target(23.976), 1)
        self.assertEqual(PongSwapEngine._mux_fragment_frame_target(30.0), 1)
        source = inspect.getsource(PongSwapEngine._produce_session)
        self.assertIn("frag_every_frame+empty_moov+default_base_moof", source)

    def test_pipeline2_off_retains_2738_fragment_behavior(self) -> None:
        config = default_config()
        config["runtime"]["pipeline2Enabled"] = False
        self.assertEqual(
            PongSwapEngine._fragment_seconds_for_session(False, "foreground", config),
            1.0,
        )
        self.assertEqual(
            PongSwapEngine._fragment_seconds_for_session(True, "prefetch", config),
            0.0,
        )

    def test_public_session_reports_transport_class(self) -> None:
        session = SwapSession(
            id="session",
            channel="test",
            source_url="https://media.example/video.mp4",
            face_id="face",
            start_seconds=12.5,
            prefetch=True,
            prebuffer_seconds=2.0,
            fragment_seconds=0.5,
            navigation_class="seek",
        )
        public = session.public()
        self.assertEqual(public["prebufferSeconds"], 2.0)
        self.assertEqual(public["fragmentSeconds"], 0.5)
        self.assertEqual(public["navigationClass"], "seek")

    def test_ffmpeg_write_avoids_full_frame_bytes_copy(self) -> None:
        source = inspect.getsource(PongSwapEngine._produce_session)
        self.assertIn('memoryview(contiguous_output).cast("B")', source)
        self.assertNotIn("output_frame).tobytes()", source)

    def test_foreground_producer_starts_during_session_registration(self) -> None:
        source = inspect.getsource(PongSwapEngine.create_session)
        self.assertIn("self._ensure_session_producer(session)", source)
        self.assertNotIn("if prefetch:\n            self._ensure_session_producer(session)", source)

    def test_scrub_suspension_yields_before_inference(self) -> None:
        source = inspect.getsource(PongSwapEngine._produce_session)
        self.assertIn("while session.scrub_suspended.is_set()", source)
        self.assertIn("session.condition.wait(timeout=0.025)", source)
        public_source = inspect.getsource(SwapSession.public)
        self.assertIn('"scrubSuspended": self.scrub_suspended.is_set()', public_source)

    def test_persistent_detector_copies_each_worker_frame_into_owned_input(self) -> None:
        state_source = inspect.getsource(Models._get_retinaface_io_state)
        detect_source = inspect.getsource(Models._detect_retinaface_inner)
        self.assertIn("input_buffer = torch.empty", state_source)
        self.assertIn("'input': input_buffer", state_source)
        self.assertIn("persistent_state['input'].copy_(det_img)", detect_source)
        self.assertNotIn("_get_retinaface_io_binding", detect_source)

    def test_headless_recognition_skips_unused_thumbnail_conversion(self) -> None:
        detect_source = inspect.getsource(PongSwapEngine._detect)
        recognize_source = inspect.getsource(Models.recognize)
        self.assertIn("return_crop=False", detect_source)
        self.assertIn("if return_crop", recognize_source)

    def test_cpu_tracking_preparation_happens_before_gpu_lock(self) -> None:
        source = inspect.getsource(PongSwapEngine.process_frame)
        gray_index = source.index("cv2.cvtColor")
        lock_index = source.index("with self._lock")
        self.assertLess(gray_index, lock_index)

    def test_source_open_overlaps_model_and_identity_preparation(self) -> None:
        source = inspect.getsource(PongSwapEngine._produce_session)
        start_index = source.index("source_opener.start()")
        warm_index = source.index("self._run_gpu_work(", start_index)
        result_index = source.index("source_open_result.get")
        self.assertLess(start_index, warm_index)
        self.assertLess(warm_index, result_index)


if __name__ == "__main__":
    unittest.main()
