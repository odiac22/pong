import copy
import unittest
from pong_tiktok_restorer import (ADAPT_PROFILE, ADAPT_THREE_X_PROFILE, PLAYBACK_PROFILE,
    TIKTOK_THREE_X_PROFILE, THREE_X_PROFILES, session_config_for_profile, restorer_models, select_restorer)
from pong_three_x import apply_quality_policy


class AdaptTests(unittest.TestCase):
    def config(self, model):
        return {'parameters': {'RestorerSwitch': True, 'RestorerTypeTextSel': model,
                'RestorerSlider': 100, 'SwapperTypeTextSel': '256'}, 'runtime': {
                'temporalForegroundReuseEnabled': False, 'adaptiveRestorer': False,
                'temporalDetectorLkFusionEnabled': True,
                'temporalDetectorShapeContinuityEnabled': True,
                'temporalIdentityResidualStabilizationEnabled': True,
                'temporalFullMaxFaceMae': 14, 'maximumFps': 30, 'maximumWidth': 4096}}

    def test_selected_models_and_attachment_guards_survive_both_modes(self):
        for model in ('GPEN256', 'GPEN512', 'GPEN1024', 'GFPGAN1.2'):
            original = self.config(model)
            before = copy.deepcopy(original)
            for profile in (ADAPT_PROFILE, ADAPT_THREE_X_PROFILE):
                session = session_config_for_profile(original, profile)
                if profile == ADAPT_THREE_X_PROFILE and model != 'GFPGAN1.2':
                    # Responsive 3X Adapt keeps the whole dynamic ladder resident.
                    self.assertEqual(restorer_models(session)[0], model)
                    self.assertEqual(set(restorer_models(session)), {'GPEN1024', 'GPEN512', 'GPEN256'})
                else:
                    self.assertEqual(restorer_models(session), (model,))
                self.assertEqual(select_restorer(session, None), model)
                self.assertEqual(session['parameters'], original['parameters'])
                for key in ('temporalDetectorLkFusionEnabled', 'temporalDetectorShapeContinuityEnabled',
                            'temporalIdentityResidualStabilizationEnabled', 'temporalFullMaxFaceMae',
                            'maximumFps', 'maximumWidth'):
                    self.assertEqual(session['runtime'][key], original['runtime'][key])
                self.assertTrue(session['runtime']['temporalForegroundReuseEnabled'])
                self.assertTrue(session['runtime']['adaptiveRestorer'])
                self.assertEqual(session['runtime']['temporalFullAnchorHz'], 3)
                off = session_config_for_profile(session, TIKTOK_THREE_X_PROFILE if profile in THREE_X_PROFILES else PLAYBACK_PROFILE)
                self.assertFalse(off['runtime']['temporalForegroundReuseEnabled'])
                self.assertFalse(off['runtime']['adaptiveRestorer'])
                self.assertEqual(restorer_models(off), (model,))
            self.assertEqual(original, before)

    def test_mode_off_overrides_an_old_reuse_preset(self):
        config = self.config('GPEN256')
        config['runtime'].update(temporalForegroundReuseEnabled=True, adaptiveRestorer=True)
        session = session_config_for_profile(config, PLAYBACK_PROFILE)
        self.assertFalse(session['runtime']['temporalForegroundReuseEnabled'])
        self.assertFalse(session['runtime']['adaptiveRestorer'])
        self.assertEqual(session_config_for_profile(session), config)

    def test_repeated_adapt_and_default_restore_original_settings(self):
        config = self.config('GPEN256')
        session = session_config_for_profile(config, ADAPT_PROFILE)
        session = session_config_for_profile(session, ADAPT_PROFILE)
        self.assertEqual(session_config_for_profile(session), config)

    def test_three_x_adapt_never_reduces_selected_model_strength_or_swapper(self):
        config = session_config_for_profile(self.config('GPEN256'), ADAPT_THREE_X_PROFILE)
        self.assertIn(config['runtime']['tiktokRestorerProfile'], THREE_X_PROFILES)
        for level in range(4):
            working = copy.deepcopy(config)
            apply_quality_policy(working, config, level)
            self.assertEqual(working['parameters'], config['parameters'])
            self.assertFalse(working['runtime']['threeXForce256'])


if __name__ == '__main__': unittest.main()
