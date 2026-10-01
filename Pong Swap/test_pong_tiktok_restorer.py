import unittest
import ast
from pathlib import Path
from types import SimpleNamespace
from pong_tiktok_restorer import PROFILE, MOTION_TRIAL_PROFILE, FIXED_512_PROFILE, restorer_models, select_restorer, session_config_for_profile


def points(edge):
    return [[0, 0], [edge * .33, 0], [30, 40], [10, 60], [50, 60]]


class TikTokRestorerTest(unittest.TestCase):
    def setUp(self):
        self.saved = {"parameters": {"RestorerSwitch": True, "RestorerTypeTextSel": "GPEN1024", "RestorerSlider": 100}, "runtime": {}}
        self.config = session_config_for_profile(self.saved, PROFILE)

    def test_small_and_large(self):
        self.assertEqual(select_restorer(self.config, points(200)), "GPEN512")
        self.assertEqual(select_restorer(self.config, points(700)), "GPEN1024")

    def test_boundary_hysteresis(self):
        self.assertEqual(select_restorer(self.config, points(500)), "GPEN512")
        self.assertEqual(select_restorer(self.config, points(520)), "GPEN1024")
        self.assertEqual(select_restorer(self.config, points(500)), "GPEN1024")
        self.assertEqual(select_restorer(self.config, points(440)), "GPEN512")

    def test_bad_geometry_keeps_quality(self):
        for kps in (None, [], points(0), points(float("nan")), points(float("inf"))):
            self.assertEqual(select_restorer(self.config, kps), "GPEN1024")

    def test_default_and_saved_unchanged(self):
        select_restorer(self.config, points(200))
        self.assertEqual(self.saved["runtime"], {})
        self.assertEqual(self.saved["parameters"], self.config["parameters"])
        normal = session_config_for_profile(self.config)
        self.assertEqual(normal, self.saved)
        self.assertEqual(select_restorer(normal, points(20)), "GPEN1024")

    def test_both_models_prepared_only_for_tiktok(self):
        self.assertEqual(restorer_models(self.config), ("GPEN512", "GPEN1024"))
        self.assertEqual(restorer_models(self.saved), ("GPEN1024",))
        self.config["parameters"]["RestorerSwitch"] = False
        self.assertEqual(restorer_models(self.config), ())

    def test_sessions_do_not_share_hysteresis_or_metrics(self):
        second = session_config_for_profile(self.saved, PROFILE)
        select_restorer(self.config, points(900))
        self.assertEqual(select_restorer(second, points(500)), "GPEN512")
        self.assertEqual(self.config["runtime"]["tiktokRestorerState"]["GPEN1024Frames"], 1)

    def test_reject_unrecognized_profile(self):
        with self.assertRaises(ValueError):
            session_config_for_profile(self.saved, "anything")

    def test_explicit_tiktok_512_is_session_local_and_never_promotes(self):
        fixed = session_config_for_profile(self.saved, FIXED_512_PROFILE)
        self.assertEqual(fixed["parameters"], self.saved["parameters"])
        self.assertEqual(restorer_models(fixed), ("GPEN512",))
        for landmarks in (points(200), points(900), None):
            self.assertEqual(select_restorer(fixed, landmarks), "GPEN512")
        self.assertEqual(fixed["runtime"]["tiktokRestorerState"]["GPEN512Frames"], 3)
        self.assertEqual(session_config_for_profile(fixed), self.saved)
        self.assertEqual(session_config_for_profile(fixed, PROFILE), self.config)
        self.assertEqual(self.saved["runtime"], {})

    def test_512_cloned_from_motion_trial_restores_original_cadence(self):
        trial = session_config_for_profile(self.saved, MOTION_TRIAL_PROFILE)
        fixed = session_config_for_profile(trial, FIXED_512_PROFILE)
        self.assertNotIn("temporalFullAnchorHz", fixed["runtime"])
        self.assertNotIn("tiktokMotionTrialOriginal", fixed["runtime"])
        self.assertEqual(session_config_for_profile(fixed), self.saved)

    def test_512_does_not_enable_disabled_restoration(self):
        fixed = session_config_for_profile(self.saved, FIXED_512_PROFILE)
        fixed["parameters"]["RestorerSwitch"] = False
        self.assertEqual(restorer_models(fixed), ())

    def test_motion_trial_is_opt_in_and_does_not_change_output_quality_parameters(self):
        trial = session_config_for_profile(self.saved, MOTION_TRIAL_PROFILE)
        self.assertTrue(trial["runtime"]["temporalForegroundReuseEnabled"])
        self.assertEqual(trial["runtime"]["temporalFullAnchorHz"], 15)
        self.assertEqual(trial["parameters"], self.saved["parameters"])
        self.assertEqual(restorer_models(trial), ("GPEN512", "GPEN1024"))
        self.assertNotIn("temporalForegroundReuseEnabled", self.config["runtime"])
        self.assertEqual(session_config_for_profile(trial), self.saved)
        self.assertEqual(session_config_for_profile(trial, PROFILE), self.config)

    def test_motion_trial_restores_preexisting_runtime_values(self):
        self.saved["runtime"].update(temporalForegroundReuseEnabled=False, minimumHeadroom=3,
                                     temporalFullAnchorHz=4, temporalForegroundReuseHighLoadOnly=True)
        trial = session_config_for_profile(self.saved, MOTION_TRIAL_PROFILE)
        self.assertEqual(session_config_for_profile(trial), self.saved)

    def test_production_cleanup_keeps_both_adaptive_models(self):
        # Execute the actual cleanup method without importing CUDA/ONNX.
        tree = ast.parse((Path(__file__).parent / "engine/Rope/rope/Models.py").read_text(encoding="utf-8"))
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "reconcile_production_residency")
        module = ast.Module(body=[method], type_ignores=[])
        scope = {"torch": SimpleNamespace(cuda=SimpleNamespace(mem_get_info=lambda: (8 * 1024**3, 12 * 1024**3)))}
        exec(compile(module, "residency", "exec"), scope)
        loaded = {"g512", "g1024"}
        fake = SimpleNamespace(_SWAPPER_RESIDENCY_ATTR={}, _DETECTOR_LOADED_ATTR={},
            _RESTORER_RESIDENCY_ATTR={"GPEN512": "g512", "GPEN1024": "g1024"},
            _ALTERNATIVE_SWAPPER_ATTRS=set(), _ALTERNATIVE_RESTORER_ATTRS=set(loaded),
            _model_last_used={}, is_model_loaded=lambda x: x in loaded,
            loaded_model_attrs=lambda: sorted(loaded), unload_model=loaded.remove,
            _release_unused_cuda_arenas=lambda: None)
        reconcile = scope["reconcile_production_residency"]
        self.assertEqual(reconcile(fake, self.saved["parameters"], retained_restorers=restorer_models(self.config))["evicted"], [])
        self.assertEqual(reconcile(fake, self.saved["parameters"])["evicted"], ["g512"])


if __name__ == "__main__":
    unittest.main()
