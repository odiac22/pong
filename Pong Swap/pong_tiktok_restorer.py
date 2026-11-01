"""Session-local restoration profiles; never change the saved Pong preset."""
from copy import deepcopy
import math
from pong_restorer_profiles import physical_restorer,restorer_for_mode

PROFILE = "tiktok-face-size"
MOTION_TRIAL_PROFILE = "tiktok-face-size-motion-trial"
PLAYBACK_PROFILE = "tiktok-playback"
FIXED_512_PROFILE = "tiktok-gpen512"
FIXED_GFPGAN12_PROFILE = "tiktok-gfpgan12"
FIXED_GFPGAN12_THREE_X_PROFILE = "tiktok-3x-gfpgan12"
ADAPTIVE_512_PROFILE = "swap-3x-512-adaptive-256"
TIKTOK_THREE_X_PROFILE = "tiktok-3x-gpen1024"
ADAPT_PROFILE = "tiktok-adapt"
ADAPT_THREE_X_PROFILE = "tiktok-3x-adapt"
ADAPT_PROFILES = (ADAPT_PROFILE, ADAPT_THREE_X_PROFILE)
THREE_X_PROFILES = (ADAPT_THREE_X_PROFILE, ADAPTIVE_512_PROFILE, TIKTOK_THREE_X_PROFILE, FIXED_GFPGAN12_THREE_X_PROFILE)
SELECTED_TIKTOK_PROFILES = (PLAYBACK_PROFILE, TIKTOK_THREE_X_PROFILE, *ADAPT_PROFILES)
ADAPT_RESTORER_STEP = {'GPEN1024': 'GPEN512', 'GPEN512': 'GPEN256'}
# Responsive 3X Adapt restorer ladder (highest quality first). GPEN357 is the 3X
# alias of the 256 weights. The ceiling/floor can be narrowed per preset through
# runtime.adaptRestorerCeiling / runtime.adaptRestorerFloor.
ADAPT_RESTORER_LADDER = ('GPEN1024', 'GPEN512', 'GPEN357')


def adapt_restorer_ladder(runtime):
    """Ladder rungs active for a responsive 3X Adapt session, highest quality first."""
    order = list(ADAPT_RESTORER_LADDER)
    ceiling = runtime.get('adaptRestorerCeiling', 'GPEN1024')
    floor = runtime.get('adaptRestorerFloor', 'GPEN357')
    top = order.index(ceiling) if ceiling in order else 0
    bottom = order.index(floor) if floor in order else len(order) - 1
    if top > bottom:
        top, bottom = bottom, top
    return tuple(order[top:bottom + 1])


def temporal_transport_enabled(runtime, parameters):
    """Allow guarded full-face transport for every supported Adapt model.

    Restoration's internal caches keep their own model-specific guards. Fresh
    GFPGAN anchors still run GFPGAN; this only admits motion-checked transport
    between anchors when the session explicitly enables adaptive restoration.
    """
    if runtime.get('frameReuseCadence') in (3, 4):
        return True
    return bool(runtime.get('adaptiveRestorer', False)
                and parameters.get('RestorerSwitch', False)
                and physical_restorer(parameters.get('RestorerTypeTextSel')) in
                {'GPEN256', 'GPEN512', 'GPEN1024', 'GFPGAN1.2'})


