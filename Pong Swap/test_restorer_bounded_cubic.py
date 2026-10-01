from __future__ import annotations

from collections import OrderedDict
import unittest

import numpy as np
import torch

from rope.VideoManager import VideoManager


class RestorerBoundedCubicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not torch.cuda.is_available():
            raise unittest.SkipTest('CUDA is required for the production sampler contract')

    def setUp(self):
        self.manager = VideoManager.__new__(VideoManager)
        self.manager._restorer_return_geometry_cache = OrderedDict()
        self.device = torch.device('cuda:0')

    def sample(self, source, matrix, *, mode, cache=True, out_h=None, out_w=None):
        return self.manager._affine_resize_grid_sample(
            source,
            matrix,
            in_h=source.shape[-2],
            in_w=source.shape[-1],
            out_h=out_h or source.shape[-2],
            out_w=out_w or source.shape[-1],
            sampler=mode,
            cache_geometry=cache,
        )

    def test_cached_bilinear_is_bit_exact_with_uncached_control(self):
        generator = torch.Generator(device=self.device).manual_seed(19)
        source = torch.rand((1, 3, 32, 32), generator=generator, device=self.device)
        matrix = np.array([[0.97, -0.08, 2.25], [0.08, 0.97, -1.75], [0, 0, 1]], np.float32)
        control = self.sample(source, matrix, mode='bilinear-v1', cache=False, out_h=27, out_w=29)
        first = self.sample(source, matrix, mode='bilinear-v1', cache=True, out_h=27, out_w=29)
        second = self.sample(source, matrix, mode='bilinear-v1', cache=True, out_h=27, out_w=29)
        self.assertTrue(torch.equal(control, first))
        self.assertTrue(torch.equal(first, second))

    def test_nonblocking_geometry_is_bit_exact_to_original_cuda_constructor(self):
        # Include non-default streams and both adaptive restoration sizes.
        # CPU submission speed must not change donor pixels or matrix math.
        for stream in (torch.cuda.current_stream(), torch.cuda.Stream()):
            with torch.cuda.stream(stream):
                for size in (512, 1024):
                    for shift in (-4.25, 0.0, 3.125):
                        matrix = np.array([[.97, -.08, shift], [.08, .97, -1.75], [0, 0, 1]], np.float32)
                        source = torch.zeros((1, 3, size, size), device=self.device)
                        out_h, out_w = 256, 256
                        m_out = torch.tensor([[(out_w-1)*.5, 0, (out_w-1)*.5],
                            [0, (out_h-1)*.5, (out_h-1)*.5], [0, 0, 1]], device=self.device, dtype=torch.float32)
                        m_in = torch.tensor([[2/(size-1), 0, -1], [0, 2/(size-1), -1],
                            [0, 0, 1]], device=self.device, dtype=torch.float32)
                        transform = torch.as_tensor(matrix, device=self.device)
                        expected = torch.nn.functional.affine_grid((m_in @ transform @ m_out)[:2].unsqueeze(0),
                            [1, 1, out_h, out_w], align_corners=True)
                        actual, _ = self.manager._restorer_return_geometry(source, matrix, size, size,
                            out_h, out_w, sampler='bilinear-v1', cache_geometry=False)
                        stream.synchronize()
                        self.assertTrue(torch.equal(expected, actual['grid']), (size, shift))

    def test_cubic_and_bilinear_share_identical_donor_coordinates(self):
        source = torch.zeros((1, 3, 32, 32), device=self.device)
        matrix = np.array([[1.0, 0.03, 0.375], [-0.03, 1.0, 1.125], [0, 0, 1]], np.float32)
        bilinear, _ = self.manager._restorer_return_geometry(
            source, matrix, 32, 32, 25, 27,
            sampler='bilinear-v1', cache_geometry=False,
        )
        cubic, _ = self.manager._restorer_return_geometry(
            source, matrix, 32, 32, 25, 27,
            sampler='bounded-cubic-v1', cache_geometry=False,
        )
        self.assertTrue(torch.equal(bilinear['grid'], cubic['grid']))

    def test_constant_and_integer_coordinate_fields_are_preserved(self):
        identity = np.eye(3, dtype=np.float32)
        constant = torch.full((1, 3, 32, 32), 73.25, device=self.device)
        result = self.sample(constant, identity, mode='bounded-cubic-v1')
        torch.testing.assert_close(result, constant, atol=2e-4, rtol=0.0)

        y, x = torch.meshgrid(
            torch.arange(32, device=self.device),
            torch.arange(32, device=self.device),
            indexing='ij',
        )
        ramp = torch.stack((x, y, 3 * x + 5 * y)).to(torch.float32).unsqueeze(0)
        result = self.sample(ramp, identity, mode='bounded-cubic-v1')
        torch.testing.assert_close(result, ramp, atol=2e-4, rtol=0.0)

    def test_output_stays_inside_four_by_four_donor_range(self):
        generator = torch.Generator(device=self.device).manual_seed(77)
        source = torch.randn((1, 3, 40, 40), generator=generator, device=self.device) * 70.0
        matrix = np.array([[0.99, -0.04, 2.375], [0.04, 0.99, 1.625], [0, 0, 1]], np.float32)
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 40, 40, 31, 33,
            sampler='bounded-cubic-v1', cache_geometry=False,
        )
        output = self.manager._range_bounded_cubic_sample(source, geometry)
        padded = torch.nn.functional.pad(source, (1, 2, 1, 2), value=0.0)
        donor_max = torch.nn.functional.max_pool2d(padded, 4, 1)
        donor_min = -torch.nn.functional.max_pool2d(-padded, 4, 1)
        index = geometry['floorIndex'].expand(1, 3, -1)
        expected_shape = (1, 3, 31, 33)
        donor_max = torch.gather(donor_max.flatten(2), 2, index).reshape(expected_shape)
        donor_min = torch.gather(donor_min.flatten(2), 2, index).reshape(expected_shape)
        interior = geometry['interior'].expand_as(output)
        self.assertTrue(bool(torch.all(output[interior] <= donor_max[interior] + 1e-6)))
        self.assertTrue(bool(torch.all(output[interior] >= donor_min[interior] - 1e-6)))

    def test_border_footprints_use_legacy_bilinear_output(self):
        generator = torch.Generator(device=self.device).manual_seed(91)
        source = torch.rand((1, 3, 24, 24), generator=generator, device=self.device)
        matrix = np.array([[1.0, 0.0, -0.4], [0.0, 1.0, 0.6], [0, 0, 1]], np.float32)
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 24, 24, 24, 24,
            sampler='bounded-cubic-v1', cache_geometry=False,
        )
        candidate = self.manager._range_bounded_cubic_sample(source, geometry)
        control = self.sample(source, matrix, mode='bilinear-v1', cache=False)
        border = (~geometry['interior']).expand_as(candidate)
        self.assertTrue(torch.equal(candidate[border], control[border]))

    def test_zero_weight_is_exact_bilinear_and_half_weight_is_midpoint(self):
        generator = torch.Generator(device=self.device).manual_seed(131)
        source = torch.rand((1, 3, 32, 32), generator=generator, device=self.device)
        matrix = np.array(
            [[0.98, -0.05, 1.375], [0.05, 0.98, -0.625], [0, 0, 1]],
            np.float32,
        )
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 32, 32, 27, 29,
            sampler='bounded-cubic-v1', cache_geometry=False,
        )
        bilinear = self.sample(
            source, matrix, mode='bilinear-v1', cache=False, out_h=27, out_w=29
        )
        cubic = self.manager._range_bounded_cubic_sample(source, geometry, weight=1.0)
        zero = self.manager._range_bounded_cubic_sample(source, geometry, weight=0.0)
        half = self.manager._range_bounded_cubic_sample(source, geometry, weight=0.5)
        self.assertTrue(torch.equal(zero, bilinear))
        torch.testing.assert_close(
            half,
            torch.lerp(bilinear, cubic, 0.5),
            atol=1e-6,
            rtol=0.0,
        )

    def test_geometry_cache_is_bounded_and_lru(self):
        source = torch.zeros((1, 3, 16, 16), device=self.device)
        for offset in range(10):
            matrix = np.eye(3, dtype=np.float32)
            matrix[0, 2] = offset / 10.0
            self.manager._restorer_return_geometry(
                source, matrix, 16, 16, 16, 16,
                sampler='bounded-cubic-v1', cache_geometry=True,
            )
        self.assertEqual(len(self.manager._restorer_return_geometry_cache), 8)


if __name__ == '__main__':
    unittest.main()
