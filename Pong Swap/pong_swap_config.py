from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
ROPE_ROOT = ROOT / "engine" / "Rope"
MODELS_DIR = ROOT / "runtime" / "models"
FACES_DIR = ROOT / "approved-faces"
PRESETS_DIR = ROOT / "presets"
CURRENT_PRESET = PRESETS_DIR / "current.json"
PRESET_HISTORY_DIR = PRESETS_DIR / "history"
CACHE_DIR = ROOT / "cache"
LOG_DIR = ROOT / "logs"


RUNTIME_DEFAULTS: dict[str, Any] = {
    # Same GPU models and kernels; omit redundant ORT host fences only when
    # every bound buffer/provider is verified on Pong's owned CUDA stream.
    "orderedGpuSubmission": True,
    "identityClassifierBackend": "cpu",
    "temporalRestorerDetectorRecoveryEnabled": False,
    "temporalMaskDetectorRecoveryEnabled": False,
    # Uniform source-frame selection under a measured full-quality FPS budget.
    # Zero preserves every source frame; no resolution/model/encoder downgrade.
    "qualityPreservingMaxFps": 0.0,
    "colorMatchCudaGraph": False,
    "temporalRestorerLocalRefreshEnabled": False,
    "backend": "cuda",
    # Independent of detector/swapper selection. Legacy preserves the existing
    # GPEN256 TRT-first / GPEN512 CUDA provider policy.
    "restorerBackendPreference": "legacy",
    # Native TensorRT only: match ORT CUDA's production FP32 policy by allowing
    # TF32 kernels. This stays off unless native-trt is explicitly selected.
    "restorerNativeTrtTf32": False,
    # Benchmark-only immutable native plan override. Production presets leave
    # this empty; a non-empty path must have a matching signed-by-hash manifest
    # and initialization fails instead of rebuilding or falling back.
    "restorerNativeTrtQualifiedPlan": "",
    "restorerNativeTrtQualifiedPlan1024": "",
    # Experimental exact-tail GPEN512 plan.  The artifact contains the native
    # TensorRT prefix only; the numerically qualified final toRGB projection is
    # executed on the same CUDA stream.  Empty preserves production behavior.
    "restorerNativeTrtSplitPlan": "",
    # Experimental content-independent calibration for a specific qualified
    # native GPEN plan. The checkpoint is validated against both the GPEN ONNX
    # and TensorRT plan hashes before its fixed residual is admitted. Empty is
    # the production/default behavior.
    "restorerNativeStaticResidualPath": "",
    "restorerCudaDirectIo": False,
    "restorerCudaGraph": False,
    # Opt-in compositor contract experiment.  The legacy fused GPEN return
    # warp predates torchvision's half-pixel resize convention.  Keep the
    # production image unchanged until the silent temporal gate qualifies the
    # analytically composed pixel-center map.
    "restorerPixelCenterReturnMap": False,
    # Opt-in reconstruction experiment.  Preserve the production return-map
    # coordinates, but reconstruct GPEN512 with a donor-range-bounded cubic
    # sampler.  Geometry is cached per CUDA stream and exact return matrix.
    # Disabled until the frozen silent temporal corpus proves both quality and
    # throughput non-regression.
    "restorerBoundedCubicReturnSampler": False,
    # Experimental interpolation amount.  One is the existing bounded-cubic
    # return; zero is byte-equivalent to the legacy bilinear return.
    "restorerBoundedCubicWeight": 1.0,
    # Experimental shape-preserving reconstruction.  It limits Hermite
    # slopes before interpolation, averages both separable axis orders, and
    # retains the legacy bilinear arithmetic at incomplete 4x4 footprints.
    # Keep disabled until the frozen temporal corpus proves strict quality
    # and throughput non-regression.
    "restorerMonotoneHermiteReturnSampler": False,
    # Experimental anti-aliased GPEN input contract.  Rope historically lets
    # torchvision affine use its NEAREST default before the 512px resize.
    # Bilinear removes subpixel staircase changes without altering landmarks.
    "restorerBilinearInputAlignment": False,
    # Experimental one-pass GPEN512 input warp.  It composes alignment and
    # resize in floating point, avoiding the legacy intermediate uint8 affine
    # and second interpolation pass.
    "restorerFusedInputAlignment": False,
    # Experimental correction-only return.  Reconstruct GPEN(output) and the
    # matching GPEN(input) through one sampling grid, then add only their
    # difference to the untouched current crop.  Zero neural correction is
    # therefore an exact identity operation.  Disabled pending the frozen
    # quality/speed gate.
    "restorerResidualReturn": False,
    "restorerResidualReturnWeight": 1.0,
    "restorerResidualReturnMinimumFaceSize": 0,
    "restorerResidualParserUsesLegacyAppearance": False,
    "restorerLowFrequencyAnchorStabilization": False,
    "restorerLowFrequencyAnchorStrength": 0.15,
    "restorerLowFrequencyAnchorKernel": 15,
    "restorerLowFrequencyAnchorMaxCorrection": 3.0,
    # Experimental exact/reuse quantization parity.  The legacy exact paste-
    # back truncates positive float pixels while reuse transports integer
    # residuals.  Explicit round-to-nearest is gated until the silent corpus
    # proves improved handoff stability without any quality regression.
    "exactPastebackRoundToNearest": False,
    "exactPastebackFloat64Composite": False,
    # Experimental temporal-reuse sampler. OpenCV INTER_LINEAR quantizes its
    # fractional interpolation phase; this keeps the same four-sample support,
    # transform, zero border and integer output while evaluating the bilinear
    # weights continuously. It remains off until the frozen video gate proves
    # temporal-quality improvement without a throughput regression.
    "temporalContinuousResidualWarp": False,
    # Experimental canonical-output precision. Zero preserves the current
    # floating GPEN output. A positive value is the number of fractional
    # levels per 8-bit pixel and is used only by isolated quality benchmarks.
    "restorerOutputFractionalLevels": 0,
    # Experimental parser-only evidence canonicalization. Zero preserves the
    # current input. Positive pixel steps affect only the semantic parser's
    # evidence tensor; rendered GPEN pixels and occluder input stay untouched.
    "faceParserEvidenceQuantizationStep": 0.0,
    # Diagnostic only: retain the selected restorer for visible RGB while
    # deriving the semantic face-parser mask from the reference GPEN path.
    # Disabled in production and excluded from persisted user baselines.
    "referenceParserMaskDiagnostic": False,
    # Experimental native-TRT hybrid. Empty preserves one backend. Benchmark
    # profiles may name exact-anchor reasons that must use the frozen ORT CUDA
    # reference while all other GPEN refreshes retain native TensorRT speed.
    "restorerHybridReferenceReasons": [],
    "restorerHybridReferenceCadenceByReason": {},
    "restorerHybridReferencePhaseByReason": {},
    # Optional benchmark-only severity floor for a configured hybrid reason.
    # Empty preserves the exact historical selection behavior.
    "restorerHybridReferenceMinimumInputMaeByReason": {},
    # One is the historical full reference result. Benchmark profiles may
    # cross-fade an explicitly selected reference anchor to avoid a backend
    # handoff pop while retaining the fast backend's detail.
    "restorerHybridReferenceBlendWeight": 1.0,
    "restorerHybridReferenceBlendWeightByReason": {},
    # Optional content-based hybrid gate.  When explicitly enabled through
    # restorerHybridReferenceReasons, a strong local change in this normalized
    # lower-centre region uses the reference backend for that exact anchor.
    # Empty reasons above keep the production renderer unchanged.
    "restorerHybridLowerCenterMinX": 0.45,
    "restorerHybridLowerCenterMaxX": 0.70,
    "restorerHybridLowerCenterMinY": 0.70,
    # Experimental spatially selective exact-anchor stabilization.  It blends
    # only the restoration correction in unchanged canonical regions; pixels
    # whose aligned source appearance changed keep the current exact result.
    "temporalRestorerSpatialBlendEnabled": False,
    "temporalRestorerSpatialBlendTriggerReasons": [],
    "temporalRestorerSpatialBlendRequiresHybridReference": False,
    "temporalRestorerSpatialBlendTriggerMaxGapFrames": 0,
    "temporalRestorerSpatialBlendTriggerMinimumEvents": 2,
    "temporalRestorerSpatialBlendTriggerMinimumPatchToMeanRatio": 0.0,
    # Once two qualifying reference events occur close together, retain the
    # event-density decision for this many frames.  A zero value preserves the
    # original stateless trigger.  This remains opt-in until the strict corpus
    # proves that it improves both temporal quality and throughput.
    "temporalRestorerSpatialBlendBurstHoldFrames": 0,
    "temporalRestorerSpatialBlendCurrentWeight": 0.75,
    "temporalRestorerSpatialBlendChangeLow": 1.0,
    "temporalRestorerSpatialBlendChangeHigh": 8.0,
    "temporalRestorerSpatialBlendEdgeGuardFraction": 0.0,
    # Lossless execution-only optimization.  The immutable affine sampling
    # grid is reused only for an exact matrix/dimension/device/stream match.
    "restorerReturnGeometryCache": False,
    # Experimental execution-only optimization for the fixed-shape occluder
    # and face-parser graphs. Disabled until the silent corpus proves parity
    # and a repeatable throughput gain.
    "maskCudaGraph": False,
    "maskBackendPreference": "cuda",
    # Diagnostic/experimental family overrides. ``inherit`` preserves the
    # single-backend production contract.
    "maskOccluderBackendPreference": "inherit",
    "maskFaceParserBackendPreference": "inherit",
    # Experimental quality/speed co-optimization.  The renderer starts on the
    # exact CUDA-graph mask path, observes only geometry already produced by
    # the temporal tracker, then locks one backend for the remainder of that
    # tracking generation.  It never changes the user's mask controls.
    "maskAdaptiveBackendEnabled": False,
    "maskAdaptiveResidualThreshold": 0.008,
    "maskAdaptiveMinimumSamples": 3,
    "maskAdaptivePreflightEnabled": False,
    "maskAdaptivePreflightFrames": 5,
    "maskAdaptiveFlowP90Threshold": 0.80,
    # Experimental exact-anchor stabilization for the semantic parser mask.
    # This does not alter the occluder, so newly visible foreground objects
    # remain protected by a current-frame mask.
    "maskExactParserBlendEnabled": False,
    "maskExactParserBlendCurrentWeight": 0.80,
    "maskExactParserBlendHalfLifeSeconds": 0.020,
    # Compensate only the tiny detail loss measured on the qualified TRT mask
    # path.  Zero preserves the user's existing Detail Transfer semantics.
    "maskTrtDetailGainCompensation": 0.0,
    "maskTrtPostSharpenAmount": 0.0,
    # Experimental one-LSB edge correction for the fast TRT mask lane.  Zero
    # is an exact no-op; a positive value is the minimum local high-pass
    # magnitude required before a central face pixel is moved by one level.
    "maskTrtSparseEdgeBoostThreshold": 0.0,
    # Swap Pipeline 2 is independently reversible from the user's visual
    # preset. It changes scheduling/transport only; face acceptance and face
    # image settings remain untouched.
    "pipeline2Enabled": True,
    "adaptivePrefetchEnabled": True,
    # A first decodable fMP4 fragment is deliberately shorter than the total
    # safety lead. This removes a muxer/GOP wait from first tap and seeking
    # without reducing the amount of media prepared before a swipe.
    "foregroundFragmentSeconds": 0.50,
    "prefetchFragmentSeconds": 0.75,
    "seekFragmentSeconds": 0.50,
    # Capability flag only. The user asked to keep dynamic model/resolution
    # switching disabled until a later, explicit quality decision.
    "dynamicQualityEnabled": False,
    "startupDeadlineMs": 8000,
    "leadBufferSeconds": 3.0,
    # Keep speculative inference off CUDA while the visible growing stream is
    # within four seconds of its live edge. Android's growing-fMP4 decoder needs
    # roughly two seconds beyond its current frame to stay in HAVE_FUTURE_DATA;
    # the larger server floor also covers transport/demux lag without changing
    # a transformed frame or its encoding quality.
    "minimumHeadroom": 2.0,
    # Android System WebView can classify a still-growing low-entropy fMP4 as
    # an unsupported format when its first response contains only the init
    # segment plus roughly three seconds / 30 KiB of tiny passthrough frames.
    # A measured 32 KiB decoded successfully; retain a small 48 KiB margin and
    # release it as one initial response chunk. This is transport buffering
    # only and does not change encoder quality or face-swap inference.
    "browserStartupBytes": 48 * 1024,
    # Require real media time as well as sniffing bytes. The minimum fragment
    # padding below keeps tiny CQ streams flowing but must never let padding
    # alone expose a response before Android has a useful decoded lead.
    "browserStartupMediaSeconds": 0.5,
    # This is ISO-BMFF transport padding outside every video sample. It gives
    # Android/WebView regular socket progress for exceptionally compressible
    # scenes without changing GPEN, masks, resolution, CQ, timestamps, or pixels.
    "transportMinimumFragmentBytes": 2048,
    # Group the same bounded padding into three top-level boxes per second at
    # 24 fps. This wakes WebView's socket reader without asking its MP4 parser to
    # process an otherwise-empty box for every individual video sample.
    "transportPaddingIntervalFragments": 8,
    # Speculative swap sessions are optional. Keep enough device memory for a
    # foreground swipe and the selected production graph instead of letting a
    # preview/prefetch allocation turn into a visible CUDA OOM.
    "prefetchMinFreeMiB": 1536,
    "previewModelLruLimit": 0,
    "encoderPreset": "p1",
    "encoderCq": 23,
    "swapAudioEnabled": False,
    "frameEnhancerEnabled": False,
    "frameEnhancerType": "RealEsrgan-x2-Plus",
    "frameEnhancerBlend": 100,
    "frameEnhancerDownscale": False,
    "frameEnhancerScope": "full",
    "frameEnhancerTileSize": 512,
    "maximumFaces": 1,
    "targetDetectIntervalFrames": 1,
    "identityCheckIntervalFrames": 12,
    # When positive, source FPS is converted into a per-session frame cadence.
    # This keeps detector and identity verification frequency stable in wall
    # time instead of making a 60 fps clip update half as often as a 30 fps one.
    "targetDetectHz": 0.0,
    "identityCheckHz": 0.0,
    "temporalFaceParserHz": 0.0,
    # Keep the conservative full-inference path unless a preset explicitly
    # opts into temporal reuse for speculative (never visible yet) frames.
    # The engine currently supports 1 (off) and 2 (alternate-frame inference).
    "prefetchInferenceStride": 1,
    "idleUnloadSeconds": 900,
    "fallback": "original",
    "adaptiveRestorer": True,
    # Quality-gated temporal acceleration. Exact GPEN/mask anchors retain the
    # selected production model and settings; intervening aligned frames reuse
    # only validated session-owned state. Full-frame residual reuse is allowed
    # only while strict LK tracking remains valid and always falls back to a
    # fresh swap when uncertain.
    "temporalForegroundReuseEnabled": True,
    # Optional load gate for full-frame residual transport. When enabled, a
    # phone-sized or <=25 fps source keeps fresh InSwapper inference on every
    # frame; only high-resolution/high-frame-rate sources use blended
    # intermediate frames to preserve playback speed.
    "temporalForegroundReuseHighLoadOnly": False,
    "temporalForegroundReuseMinimumPixels": 700000,
    "temporalForegroundReuseMinimumFps": 27.0,
    # Optional workload gate. Pixel-rate captures both resolution and FPS, so
    # a high-resolution 24 fps clip and a smaller 60 fps clip are treated by
    # their actual decoding/rendering load rather than one fixed FPS cutoff.
    "temporalForegroundReuseMinimumPixelRate": 0.0,
    "exactCpuResidualOverlap": False,
    # The 24-clip strict stock gate measured the denser schedule at 20/20
    # distinct identity-proven passes with 1.54x p10 real-time headroom while
    # improving worst-case SSIM/MAE versus 4.0/2.5 Hz.
    "temporalFullAnchorHz": 3.0,
    "temporalDetectorLkFusionEnabled": False,
    "temporalDetectorLkFusionWeight": 0.5,
    "temporalDetectorLkFusionMaxResidualRatio": 0.02,
    # Detector frames provide absolute position while LK carries the local
    # feature shape continuously from the preceding frame. This experimental
    # handoff first aligns the LK constellation to the detector's global pose,
    # then admits only a bounded amount of detector-local deformation. It is
    # distinct from point-wise detector/LK blending, which can move global pose
    # and local expression at the same time.
    "temporalDetectorShapeContinuityEnabled": False,
    "temporalDetectorShapeContinuityWeight": 0.20,
    "temporalDetectorShapeContinuityMaxResidualRatio": 0.05,
    # Canonical-space EMA for the generated identity correction. The current
    # aligned source is always the base image; only the swapper's residual is
    # stabilized, and a per-pixel source-change gate immediately restores full
    # current-frame authority around expression, pose, and occlusion changes.
    "temporalIdentityResidualStabilizationEnabled": False,
    "temporalIdentityResidualHighMotionOnly": False,
    "temporalIdentityResidualCurrentWeight": 0.70,
    # Wall-clock smoothing makes the same identity-detail filter behave alike
    # at 24, 25, 30, 50, and 60 fps. A non-positive value retains the legacy
    # fixed per-frame weight.
    "temporalIdentityResidualHalfLifeSeconds": 0.020,
    "temporalIdentityResidualChangeLow": 2.0,
    "temporalIdentityResidualChangeHigh": 14.0,
    "temporalIdentityResidualMaxInputMae": 20.0,
    "temporalIdentityResidualMaxInputPatchMae": 48.0,
    "temporalDisableLkSmoothing": False,
    "temporalFullFeaturePatchLockEnabled": False,
    "temporalFullFeaturePatchLockStrength": 0.65,
    "temporalFullFeaturePatchMaxMae": 16.0,
    "temporalFullFeaturePatchMaxP90": 34.0,
    # Experimental temporal-geometry contract.  Exact frames align the face
    # to Rope's canonical template, while the historical reuse path fitted a
    # separate previous->current LMEDS transform.  Compose the two canonical
    # transforms instead so exact and reused frames share one coordinate
    # system.  Remains disabled until the frozen silent corpus passes every
    # quality metric and the per-clip speed floor.
    "temporalCanonicalResidualTransport": False,
    "temporalCanonicalResidualLowMotionOnly": False,
    "temporalCanonicalResidualBlendWeight": 1.0,
    # Experimental yaw-aware transport. A five-point similarity transform is
    # intentionally the conservative default, but it cannot represent the
    # bounded anisotropic foreshortening visible during head turns. When this
    # path is enabled the engine evaluates an all-landmark affine fit and uses
    # it only when it materially improves both RMS and worst-point alignment,
    # remains orientation preserving, and stays inside a tight anisotropy
    # envelope. The swapper, restorer, masks, and exact-anchor cadence are
    # unchanged; an unsafe candidate falls back to the established similarity
    # path for that frame.
    "temporalPoseAwareAffineResidual": False,
    "temporalPoseAwareAffineMaxAnisotropy": 1.12,
    "temporalPoseAwareAffineMinImprovement": 0.12,
    "temporalPoseAwareAffineMinResidualRatio": 0.008,
    "temporalExactOutputStabilizationEnabled": False,
    "temporalExactOutputCurrentWeight": 0.85,
    "temporalExactOutputDenseFlowEnabled": False,
    "temporalExactOutputHalfLifeSeconds": 0.020,
    "temporalExactOutputLocalChangeLow": 3.0,
    "temporalExactOutputLocalChangeHigh": 18.0,
    "temporalExactOutputMotionLowPerSecond": 0.20,
    "temporalExactOutputMotionHighPerSecond": 1.50,
    "temporalExactOutputPoseAwareAffine": True,
    # Cheap exact-anchor stabilization restricted to the mouth/lower-lip
    # island. It transports only the prior generated residual, never the prior
    # source pixels, and yields immediately when the current mouth appearance
    # suggests speech, an expression change, or a new occluder.
    "temporalExactMouthStabilizationEnabled": False,
    "temporalExactMouthCurrentWeight": 0.80,
    "temporalExactMouthMaxMae": 10.0,
    "temporalExactMouthMaxP90": 24.0,
    "temporalExactLandmarkLockEnabled": False,
    "temporalExactLandmarkLockStrength": 0.5,
    # Experimental semantic mesh. Disabled unless a benchmark candidate proves
    # both the frozen quality and speed gates; the production baseline remains
    # byte-for-byte on the established five-point path meanwhile.
    "temporalSemanticMeshEnabled": False,
    "temporalSemanticHighMotionOnly": False,
    "temporalSemanticFeaturePatchesEnabled": False,
    "temporalSemanticFeatureGroups": ["leftEye", "rightEye"],
    "temporalSemanticLandmarkRefreshHz": 1.0,
    "temporalSemanticMinimumScore": 0.75,
    "temporalRestorerAnchorHz": 3.0,
    # Experimental exact-anchor stabilizer. Only a scheduled, appearance-
    # compatible GPEN refresh may blend canonical corrections; cuts, identity
    # checks and disagreement retain the untouched exact result.
    "temporalRestorerExactBlendEnabled": False,
    "temporalRestorerExactBlendCurrentWeight": 0.75,
    "temporalRestorerMaxInputMae": 18.0,
    "temporalRestorerMaxInputPatchMae": 34.0,
    "temporalMaskMaxInputMae": 16.0,
    "temporalMaskAnchorHz": 0.0,
    "temporalRestorerCorrectionStabilizationEnabled": False,
    "temporalRestorerCorrectionLocalGuardEnabled": False,
    "temporalMaskMaxInputPatchMae": 30.0,
    "temporalMaskLocalChangeGuardEnabled": False,
    "temporalMaskMaxLocalPatchMae": 30.0,
    "temporalVerifiedIdentityRefreshReuseEnabled": False,
    # Optional current-geometry acceleration. These do not disable or replace
    # either user-selected mask model: they retain a canonical mask only while
    # the model input remains inside the existing mean/patch safety gates and
    # the scheduled anchor deadline has not elapsed.
    "temporalDflXSegReuseEnabled": False,
    "temporalOccluderDecoupledFromRestorer": False,
    # Full rendered-frame reuse has a stricter, source-space guard than LK.
    # Mean + p90 + patch thresholds catch expressions and thin occluders that
    # five landmarks alone cannot observe. These controls do not change model
    # output; a failed guard simply runs the unchanged exact path.
    "temporalFullMaxFaceMae": 14.0,
    "temporalFullMaxFaceP90": 32.0,
    "temporalFullMaxPatchMae": 46.0,
    # PTS is the authority for reuse age. A missing, backwards, or unusually
    # discontinuous timestamp invalidates the temporal chain for that frame.
    "temporalMaxPtsGapSeconds": 0.25,
}

