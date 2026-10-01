"""Session-local TikTok restoration; never changes the saved Pong preset."""
from copy import deepcopy
import math

PROFILE = "tiktok-face-size"
MOTION_TRIAL_PROFILE = "tiktok-face-size-motion-trial"
FIXED_512_PROFILE = "tiktok-gpen512"


def session_config_for_profile(config, profile="default"):
    if profile not in ("default", PROFILE, MOTION_TRIAL_PROFILE, FIXED_512_PROFILE):
        raise ValueError("Unsupported restoration profile")
    result = deepcopy(config)
    # A trial is session-local, including when a subsequent session is cloned
    # from its config. Restore the exact original values before applying the
    # requested profile; never let experimental cadence enter the saved preset.
    prior = result.setdefault("runtime", {}).pop("tiktokMotionTrialOriginal", None)
    if prior is not None:
        for key, entry in prior.items():
            if entry[0]:
                result["runtime"][key] = entry[1]
            else:
                result["runtime"].pop(key, None)
    # Explicitly remove internal state, even when cloning another session.
    result.setdefault("runtime", {}).pop("tiktokRestorerState", None)
    result["runtime"].pop("tiktokRestorerProfile", None)
    if profile in (PROFILE, MOTION_TRIAL_PROFILE):
        result["runtime"]["tiktokRestorerProfile"] = PROFILE
        result["runtime"]["tiktokRestorerState"] = {}
    elif profile == FIXED_512_PROFILE:
        # Explicitly requested TikTok-only quality option. Keep an independent
        # warm signature and cache identity; never alter the saved parameters,
        # resolution, encoder, masks, detection or temporal inference cadence.
        result["runtime"]["tiktokRestorerProfile"] = FIXED_512_PROFILE
        result["runtime"]["tiktokRestorerState"] = {}
    if profile == MOTION_TRIAL_PROFILE:
        runtime = result["runtime"]
        # Keep output FPS, model, restoration, masks, encoder CQ and resolution.
        # On alternate safe frames, transport the previous face correction
        # using the existing landmark/appearance guards. Unsafe motion still
        # runs fresh inference. This is an opt-in quality trial, not a default.
        changes = {"temporalForegroundReuseEnabled": True,
                   "temporalForegroundReuseHighLoadOnly": False,
                   "temporalFullAnchorHz": 15.0,
                   "minimumHeadroom": 1.0}
        runtime["tiktokMotionTrialOriginal"] = {
            key: (key in runtime, deepcopy(runtime.get(key))) for key in changes
        }
        runtime.update(changes)
    return result


def restorer_models(config):
    if not config["parameters"].get("RestorerSwitch"):
        return ()
    if config.get("runtime", {}).get("tiktokRestorerProfile") == FIXED_512_PROFILE:
        return ("GPEN512",)
    if config.get("runtime", {}).get("tiktokRestorerProfile") == PROFILE:
        return ("GPEN512", "GPEN1024")
    return (config["parameters"].get("RestorerTypeTextSel"),)


def select_restorer(config, landmarks):
    """Estimate source-pixel aligned crop from eye spacing, not viewport size.

    Canonical GPEN eye spacing is about 33% of its aligned crop. Promote at
    512px; demote below 448px to avoid switching repeatedly near the boundary.
    Invalid geometry keeps the higher-quality model, never guesses smaller.
    """
    runtime = config.get("runtime", {})
    if runtime.get("tiktokRestorerProfile") == FIXED_512_PROFILE:
        state = runtime.setdefault("tiktokRestorerState", {})
        state["model"] = "GPEN512"
        state["policy"] = FIXED_512_PROFILE
        state["GPEN512Frames"] = state.get("GPEN512Frames", 0) + 1
        return "GPEN512"
    if runtime.get("tiktokRestorerProfile") != PROFILE:
        return config["parameters"].get("RestorerTypeTextSel")
    state = runtime.setdefault("tiktokRestorerState", {})
    edge = float("nan")
    try:
        edge = math.hypot(float(landmarks[1][0]) - float(landmarks[0][0]),
                          float(landmarks[1][1]) - float(landmarks[0][1])) / 0.33
    except (TypeError, ValueError, IndexError, OverflowError):
        pass
    valid = math.isfinite(edge) and edge > 0
    threshold = 448 if state.get("model") == "GPEN1024" else 512
    selected = "GPEN512" if valid and edge < threshold else "GPEN1024"
    if state.get("model") and state["model"] != selected:
        state["switches"] = state.get("switches", 0) + 1
    state["model"] = selected
    state["sourceFaceCropPixels"] = round(edge, 1) if valid else None
    state[selected + "Frames"] = state.get(selected + "Frames", 0) + 1
    return selected
