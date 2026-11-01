"""CPU-only checks: no media, inference, or running-service access."""
import unittest
from copy import deepcopy
from pong_tiktok_restorer import (
    ADAPTIVE_512_PROFILE, restorer_models, select_restorer, session_config_for_profile,
)


def points(edge):
    return [[0, 0], [edge * .33, 0]]


class ThreeXRestorerTest(unittest.TestCase):
    def setUp(self):
        self.saved = {"parameters": {"RestorerSwitch": True,
            "RestorerTypeTextSel": "GPEN257", "RestorerSlider": 100}, "runtime": {}}
        self.config = session_config_for_profile(self.saved, ADAPTIVE_512_PROFILE)

    def test_automatic357_physical_model_prepared(self):
        self.assertEqual(restorer_models(self.config), ("GPEN256",))

    def test_automatic357_does_not_change_with_crop_size(self):
        for edge in [900,240,220,240,260]:
            self.assertEqual(select_restorer(self.config,points(edge)), 'GPEN357')

    def test_invalid_geometry_keeps_selected357(self):
        for value in [None,[],points(0),points(float('nan')),points(float('inf'))]:
            self.assertEqual(select_restorer(self.config,value),'GPEN357')

    def test_preset_and_other_sessions_unchanged(self):
        original=deepcopy(self.saved)
        select_restorer(self.config,points(900))
        second=session_config_for_profile(self.saved,ADAPTIVE_512_PROFILE)
        self.assertEqual(select_restorer(second,points(240)),'GPEN357')
        self.assertEqual(self.saved,original)
        self.assertEqual(session_config_for_profile(self.config),original)
        self.assertEqual(self.config['parameters']['RestorerTypeTextSel'],'GPEN357')

    def test_load_fallback_cannot_override357_or_leak_to_next_session(self):
        self.config['runtime']['threeXForce256']=True
        self.assertEqual(select_restorer(self.config,points(900)),'GPEN357')
        self.assertNotIn('threeXForce256',session_config_for_profile(self.config)['runtime'])
        self.assertNotIn('threeXForce256',self.saved['runtime'])

    def test_disabled_restoration_stays_disabled(self):
        self.config["parameters"]["RestorerSwitch"] = False
        self.assertEqual(restorer_models(self.config), ())


if __name__ == "__main__":
    unittest.main()
