"""Run existing silent exact profiler with optional process-local experiments."""
import argparse
import json
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import pong_swap_config
sys.path.insert(0, str(pong_swap_config.ROPE_ROOT))

parser = argparse.ArgumentParser()
parser.add_argument('--experiment', choices=('baseline', 'mask-graphs', 'model-graphs', 'identity-graph', 'geometry-cache', 'mask-overlap', 'identity-guards', 'detection-prefetch', 'confidence-kernel', 'confidence-blend', 'inference-mode', 'combined'), default='baseline')
parser.add_argument('--opencv-threads', type=int)
parser.add_argument('--ort-single-thread', action='store_true')
parser.add_argument('--pinned-frame-transfers', action='store_true')
parser.add_argument('--native-swapper', action='store_true')
parser.add_argument('--input-warp-graph', action='store_true')
parser.add_argument('--restorer-pointwise', action='store_true')
parser.add_argument('--detector-postprocess', action='store_true')
parser.add_argument('--restorer-prepare-graph', action='store_true')
parser.add_argument('--u8-grid-sample', action='store_true')
parser.add_argument('--color-lut', action='store_true')
parser.add_argument('--restorer-guard-graph', action='store_true')
parser.add_argument('--restorer-display-graph', action='store_true')
parser.add_argument('--pasteback-matrix', action='store_true')
parser.add_argument('--borrow-restorer-outputs', action='store_true')
parser.add_argument('--swap-prefix-graph', action='store_true')
parser.add_argument('--mask-tail-graph', action='store_true')
parser.add_argument('--native-detection', action='store_true')
parser.add_argument('--confidence-twopass', action='store_true')
parser.add_argument('--lab-inverse', action='store_true')
parser.add_argument('--lab-transfer', action='store_true')
parser.add_argument('--lab-forward', action='store_true')
parser.add_argument('--arcface-crop', action='store_true')
args, rest = parser.parse_known_args()
if args.lab_forward and args.color_lut:
    raise ValueError('Select exact color forward kernel or lookup, not both')
if args.lab_forward:
    from experiment_lab_forward import install
    install()
if args.arcface_crop:
    from experiment_arcface_crop import install
    install()
if args.lab_inverse or args.lab_transfer:
    from experiment_lab_inverse import install
    install(fuse_transfer=args.lab_transfer)
if args.confidence_twopass:
    from experiment_confidence_twopass import install
    install()
if args.native_detection:
    from experiment_native_detection import install
    install()
if args.pinned_frame_transfers:
    import experiment_frame_transfers  # Installed after profiler config isolation.
if args.native_swapper:
    from experiment_native_swapper import install
    install(graph=not args.swap_prefix_graph)
if args.u8_grid_sample:
    from experiment_u8_grid_sample import install
    install()
if args.input_warp_graph:
    from experiment_input_warp_graph import install
    install()
if args.pasteback_matrix:
    from experiment_pasteback_matrix import install
    install()
if args.restorer_pointwise:
    from experiment_restorer_pointwise import install
    install()
if args.detector_postprocess:
    from experiment_retinaface_postprocess import install
    install()
if args.restorer_prepare_graph:
    from experiment_restorer_prepare_graph import install
    install(guard_graph=args.restorer_guard_graph, borrow_outputs=args.borrow_restorer_outputs)
elif args.restorer_guard_graph:
    raise ValueError('Guard graph experiment requires restorer preparation graph')
if args.color_lut:
    from experiment_color_lut import install
    install()
if args.restorer_display_graph:
    from experiment_restorer_display_graph import install
    install()
if args.opencv_threads is not None:
    if args.opencv_threads < 1:
        raise ValueError('OpenCV threads must be positive')
    import cv2
    cv2.setNumThreads(args.opencv_threads)
if args.ort_single_thread:
    from rope.Models import Models
    original_options = Models._make_session_options
    def no_spin_options(self):
        options = original_options(self)
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        return options
    Models._make_session_options = no_spin_options