# Production Pong intentionally exposes one swapper and the two GPEN quality
# profiles the user retained. Historical comparison assets remain isolated on
# disk, but a live settings update must never make them resident in the GPU
# worker.
# 2026-10-02 owner live trial: 256 (InSwapper x4), AlphaFace 256, HyperSwap 1C 256.
# A swapper change must be applied with a renderer restart (the exact
# acceleration bundle is not re-qualified for a hot model switch).
PRODUCTION_SWAPPER_OPTIONS = ("128", "256", "AlphaFace", "HyperSwap1C")
PRODUCTION_RESTORER_OPTIONS = ("GPEN256", "GPEN512", "GPEN1024")


def normalize_production_model_choices(config: dict[str, Any]) -> dict[str, Any]:
    parameters = config.setdefault("parameters", {})
    if str(parameters.get("SwapperTypeTextSel", "128")) not in PRODUCTION_SWAPPER_OPTIONS:
        parameters["SwapperTypeTextSel"] = "128"
    if str(parameters.get("RestorerTypeTextSel", "GPEN512")) not in PRODUCTION_RESTORER_OPTIONS:
        parameters["RestorerTypeTextSel"] = "GPEN512"
    return config


def validate_restorer_backend_preference(value: str) -> str:
    if value not in ("legacy", "cuda", "trt", "native-trt"):
        raise ValueError(
            "restorerBackendPreference must be legacy, cuda, trt or native-trt"
        )
    return value


