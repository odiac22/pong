"""OFF-by-default, disposable TikTok Multi Face acquisition trial.

This module is not imported by the production service. ``install`` requires an
explicit qualification flag and environment opt-in before any session exists.
Only two guarded method copies are changed in memory; the frozen engine source,
models, selectors, hair rules, quality settings, and admission gates are not.
"""

import hashlib
import __future__
import inspect
import os
import textwrap
from types import MethodType


TRIAL_ENV = "PONG_TIKTOK_ACQUISITION_TRIAL"
TIKTOK_PROFILE = "tiktok-face-size"
_METHOD_HASHES = {
    "_select_compatible_identity_for_frame": frozenset({
        "fe1e8126cc1ed4fe1ef44fc1eceb645124b5b2c3efb6b7fb8f7cabc2b4adf9ce",
    }),
    "_produce_session": frozenset({
        "0a9028520d5b80a308c6a3999df394b3082fd6878d5bc2c3bd3ef595b257d554",
        "44ddbd66b9a65918a51daba74fa5610afda87fc50d9c645155ba56777a3ea836",
    }),
}

_HAIR_OLD = "    needs_hair = len(candidates) > 1 and any(required_hair(c.face_id) for c in candidates)\n"
_HAIR_NEW = """    hair_candidates = (
        tuple(c for c in candidates if c.face_id == multi_source_face_id)
        if multi_source_face_id
        and (config.get("runtime") or {}).get("tiktokRestorerProfile") == "tiktok-face-size"
        else candidates
    )
    needs_hair = len(candidates) > 1 and any(required_hair(c.face_id) for c in hair_candidates)
"""
_HAIR_PRECHECK_OLD = """        hair_color, hair_confidence = ('unknown', 0.0)
        if needs_hair:
"""
_HAIR_PRECHECK_NEW = """        hair_color, hair_confidence = ('unknown', 0.0)
        parse_hair = needs_hair
        if parse_hair and (config.get("runtime") or {}).get("tiktokRestorerProfile") == "tiktok-face-size":
            try:
                # Unknown hair admits every source under the existing policy.
                # If none passes the OTHER gates, known hair cannot rescue it.
                # Keep this target in the list for manual-point semantics;
                # never use the preliminary choice as the final selection.
                precheck_target = TargetIdentity(
                    keypoints=np.asarray(keypoints, dtype=np.float32),
                    embedding=np.asarray(embedding, dtype=np.float32),
                    presentation=presentation,
                    area=float(area),
                    hair_color='unknown',
                    hair_confidence=0.0,
                )
                precheck_strictness = float((config.get("parameters") or {}).get("DetectScoreSlider", 45))
                precheck = choose_multi_face(
                    hair_candidates, (precheck_target,),
                    minimum_similarity=precheck_strictness,
                    minimum_presentation_confidence=presentation_confidence_for_strictness(precheck_strictness),
                )
                if precheck.selection is None:
                    parse_hair = False
            except Exception:
                # Failure to establish a no-match proof takes the baseline path.
                pass
        if parse_hair:
"""
_PROBE_OLD = """                    if (
                        not identity_locked
                        and int(session.frames) >= int(next_compatibility_probe_frame)
                    ):
"""
_PROBE_STATE_OLD = "            next_compatibility_probe_frame = 0\n"
_PROBE_STATE_NEW = """            next_compatibility_probe_frame = 0
            compatibility_probe_was_prefetch = bool(session.prefetch)
"""
_PROBE_NEW = """                    if (
                        not identity_locked
                        and compatibility_probe_was_prefetch
                        and not bool(session.prefetch)
                        and (session.config.get("runtime") or {}).get("tiktokRestorerProfile") == "tiktok-face-size"
                    ):
                        # A speculative miss may have scheduled the next
                        # probe 350 ms away. Check on promotion only; later
                        # foreground frames keep their ordinary cadence.
                        next_compatibility_probe_frame = min(
                            int(next_compatibility_probe_frame), int(session.frames)
                        )
                    compatibility_probe_was_prefetch = bool(session.prefetch)
                    if (
                        not identity_locked
                        and int(session.frames) >= int(next_compatibility_probe_frame)
                    ):
"""


