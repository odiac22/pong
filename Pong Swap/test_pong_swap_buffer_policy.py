"""No-GPU tests for the pure foreground render-ahead ceiling."""

import unittest
import ast
import threading
from pathlib import Path
from types import SimpleNamespace

from pong_swap_buffer_policy import render_ahead_ceiling_seconds


def ceiling(**overrides):
    values = dict(
        base_seconds=3.0,
        max_foreground_seconds=12.0,
        foreground_pacing_wait_seconds=0.0,
        active_foreground=True,
        playback_paused=False,
        startup_ready=True,
        scrub_suspended=False,
    )
    values.update(overrides)
    return render_ahead_ceiling_seconds(**values)


class RenderAheadPolicyTests(unittest.TestCase):
    def test_engine_passes_event_state_not_truthy_event_object(self):
        tree = ast.parse(Path(__file__).with_name('pong_swap_engine.py').read_text())
        call = next(n for n in ast.walk(tree) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name) and n.func.id == 'render_ahead_ceiling_seconds')
        suspended = next(k.value for k in call.keywords if k.arg == 'scrub_suspended')
        bank = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'bank_idle_time' for t in n.targets))
        session = SimpleNamespace(scrub_suspended=threading.Event(), playback_started_at=1,
                                  activation_requested=True, prefetch=False, playback_paused=False)
        read = lambda node: eval(compile(ast.Expression(node), 'engine-policy', 'eval'), {'session':session})
        self.assertIs(read(suspended), False)
        self.assertIs(read(bank), True)
        session.scrub_suspended.set()
        self.assertIs(read(suspended), True)
        self.assertIs(read(bank), False)

    def test_no_wait_keeps_existing_lead(self):
        self.assertEqual(ceiling(), 3.0)

    def test_spare_capacity_ramps_and_caps(self):
        self.assertEqual(ceiling(foreground_pacing_wait_seconds=0.25), 4.0)
        self.assertEqual(ceiling(foreground_pacing_wait_seconds=1.0), 7.0)
        self.assertEqual(ceiling(foreground_pacing_wait_seconds=3.0), 12.0)
        self.assertEqual(ceiling(foreground_pacing_wait_seconds=100.0), 12.0)

    def test_no_growth_outside_active_playback(self):
        for change in (
            {"active_foreground": False},
            {"playback_paused": True},
            {"startup_ready": False},
            {"scrub_suspended": True},
        ):
            with self.subTest(change=change):
                self.assertEqual(ceiling(foreground_pacing_wait_seconds=10.0, **change), 3.0)

    def test_invalid_inputs_fail_closed(self):
        for change in (
            {"base_seconds": 0},
            {"max_foreground_seconds": 2},
            {"foreground_pacing_wait_seconds": -1},
            {"foreground_pacing_wait_seconds": float("nan")},
        ):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    ceiling(**change)


if __name__ == "__main__":
    unittest.main()