def ensure_layout() -> None:
    for path in (MODELS_DIR, FACES_DIR, PRESETS_DIR, PRESET_HISTORY_DIR, CACHE_DIR, LOG_DIR):
        path.mkdir(parents=True, exist_ok=True)


def _rope_defaults() -> dict[str, Any]:
    import sys

    rope_path = str(ROPE_ROOT)
    if rope_path not in sys.path:
        sys.path.insert(0, rope_path)
    from rope.qt.parameters import default_values

    values = default_values()
    # Fast live defaults. Every value remains adjustable on the PC page.
    values.update(
        {
            "DetectTypeTextSel": "SCRDF",
            "DetectInputSizeTextSel": "320",
            "DetectScoreSlider": 45,
            "FaceLockSlider": 100,
            "ModelSessionsTextSel": "Shared",
            "ThreadsSlider": 1,
            "SwapperTypeTextSel": "128",
            "RestorerSwitch": False,
            # Default preview keeps the user's production-quality restorer
            # visible/selectable. RestorerSwitch remains independently off in
            # factory defaults until the user enables restoration.
            "RestorerTypeTextSel": "GPEN512",
            "RestorerDetTypeTextSel": "Blend",
            "RestorerSlider": 80,
            "HighFidelitySwitch": False,
            "HighFidelityModeTextSel": "Cached",
            "ColorMatchSwitch": True,
        }
    )
    return values