def is_tiktok_config(config):
    return ((config or {}).get("runtime") or {}).get("tiktokRestorerProfile") == TIKTOK_PROFILE


def transform_method(name, source, *, hair_precheck=False):
    """Return one exact method copy or fail closed on any frozen-source drift."""
    if name not in _METHOD_HASHES:
        raise ValueError("method is outside acquisition trial")
    original = textwrap.dedent(source)
    digest = hashlib.sha256(original.encode()).hexdigest()
    if digest not in _METHOD_HASHES[name]:
        raise RuntimeError(f"frozen {name} source changed; acquisition trial refused")
    old, new = (_HAIR_OLD, _HAIR_NEW) if name == "_select_compatible_identity_for_frame" else (_PROBE_OLD, _PROBE_NEW)
    if original.count(old) != 1:
        raise RuntimeError(f"{name} anchor changed; acquisition trial refused")
    transformed = original.replace(old, new, 1)
    if name == "_produce_session":
        if transformed.count(_PROBE_STATE_OLD) != 1:
            raise RuntimeError("producer probe state anchor changed; acquisition trial refused")
        transformed = transformed.replace(_PROBE_STATE_OLD, _PROBE_STATE_NEW, 1)
    if hair_precheck and name == "_select_compatible_identity_for_frame":
        if transformed.count(_HAIR_PRECHECK_OLD) != 1:
            raise RuntimeError("hair precheck anchor changed; acquisition trial refused")
        transformed = transformed.replace(_HAIR_PRECHECK_OLD, _HAIR_PRECHECK_NEW, 1)
    compile(transformed, f"<experiment_tiktok_acquisition:{name}>", "exec",
            flags=__future__.annotations.compiler_flag, dont_inherit=True)
    return transformed


class AcquisitionTrial:
    def __init__(self, engine, originals, installed):
        self.engine = engine
        self.original_callables = originals
        self._installed = installed
        self._restored = False

    def restore(self):
        """Reveal the exact original class methods; reject intervening owners."""
        if self._restored:
            return False
        with self.engine._sessions_lock:
            if self.engine._sessions or self.engine._active_by_channel:
                raise RuntimeError("acquisition trial can restore only when no sessions exist")
            for name, bound in self._installed.items():
                if self.engine.__dict__.get(name) is not bound:
                    raise RuntimeError(f"{name} was replaced after trial install")
            for name in self._installed:
                del self.engine.__dict__[name]
            self._restored = True
            return True


def install(engine, *, qualified=False, hair_precheck=False):
    """Install on one idle engine instance; return a restoration handle.

    Call only from an explicitly qualified experimental launcher, before any
    session is created. Every behavioral change is guarded by the session's
    TikTok profile; the global service config may have a different profile.
    No production launch script imports this module.
    """
    if not qualified or os.environ.get(TRIAL_ENV) != "1":
        raise RuntimeError("TikTok acquisition trial is not explicitly qualified")
    with engine._sessions_lock:
        if engine._sessions or engine._active_by_channel:
            raise RuntimeError("TikTok acquisition trial must install before sessions")
        originals = {}
        compiled = {}
        for name in _METHOD_HASHES:
            if name in engine.__dict__:
                raise RuntimeError(f"{name} already has an instance override")
            original = getattr(engine, name)
            original_function = getattr(original, "__func__", original)
            source = transform_method(name, inspect.getsource(original), hair_precheck=hair_precheck)
            scope = {}
            exec(compile(source, original_function.__code__.co_filename, "exec",
                         flags=__future__.annotations.compiler_flag, dont_inherit=True),
                 original_function.__globals__, scope)
            originals[name] = original
            compiled[name] = MethodType(scope[name], engine)
        try:
            for name, bound in compiled.items():
                engine.__dict__[name] = bound
        except Exception:
            for name, bound in compiled.items():
                if engine.__dict__.get(name) is bound:
                    del engine.__dict__[name]
            raise
        return AcquisitionTrial(engine, originals, compiled)
