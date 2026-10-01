"""CPU-only checks for the disposable TikTok acquisition trial."""

import ast
import __future__
from contextlib import nullcontext
import os
from pathlib import Path
import sys
import textwrap
import threading
from types import SimpleNamespace
from types import FunctionType
import unittest
from unittest.mock import patch

import numpy as np

import experiment_tiktok_acquisition as trial
from pong_multi_face import choose_multi_face
from pong_swap_identity import (
    CandidateIdentity, FacePresentation, IdentitySelection, TargetIdentity,
    choose_compatible_identity, compatible_identity_rankings,
    identity_similarity_upper_bound, presentation_confidence_for_strictness,
    rope_similarity, target_identity_lock_threshold,
)


ENGINE_FILE = Path(__file__).with_name("pong_swap_engine.py")
ENGINE_SOURCE = ENGINE_FILE.read_text(encoding="utf-8")
FROZEN_FILE = Path(__file__).parent / "pong_exact_runtime" / "frozen_methods.py"


def method_source(name):
    lines = ENGINE_SOURCE.splitlines(keepends=True)
    tree = ast.parse(ENGINE_SOURCE)
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PongSwapEngine")
    method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == name)
    return "".join(lines[method.lineno - 1:method.end_lineno])


def qualified_producer_source():
    source = FROZEN_FILE.read_text(encoding="utf-8")
    method = next(node for node in ast.parse(source).body
                  if isinstance(node, ast.FunctionDef) and node.name == "_produce_session")
    return "".join(source.splitlines(keepends=True)[method.lineno - 1:method.end_lineno])


def selector(source):
    scope = {}
    globals_ = {
        "np": np,
        "FacePresentation": FacePresentation,
        "TargetIdentity": TargetIdentity,
        "CandidateIdentity": CandidateIdentity,
        "IdentitySelection": IdentitySelection,
        "choose_multi_face": choose_multi_face,
        "choose_compatible_identity": choose_compatible_identity,
        "compatible_identity_rankings": compatible_identity_rankings,
        "identity_similarity_upper_bound": identity_similarity_upper_bound,
        "presentation_confidence_for_strictness": presentation_confidence_for_strictness,
        "rope_similarity": rope_similarity,
        "target_identity_lock_threshold": target_identity_lock_threshold,
    }
    exec(compile(textwrap.dedent(source), str(ENGINE_FILE), "exec",
                 flags=__future__.annotations.compiler_flag, dont_inherit=True), globals_, scope)
    return scope["_select_compatible_identity_for_frame"]


def vector(cosine):
    return np.asarray([cosine, (1 - cosine * cosine) ** .5, 0], dtype=np.float32)


def source_face(face_id, cosine):
    return CandidateIdentity(face_id, vector(cosine), FacePresentation("female", .99))


class FakeStream:
    def synchronize(self):
        pass


class FakeEngine:
    def __init__(self, detections, hair=("dark", .95)):
        self._lock = threading.RLock()
        self._compute_stream = FakeStream()
        self._torch = SimpleNamespace(cuda=SimpleNamespace(stream=lambda _stream: nullcontext()))
        self._presentation_classifier = SimpleNamespace(classify=lambda _frame, _points: FacePresentation("female", .99))
        self.detections = detections
        self.hair = hair
        self.hair_calls = 0

    def _frame_tensor(self, frame):
        return frame

    def _target_detection_score(self):
        return .5

    def _detect(self, *_args, **_kwargs):
        return self.detections

    def _hair_for_multi_target(self, _frame, _keypoints):
        self.hair_calls += 1
        return self.hair


def detect(embedding, x=20):
    points = np.asarray([[x, 20], [x + 3, 20], [x + 1, 22], [x, 24], [x + 3, 24]], dtype=np.float32)
    return (100.0, points, np.asarray(embedding, dtype=np.float32))


def run_selection(method, candidates, detections, *, bound=None, manual_point=None, hair=("dark", .95), tiktok=True):
    engine = FakeEngine(detections, hair)
    evidence = SimpleNamespace()
    config = {"runtime": {"tiktokRestorerProfile": "tiktok-face-size" if tiktok else "ordinary"},
              "parameters": {"DetectScoreSlider": 0}}
    selected = method(engine, np.zeros((100, 100, 3), dtype=np.uint8), tuple(candidates), config,
                      evidence, manual_target_point=manual_point, multi_source_face_id=bound)
    return selected, engine.hair_calls, evidence


