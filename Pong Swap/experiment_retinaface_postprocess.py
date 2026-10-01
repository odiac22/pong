"""Process-local RetinaFace compaction experiment; no model/geometry changes.

Decode all anchors in the original stride order, then compact all three
outputs with one ascending keep-index. The original sort, scale-back, NMS and
face ranking remain byte-for-byte source-identical. No CUDA work on import.
"""

import inspect
import sys
import textwrap


_MASK = "            pos_mask = scores_t >= score"
_APPEND = """            scores_list.append(scores_t[pos_mask])
            bboxes_list.append(bboxes[pos_mask])
            kpss_list.append(kpss[pos_mask])"""
_APPEND_NEW = """            scores_list.append(scores_t)
            bboxes_list.append(bboxes)
            kpss_list.append(kpss)"""
_CAT = """        all_scores = torch.cat(scores_list)
        all_bboxes = torch.cat(bboxes_list)
        all_kpss = torch.cat(kpss_list)"""
_CAT_NEW = """        all_scores, all_bboxes, all_kpss = _isolated_retinaface_compact(
            scores_list, bboxes_list, kpss_list, score,
        )"""


def _compact_outputs(scores_list, bboxes_list, kpss_list, score):
    import torch

    # torch.nonzero emits ascending indices for this 1-D concatenation. The
    # old per-stride boolean gathers likewise preserved order within each
    # stride, then concatenated strides 8/16/32 in that order.
    all_scores = torch.cat(scores_list)
    all_bboxes = torch.cat(bboxes_list)
    all_kpss = torch.cat(kpss_list)
    keep = torch.nonzero(all_scores >= score, as_tuple=False).flatten()
    return (
        all_scores.index_select(0, keep),
        all_bboxes.index_select(0, keep),
        all_kpss.index_select(0, keep),
    )


def install():
    from rope import Models as module

    original = module.Models._detect_retinaface_inner
    source = textwrap.dedent(inspect.getsource(original))
    expected = ((_MASK, 1), (_APPEND, 1), (_CAT, 1))
    for fragment, count in expected:
        if source.count(fragment) != count:
            raise RuntimeError("RetinaFace postprocess source contract changed")
    patched = source.replace(_MASK, "            # Single cross-stride threshold below.")
    patched = patched.replace(_APPEND, _APPEND_NEW).replace(_CAT, _CAT_NEW)
    module._isolated_retinaface_compact = _compact_outputs
    scope = {}
    exec(compile(patched, module.__file__, "exec"), module.__dict__, scope)
    module.Models._detect_retinaface_inner = scope[original.__name__]
    return module.Models


if __name__ == "__main__":
    # CPU smoke only; detailed randomized, tied, empty and all-selected cases
    # live in test_experiment_retinaface_postprocess.py.
    import unittest

    sys.path.insert(0, str(__file__).rsplit("\\", 1)[0])
    unittest.main(module="test_experiment_retinaface_postprocess")