def session_config_for_profile(config, profile="default"):
    if profile not in ("default", PROFILE, MOTION_TRIAL_PROFILE, PLAYBACK_PROFILE, FIXED_512_PROFILE, FIXED_GFPGAN12_PROFILE, ADAPT_PROFILE, *THREE_X_PROFILES):
        raise ValueError("Unsupported restoration profile")
    result = deepcopy(config)
    # Recover the saved selection when cloning a3X session, then apply the
    # new session's override. Never persist the automatic357 into the preset.
    original_restorer=result.setdefault('runtime',{}).pop('threeXOriginalRestorer',None)
    if original_restorer is not None:result['parameters']['RestorerTypeTextSel']=original_restorer
    if profile in THREE_X_PROFILES:
        result['runtime']['threeXOriginalRestorer']=result['parameters'].get('RestorerTypeTextSel')
    result['parameters']['RestorerTypeTextSel']=restorer_for_mode(
        result['parameters'].get('RestorerTypeTextSel'),profile in THREE_X_PROFILES)
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
    result["runtime"].pop("threeXForce256", None)
    result["runtime"].pop("crowdRestorerModel", None)
    if profile in (PROFILE, MOTION_TRIAL_PROFILE):
        result["runtime"]["tiktokRestorerProfile"] = PROFILE
        result["runtime"]["tiktokRestorerState"] = {}
    elif profile in (FIXED_512_PROFILE, *THREE_X_PROFILES):
        # Explicitly requested quality option. Keep an independent
        # warm signature and cache identity; never alter the saved parameters,
        # resolution, encoder, masks, detection or temporal inference cadence.
        result["runtime"]["tiktokRestorerProfile"] = profile
        result["runtime"]["tiktokRestorerState"] = {}
    if profile in (PLAYBACK_PROFILE, ADAPT_PROFILE):
        # Legacy profile names are transport/topology identifiers. Honor the
        # configured restorer, strength, cadence, output resolution and masks.
        result['runtime']['tiktokRestorerProfile'] = profile
        result['runtime']['tiktokRestorerState'] = {}
    if profile == MOTION_TRIAL_PROFILE:
        runtime = result["runtime"]
        # Keep output FPS, swap model, masks, encoder CQ and resolution.
        # Only the explicit motion trial uses the size-based reuse policy.
        # Between exact anchors, transport the previous face correction
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
    if profile in (FIXED_GFPGAN12_PROFILE, FIXED_GFPGAN12_THREE_X_PROFILE):
        result['parameters']['RestorerTypeTextSel'] = 'GFPGAN1.2'
    if result.get('parameters', {}).get('RestorerTypeTextSel') == 'GFPGAN1.2' and profile not in ADAPT_PROFILES:
        # The explicit GFPGAN selection takes precedence over the older
        # TikTok-only GPEN policy. Every frame receives fresh inference.
        runtime = result['runtime']
        if profile != 'default':
            # A restorer choice must not turn simultaneous people into the
            # single-target selector. Preserve the requested rendering topology.
            runtime['tiktokRestorerProfile'] = (FIXED_GFPGAN12_THREE_X_PROFILE
                if profile in THREE_X_PROFILES else FIXED_GFPGAN12_PROFILE)
            runtime['tiktokRestorerState'] = {}
        runtime.update(adaptiveRestorer=False, temporalForegroundReuseEnabled=False,
            temporalExactOutputStabilizationEnabled=False,
            temporalExactMouthStabilizationEnabled=False,
            temporalExactLandmarkLockEnabled=False,
            temporalRestorerCorrectionStabilizationEnabled=False)
    if profile in SELECTED_TIKTOK_PROFILES:
        # Adapt restores the earlier bounded reuse cadence, while retaining
        # today's detector/LK fusion, shape continuity, identity and masks.
        # Output cadence stays fixed. Multi-person Adapt may temporarily use
        # one smaller GPEN model under measured pressure; the preset stays intact.
        adapt = profile in ADAPT_PROFILES
        changes = dict(adaptiveRestorer=adapt, temporalForegroundReuseEnabled=adapt)
        if adapt:
            changes.update(temporalForegroundReuseHighLoadOnly=False,
                temporalFullAnchorHz=3.0, temporalRestorerAnchorHz=2.0,
                temporalRestorerCorrectionStabilizationEnabled=True)
        original = result['runtime'].setdefault('tiktokMotionTrialOriginal', {})
        for key, value in changes.items():
            original.setdefault(key, (key in result['runtime'], deepcopy(result['runtime'].get(key))))
            result['runtime'][key] = value
    result['parameters']['RestorerTypeTextSel']=restorer_for_mode(
        result['parameters'].get('RestorerTypeTextSel'),profile in THREE_X_PROFILES)
    return result


