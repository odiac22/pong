from __future__ import annotations

import argparse
import json
from pathlib import Path

from pong_swap_config import PRESETS_DIR, load_config, save_config


def newest_import() -> Path:
    imports = PRESETS_DIR / "imports"
    candidates = sorted(
        (path for path in imports.glob("*.json") if path.name != "latest-upload.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError("No uploaded preset JSON was found")
    return candidates[0]


def import_preset(source: Path) -> dict:
    raw = json.loads(source.read_text(encoding="utf-8-sig"))
    config = load_config()
    parameters = config["parameters"]
    runtime = config["runtime"]

    parameters.update(
        {
            "DetectTypeTextSel": "Retinaface",
            "DetectInputSizeTextSel": "640",
            "DetectScoreSlider": int(raw.get("DetectorScoreSlider", 50)),
            "SwapperTypeTextSel": "128",
            "MergeTextSel": str(raw.get("EmbMergeMethodSelection", "Mean")),
            "ThreadsSlider": int(raw.get("nThreadsSlider", 7)),
            "OrientAutoSwitch": bool(raw.get("AutoRotationToggle", True)),
            "OrientSwitch": bool(raw.get("ManualRotationEnableToggle", False)),
            "OrientSlider": float(raw.get("ManualRotationAngleSlider", 0)),
            "VideoQualSlider": int(raw.get("FFQualitySlider", 18)),
            # The uploaded preset does not enable occlusion, differencing,
            # face parsing, restoration, or denoising.
            "OccluderSwitch": False,
            "DiffSwitch": False,
            "FaceParserSwitch": False,
            "RestorerSwitch": False,
        }
    )
    runtime.update(
        {
            "backend": "cuda",
            "encoderPreset": str(raw.get("FFPresetsSDRSelection", "p5")),
            "encoderCq": int(raw.get("FFQualitySlider", 18)),
            "maximumFaces": int(raw.get("MaxFacesToDetectSlider", 20)),
            "frameEnhancerEnabled": bool(raw.get("FrameEnhancerEnableToggle", False)),
            "frameEnhancerType": str(
                raw.get("FrameEnhancerTypeSelection", "RealEsrgan-x2-Plus")
            ),
            "frameEnhancerBlend": int(raw.get("FrameEnhancerBlendSlider", 100)),
            "frameEnhancerDownscale": bool(raw.get("FrameEnhancerDownToggle", False)),
            "frameEnhancerTileSize": 512,
            "recognitionModel": str(
                raw.get("RecognitionModelSelection", "Inswapper128ArcFace")
            ),
            "similarityType": str(raw.get("SimilarityTypeSelection", "Optimal")),
            "sourcePreset": source.name,
        }
    )
    saved = save_config(config)
    audit = {
        "source": str(source),
        "mappedExactly": {
            "provider": raw.get("ProvidersPrioritySelection"),
            "threads": raw.get("nThreadsSlider"),
            "recognition": raw.get("RecognitionModelSelection"),
            "similarity": raw.get("SimilarityTypeSelection"),
            "detector": raw.get("DetectorModelSelection"),
            "detectorScore": raw.get("DetectorScoreSlider"),
            "maximumFaces": raw.get("MaxFacesToDetectSlider"),
            "autoRotation": raw.get("AutoRotationToggle"),
            "frameEnhancer": raw.get("FrameEnhancerTypeSelection"),
            "frameEnhancerBlend": raw.get("FrameEnhancerBlendSlider"),
            "frameEnhancerDownscale": raw.get("FrameEnhancerDownToggle"),
            "encoderPreset": raw.get("FFPresetsSDRSelection"),
            "encoderQuality": raw.get("FFQualitySlider"),
        },
        "disabledAsRequested": {
            "denoisers": not any(
                bool(raw.get(key))
                for key in (
                    "DenoiserUNetEnableBeforeRestorersToggle",
                    "DenoiserAfterFirstRestorerToggle",
                    "DenoiserAfterRestorersToggle",
                )
            ),
            "landmarkDetector": not bool(raw.get("LandmarkDetectToggle")),
        },
        "notVisualPipelineSettings": [
            "ThemeSelection",
            "OutputMediaFolder",
            "OpenOutputToggle",
            "WebcamBackendSelection",
            "VirtCamBackendSelection",
            "AutoSaveWorkspaceToggle",
            "AutoLoadWorkspaceToggle",
        ],
        "qualityReductions": [],
        "savedConfig": saved,
    }
    audit_path = PRESETS_DIR / "visomaster-import-audit.json"
    audit_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    return audit


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", type=Path)
    args = parser.parse_args()
    audit = import_preset(args.source.resolve() if args.source else newest_import())
    print(json.dumps(audit, indent=2))


if __name__ == "__main__":
    main()
