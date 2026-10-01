"""Offline identity checks for the signed-manager Recall receipt matcher."""
import importlib.util
import sys
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    'signed_manager_harness', Path(__file__).with_name('qualify-current-tampermonkey-manager.py')
)
original_argv = sys.argv
try:
    sys.argv = [str(spec.origin)]
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
finally:
    sys.argv = original_argv


PAGE = 'https://example.org/watch/second?quality=high'
SENT_AT = datetime(2026, 9, 28, 22, 0, 0, tzinfo=timezone.utc).timestamp()
PRIOR = {'id': 'previous-capture', 'startedAt': '2026-09-28T21:59:30.000Z'}


def state(capture_id='fresh-capture', source=PAGE, started='2026-09-28T22:00:01.000Z', recall_id=None):
    return {
        'mediaCapture': {'id': capture_id, 'sourceUrl': source, 'startedAt': started,
                         'state': 'complete', 'deliveredVideos': 1},
        'recall': {'id': capture_id if recall_id is None else recall_id,
                   'genericBundles': [{'videos': [{'videoUrl': 'https://cdn.example.org/a.mp4'}]}]},
    }


class ReceiptIdentityTests(unittest.TestCase):
    def match(self, value):
        return harness.matching_receipt(value, PRIOR, SENT_AT, PAGE)

    def test_accepts_new_capture_for_exact_page_and_recall(self):
        capture, payload = self.match(state(source=PAGE + '#player'))
        self.assertEqual(capture['id'], payload['id'])

    def test_rejects_previous_capture_on_same_host(self):
        self.assertIsNone(self.match(state(capture_id=PRIOR['id'])))

    def test_rejects_other_page_on_same_host(self):
        self.assertIsNone(self.match(state(source='https://example.org/watch/first?quality=high')))

    def test_rejects_mismatched_recall_identity(self):
        self.assertIsNone(self.match(state(recall_id='unrelated-capture')))

    def test_rejects_capture_before_send(self):
        self.assertIsNone(self.match(state(started='2026-09-28T21:59:58.000Z')))

    def test_rejects_capture_not_newer_than_prior(self):
        old_prior = {'id': PRIOR['id'], 'startedAt': '2026-09-28T22:00:01.000Z'}
        self.assertIsNone(harness.matching_receipt(state(), old_prior, SENT_AT, PAGE))

    def test_rejects_malformed_timestamp(self):
        self.assertIsNone(self.match(state(started='not-a-date')))

    def test_live_test_requires_empty_idle_recall(self):
        with patch.object(harness.args, 'live_current', True):
            for value in [{'recall': {'id': 'existing'}}, {'pending': {'id': 'pending'}},
                          {'mediaCapture': {'state': 'running'}}]:
                with self.assertRaises(RuntimeError):
                    harness.require_empty_live_recall(value)
            harness.require_empty_live_recall({'recall': None, 'pending': None})

    def test_isolated_test_can_use_its_existing_recall(self):
        with patch.object(harness.args, 'live_current', False):
            harness.require_empty_live_recall(state())


if __name__ == '__main__':
    unittest.main()