def apply_frame_reuse_cadence(config, cadence, *, adapt=False):
    """Explicit client choice is session-local and cannot enable Adapt."""
    if cadence is None:
        return config
    if type(cadence) is not int or cadence not in (1, 3, 4):
        raise ValueError('Frame reuse cadence must be 1, 3 or 4')
    runtime = config.setdefault('runtime', {})
    changes = dict(frameReuseCadence=cadence, adaptiveRestorer=bool(adapt),
        temporalForegroundReuseEnabled=cadence in (3, 4),
        temporalForegroundReuseHighLoadOnly=False,
        temporalFullAdaptiveGraceEnabled=False)
    if cadence in (3, 4):
        changes.update(temporalFullAnchorHz=30./cadence, temporalRestorerAnchorHz=1000.,
            temporalFullDenseFlowResidual=False, temporalFullSparseMeshResidual=False,
            temporalSemanticFeaturePatchesEnabled=False, exactCpuResidualOverlap=False)
    original = runtime.setdefault('tiktokMotionTrialOriginal', {})
    for key, value in changes.items():
        original.setdefault(key, (key in runtime, deepcopy(runtime.get(key))))
        runtime[key] = value
    return config


def _logical_restorer_models(config):
    if not config["parameters"].get("RestorerSwitch"):
        return ()
    if (config.get('runtime', {}).get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE
            and config['parameters'].get('RestorerTypeTextSel') in ('GPEN1024', 'GPEN512', 'GPEN256', 'GPEN257', 'GPEN357')):
        # Every ladder rung must be resident so the dynamic controller can switch
        # per frame without compiling or loading on the playback worker.
        return (config['parameters']['RestorerTypeTextSel'], *adapt_restorer_ladder(config.get('runtime', {})))
    if config['parameters'].get('RestorerTypeTextSel') in ('GPEN257','GPEN357','GFPGAN1.2'):
        return (config['parameters']['RestorerTypeTextSel'],)
    if config.get('runtime', {}).get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE:
        selected = config['parameters'].get('RestorerTypeTextSel')
        fallback = ADAPT_RESTORER_STEP.get(selected)
        return (selected, fallback) if fallback else (selected,)
    if config.get("runtime", {}).get("tiktokRestorerProfile") in SELECTED_TIKTOK_PROFILES:
        return (config["parameters"].get("RestorerTypeTextSel"),)
    if config.get("runtime", {}).get("tiktokRestorerProfile") == ADAPTIVE_512_PROFILE:
        return ("GPEN512", "GPEN256")
    if config.get("runtime", {}).get("tiktokRestorerProfile") == FIXED_512_PROFILE:
        return ("GPEN512",)
    if config.get("runtime", {}).get("tiktokRestorerProfile") == PROFILE:
        return ("GPEN512", "GPEN1024")
    return (config["parameters"].get("RestorerTypeTextSel"),)

def restorer_models(config):
    return tuple(dict.fromkeys(physical_restorer(name) for name in _logical_restorer_models(config)))


