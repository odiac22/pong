"""Lossless buffer-ownership regression tests; not a face-quality benchmark."""
import gc
import unittest
import numpy as np

from server import wrap_rgb_frame
from swap_bridge import composite_frame


class FrameTests(unittest.TestCase):
    def test_composite_preserves_ui_pixels_and_avoids_second_copy(self):
        source = np.random.default_rng(3).integers(0, 256, (2340, 1080, 3), dtype=np.uint8)
        original = source.copy()
        bounds = (10, 120, 901, 2100)
        crop = np.full((1980, 891, 3), 83, np.uint8)
        output = composite_frame(source, crop.tobytes(), bounds)
        expected = original.copy()
        expected[120:2100, 10:901] = crop
        np.testing.assert_array_equal(output, expected)
        np.testing.assert_array_equal(source, original)
        self.assertFalse(output.flags.writeable)
        self.assertTrue(output.flags.owndata)
        frame = wrap_rgb_frame(output)
        self.assertEqual(frame.planes[0].buffer_ptr, output.ctypes.data)
        source[:] = 0
        del output
        gc.collect()
        np.testing.assert_array_equal(frame.to_ndarray(format='rgb24'), expected)

    def test_owned_immutable_buffer_is_retained_without_copy(self):
        raw = bytes(range(192))
        rgb = np.frombuffer(raw, np.uint8).reshape(8, 8, 3)
        frame = wrap_rgb_frame(rgb)
        self.assertEqual(frame.planes[0].buffer_ptr, rgb.ctypes.data)
        del rgb, raw
        gc.collect()
        np.testing.assert_array_equal(frame.to_ndarray(format='rgb24').ravel(),
                                      np.arange(192, dtype=np.uint8))

    def test_mutable_backend_cannot_overwrite_queued_frame(self):
        rgb = np.full((8, 8, 3), 71, dtype=np.uint8)
        frame = wrap_rgb_frame(rgb)
        rgb[:] = 0
        self.assertTrue(np.all(frame.to_ndarray(format='rgb24') == 71))

    def test_native_resolution_pixels_and_channels_are_exact(self):
        expected = np.random.default_rng(1).integers(0, 256, (2340, 1080, 3), dtype=np.uint8)
        rgb = np.frombuffer(expected.tobytes(), np.uint8).reshape(expected.shape)
        frame = wrap_rgb_frame(rgb)
        self.assertEqual((frame.width, frame.height), (1080, 2340))
        np.testing.assert_array_equal(frame.to_ndarray(format='rgb24'), expected)

    def test_invalid_format_rejected(self):
        for rgb in (np.zeros((8, 8)), np.zeros((8, 8, 4), dtype=np.uint8)):
            with self.assertRaises(ValueError):
                wrap_rgb_frame(rgb)
