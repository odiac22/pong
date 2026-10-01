from __future__ import annotations

import unittest
import threading
from copy import deepcopy
from unittest.mock import Mock, patch

from pong_swap_engine import (
    ConfigUpdateConflict,
    PongSwapEngine,
    StaleActivationError,
    SwapSession,
)
from pong_swap_config import parameter_schema


def created_session(config: dict, revision: int = 1) -> SwapSession:
    return SwapSession(
        id="f" * 32,
        channel="test",
        source_url="https://example.invalid/video.mp4",
        face_id="approved-face",
        start_seconds=0.0,
        config=deepcopy(config),
        config_revision=revision,
    )


class ConfigSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = PongSwapEngine()

    def test_config_property_is_not_mutable_engine_state(self) -> None:
        exposed = self.engine.config
        original = self.engine.config["runtime"]["encoderCq"]
        exposed["runtime"]["encoderCq"] = original + 10

        self.assertEqual(self.engine.config["runtime"]["encoderCq"], original)

    def test_created_session_counts_as_active_before_stream_starts(self) -> None:
        session = created_session(self.engine.config)
        self.engine._sessions = {session.id: session}

        self.assertEqual(self.engine._active_session_count(), 1)

    def test_hot_update_does_not_mutate_existing_session_snapshot(self) -> None:
        session = created_session(self.engine.config, self.engine._config_revision)
        self.engine._sessions = {session.id: session}
        old_threshold = session.config["parameters"]["ThresholdSlider"]
        proposed = self.engine.config
        proposed["parameters"]["ThresholdSlider"] = old_threshold + 1

        with patch(
            "pong_swap_config.save_config",
            side_effect=lambda value: deepcopy(value),
        ):
            updated = self.engine.update_config(proposed)

        self.assertEqual(
            session.config["parameters"]["ThresholdSlider"],
            old_threshold,
        )
        self.assertEqual(
            updated["parameters"]["ThresholdSlider"],
            old_threshold + 1,
        )
        self.assertGreater(self.engine._config_revision, session.config_revision)

    def test_live_preview_updates_memory_without_persisting(self) -> None:
        proposed = self.engine.config
        proposed["parameters"]["DiffSlider"] += 1

        with patch("pong_swap_config.save_config") as save:
            updated = self.engine.update_config(proposed, persist=False)

        save.assert_not_called()
        self.assertEqual(updated["parameters"]["DiffSlider"], proposed["parameters"]["DiffSlider"])
        self.assertEqual(self.engine.config, updated)

    def test_baseline_commit_requests_a_timestamped_backup(self) -> None:
        proposed = self.engine.config
        proposed["parameters"]["OccluderSlider"] += 1

        with patch(
            "pong_swap_config.save_config",
            side_effect=lambda value, **_: deepcopy(value),
        ) as save:
            self.engine.update_config(proposed, backup=True)

        save.assert_called_once_with(proposed, backup=True)

    def test_explicit_send_persists_baseline_without_increment_or_unload(self) -> None:
        original_revision = self.engine._config_revision
        self.engine.unload = Mock()
        original_config = self.engine.config

        with patch(
            "pong_swap_config.save_config",
            side_effect=lambda value, **_: deepcopy(value),
        ) as save:
            updated = self.engine.update_config(
                self.engine.config,
                persist=True,
                backup=True,
            )

        save.assert_called_once_with(original_config, backup=True)
        self.engine.unload.assert_not_called()
        self.assertEqual(self.engine._config_revision, original_revision)
        self.assertEqual(updated, self.engine.config)

    def test_lifecycle_update_is_rejected_while_created_session_exists(self) -> None:
        session = created_session(self.engine.config)
        self.engine._sessions = {session.id: session}
        proposed = self.engine.config
        proposed["runtime"]["backend"] = (
            "cuda" if proposed["runtime"]["backend"] == "trt" else "trt"
        )

        save = Mock(side_effect=lambda value: deepcopy(value))
        with patch("pong_swap_config.save_config", save):
            with self.assertRaises(ConfigUpdateConflict):
                self.engine.update_config(proposed)

        save.assert_not_called()

    def test_lifecycle_update_unloads_idle_pipeline_for_next_warm(self) -> None:
        proposed = self.engine.config
        proposed["runtime"]["backend"] = (
            "cuda" if proposed["runtime"]["backend"] == "trt" else "trt"
        )
        self.engine.unload = Mock()

        with patch(
            "pong_swap_config.save_config",
            side_effect=lambda value: deepcopy(value),
        ):
            self.engine.update_config(proposed)

        self.engine.unload.assert_called_once_with()

    def test_ordered_submission_change_requires_idle_model_reload(self) -> None:
        proposed = self.engine.config
        proposed["runtime"]["orderedGpuSubmission"] = not proposed["runtime"]["orderedGpuSubmission"]
        session = created_session(self.engine.config)
        self.engine._sessions = {session.id: session}
        with self.assertRaises(ConfigUpdateConflict):
            self.engine.update_config(proposed, persist=False)
        self.engine._sessions.clear()
        self.engine.unload = Mock()
        self.engine.update_config(proposed, persist=False)
        self.engine.unload.assert_called_once_with()

    def test_lifecycle_update_cancels_sleeping_embedding_primer(self) -> None:
        self.engine.prime_embeddings_async(delay_seconds=30.0)
        primer = self.engine._embedding_prime_thread
        self.assertIsNotNone(primer)
        self.assertTrue(primer.is_alive())
        proposed = self.engine.config
        proposed["runtime"]["backend"] = (
            "cuda" if proposed["runtime"]["backend"] == "trt" else "trt"
        )

        updated = self.engine.update_config(proposed, persist=False)

        primer.join(timeout=1.0)
        self.assertFalse(primer.is_alive())
        self.assertEqual(updated["runtime"]["backend"], proposed["runtime"]["backend"])

    def test_cancelled_but_live_primer_blocks_model_unload(self) -> None:
        release = threading.Event()
        exited = threading.Event()

        def primer_body() -> None:
            try:
                release.wait(2.0)
            finally:
                with self.engine._embedding_prime_lock:
                    if self.engine._embedding_prime_thread is threading.current_thread():
                        self.engine._embedding_prime_thread = None
                        self.engine._embedding_prime_started = False
                exited.set()

        primer = threading.Thread(target=primer_body, daemon=True)
        with self.engine._embedding_prime_lock:
            self.engine._embedding_prime_started = True
            self.engine._embedding_prime_thread = primer
            old_cancel = threading.Event()
            old_cancel.set()
            self.engine._embedding_prime_cancel = old_cancel
        models = Mock()
        self.engine._models = models
        primer.start()

        self.engine.unload()
        self.assertIs(self.engine._models, models)
        models.delete_models.assert_not_called()
        self.assertIs(self.engine._embedding_prime_cancel, old_cancel)

        release.set()
        self.assertTrue(exited.wait(1.0))
        primer.join(1.0)
        self.engine.unload()
        models.delete_models.assert_called_once_with()
        self.assertIsNone(self.engine._models)
        self.assertIsNot(self.engine._embedding_prime_cancel, old_cancel)

    def test_embedding_profile_changes_with_alignment_or_merge_settings(self) -> None:
        base = self.engine.config
        detect_changed = deepcopy(base)
        detect_changed["parameters"]["DetectInputSizeTextSel"] = "416"
        merge_changed = deepcopy(base)
        merge_changed["parameters"]["MergeTextSel"] = "Median"

        self.assertNotEqual(
            self.engine._embedding_profile_key(base),
            self.engine._embedding_profile_key(detect_changed),
        )
        self.assertNotEqual(
            self.engine._embedding_profile_key(base),
            self.engine._embedding_profile_key(merge_changed),
        )

    def test_production_model_choices_are_limited_to_retained_models(self) -> None:
        schema = {item["name"]: item for item in parameter_schema()}
        self.assertEqual(schema["SwapperTypeTextSel"]["options"], ["128"])
        self.assertEqual(
            schema["RestorerTypeTextSel"]["options"],
            ["GPEN256", "GPEN512", "GPEN1024"],
        )

    def test_stale_alternative_model_selection_is_normalized(self) -> None:
        proposed = self.engine.config
        proposed["parameters"]["SwapperTypeTextSel"] = "AlphaFace"
        proposed["parameters"]["RestorerTypeTextSel"] = "CodeFormer"

        normalized = self.engine._normalized_config(proposed)

        self.assertEqual(normalized["parameters"]["SwapperTypeTextSel"], "128")
        self.assertEqual(normalized["parameters"]["RestorerTypeTextSel"], "GPEN512")

    def test_null_stale_settings_fall_back_to_authoritative_defaults(self) -> None:
        defaults = self.engine.config
        proposed = {
            "runtime": {
                "restorerHybridReferenceBlendWeightByReason": None,
                "encoderCq": None,
            },
            "parameters": {
                "StrengthSlider": None,
            },
        }

        normalized = self.engine._normalized_config(proposed)

        self.assertEqual(
            normalized["runtime"]["restorerHybridReferenceBlendWeightByReason"],
            defaults["runtime"]["restorerHybridReferenceBlendWeightByReason"],
        )
        self.assertEqual(normalized["runtime"]["encoderCq"], defaults["runtime"]["encoderCq"])
        self.assertEqual(
            normalized["parameters"]["StrengthSlider"],
            defaults["parameters"]["StrengthSlider"],
        )

    def test_stale_activation_cannot_replace_newer_browser_intent(self) -> None:
        older = created_session(self.engine.config)
        older.id = "1" * 32
        older.prefetch = True
        older.complete = True
        newer = created_session(self.engine.config)
        newer.id = "2" * 32
        newer.prefetch = True
        newer.complete = True
        self.engine._sessions = {older.id: older, newer.id: newer}

        self.engine.activate_session(
            newer.id,
            client_epoch="browser-epoch",
            activation_sequence=2,
        )
        with self.assertRaises(StaleActivationError):
            self.engine.activate_session(
                older.id,
                client_epoch="browser-epoch",
                activation_sequence=1,
            )

        self.assertEqual(self.engine._active_by_channel["test"], newer.id)
        self.assertEqual(newer.public()["activationSequence"], 2)


if __name__ == "__main__":
    unittest.main()