def select_restorer(config, landmarks):
    """Estimate source-pixel aligned crop from eye spacing, not viewport size.

    Canonical GPEN eye spacing is about 33% of its aligned crop. Promote at
    512px; demote below 448px to avoid switching repeatedly near the boundary.
    Invalid geometry keeps the higher-quality model, never guesses smaller.
    """
    runtime = config.get("runtime", {})
    configured = config['parameters'].get('RestorerTypeTextSel')
    if (runtime.get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE
            and runtime.get('crowdRestorerModel') in ADAPT_RESTORER_LADDER
            and configured in ('GPEN1024', 'GPEN512', 'GPEN256', 'GPEN257', 'GPEN357')):
        # Dynamic restorer ladder chosen by the 3X controller for this frame.
        selected = runtime['crowdRestorerModel']
        state = runtime.setdefault('tiktokRestorerState', {})
        if state.get('model') and state['model'] != selected:
            state['switches'] = state.get('switches', 0) + 1
        state.update(model=selected, configuredModel=configured, physicalModel=physical_restorer(selected),
                     policy=runtime['tiktokRestorerProfile'], modelPolicy='adapt-restorer-ladder')
        state[str(selected) + 'Frames'] = state.get(str(selected) + 'Frames', 0) + 1
        return selected
    if configured in ('GPEN257','GPEN357'):
        selected=configured
        state=runtime.setdefault('tiktokRestorerState',{})
        state.update(model=selected,physicalModel='GPEN256',modelPolicy='approved-face-finish')
        state[selected+'Frames']=state.get(selected+'Frames',0)+1
        return selected
    if config['parameters'].get('RestorerTypeTextSel') == 'GFPGAN1.2':
        state = runtime.setdefault('tiktokRestorerState', {})
        state['model'] = 'GFPGAN1.2'
        state['GFPGAN1.2Frames'] = state.get('GFPGAN1.2Frames', 0) + 1
        return 'GFPGAN1.2'
    if runtime.get("tiktokRestorerProfile") in SELECTED_TIKTOK_PROFILES:
        selected = config["parameters"].get("RestorerTypeTextSel")
        configured = selected
        if (runtime.get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE
                and runtime.get('crowdRestorerModel') == ADAPT_RESTORER_STEP.get(selected)
                and runtime.get('crowdRestorerModel')):
            selected = runtime['crowdRestorerModel']
        state = runtime.setdefault("tiktokRestorerState", {})
        if state.get('model') and state['model'] != selected:
            state['switches'] = state.get('switches', 0) + 1
        state["model"] = selected
        state['configuredModel'] = configured
        state["policy"] = runtime["tiktokRestorerProfile"]
        state["modelPolicy"] = 'adapt-crowd-one-step' if selected != configured else "configured-restorer"
        state[str(selected) + "Frames"] = state.get(str(selected) + "Frames", 0) + 1
        return selected
    if runtime.get("tiktokRestorerProfile") == FIXED_512_PROFILE:
        state = runtime.setdefault("tiktokRestorerState", {})
        state["model"] = "GPEN512"
        state["policy"] = runtime["tiktokRestorerProfile"]
        state["GPEN512Frames"] = state.get("GPEN512Frames", 0) + 1
        return "GPEN512"
    if runtime.get("tiktokRestorerProfile") not in (PROFILE, ADAPTIVE_512_PROFILE):
        return config["parameters"].get("RestorerTypeTextSel")
    state = runtime.setdefault("tiktokRestorerState", {})
    edge = float("nan")
    try:
        edge = math.hypot(float(landmarks[1][0]) - float(landmarks[0][0]),
                          float(landmarks[1][1]) - float(landmarks[0][1])) / 0.33
    except (TypeError, ValueError, IndexError, OverflowError):
        pass
    valid = math.isfinite(edge) and edge > 0
    if runtime.get("tiktokRestorerProfile") == ADAPTIVE_512_PROFILE:
        # Keep 512 for full-size faces and uncertain geometry. Small source
        # crops use 256; hysteresis avoids flickering near the size boundary.
        threshold = 224 if state.get("model") == "GPEN512" else 256
        selected = "GPEN256" if runtime.get("threeXForce256") or (valid and edge < threshold) else "GPEN512"
    else:
        threshold = 448 if state.get("model") == "GPEN1024" else 512
        selected = "GPEN512" if valid and edge < threshold else "GPEN1024"
    if state.get("model") and state["model"] != selected:
        state["switches"] = state.get("switches", 0) + 1
    state["model"] = selected
    state["sourceFaceCropPixels"] = round(edge, 1) if valid else None
    state[selected + "Frames"] = state.get(selected + "Frames", 0) + 1
    return selected
