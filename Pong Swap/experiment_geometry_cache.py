"""Process-local experiment: cache invariant geometry, never facial pixels."""
from collections import OrderedDict
import inspect
import textwrap


def install():
    import torch
    from torchvision.transforms.v2.functional import _geometry as geometry
    from rope import VideoManager as module
    cls = module.VideoManager

    def cached_affine(self, image, angle, translate, scale, shear, *, center, interpolation):
        # Same torchvision math and sampler; only the constant grid is retained.
        # Exact float keys prevent rounding different transforms into one key.
        stream = torch.cuda.current_stream(image.device)
        key = (tuple(image.shape[-2:]), str(image.device), image.dtype,
               int(stream.cuda_stream), float(angle).hex(),
               tuple(float(v).hex() for v in translate), float(scale).hex(),
               tuple(float(v).hex() for v in center), interpolation.value)
        cache = getattr(self, '_experiment_affine_grids', None)
        if cache is None:
            cache = self._experiment_affine_grids = OrderedDict()
        grid = cache.get(key)
        if grid is None:
            angle, translate, shear, center = geometry._affine_parse_args(
                angle, translate, scale, shear, interpolation, center)
            height, width = image.shape[-2:]
            center_f = [(c - s * .5) for c, s in zip(center, [width, height])]
            matrix = geometry._get_inverse_affine_matrix(
                center_f, angle, [float(v) for v in translate], scale, shear)
            dtype = image.dtype if image.is_floating_point() else torch.float32
            theta = torch.tensor(matrix, dtype=dtype, device=image.device).reshape(1, 2, 3)
            grid = geometry._affine_grid(theta, w=width, h=height, ow=width, oh=height)
            cache[key] = grid
            while len(cache) > 8:
                cache.popitem(last=False)
        cache.move_to_end(key)
        return geometry._apply_grid_transform(image, grid, interpolation.value, fill=None)

    cls._experiment_cached_affine = cached_affine
    original = cls._apply_restorer_inner
    source = textwrap.dedent(inspect.getsource(original))
    old = 'input_face = v2.functional.affine('
    if source.count(old) != 1:
        raise RuntimeError('Restorer affine source contract changed')
    scope = {}
    exec(compile(source.replace(old, 'input_face = self._experiment_cached_affine('),
                 module.__file__, 'exec'), module.__dict__, scope)
    cls._apply_restorer_inner = scope[original.__name__]