def default_config() -> dict[str, Any]:
    return normalize_production_model_choices({
        "version": 1,
        "runtime": dict(RUNTIME_DEFAULTS),
        "parameters": _rope_defaults(),
    })


def load_config() -> dict[str, Any]:
    ensure_layout()
    base = default_config()
    if not CURRENT_PRESET.exists():
        save_config(base)
        return base
    try:
        saved = json.loads(CURRENT_PRESET.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return base
    if isinstance(saved, dict):
        if isinstance(saved.get("runtime"), dict):
            base["runtime"].update(
                {name: value for name, value in saved["runtime"].items() if value is not None}
            )
        if isinstance(saved.get("parameters"), dict):
            base["parameters"].update(
                {name: value for name, value in saved["parameters"].items() if value is not None}
            )
    normalize_production_model_choices(base)
    validate_restorer_backend_preference(base["runtime"]["restorerBackendPreference"])
    return base


def save_config(config: dict[str, Any], *, backup: bool = False) -> dict[str, Any]:
    ensure_layout()
    normalized = default_config()
    if isinstance(config.get("runtime"), dict):
        normalized["runtime"].update(
            {name: value for name, value in config["runtime"].items() if value is not None}
        )
    if isinstance(config.get("parameters"), dict):
        normalized["parameters"].update(
            {name: value for name, value in config["parameters"].items() if value is not None}
        )
    normalize_production_model_choices(normalized)
    validate_restorer_backend_preference(normalized["runtime"]["restorerBackendPreference"])
    if backup and CURRENT_PRESET.is_file():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup_path = PRESET_HISTORY_DIR / f"{stamp}-current.json"
        shutil.copy2(CURRENT_PRESET, backup_path)
    temp = CURRENT_PRESET.with_suffix(".tmp")
    temp.write_text(json.dumps(normalized, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temp, CURRENT_PRESET)
    return normalized


def parameter_schema() -> list[dict[str, Any]]:
    import sys

    rope_path = str(ROPE_ROOT)
    if rope_path not in sys.path:
        sys.path.insert(0, rope_path)
    from rope.qt.parameters import PARAMETERS

    schema: list[dict[str, Any]] = []
    for item in PARAMETERS:
        if item.kind == "button" or item.scope == "control":
            continue
        row: dict[str, Any] = {
            "name": item.name,
            "label": item.label,
            "kind": item.kind,
            "scope": item.scope,
            "default": item.default,
            "description": item.info_text,
        }
        if item.kind == "slider":
            row.update(
                min=getattr(item, "minimum", getattr(item, "min")),
                max=getattr(item, "maximum", getattr(item, "max")),
                step=getattr(item, "increment", getattr(item, "inc")),
            )
        elif item.kind == "select":
            options = list(getattr(item, "options", getattr(item, "modes")))
            if item.name == "SwapperTypeTextSel":
                options = list(PRODUCTION_SWAPPER_OPTIONS)
            elif item.name == "RestorerTypeTextSel":
                options = list(PRODUCTION_RESTORER_OPTIONS)
                row["default"] = "GPEN512"
            row["options"] = options
        if item.name == "DetectScoreSlider":
            row.update(
                label="Face Match Strictness",
                default=45,
                description=(
                    "Identity strictness from 0-100. Higher values require closer facial "
                    "resemblance, compatible central-face appearance, and stronger matching "
                    "female/male visual-presentation evidence between the selected picture "
                    "and the person in the video."
                ),
                min=0,
                max=100,
                step=1,
            )
        schema.append(row)
        if item.name == "DetectScoreSlider":
            schema.append(
                {
                    "name": "FaceLockSlider",
                    "label": "Face Lock Strictness",
                    "kind": "slider",
                    "scope": "parameter",
                    "default": 100,
                    "description": (
                        "Controls switching among selected approved faces after a swap starts. "
                        "0 follows a better match quickly; 100 never changes the selected source face."
                    ),
                    "min": 0,
                    "max": 100,
                    "step": 1,
                }
            )
    return schema
