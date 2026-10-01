"""CPU-only contracts for the exact uncached-color eager adapter."""

import gc
import unittest
import weakref

from experiment_color_graph_adaptive import graph_key, install_on_vm, status


class _Tensor:
    def __init__(self, dtype, *, is_cuda=True):
        self.dtype = dtype
        self.is_cuda = is_cuda
        self.device = "cuda:0"
        self.shape = (3, 160, 160)
        self.clamps = []

    def clamp_(self, low, high):
        self.clamps.append((low, high))
        return self


class _Torch:
    uint8 = "u8"
    float32 = "f32"

    class cuda:
        @staticmethod
        def current_stream(_device):
            return type("Stream", (), {"cuda_stream": 123})()


class _VM:
    color_match_cuda_graph_enabled = True

    def __init__(self):
        self.original_calls = 0
        self._color_match_graphs = {}

    def _match_color(self, *_args):
        self.original_calls += 1
        return "original"


class AdaptiveColorTests(unittest.TestCase):
    def test_uncached_key_calls_same_lab_function_without_cache_mutation(self):
        vm = _VM()
        calls = []
        state = install_on_vm(vm, _Torch, lambda *args: calls.append(args) or "lab")
        a, b = _Tensor("u8"), _Tensor("u8")
        self.assertEqual(vm._match_color(a, b), "lab")
        self.assertEqual(calls, [(a, b, None)])
        self.assertEqual(vm._color_match_graphs, {})
        self.assertEqual(state["eagerMisses"], 1)
        self.assertIs(install_on_vm(vm, _Torch, lambda *_: "wrong"), state)

    def test_existing_graph_key_replays_original(self):
        vm = _VM()
        a, b = _Tensor("u8"), _Tensor("u8")
        vm._color_match_graphs[graph_key(_Torch, a, b, None)] = object()
        state = install_on_vm(vm, _Torch, lambda *_: self.fail("must not use eager"))
        self.assertEqual(vm._match_color(a, b), "original")
        self.assertEqual(vm.original_calls, 1)
        self.assertEqual(status(state)["graphHits"], 1)

    def test_float32_side_effect_and_mask_passthrough(self):
        vm = _VM()
        seen = []
        install_on_vm(vm, _Torch, lambda *args: seen.append(args) or "lab")
        a, b, mask = _Tensor("f32"), _Tensor("f32"), _Tensor("f32")
        mask.shape = (1, 160, 160)
        self.assertEqual(vm._match_color(a, b, mask), "lab")
        self.assertEqual(a.clamps, [(0, 255)])
        self.assertEqual(b.clamps, [(0, 255)])
        self.assertEqual(mask.clamps, [])
        self.assertEqual(seen, [(a, b, mask)])

    def test_unsupported_and_disabled_use_original(self):
        vm = _VM()
        state = install_on_vm(vm, _Torch, lambda *_: self.fail("must not use eager"))
        vm.color_match_cuda_graph_enabled = False
        self.assertEqual(vm._match_color(_Tensor("u8"), _Tensor("u8")), "original")
        vm.color_match_cuda_graph_enabled = True
        self.assertEqual(vm._match_color(_Tensor("u8", is_cuda=False), _Tensor("u8")), "original")
        self.assertEqual(vm._match_color(_Tensor("other"), _Tensor("u8")), "original")
        self.assertEqual(state["originalFallbacks"], 3)

    def test_out_of_scope_call_uses_original_without_eager_or_capture_change(self):
        vm = _VM()
        active = [False]
        state = install_on_vm(
            vm, _Torch, lambda *_: "lab",
            enabled_for_call=lambda: active[0],
        )
        self.assertEqual(vm._match_color(_Tensor("u8"), _Tensor("u8")), "original")
        self.assertEqual(state["eagerMisses"], 0)
        self.assertEqual(state["originalFallbacks"], 1)
        active[0] = True
        self.assertEqual(vm._match_color(_Tensor("u8"), _Tensor("u8")), "lab")
        self.assertEqual(state["eagerMisses"], 1)

    def test_vm_releases_immediately_even_with_cycle_collector_disabled(self):
        was_enabled = gc.isenabled()
        vm = _VM()
        owner_ref = weakref.ref(vm)
        try:
            gc.disable()
            state = install_on_vm(vm, _Torch, lambda *_: "lab")
            del vm
            # Neither state nor the function stored on the VM may retain a
            # bound method or closure that keeps that VM alive until GC.
            self.assertIsNone(owner_ref())
            self.assertEqual(state["eagerMisses"], 0)
        finally:
            if was_enabled:
                gc.enable()


if __name__ == "__main__":
    unittest.main()
