"""Disposable TikTok stage diagnostic using the existing frozen producer harness.

The harness is deliberately run with its standard frozen flag.  Only the
newly-created diagnostic session receives the TikTok profile and CUDA event
collection; the accelerated bundle, presets, and source bytes are untouched.
This is not a performance qualification because event collection changes
synchronization and the async readback path.
"""

import argparse
import json
import runpy
import sys
import threading
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--prewarm-color-size", type=int)
    parser.add_argument("--prewarm-color-masked", action="store_true")
    parser.add_argument("--probe-color-key", action="store_true")
    parser.add_argument("--eager-uncached-color", action="store_true")
    diagnostic_args, runner_args = parser.parse_known_args()
    if diagnostic_args.prewarm_color_size is not None:
        from experiment_color_graph_prewarm import ColorGraphSpec
        color_spec = ColorGraphSpec(diagnostic_args.prewarm_color_size,
                                   diagnostic_args.prewarm_color_masked)
    else:
        color_spec = None
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    from pong_swap_engine import PongSwapEngine

    original_init = PongSwapEngine.__init__
    original_warm = PongSwapEngine.warm
    prewarm_result = {}
    color_keys = []
    adaptive_state = [None]

    def diagnostic_warm(self, *args, **kwargs):
        result = original_warm(self, *args, **kwargs)
        if (color_spec is not None
                and threading.get_ident() == getattr(self, "_gpu_worker_ident", None)
                and not getattr(self, "_diagnostic_color_prewarmed", False)):
            from experiment_color_graph_prewarm import prewarm_on_owner
            prewarm_result.update(prewarm_on_owner(self, (color_spec,)))
            self._diagnostic_color_prewarmed = True
        if (diagnostic_args.eager_uncached_color
                and threading.get_ident() == getattr(self, "_gpu_worker_ident", None)
                and not getattr(self, "_diagnostic_color_adaptive", False)):
            from experiment_color_graph_adaptive import install_on_vm
            from rope import VideoManager as video_manager_module
            adaptive_state[0] = install_on_vm(
                self._vm, self._torch, video_manager_module._match_lab_color)
            self._diagnostic_color_adaptive = True
        if (diagnostic_args.probe_color_key
                and threading.get_ident() == getattr(self, "_gpu_worker_ident", None)
                and not getattr(self, "_diagnostic_color_probed", False)):
            vm = self._vm
            original_match = vm._match_color

            def observed_match(swap, target, valid_mask=None):
                if len(color_keys) < 256:
                    stream = self._torch.cuda.current_stream(swap.device)
                    key = (str(swap.device), int(stream.cuda_stream),
                           tuple(swap.shape), swap.dtype, tuple(target.shape),
                           target.dtype, None if valid_mask is None else
                           (tuple(valid_mask.shape), valid_mask.dtype))
                    color_keys.append({
                        "swapShape": tuple(swap.shape), "swapDtype": str(swap.dtype),
                        "targetShape": tuple(target.shape), "targetDtype": str(target.dtype),
                        "maskShape": None if valid_mask is None else tuple(valid_mask.shape),
                        "maskDtype": None if valid_mask is None else str(valid_mask.dtype),
                        "cacheHit": key in getattr(vm, "_color_match_graphs", {}),
                    })
                return original_match(swap, target, valid_mask)

            vm._match_color = observed_match
            self._diagnostic_color_probed = True
        return result

    def diagnostic_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        original_create_session = self.create_session

        def diagnostic_create_session(*session_args, **session_kwargs):
            if session_kwargs.get("channel") != "test":
                raise RuntimeError("Diagnostic runner expected its isolated test channel")
            session_kwargs["restoration_profile"] = "tiktok-face-size"
            session_kwargs["diagnostics_enabled"] = True
            return original_create_session(*session_args, **session_kwargs)

        self.create_session = diagnostic_create_session

    PongSwapEngine.__init__ = diagnostic_init
    if (color_spec is not None or diagnostic_args.probe_color_key
            or diagnostic_args.eager_uncached_color):
        PongSwapEngine.warm = diagnostic_warm
    try:
        sys.argv = [str(here / "run_production_performance_experiment.py"),
                    *runner_args, "--experiment", "frozen-exact",
                    "--no-frame-diagnostics"]
        runpy.run_path(sys.argv[0], run_name="__main__")
    finally:
        PongSwapEngine.__init__ = original_init
        PongSwapEngine.warm = original_warm
        if (color_spec is not None or diagnostic_args.probe_color_key
                or diagnostic_args.eager_uncached_color):
            if "--output-dir" in runner_args:
                output = Path(runner_args[runner_args.index("--output-dir") + 1])
                if output.is_dir():
                    (output / "color-prewarm.json").write_text(
                        json.dumps(prewarm_result, indent=2), encoding="utf-8")
                    (output / "color-keys.json").write_text(
                        json.dumps(color_keys, indent=2), encoding="utf-8")
                    if adaptive_state[0] is not None:
                        from experiment_color_graph_adaptive import status
                        (output / "adaptive-color.json").write_text(
                            json.dumps(status(adaptive_state[0]), indent=2),
                            encoding="utf-8")


if __name__ == "__main__":
    main()
