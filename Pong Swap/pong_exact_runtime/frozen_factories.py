"""Generated helper closure factories; no runtime source rewriting."""
from pong_exact_runtime.vendor.experiment_identity_guard_overlap import _retire_identity_pending

def make_color_lut():
    from rope import VideoManager as vm
    import torch
    from pong_exact_runtime.vendor import experiment_color_lut as color
    _original = vm._rgb_chw_to_lab
    _coverage = color._coverage
    _launch_lookup = color._launch_lookup
    def lookup(rgb):
            if (rgb.is_cuda and rgb.device.index == 0 and rgb.dtype == torch.uint8
                    and rgb.ndim == 3 and rgb.shape[0] == 3
                    and rgb.shape[1] > 0 and rgb.shape[2] > 0
                    and all(stride > 0 for stride in rgb.stride())):
                return _launch_lookup(rgb)
            _coverage["fallback"] += 1
            return _original(rgb)

    return {'lookup': lookup}

def make_prefix():
    from collections import OrderedDict
    import weakref
    import torch
    from rope import VideoManager as module
    from rope.Models import Models
    vm = module.VideoManager
    owners = weakref.WeakSet()
    old_shutdown = vm.shutdown_background_workers
    old_delete = Models.delete_models
    def eligible(self, crop, latent, parameters, swap_size, dim,
                     pipeline_size, hf_switch_on):
            if (str(parameters.get('SwapperTypeTextSel')) != '128'
                    or int(swap_size) != 128 or int(dim) != 1
                    or bool(parameters.get('StrengthSwitch'))
                    or float(parameters.get('StrengthSlider', 0)) != 100.0
                    or bool(hf_switch_on)
                    or bool(parameters.get('FaceAdjSwitch'))
                    or not isinstance(crop, torch.Tensor)
                    or not crop.is_cuda or crop.device.index != 0
                    or crop.dtype != torch.uint8 or crop.ndim != 3
                    or crop.shape[0] != 3 or min(crop.shape[1:]) <= 0
                    or not isinstance(latent, torch.Tensor)
                    or not latent.is_cuda or latent.device != crop.device
                    or latent.dtype != torch.float32
                    or tuple(latent.shape) != (1, 512)
                    or int(pipeline_size) != int(crop.shape[1])
                    or crop.shape[1] != crop.shape[2]):
                return False
            state = getattr(self.models, '_isolated_native_swapper', None)
            if state is None or state.get('graph') is not None:
                return False
            # A graph replay bypasses Models.run_swapper, hence its normal lazy
            # session/backend rebinding checks. Perform the same binding check at
            # the prefix boundary, and drain captures before old TRT state drops.
            session = self.models._get_swapper_session()
            binding = (id(session), str(self.models.models_folder),
                       self.models.get_backend_preference('swapper_model'),
                       str(self.models._swapper_io_dtype),
                       bool(self.models._swapper_uses_trt),
                       tuple(torch.cuda.get_device_capability(crop.device)))
            if (not self.models._persistent_shared_io_enabled()
                    or not self.models._swapper_uses_trt
                    or state.get('binding') != binding):
                drain(self)
                return False
            stream = torch.cuda.current_stream(crop.device)
            return int(state['stream'].cuda_stream) == int(stream.cuda_stream)

    def drain(self):
            cache = getattr(self, '_experimental_swap_prefix_graphs', None)
            if cache is not None:
                for entry in cache.values():
                    if entry.get('lastUse') is not None:
                        entry['lastUse'].synchronize()
                cache.clear()

    def operations(self, crop, latent, pipeline_size, parameters):
            # Exactly the baseline branch of the preserved swap_core block.
            swap_face_input = module.v2.functional.resize(
                crop, [128, 128], interpolation=module.v2.InterpolationMode.BILINEAR,
                antialias=False,
            )
            swap_face_input = swap_face_input.permute(1, 2, 0)
            swap_face_input = torch.div(swap_face_input, 255.0)
            swap_face_output = self._polyphase_pass_v1(
                swap_face_input, latent, 1, 128, parameters, source_frame=None,
            )
            swap_face_output = torch.mul(swap_face_output, 255)
            swap_face_output = torch.clamp(swap_face_output, 0, 255)
            swap = swap_face_output.permute(2, 0, 1)
            swap = module.v2.Resize(
                (pipeline_size, pipeline_size),
                interpolation=module.v2.InterpolationMode.BICUBIC,
                antialias=False,
            )(swap.type(torch.float32))
            return swap.clamp(0, 255).type(torch.uint8)

    def prefix(self, crop, latent, pipeline_size, parameters):
            owners.add(self)
            stream = torch.cuda.current_stream(crop.device)
            key = (tuple(crop.shape), tuple(crop.stride()), crop.dtype,
                   tuple(latent.shape), tuple(latent.stride()), latent.dtype,
                   str(crop.device), int(stream.cuda_stream), int(pipeline_size),
                   id(self.models._isolated_native_swapper['context']))
            cache = getattr(self, '_experimental_swap_prefix_graphs', None)
            if cache is None:
                cache = self._experimental_swap_prefix_graphs = OrderedDict()
            state = cache.get(key)
            if state is None:
                state = {'seen': 0, 'lastUse': None}
                cache[key] = state
            cache.move_to_end(key)
            while len(cache) > 3:
                _, evicted = cache.popitem(last=False)
                if evicted['lastUse'] is not None:
                    evicted['lastUse'].synchronize()
            state['seen'] += 1
            if state['seen'] < 3:
                return operations(self, crop, latent, pipeline_size, parameters)
            if 'graph' not in state:
                static_crop = torch.empty(crop.shape, device=crop.device, dtype=crop.dtype)
                static_latent = torch.empty(latent.shape, device=latent.device,
                                            dtype=latent.dtype)
                static_crop.copy_(crop)
                static_latent.copy_(latent)
                operations(self, static_crop, static_latent, pipeline_size, parameters)
                stream.synchronize()
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph, stream=stream,
                                      capture_error_mode='thread_local'):
                    output = operations(
                        self, static_crop, static_latent, pipeline_size, parameters,
                    )
                state.update(graph=graph, crop=static_crop, latent=static_latent,
                             output=output)
            state['crop'].copy_(crop)
            state['latent'].copy_(latent)
            state['graph'].replay()
            owned = state['output'].clone()
            done = torch.cuda.Event()
            done.record(stream)
            state['lastUse'] = done
            return owned

    def shutdown(self):
            try:
                return old_shutdown(self)
            finally:
                drain(self)

    def delete(self):
            for owner in tuple(owners):
                if getattr(owner, 'models', None) is self:
                    drain(owner)
            return old_delete(self)

    return {'eligible': eligible, 'drain': drain, 'operations': operations, 'prefix': prefix, 'shutdown': shutdown, 'delete': delete}