if args.experiment == 'inference-mode':
    import torch
    from rope.VideoManager import VideoManager
    VideoManager.swap_core = torch.inference_mode()(VideoManager.swap_core)
if args.experiment == 'mask-overlap':
    from experiment_mask_overlap import install
    install()
if args.experiment == 'identity-guards':
    from experiment_identity_guard_overlap import install
    install()
if args.swap_prefix_graph:
    if not args.native_swapper:
        raise ValueError('Swap prefix graph requires the native swapper')
    from experiment_swap_prefix_graph import install
    install()
if args.experiment == 'detection-prefetch':
    # The external profiler installs this after its config override and
    # PongSwapEngine import. Importing the engine here would bind old config.
    import experiment_detection_prefetch  # noqa: F401
if args.mask_tail_graph:
    from experiment_mask_tail_graph import install
    install()
if args.experiment in ('confidence-kernel', 'confidence-blend'):
    from experiment_confidence_kernel import install
    install(blend=args.experiment == 'confidence-blend')
if args.experiment == 'geometry-cache':
    from experiment_geometry_cache import install
    install()
if args.experiment in ('mask-graphs', 'model-graphs', 'combined'):
    from experiment_mask_graphs import install
    install(swapper=args.experiment in ('model-graphs', 'combined'))
if args.experiment in ('identity-graph', 'combined'):
    from experiment_identity_graph import install
    install()
coverage = {}
if args.experiment in ('identity-graph', 'combined'):
    from rope.VideoManager import VideoManager
    original_apply = VideoManager._isolated_identity_graph_apply
    def observed_apply(self, *args, **kwargs):
        result = original_apply(self, *args, **kwargs)
        state = getattr(self, '_isolated_identity_graph_state', None)
        if state:
            coverage.update({key: value for key, value in state.items() if key not in ('graphs', 'seen')})
        return result
    VideoManager._isolated_identity_graph_apply = observed_apply
sys.argv = ['profile_exact_stages.py', *rest]
runpy.run_path('E:/Pong Benchmarks/v3030-exact-stage-profile/profile_exact_stages.py', run_name='__main__')
if '--output-dir' in rest:
    report_file = Path(rest[rest.index('--output-dir') + 1]) / 'report.json'
    report = json.loads(report_file.read_text(encoding='utf-8'))
    report['experiment'] = args.experiment
    report['opencvThreadsOverride'] = args.opencv_threads
    report['ortSingleThreadOverride'] = args.ort_single_thread
    report['pinnedFrameTransfers'] = args.pinned_frame_transfers
    report['nativeSwapper'] = args.native_swapper
    report['inputWarpGraph'] = args.input_warp_graph
    report['restorerPointwise'] = args.restorer_pointwise
    report['detectorPostprocess'] = args.detector_postprocess
    report['restorerPrepareGraph'] = args.restorer_prepare_graph
    report['u8GridSample'] = args.u8_grid_sample
    report['colorLut'] = args.color_lut
    report['restorerGuardGraph'] = args.restorer_guard_graph
    report['restorerDisplayGraph'] = args.restorer_display_graph
    report['pastebackMatrix'] = args.pasteback_matrix
    report['borrowRestorerOutputs'] = args.borrow_restorer_outputs
    report['swapPrefixGraph'] = args.swap_prefix_graph
    report['maskTailGraph'] = args.mask_tail_graph
    report['nativeDetection'] = args.native_detection
    report['confidenceTwopass'] = args.confidence_twopass
    report['labInverse'] = args.lab_inverse
    report['labTransfer'] = args.lab_transfer
    report['labForward'] = args.lab_forward
    report['arcfaceCrop'] = args.arcface_crop
    if args.color_lut:
        from experiment_color_lut import coverage as color_coverage
        report['colorLutCoverage'] = color_coverage()
    if args.restorer_pointwise:
        from experiment_restorer_pointwise import coverage as restorer_coverage
        report['restorerPointwiseCoverage'] = restorer_coverage()
    report['identityGraphCoverage'] = coverage
    report_file.write_text(json.dumps(report, indent=2), encoding='utf-8')
