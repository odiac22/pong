"""Process-local exact identity guard precomputation, no history-policy changes."""
import inspect
import sys
import textwrap

SOURCE = '''        source_delta = torch.mean(
            torch.abs(current_input - prior_input.to(torch.float32)),
            dim=0,
            keepdim=True,
        )
        patch_kernel = max(8, int(min(source_delta.shape[-2:]) // 16))
        finite, input_mae, patch_mae = _read_guard_scalars(
            torch.isfinite(source_delta).all(),
            torch.mean(source_delta),
            torch.nn.functional.avg_pool2d(
                source_delta.unsqueeze(0),
                kernel_size=patch_kernel,
                stride=patch_kernel,
            ).max(),
        )'''
SOURCE = textwrap.indent(textwrap.dedent(SOURCE), '    ')
REPLACEMENT = '''    source_delta, (finite, input_mae, patch_mae) = self._isolated_identity_guard(
        temporal_context, aligned_input, state, prior_input,
    )'''


def _completed(pending):
    future = pending.get('future')
    if future is None or not future.done():
        return False
    if future.exception() is not None:
        return False
    if pending['result'] is None:
        return True
    return pending['done'].query()


def _retire_identity_pending(state, pending):
    if pending is None or pending.get('future') is None:
        return
    retired = state.setdefault('identityRetired', [])
    retired[:] = [item for item in retired if not _completed(item)]
    if not _completed(pending):
        retired.append(pending)
    # A cancelled/bypassed frame must not release its pinned D2H host
    # buffer or side-stream tensor before the side event finishes. Bound
    # ownership even if a future GPU operation stops making progress.
    while len(retired) > 4:
        oldest = retired[0]
        try:
            oldest['future'].result()
        except Exception:
            state['stream'].synchronize()
            # The mask overlap teardown reports worker errors.
        if oldest['result'] is not None:
            oldest['done'].synchronize()
        retired.pop(0)


def install(*, fused_delta=False):
    import torch
    from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    from rope.VideoManager import VideoManager, _read_guard_scalars
    installed = getattr(VideoManager, '_isolated_identity_guard_mode', None)
    if installed is not None:
        if installed != bool(fused_delta):
            raise RuntimeError('Identity guard already installed with a different delta mode')
        return VideoManager
    source = textwrap.dedent(inspect.getsource(VideoManager._temporal_identity_residual))
    if source.count(SOURCE) != 1:
        raise RuntimeError('Identity guard source changed')
    old_compute = overlap._compute_guards
    old_launch = overlap._launch
    if fused_delta:
        from pong_exact_runtime.vendor.experiment_identity_delta_kernel import mean_abs_delta

    def reductions(current, prior):
        delta = (mean_abs_delta(current, prior) if fused_delta else
                 torch.mean(torch.abs(current.to(torch.float32)-prior.to(torch.float32)),
                            dim=0, keepdim=True))
        kernel = max(8, int(min(delta.shape[-2:]) // 16))
        tensors = (torch.isfinite(delta).all(), torch.mean(delta),
                   torch.nn.functional.avg_pool2d(delta.unsqueeze(0), kernel_size=kernel, stride=kernel).max())
        return delta, tensors

    def compute(state, image, entries, ready, done, identity=None):
        # The identity entry is captured at submission. Looking up the latest
        # entry in shared state here could pick a later frame if the host
        # worker starts after the next launch.
        side_stream = state['stream']
        with torch.cuda.device(image.device), torch.cuda.stream(side_stream), torch.no_grad():
            side_stream.wait_event(ready)
            if identity is not None and identity['image'] is image:
                delta, tensors = reductions(image, identity['prior'])
                host = torch.empty((3,), dtype=torch.float32, pin_memory=True)
                host.copy_(torch.stack(tensors), non_blocking=True)
                identity['result'] = (delta, host)
                identity['done'].record(side_stream)
        return old_compute(state, image, entries, ready, done, identity)

    def launch(self, image, parameters, context):
        state = overlap._side_state(self)
        _retire_identity_pending(state, state.get('identityPending'))
        state['identityPending'] = None
        anchor = context.get('identityResidualAnchor') if context else None
        prior = anchor.get('input') if isinstance(anchor, dict) else None
        pending = None
        if (isinstance(prior, torch.Tensor) and prior.shape == image.shape and prior.device == image.device
                and context.get('identityResidualStabilizationEnabled', False)):
            prior.record_stream(state['stream'])
            pending = {'context': context, 'index': context.get('frameIndex'), 'image': image,
                       'mediaTimeSeconds': context.get('mediaTimeSeconds'),
                       'imageVersion': image._version,
                       'anchor': anchor, 'prior': prior, 'version': prior._version,
                       'done': torch.cuda.Event(), 'result': None}
        state['identityLaunch'] = pending
        old_launch(self, image, parameters, context)
        # _compute_guards runs only when there are unchanged mask probe entries.
        guard_pending = state.get('guardPending')
        if (pending is not None and guard_pending is not None
                and guard_pending['context'] is context
                and guard_pending['input'] is image):
            pending['future'] = guard_pending['future']
            state['identityPending'] = pending
        state['identityLaunch'] = None

    def guard(self, context, image, anchor, prior):
        state = getattr(self, '_isolated_mask_overlap', None)
        pending = state.get('identityPending') if state else None
        if (pending is not None and pending['context'] is context and pending['index'] == context.get('frameIndex')
                and pending['mediaTimeSeconds'] == context.get('mediaTimeSeconds')
                and pending['anchor'] is anchor and pending['prior'] is prior and pending['version'] == prior._version
                and pending['image'] is image and pending['imageVersion'] == image._version):
            pending['future'].result()
            if pending['result'] is not None:
                pending['done'].synchronize()
                delta, host = pending['result']
                delta.record_stream(torch.cuda.current_stream(image.device))
                return delta, host.tolist()
        delta, tensors = reductions(image, prior)
        return delta, _read_guard_scalars(*tensors)

    overlap._compute_guards = compute
    overlap._launch = launch
    overlap.install()
    VideoManager._isolated_identity_guard = guard
    old_shutdown = VideoManager.shutdown_background_workers

    def shutdown(self):
        state = getattr(self, '_isolated_mask_overlap', None)
        # Retain all pending owners through the mask module's executor join
        # and CUDA stream synchronization, including bypassed frames.
        owners = [] if state is None else list(state.get('identityRetired', []))
        if state is not None:
            owners.extend(item for item in (state.get('identityPending'),
                                            state.get('identityLaunch')) if item is not None)
        try:
            return old_shutdown(self)
        finally:
            owners.clear()

    VideoManager.shutdown_background_workers = shutdown
    scope = {}
    exec(compile(source.replace(SOURCE, REPLACEMENT), __file__, 'exec'),
         sys.modules[VideoManager.__module__].__dict__, scope)
    VideoManager._temporal_identity_residual = scope['_temporal_identity_residual']
    VideoManager._isolated_identity_guard_source = source.replace(SOURCE, REPLACEMENT)
    VideoManager._isolated_identity_guard_mode = bool(fused_delta)
    return VideoManager