def make_mask_tail():
    from collections import OrderedDict
    import torch
    from rope import VideoManager as module
    vm = module.VideoManager
    old_shutdown = vm.shutdown_background_workers
    def eligible(self, swap, mask, border, valid, size, parameters):
            if (not isinstance(parameters, dict)
                    or 'BlendSlider' not in parameters
                    or not isinstance(size, int) or size <= 0):
                return False
            if type(parameters['BlendSlider']) is not int:
                return False
            tensors = (swap, mask, border) + (() if valid is None else (valid,))
            if any(not isinstance(t, torch.Tensor) or not t.is_cuda
                   or t.device.index != 0 or t.dtype != torch.float32
                   or not t.is_contiguous() for t in tensors):
                return False
            if (swap.ndim != 3 or tuple(swap.shape) != (3, size, size)
                    or mask.ndim != 3 or border.ndim != 3
                    or tuple(mask.shape) != tuple(border.shape)
                    or mask.shape[0] != 1 or mask.shape[1] <= 0
                    or mask.shape[2] <= 0
                    or valid is not None and tuple(valid.shape) != (1, size, size)):
                return False
            slider = parameters['BlendSlider']
            if slider < 0 or slider > 100:
                return False
            return not torch.cuda.is_current_stream_capturing()

    def operations(self, swap, mask, border, valid, size, slider):
            mask = self._get_gaussian_blur(
                slider * 2 + 1, (slider + 1) * 0.2,
            )(mask)
            mask = torch.mul(mask, border)
            mask = module.v2.Resize((size, size))(mask)
            if valid is not None:
                mask = torch.mul(mask, valid)
            swap = torch.mul(swap, mask)
            return swap, mask

    def graph_tail(self, swap, mask, border, valid, size, parameters):
            slider = int(parameters['BlendSlider'])
            stream = torch.cuda.current_stream(swap.device)
            descriptors = tuple((tuple(t.shape), tuple(t.stride()), t.dtype)
                                for t in (swap, mask, border))
            valid_descriptor = (None if valid is None else
                                (tuple(valid.shape), tuple(valid.stride()), valid.dtype))
            key = (descriptors, valid_descriptor, slider, int(size),
                   int(stream.cuda_stream), str(swap.device))
            cache = getattr(self, '_experimental_mask_tail_graphs', None)
            if cache is None:
                cache = self._experimental_mask_tail_graphs = OrderedDict()
            state = cache.get(key)
            if state is None:
                state = {'seen': 0, 'lastUse': None}
                cache[key] = state
            cache.move_to_end(key)
            while len(cache) > 3:
                _, evicted = cache.popitem(last=False)
                if evicted['lastUse'] is not None:
                    evicted['lastUse'].synchronize()
            state['seen'] += 1
            if state['seen'] < 3:
                return operations(self, swap, mask, border, valid, size, slider)
            if 'graph' not in state:
                static_swap = torch.empty_like(swap)
                static_mask = torch.empty_like(mask)
                static_border = torch.empty_like(border)
                static_valid = None if valid is None else torch.empty_like(valid)
                static_swap.copy_(swap)
                static_mask.copy_(mask)
                static_border.copy_(border)
                if static_valid is not None:
                    static_valid.copy_(valid)
                operations(self, static_swap, static_mask, static_border,
                           static_valid, size, slider)
                stream.synchronize()
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph, stream=stream,
                                      capture_error_mode='thread_local'):
                    output_swap, output_mask = operations(
                        self, static_swap, static_mask, static_border,
                        static_valid, size, slider,
                    )
                state.update(graph=graph, swap=static_swap, mask=static_mask,
                             border=static_border, valid=static_valid,
                             output_swap=output_swap, output_mask=output_mask)
            state['swap'].copy_(swap)
            state['mask'].copy_(mask)
            state['border'].copy_(border)
            if valid is not None:
                state['valid'].copy_(valid)
            state['graph'].replay()
            owned_swap = state['output_swap'].clone()
            owned_mask = state['output_mask'].clone()
            done = torch.cuda.Event()
            done.record(stream)
            state['lastUse'] = done
            return owned_swap, owned_mask

    def shutdown(self):
            try:
                return old_shutdown(self)
            finally:
                cache = getattr(self, '_experimental_mask_tail_graphs', None)
                if cache is not None:
                    for state in cache.values():
                        if state['lastUse'] is not None:
                            state['lastUse'].synchronize()
                    cache.clear()

    return {'eligible': eligible, 'operations': operations, 'graph_tail': graph_tail, 'shutdown': shutdown}