class AcquisitionTrialTests(unittest.TestCase):
    def test_exact_transforms_compile_and_source_drift_fails_closed(self):
        for name in trial._METHOD_HASHES:
            original = method_source(name)
            changed = trial.transform_method(name, original)
            self.assertNotEqual(changed, textwrap.dedent(original))
            ast.parse(changed)
            with self.assertRaisesRegex(RuntimeError, "source changed"):
                trial.transform_method(name, original + "\n# drift\n")
        with_precheck = trial.transform_method("_select_compatible_identity_for_frame",
                                               method_source("_select_compatible_identity_for_frame"),
                                               hair_precheck=True)
        self.assertIn("precheck = choose_multi_face(", with_precheck)
        self.assertIn("        targets.append(", with_precheck)
        self.assertNotIn("if precheck.selection is None:\n                    continue", with_precheck)
        baseline = selector(method_source("_select_compatible_identity_for_frame"))
        transformed = selector(with_precheck)
        self.assertEqual(baseline.__annotations__, transformed.__annotations__)
        self.assertIsInstance(transformed.__annotations__["frame"], str)
        generated = qualified_producer_source()
        self.assertNotEqual(textwrap.dedent(method_source("_produce_session")), generated)
        qualified = trial.transform_method("_produce_session", generated)
        self.assertIn("next_compatibility_probe_frame = min(", qualified)
        generated_scope = {}
        changed_scope = {}
        exec(compile(generated, str(FROZEN_FILE), "exec",
                     flags=__future__.annotations.compiler_flag, dont_inherit=True), {}, generated_scope)
        exec(compile(qualified, str(FROZEN_FILE), "exec",
                     flags=__future__.annotations.compiler_flag, dont_inherit=True), {}, changed_scope)
        self.assertEqual(generated_scope["_produce_session"].__annotations__,
                         changed_scope["_produce_session"].__annotations__)
        with self.assertRaisesRegex(RuntimeError, "source changed"):
            trial.transform_method("_produce_session", generated + "\n# drift\n")

    def test_promoted_tiktok_clamps_old_speculative_deadline_only_while_unlocked(self):
        inserted = trial._PROBE_NEW.split(trial._PROBE_OLD)[0]
        code = ("def probe(session, identity_locked, next_compatibility_probe_frame, compatibility_probe_was_prefetch):\n"
                + textwrap.indent(textwrap.dedent(inserted), "    ")
                + "    return next_compatibility_probe_frame, compatibility_probe_was_prefetch\n")
        scope = {}
        exec(code, scope)
        probe = scope["probe"]
        config = {"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}
        session = SimpleNamespace(frames=2, prefetch=False, config=config)
        self.assertEqual(probe(session, False, 11, True), (2, False))
        # Remaining in foreground must not repeatedly defeat a new deadline.
        session.frames = 3
        self.assertEqual(probe(session, False, 11, False), (11, False))
        session.prefetch = True
        self.assertEqual(probe(session, False, 11, False), (11, True))
        session.prefetch = False
        self.assertEqual(probe(session, False, 11, True), (3, False))
        self.assertEqual(probe(session, True, 11, True), (11, False))
        session.config = {"runtime": {"tiktokRestorerProfile": "ordinary"}}
        self.assertEqual(probe(session, False, 11, True), (11, False))

    def test_retained_unrestricted_source_skips_hair_without_changing_decision(self):
        baseline = selector(method_source("_select_compatible_identity_for_frame"))
        changed = selector(trial.transform_method("_select_compatible_identity_for_frame",
                                                  method_source("_select_compatible_identity_for_frame")))
        candidates = [source_face("approved-18", .9), source_face("approved-2", .85)]
        detections = [detect([1, 0, 0])]
        old, old_calls, _ = run_selection(baseline, candidates, detections, bound="approved-18")
        new, new_calls, _ = run_selection(changed, candidates, detections, bound="approved-18")
        self.assertEqual(old.candidate.face_id, new.candidate.face_id)
        self.assertAlmostEqual(old.similarity, new.similarity)
        self.assertEqual((old_calls, new_calls), (1, 0))
        # A retained restricted source still needs the original hair policy.
        old, old_calls, _ = run_selection(baseline, candidates, detections, bound="approved-2", hair=("light", .95))
        new, new_calls, _ = run_selection(changed, candidates, detections, bound="approved-2", hair=("light", .95))
        self.assertIsNone(old)
        self.assertIsNone(new)
        self.assertEqual((old_calls, new_calls), (1, 1))
        # Non-TikTok sessions retain baseline work and policy.
        _, old_calls, _ = run_selection(baseline, candidates, detections, bound="approved-18", tiktok=False)
        _, new_calls, _ = run_selection(changed, candidates, detections, bound="approved-18", tiktok=False)
        self.assertEqual((old_calls, new_calls), (1, 1))

    def test_optional_no_match_precheck_skips_parser_but_preserves_final_manual_choice(self):
        baseline = selector(method_source("_select_compatible_identity_for_frame"))
        with_precheck = selector(trial.transform_method("_select_compatible_identity_for_frame",
                                                        method_source("_select_compatible_identity_for_frame"),
                                                        hair_precheck=True))
        candidates = [source_face("approved-18", .9), source_face("approved-2", .8)]
        no_match = [detect([-1, 0, 0])]
        old, old_calls, _ = run_selection(baseline, candidates, no_match)
        new, new_calls, _ = run_selection(with_precheck, candidates, no_match)
        self.assertIsNone(old)
        self.assertIsNone(new)
        self.assertEqual((old_calls, new_calls), (1, 0))
        # Do not drop the tapped first target merely because its precheck fails;
        # otherwise a second valid bystander could inherit the manual tap.
        two = [detect([-1, 0, 0], 20), detect([1, 0, 0], 80)]
        old, _, _ = run_selection(baseline, candidates, two, manual_point=(.2, .2))
        new, _, _ = run_selection(with_precheck, candidates, two, manual_point=(.2, .2))
        self.assertIsNone(old)
        self.assertIsNone(new)
        # If a source is eligible, both paths still parse hair and use the same
        # original final chooser and hair restrictions.
        match = [detect([1, 0, 0])]
        old, old_calls, _ = run_selection(baseline, candidates, match, hair=("light", .95))
        new, new_calls, _ = run_selection(with_precheck, candidates, match, hair=("light", .95))
        self.assertEqual(old.candidate.face_id, new.candidate.face_id)
        self.assertAlmostEqual(old.similarity, new.similarity)
        self.assertEqual((old_calls, new_calls), (1, 1))
        # A speculative no-match proof failure must fall back to hair parsing.
        fallback = selector(trial.transform_method("_select_compatible_identity_for_frame",
                                                   method_source("_select_compatible_identity_for_frame"),
                                                   hair_precheck=True))
        original_choose = fallback.__globals__["choose_multi_face"]
        calls = 0

        def fail_first(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("precheck unavailable")
            return original_choose(*args, **kwargs)

        fallback.__globals__["choose_multi_face"] = fail_first
        recovered, hair_calls, _ = run_selection(fallback, candidates, match)
        self.assertIsNotNone(recovered)
        self.assertEqual(hair_calls, 1)

    def test_install_requires_opt_in_and_restore_requires_idle_engine(self):
        class Idle:
            def __init__(self):
                self._sessions_lock = threading.Lock()
                self._sessions = {}
                self._active_by_channel = {}

            def _select_compatible_identity_for_frame(self):
                return "original-select"

            def _produce_session(self):
                return "original-produce"

        engine = Idle()
        with self.assertRaisesRegex(RuntimeError, "not explicitly qualified"):
            trial.install(engine)
        qualified_globals = {"sentinel": "from-qualified-globals"}
        Idle._produce_session = FunctionType(Idle._produce_session.__code__, qualified_globals,
                                             Idle._produce_session.__name__)
        replacement = lambda name, _source, **_kwargs: (
            f"def {name}(self):\n    return sentinel\n" if name == "_produce_session"
            else f"def {name}(self):\n    return 'trial-{name}'\n"
        )
        with patch.dict(os.environ, {trial.TRIAL_ENV: "1"}), patch.object(trial, "transform_method", side_effect=replacement):
            handle = trial.install(engine, qualified=True)
            self.assertEqual(engine._produce_session(), "from-qualified-globals")
            self.assertIs(engine._produce_session.__func__.__globals__, qualified_globals)
            self.assertEqual(handle.original_callables["_produce_session"](), "original-produce")
            engine._sessions["active"] = object()
            with self.assertRaisesRegex(RuntimeError, "no sessions"):
                handle.restore()
            engine._sessions.clear()
            self.assertTrue(handle.restore())
            self.assertEqual(engine._produce_session(), "original-produce")
            self.assertFalse(handle.restore())


if __name__ == "__main__":
    unittest.main()
