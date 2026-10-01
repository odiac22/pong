from __future__ import annotations

from collections import OrderedDict
import unittest

import numpy as np
import torch

from rope.VideoManager import VideoManager


SAMPLER = 'minmod-hermite-symmetric-v1'


def _minmod(a: float, b: float) -> float:
    if a * b <= 0.0:
        return 0.0
    return float(np.sign(a) * min(abs(a), abs(b)))


def _hermite(pm1: float, p0: float, p1: float, p2: float, f: float) -> float:
    delta = p1 - p0
    m0 = _minmod(p0 - pm1, delta)
    m1 = _minmod(delta, p2 - p1)
    return p0 + f * delta + f * (1.0 - f) * (
        (1.0 - f) * (m0 - delta) - f * (m1 - delta)
    )


def _reference_patch(patch: np.ndarray, fx: float, fy: float) -> float:
    rows = [_hermite(*patch[row, :], fx) for row in range(4)]
    columns = [_hermite(*patch[:, column], fy) for column in range(4)]
    return 0.5 * (_hermite(*rows, fy) + _hermite(*columns, fx))


class RestorerMonotoneHermiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not torch.cuda.is_available():
            raise unittest.SkipTest('CUDA is required for the production sampler contract')

    def setUp(self):
        self.manager = VideoManager.__new__(VideoManager)
        self.manager._restorer_return_geometry_cache = OrderedDict()
        self.device = torch.device('cuda:0')

    def sample(self, source, matrix, *, cache=True, out_h=None, out_w=None):
        return self.manager._affine_resize_grid_sample(
            source,
            matrix,
            in_h=source.shape[-2],
            in_w=source.shape[-1],
            out_h=out_h or source.shape[-2],
            out_w=out_w or source.shape[-1],
            sampler=SAMPLER,
            cache_geometry=cache,
        )

    def test_scalar_reference_matches_gpu(self):
        generator = torch.Generator(device=self.device).manual_seed(141)
        source = torch.rand((1, 1, 14, 15), generator=generator, device=self.device) * 255.0
        matrix = np.array([[0.91, -0.06, 2.375], [0.06, 0.91, 2.625], [0, 0, 1]], np.float32)
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 14, 15, 8, 9, sampler=SAMPLER, cache_geometry=False,
        )
        output = self.manager._symmetric_monotone_hermite_sample(source, geometry)
        donors = torch.gather(
            source.flatten(2).unsqueeze(2).expand(-1, -1, 16, -1),
            3,
            geometry['donorIndex'],
        ).reshape(1, 1, 4, 4, 8, 9).cpu().numpy()
        fx = geometry['fractionX'].cpu().numpy()
        fy = geometry['fractionY'].cpu().numpy()
        interior = geometry['interior'].cpu().numpy()
        actual = output.cpu().numpy()
        for y in range(8):
            for x in range(9):
                if interior[0, 0, y, x]:
                    expected = _reference_patch(
                        donors[0, 0, :, :, y, x],
                        float(fx[0, 0, y, x]),
                        float(fy[0, 0, y, x]),
                    )
                    self.assertAlmostEqual(float(actual[0, 0, y, x]), expected, delta=1e-3)

    def test_constant_integer_and_linear_ramps_are_preserved(self):
        identity = np.eye(3, dtype=np.float32)
        constant = torch.full((1, 3, 32, 32), 73.25, device=self.device)
        torch.testing.assert_close(self.sample(constant, identity), constant, atol=2e-4, rtol=0.0)

        y, x = torch.meshgrid(
            torch.arange(32, device=self.device),
            torch.arange(32, device=self.device),
            indexing='ij',
        )
        ramp = torch.stack((x, y, 3 * x + 5 * y)).to(torch.float32).unsqueeze(0)
        torch.testing.assert_close(self.sample(ramp, identity), ramp, atol=2e-4, rtol=0.0)

        translated = np.array([[1.0, 0.0, 1.375], [0.0, 1.0, 1.625], [0, 0, 1]], np.float32)
        result = self.sample(ramp, translated, out_h=26, out_w=26)
        expected_x = x[:26, :26].to(torch.float32) + 1.375
        expected_y = y[:26, :26].to(torch.float32) + 1.625
        expected = torch.stack((expected_x, expected_y, 3 * expected_x + 5 * expected_y)).unsqueeze(0)
        torch.testing.assert_close(result, expected, atol=1e-3, rtol=0.0)

    def test_interior_stays_inside_central_two_by_two_donor_range(self):
        generator = torch.Generator(device=self.device).manual_seed(177)
        source = torch.randn((1, 3, 40, 40), generator=generator, device=self.device) * 70.0
        matrix = np.array([[0.99, -0.04, 2.375], [0.04, 0.99, 1.625], [0, 0, 1]], np.float32)
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 40, 40, 31, 33, sampler=SAMPLER, cache_geometry=False,
        )
        output = self.manager._symmetric_monotone_hermite_sample(source, geometry)
        donors = torch.gather(
            source.flatten(2).unsqueeze(2).expand(-1, -1, 16, -1),
            3,
            geometry['donorIndex'].expand(1, 3, -1, -1),
        ).reshape(1, 3, 4, 4, 31, 33)
        central = donors[:, :, 1:3, 1:3]
        donor_min = central.amin(dim=(2, 3))
        donor_max = central.amax(dim=(2, 3))
        interior = geometry['interior'].expand_as(output)
        self.assertTrue(bool(torch.all(output[interior] >= donor_min[interior] - 1e-5)))
        self.assertTrue(bool(torch.all(output[interior] <= donor_max[interior] + 1e-5)))

    def test_borders_are_bit_exact_legacy_bilinear(self):
        generator = torch.Generator(device=self.device).manual_seed(191)
        source = torch.rand((1, 3, 24, 24), generator=generator, device=self.device)
        matrix = np.array([[1.0, 0.0, -0.4], [0.0, 1.0, 0.6], [0, 0, 1]], np.float32)
        geometry, _ = self.manager._restorer_return_geometry(
            source, matrix, 24, 24, 24, 24, sampler=SAMPLER, cache_geometry=False,
        )
        candidate = self.manager._symmetric_monotone_hermite_sample(source, geometry)
        control = self.manager._affine_resize_grid_sample(
            source, matrix, 24, 24, 24, 24,
            sampler='bilinear-v1', cache_geometry=False,
        )
        border = (~geometry['interior']).expand_as(candidate)
        self.assertTrue(torch.equal(candidate[border], control[border]))

    def test_axis_exchange_symmetry(self):
        generator = torch.Generator(device=self.device).manual_seed(223)
        source = torch.rand((1, 2, 31, 31), generator=generator, device=self.device)
        matrix = np.array([[0.98, 0.0, 1.375], [0.0, 0.98, 1.625], [0, 0, 1]], np.float32)
        original = self.sample(source, matrix, cache=False)
        transposed_matrix = matrix.copy()
        transposed_matrix[0, 2], transposed_matrix[1, 2] = matrix[1, 2], matrix[0, 2]
        transposed = self.sample(source.transpose(-1, -2), transposed_matrix, cache=False)
        torch.testing.assert_close(original, transposed.transpose(-1, -2), atol=2e-5, rtol=0.0)

    def test_cache_equivalence_determinism_and_sampler_key(self):
        generator = torch.Generator(device=self.device).manual_seed(251)
        source = torch.rand((1, 3, 28, 28), generator=generator, device=self.device)
        matrix = np.array([[0.97, -0.03, 1.25], [0.03, 0.97, 1.75], [0, 0, 1]], np.float32)
        uncached = self.sample(source, matrix, cache=False, out_h=25, out_w=26)
        first = self.sample(source, matrix, cache=True, out_h=25, out_w=26)
        second = self.sample(source, matrix, cache=True, out_h=25, out_w=26)
        self.assertTrue(torch.equal(uncached, first))
        self.assertTrue(torch.equal(first, second))
        self.manager._restorer_return_geometry(
            source, matrix, 28, 28, 25, 26,
            sampler='bounded-cubic-v1', cache_geometry=True,
        )
        self.assertEqual(len(self.manager._restorer_return_geometry_cache), 2)


if __name__ == '__main__':
    unittest.main()