def make_restorer_prepare():
    from collections import OrderedDict
    import numpy as np
    import torch
    from rope import VideoManager as module
    from torchvision.transforms.v2.functional import _geometry as geometry
    v2 = module.v2
    borrow_outputs = True
    def prepare(self, image, transform, size, bilinear):
            # The affine parameters are constant per crop geometry, not face pose:
            # the current face has already been aligned by swap_core.
            angle = transform.rotation * 57.2958
            translation = (transform.translation[0], transform.translation[1])
            scale = transform.scale
            interpolation = v2.InterpolationMode.BILINEAR if bilinear else v2.InterpolationMode.NEAREST

            def operations(source):
                result = geometry._apply_grid_transform(source, entry['grid'], interpolation.value, fill=None)
                result = v2.functional.crop(result, 0, 0, size, size)
                result = torch.unsqueeze(result, 0)
                result = result.to(torch.float32).div(127.5).sub(1.0).contiguous()
                result = v2.Resize((1024, 1024), antialias=False)(result)
                pixels = torch.squeeze(result).to(torch.float32).add(1.0).mul(127.5).clamp(0.0, 255.0)
                return result, pixels

            stream = torch.cuda.current_stream(image.device)
            key = (tuple(image.shape), tuple(image.stride()), image.dtype, str(image.device),
                   int(stream.cuda_stream), np.asarray(transform.params).tobytes(), int(size), bool(bilinear))
            cache = getattr(self, '_experimental_restorer_prepare_graphs', None)
            if cache is None:
                cache = self._experimental_restorer_prepare_graphs = OrderedDict()
            entry = cache.get(key)
            if entry is None:
                entry = {'seen': 0}
                parsed_angle, parsed_translate, parsed_shear, _ = geometry._affine_parse_args(
                    angle, translation, scale, 0, interpolation, (0, 0))
                height, width = image.shape[-2:]
                matrix = geometry._get_inverse_affine_matrix(
                    [-width * 0.5, -height * 0.5], parsed_angle,
                    [float(value) for value in parsed_translate], scale, parsed_shear)
                dtype = image.dtype if torch.is_floating_point(image) else torch.float32
                theta = torch.tensor(matrix, dtype=dtype, device=image.device).reshape(1, 2, 3)
                entry['grid'] = geometry._affine_grid(theta, w=width, h=height, ow=width, oh=height)
                cache[key] = entry
            cache.move_to_end(key)
            while len(cache) > 4:
                _, evicted = cache.popitem(last=False)
                # The graph, static image/grid and queued output clones must stay
                # owned until the last replay on the owner stream completes.
                if evicted.get('lastUse') is not None:
                    evicted['lastUse'].synchronize()
            entry['seen'] += 1
            if entry['seen'] < 3:
                return operations(image)
            if 'graph' not in entry:
                source = image.clone()
                operations(source)
                stream.synchronize()
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                    output, pixels = operations(source)
                entry.update(graph=graph, source=source, output=output, pixels=pixels)
            entry['source'].copy_(image)
            entry['graph'].replay()
            # Experimental borrowed lifetime: both consumers are on this same
            # ordered stream; all persistent temporal histories clone their input.
            # The lease ends at the next prepare call on this VM/stream. Keep the
            # default owned return until the whole-track parity contract passes.
            output, pixels = ((entry['output'], entry['pixels']) if borrow_outputs
                              else (entry['output'].clone(), entry['pixels'].clone()))
            last_use = torch.cuda.Event()
            last_use.record(stream)
            entry['lastUse'] = last_use
            return output, pixels

    return {'prepare': prepare}

def make_mask_overlap(vm, original_policy):
    from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    video_manager_class = vm.VideoManager
    _consume = overlap._consume
    _account_guided_discard = overlap._account_guided_discard
    original_shutdown = video_manager_class.shutdown_background_workers
    def policy(self, context, key, input_tensor, signature, compute,
                   *args, **kwargs):
            if key in ("occluder", "dflXSeg"):
                original = compute
                compute = lambda: _consume(self, key, original, context,
                                           input_tensor, signature=signature)
            return original_policy(
                self, context, key, input_tensor, signature, compute,
                *args, **kwargs,
            )

    def shutdown(self):
            state = getattr(self, "_isolated_mask_overlap", None)
            errors = []
            if state is not None:
                state["executor"].shutdown(wait=True, cancel_futures=False)
                state["stream"].synchronize()
                pending = state["pending"]
                if pending is not None:
                    if pending.get("guided"):
                        _account_guided_discard(state, pending)
                    else:
                        state["discarded"] += len(
                            pending["keys"] - pending["used"]
                        )
                for retired in state["retired"]:
                    _account_guided_discard(state, retired)
                if state["models"] is not None:
                    state["models"].delete_models()
                print("[mask-overlap]", {
                    key: state[key] for key in
                    ("launched", "consumed", "discarded", "fallbackExact", "throttled",
                     "guardLaunched", "guardUsed", "guardFallback", "guidedExtra",
                     "guidedMaskCalls")
                } | {"errors": state["errors"]}, flush=True)
                errors = list(state["errors"])
                self._isolated_mask_overlap = None
            result = original_shutdown(self)
            if errors:
                raise RuntimeError(f"Secondary mask task failed: {errors[0]}")
            return result

    return {'policy': policy, 'shutdown': shutdown}

def make_identity_guard():
    import torch
    from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    from pong_exact_runtime.vendor.experiment_identity_delta_kernel import mean_abs_delta
    from rope.VideoManager import VideoManager, _read_guard_scalars
    fused_delta = True
    old_compute = overlap._compute_guards
    old_launch = overlap._launch
    old_shutdown = VideoManager.shutdown_background_workers
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

    return {'reductions': reductions, 'compute': compute, 'launch': launch, 'guard': guard, 'shutdown': shutdown}

def make_async_readback(engine):
    import queue
    import time
    import numpy as np
    import torch
    from pong_exact_runtime.vendor.experiment_async_readback import AsyncReadbackLease
    original_rgb = engine._process_frame_to_rgb
    original_shutdown = engine.shutdown_gpu_worker
    def _eligible(kwargs):
            if (not kwargs.get('_isolated_async_readback', False)
                    or kwargs.get('diagnostics') is not None):
                return False
            config = kwargs.get('config') or {}
            runtime = config.get('runtime') or {}
            if (not runtime.get('orderedGpuSubmission', False)
                    or runtime.get('temporalForegroundReuseEnabled', False)
                    or runtime.get('temporalExactOutputStabilizationEnabled', False)
                    or runtime.get('temporalExactMouthStabilizationEnabled', False)
                    or runtime.get('temporalSemanticMeshEnabled', False)
                    or runtime.get('temporalSemanticFeaturePatchesEnabled', False)):
                return False
            return True

    def rgb(self, frame, source_embedding, anchor, **kwargs):
            opt_in = _eligible(kwargs)
            kwargs.pop('_isolated_async_readback', None)
            session = kwargs.pop('_isolated_async_session', None)
            if not opt_in or self._compute_stream is None:
                return original_rgb(self, frame, source_embedding, anchor, **kwargs)
            frame_started_at = time.perf_counter()
            frame_start_event = torch.cuda.Event(enable_timing=True)
            frame_start_event.record(self._compute_stream)
            self._isolated_async_readback_active = True
            try:
                swapped, updated_anchor = self.process_frame(
                    frame, source_embedding, anchor, **kwargs,
                )
            except Exception:
                # Restore the source-original failure boundary: an exception must
                # not leave partially submitted GPU work racing model teardown.
                self._compute_stream.synchronize()
                raise
            finally:
                self._isolated_async_readback_active = False
            if swapped is None:
                return None, updated_anchor
            if (not isinstance(swapped, torch.Tensor) or not swapped.is_cuda
                    or swapped.device.index != 0 or swapped.dtype != torch.uint8
                    or swapped.ndim != 3 or swapped.shape[2] != 3
                    or not swapped.is_contiguous()):
                # This should be unreachable for the guarded production frame
                # path, but a changed output contract must still be correct.
                self._compute_stream.synchronize()
                return swapped.cpu().numpy(), updated_anchor
            shape = tuple(swapped.shape)
            pool_shape = getattr(self, '_isolated_async_readback_pool_shape', None)
            pool = getattr(self, '_isolated_async_readback_pool', None)
            if pool is not None and pool_shape != shape:
                if pool.qsize() != 2:
                    # Prior output still owns one slot. Preserve order and pixels
                    # through the original synchronous path for this transition;
                    # a later frame may replace the old pool after it drains.
                    self._compute_stream.synchronize()
                    return swapped.cpu().numpy(), updated_anchor
                pool = None
                self._isolated_async_readback_pool = None
            if pool is None:
                pool = queue.Queue(maxsize=2)
                for _ in range(2):
                    pool.put(torch.empty(shape, dtype=torch.uint8, pin_memory=True))
                self._isolated_async_readback_pool = pool
                self._isolated_async_readback_pool_shape = shape
            copy_stream = getattr(self, '_isolated_async_readback_stream', None)
            if copy_stream is None:
                try:
                    copy_stream = self._isolated_async_readback_stream = torch.cuda.Stream(device=0)
                except Exception:
                    self._compute_stream.synchronize()
                    raise
            try:
                # Other seek/cancel sessions may legitimately still own both
                # engine-wide slots. Never delay a new session's first fragment
                # for pool capacity: use the exact synchronous path immediately.
                pinned = pool.get_nowait()
            except queue.Empty:
                # Never hold the GPU owner indefinitely behind a stalled encoder.
                self._compute_stream.synchronize()
                return swapped.cpu().numpy(), updated_anchor
            try:
                producer_ready = torch.cuda.Event()
                producer_ready.record(self._compute_stream)
                copy_stream.wait_event(producer_ready)
                copy_start = torch.cuda.Event(enable_timing=True)
                copy_done = torch.cuda.Event(enable_timing=True)
                with torch.cuda.stream(copy_stream):
                    copy_start.record(copy_stream)
                    pinned.copy_(swapped, non_blocking=True)
                    copy_done.record(copy_stream)
                swapped.record_stream(copy_stream)
            except Exception:
                self._compute_stream.synchronize()
                copy_stream.synchronize()
                pool.put(pinned)
                raise
            stats_owner = session if session is not None else self
            stats = getattr(stats_owner, '_isolated_async_readback_stats', None)
            if stats is None:
                stats = stats_owner._isolated_async_readback_stats = {
                    'submitted': 0, 'completed': 0, 'firstStartAt': None,
                    'firstSubmitAt': None,
                    'lastCompleteAt': None, 'waitSeconds': 0.0,
                    'copyGpuMs': 0.0, 'gpuFrameMs': 0.0,
                    'outputSeconds': 0.0, 'latencyMs': [],
                }
            submitted_at = time.perf_counter()
            if stats['firstStartAt'] is None:
                stats['firstStartAt'] = frame_started_at
            if stats['firstSubmitAt'] is None:
                stats['firstSubmitAt'] = submitted_at
            stats['submitted'] += 1
            return AsyncReadbackLease(
                pinned, copy_done, copy_start, frame_start_event,
                swapped, pool, frame_started_at, submitted_at, stats,
                getattr(self, '_benchmark_output_sink', None),
            ), updated_anchor

    def shutdown(self, *args, **kwargs):
            result = original_shutdown(self, *args, **kwargs)
            if not result:
                return result
            # The owner can submit a final lease while shutdown drains its queue.
            # Fence after it has exited, before releasing the copy stream/pool.
            copy_stream = getattr(self, '_isolated_async_readback_stream', None)
            if copy_stream is not None:
                copy_stream.synchronize()
            pool = getattr(self, '_isolated_async_readback_pool', None)
            retained = getattr(self, '_isolated_async_abandoned_leases', None)
            if retained:
                for lease in tuple(retained):
                    lease.release()
                    retained.remove(lease)
            if pool is not None and pool.qsize() == 2:
                self._isolated_async_readback_pool = None
                self._isolated_async_readback_pool_shape = None
                self._isolated_async_readback_stream = None
            return result

    return {'_eligible': _eligible, 'rgb': rgb, 'shutdown': shutdown}

def make_lab_inverse():
    import torch
    from rope import VideoManager as module
    from pong_exact_runtime.vendor.experiment_lab_inverse import inverse, transfer
    original = module._lab_to_rgb_chw_uint8
    def call(lab):
            if (lab.is_cuda and lab.device.index == 0 and lab.dtype == torch.float32
                    and lab.ndim == 3 and lab.shape[0] == 3 and min(lab.shape[1:]) > 0
                    and lab.is_contiguous()):
                return inverse(lab)
            return original(lab)

    def guarded(lab, sm, ss, tm, ts):
                values = (lab, sm, ss, tm, ts)
                if (lab.is_cuda and lab.device.index == 0 and lab.ndim == 3
                        and lab.shape[0] == 3 and min(lab.shape[1:]) > 0
                        and all(t.dtype == torch.float32 and t.device == lab.device and t.is_contiguous() for t in values)
                        and all(t.numel() == 3 for t in values[1:])):
                    return transfer(*values)
                return original((lab - sm) / ss * ts + tm)

    return {'call': call, 'guarded': guarded}
