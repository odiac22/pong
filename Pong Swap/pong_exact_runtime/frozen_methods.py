"""Generated exact-candidate methods; edit build_frozen.py, not this file.
Development-time source snapshot only. No runtime source execution.
"""
from __future__ import annotations

# Source: rope.VideoManager.VideoManager.swap_core
# SHA256: 471ed157c37808694e9c99996a41ffb7920b72686072a4f3a3285632c7e68cb5
def swap_core(self, img, kps, s_e, parameters, control, precomputed_latent=None, slot=None, source_frame=None, diagnostics=None, temporal_context=None): # img = RGB
    def mark_stage(name):
        if diagnostics is None:
            return
        event = torch.cuda.Event(enable_timing=True)
        event.record(torch.cuda.current_stream())
        diagnostics.setdefault('_swapCudaEvents', []).append((name, event))

    mark_stage('begin')
    # "512-Native" selects the inswapper_512 model: full 512x512 face
    # crop in a single forward pass, no polyphase decomposition. The
    # numeric modes ('128'/'256'/'512') use the inswapper_128 model
    # with NxN polyphase (dim = swap_size / 128). int() conversion
    # only in the numeric branch since "512-Native" isn't a plain
    # integer; any other/stale value (e.g. a removed mode saved in a
    # marker's parameter snapshot) falls back to the 128 baseline
    # instead of raising on int('256-Native').
    swapper_type = str(parameters['SwapperTypeTextSel'])
    use_native_512 = (swapper_type == '512-Native')
    use_native_256 = (swapper_type == '256-Native')
    use_alphaface = (swapper_type == 'AlphaFace')
    use_hyperswap = (swapper_type == 'HyperSwap1C')
    use_uniface = (swapper_type == 'UniFace')
    if use_native_512:
        swap_size = self._swapper_geometry_size(swapper_type)
        dim = 1
    elif use_native_256 or use_alphaface or use_hyperswap or use_uniface:
        swap_size = self._swapper_geometry_size(swapper_type)
        dim = 1
    elif swapper_type.isdigit():
        swap_size = self._swapper_geometry_size(swapper_type)
        dim = int(swap_size/128)#1, 2, 4
    else:
        swap_size = self._swapper_geometry_size(swapper_type)
        dim = 1
    # inswapper variants (128 / 256-native / 512-native) all consume the
    # emap-projected latent.
    latent_mode = (
        'alphaface' if use_alphaface
        else 'raw' if use_hyperswap
        else 'emap'
    )

    detail_strength = max(
        0.0,
        min(1.0, float(parameters.get('DetailTransferSlider', 0)) / 100.0),
    )
    pipeline_size, tform = self._canonical_face_geometry(
        kps,
        parameters,
        swap_size=swap_size,
    )
    if temporal_context is not None:
        temporal_context['fullCanonicalTransform'] = np.asarray(
            tform.params,
            dtype=np.float64,
        ).copy()
        temporal_context['fullCanonicalPipelineSize'] = int(pipeline_size)

    # Grab the aligned face crop at pipeline_size in a single
    # grid_sample call instead of warp-the-whole-frame + crop. The
    # old v2.functional.affine path computed every pixel of the
    # input frame (~6M pixels at 1080p) and then v2.functional.crop
    # discarded all but the corner pipeline_size x pipeline_size
    # region. grid_sample with a pipeline_size-sized grid only
    # samples the pixels we keep. tform.inverse.params is the
    # pixel-space matrix mapping output (pipeline coords) → input
    # (img coords), which is exactly what _warp_grid_sample needs.
    with nvtx_range("sc_input_warp"):
        input_sample_matrix = np.asarray(tform.inverse.params)[:2, :]
        needs_padding = _affine_crop_needs_padding(
            input_sample_matrix,
            (pipeline_size, pipeline_size),
            (img.shape[-2], img.shape[-1]),
        )
        warped = self._warp_grid_sample(
            img,
            input_sample_matrix,
            (pipeline_size, pipeline_size),
            return_valid_mask=needs_padding,
        )
        if needs_padding:
            pipeline_input_face, pipeline_valid_mask = warped
        else:
            pipeline_input_face = warped
            pipeline_valid_mask = None
        # Cast back to uint8 to match the dtype downstream consumers
        # (apply_occlusion etc.) and the MaskView display branch
        # expect; grid_sample returns float32 because that's what it
        # works in internally.
        pipeline_input_face = pipeline_input_face.to(torch.uint8)
    mark_stage('alignedCrop')
    self._isolated_mask_overlap_launch(
        pipeline_input_face, parameters, temporal_context,
    )

    # Likeness / Distinctiveness tuning — latent shaping over the
    # raw inswapper input. Both default to neutral (1.0 / 0.0).
    latent_scale = float(parameters.get('LikenessSlider', 100)) / 100.0
    extrap_amount = float(parameters.get('EmbExtrapSlider', 0)) / 100.0
    # High Fidelity Cached mode: if this slot already has a measured
    # identity gap, fold it into s_e here so the first (and only)
    # pass uses the corrected embedding. Bootstrap (no cached gap)
    # falls through to the 2-pass block below, which measures the
    # gap from this frame's swap output and persists it.
    # UniFace conditions on a source image rather than an ArcFace latent,
    # so Rope's embedding-correction pass does not apply to it.
    hf_switch_on = bool(parameters.get('HighFidelitySwitch')) and not use_uniface
    hf_mode = str(parameters.get('HighFidelityModeTextSel', 'Cached'))
    hf_alpha = float(parameters.get('HighFidelityAlphaSlider', 50)) / 100.0
    cached_gap = slot.get('HFCorrectionGap') if slot is not None else None
    # HFRefinePending forces a re-measurement on this swap even when
    # a cached gap exists; the 2-pass block below then blends the
    # new measurement into the cache via running mean. The flag is
    # cleared after the merge so the next frame returns to the
    # single-pass cached path.
    hf_refine_pending = bool(slot.get('HFRefinePending')) if slot is not None else False
    hf_cached_hit = (
        hf_switch_on and hf_mode == 'Cached'
        and cached_gap is not None and hf_alpha > 0.0
        and not hf_refine_pending
    )
    with nvtx_range("sc_latent"):
        s_e_for_latent = s_e
        if hf_cached_hit:
            s_e_arr = np.asarray(s_e, dtype=np.float32).reshape(-1)
            s_e_for_latent = s_e_arr + hf_alpha * cached_gap
        if precomputed_latent is not None:
            latent = precomputed_latent
        else:
            latent = self._get_latent_for(
                s_e_for_latent, scale=latent_scale, extrap_amount=extrap_amount,
                latent_mode=latent_mode,
            )
    # Bind without cloning. Both branches below (FaceAdjSwitch affine
    # and the unconditional Resize) return fresh tensors, so the
    # original pipeline_input_face is never mutated in place.
    if self._isolated_swap_prefix_eligible(
            pipeline_input_face, latent, parameters, swap_size, dim,
            pipeline_size, hf_switch_on):
        swap = self._isolated_swap_prefix_graph(
            pipeline_input_face, latent, pipeline_size, parameters)
        mark_stage('swapModel')
    else:
        swap_face_input = pipeline_input_face

        # Optional Scaling # change the thransform matrix
        if parameters['FaceAdjSwitch']:
            swap_face_input = v2.functional.affine(swap_face_input, 0, (0, 0), 1 + parameters['FaceScaleSlider'] / 100, 0, center=(pipeline_dim*128-1, pipeline_dim*128-1), interpolation=v2.InterpolationMode.BILINEAR)

        # Amount 0 is an explicit no-swap preview regardless of whether the
        # optional multi-pass Strength toggle is checked. The settings panel
        # exposes both controls independently, and leaving the checkbox off
        # must not silently turn a visible 0 back into the default 100% swap.
        swap_disabled = float(parameters['StrengthSlider']) <= 0.0
        itex = 0 if swap_disabled else 1
        if parameters['StrengthSwitch'] and not swap_disabled:
            itex = ceil(parameters['StrengthSlider'] / 100.)

        # output_size = int(128 * dim)  -- unused; swap_face_output is
        # always reassigned by poly_pass(...) below before any read.
        # Use the functional form — constructing v2.Resize() per call
        # allocates a transform object, which adds up across the per-
        # face loop. v2.functional.resize is the underlying call the
        # class wraps. Same arg semantics, same output.
        swap_face_input = v2.functional.resize(
            swap_face_input,
            [swap_size, swap_size],
            interpolation=v2.InterpolationMode.BILINEAR,
            antialias=False,
        )
        swap_face_input = swap_face_input.permute(1, 2, 0)
        swap_face_input = torch.div(swap_face_input, 255.0)

        # Dispatch one polyphase pass per strength iteration. The pass
        # implementation is owned by _polyphase_pass_v1 (production),
        # _native_512_pass (single-shot inswapper_512, selected via
        # "512-Native"), or _native_256_pass (single-shot
        # inswapper_256_phase1, selected via "256-Native").
        if use_native_512:
            poly_pass = self._native_512_pass
        elif use_alphaface:
            poly_pass = self._alphaface_pass
        elif use_hyperswap:
            poly_pass = self._hyperswap_pass
        elif use_uniface:
            poly_pass = self._uniface_pass
        elif use_native_256:
            poly_pass = self._native_256_pass
        else:
            poly_pass = self._polyphase_pass_v1

        for k in range(itex):
            with nvtx_range(f"sc_polypass[k={k}]"):
                swap_face_output = poly_pass(
                    swap_face_input, latent, dim, swap_size, parameters,
                    source_frame=source_frame,
                )
                # Track current input as prev_face by reference — no clone.
                # poly_pass writes into a per-thread cached buffer; nothing
                # downstream mutates swap_face_input in place, so a reference
                # is sufficient. (Old code cloned defensively; redundant.)
                prev_face = swap_face_input
                # Only clone the output to feed it back as the next iter's
                # input; otherwise the next poly_pass call would .zero_() the
                # cached buffer and wipe the data we want to swap from. On the
                # final iter there's no next pass, so skip the clone.
                if k < itex - 1:
                    swap_face_input = swap_face_output.clone()
                # mul/clamp are out-of-place: swap_face_output rebinds to a
                # fresh tensor, leaving the cached buffer untouched for reuse.
                swap_face_output = torch.mul(swap_face_output, 255)
                swap_face_output = torch.clamp(swap_face_output, 0, 255)

        # ====== High Fidelity 2-pass refinement ==========================
        # Measure the swap output's identity via ArcFace, compute a
        # corrected source embedding that pushes back toward s_e, and
        # re-run the swap once.
        #
        # Two modes:
        #   Per-frame: measure + re-run every frame (doubles per-face cost).
        #   Cached:    measure once per slot, persist the gap on the slot,
        #              and skip this block on subsequent frames — the
        #              correction was already folded into the first-pass
        #              latent above. Only the bootstrap frame is 2-pass.
        # Cached hits are gated out here so we don't pay the second swap.
        if not swap_disabled and hf_switch_on and not hf_cached_hit and hf_alpha > 0.0:
          with nvtx_range("sc_hf_refine"):
            # swap_face_output is HWC 0-255 float; arcface wants CHW uint8.
            chip = swap_face_output.permute(2, 0, 1).to(torch.uint8)
            try:
                output_emb = self.models.embed_face_chip(chip)
            except Exception as e:
                output_emb = None
                print(f'[swap_core] HighFidelity arcface failed: {e}')
            if output_emb is not None:
                # Correct in the same space as the original s_e
                # (no normalization here — calc_swapper_latent
                # handles that). alpha=0 → no correction; alpha=1
                # → full one-step correction.
                s_e_arr = np.asarray(s_e, dtype=np.float32).reshape(-1)
                out_arr = np.asarray(output_emb, dtype=np.float32).reshape(-1)
                gap = s_e_arr - out_arr
                # Cached mode: persist the gap on the slot so subsequent
                # frames take the single-pass cached path above. When a
                # gap already exists (refine path), blend the new sample
                # into the cache via running mean — multiple refine
                # clicks across different frames converge the gap to
                # the source-identity bias's true mean, reducing the
                # per-frame measurement noise that drove this in the
                # first place.
                if hf_mode == 'Cached' and slot is not None:
                    prev = slot.get('HFCorrectionGap')
                    n_prev = int(slot.get('HFCorrectionGapSamples', 0) or 0)
                    if prev is None or n_prev <= 0:
                        merged_gap = gap
                        merged_n = 1
                    else:
                        merged_gap = (n_prev * prev + gap) / (n_prev + 1)
                        merged_gap = merged_gap.astype(np.float32, copy=False)
                        merged_n = n_prev + 1
                    slot['HFCorrectionGap'] = merged_gap
                    slot['HFCorrectionGapSamples'] = merged_n
                    slot['HFRefinePending'] = False
                    gap = merged_gap
                s_e_corrected = s_e_arr + hf_alpha * gap
                latent2_np = self.models.calc_swapper_latent(
                    s_e_corrected,
                    scale=latent_scale,
                    extrap_amount=extrap_amount,
                    latent_mode=latent_mode,
                )
                latent2 = torch.from_numpy(latent2_np).float().to('cuda')
                # Re-run the same iteration pipeline once with the
                # corrected latent. Don't re-loop StrengthSwitch
                # iterations — those compound strength, not identity.
                swap_face_output = poly_pass(
                    swap_face_input, latent2, dim, swap_size, parameters,
                    source_frame=source_frame,
                )
                swap_face_output = torch.mul(swap_face_output, 255)
                swap_face_output = torch.clamp(swap_face_output, 0, 255)

        swap = (
            pipeline_input_face.clone()
            if swap_disabled
            else swap_face_output.permute(2, 0, 1)
        )

        # Debug dump of the per-frame swap output. Pipeline tensors are RGB;
        # cv2 expects BGR, so flip the channel order before writing.
        # cv2.imwrite('out.jpg', cv2.cvtColor(swap.permute(1, 2, 0).cpu().numpy(), cv2.COLOR_RGB2BGR))

        if parameters['StrengthSwitch'] and not swap_disabled:
            alpha = np.mod(parameters['StrengthSlider'], 100)*0.01
            if alpha==0:
                alpha=1

            # Blend the images
            prev_face = torch.mul(prev_face, 255)
            prev_face = torch.clamp(prev_face, 0, 255)
            prev_face = prev_face.permute(2, 0, 1)

            swap = torch.mul(swap, alpha)
            prev_face = torch.mul(prev_face, 1-alpha)
            swap = torch.add(swap, prev_face)
        # Resize in float32 without the antialias low-pass, then quantize.
        # Previously the cast to uint8 + antialias=True softened the swap
        # (float -> rounded ints before interpolation, plus a Gaussian-ish
        # low-pass baked into the downsample path).
        with nvtx_range("sc_resize_to_pipeline"):
            swap = v2.Resize(
                (pipeline_size, pipeline_size),
                interpolation=v2.InterpolationMode.BICUBIC,
                antialias=False,
            )(swap.type(torch.float32))
            swap = swap.clamp(0, 255).type(torch.uint8)
        mark_stage('swapModel')

    # LAB color transfer on the GPU: shift swap's per-channel LAB
    # mean/std to match the pre-swap target crop. No device->host
    # bounces, no cv2 — same Reinhard transform as before, but the
    # toggle stops causing the one-time cv2/torch warmup stutter.
    if parameters['ColorMatchSwitch']:
      with nvtx_range("sc_color_match"):
        swap = self._match_color(swap, pipeline_input_face, pipeline_valid_mask)

    # Apply color corerctions
    if parameters['ColorSwitch']:
        swap = v2.functional.adjust_contrast(swap, parameters['ColorContrastSlider'])
        swap = v2.functional.adjust_gamma(swap, parameters['ColorGammaSlider'], 1.0)
        swap = v2.functional.adjust_saturation(swap, parameters['ColorSaturationSlider'])

        swap = swap.permute(1, 2, 0).type(torch.float32)
        del_color = torch.tensor([parameters['ColorRedSlider'], parameters['ColorGreenSlider'], parameters['ColorBlueSlider']], device=device)
        swap += del_color
        swap = torch.clamp(swap, min=0, max=255)
        swap = swap.permute(2, 0, 1)

    swap = self._temporal_identity_residual(
        swap,
        pipeline_input_face,
        parameters,
        temporal_context,
    )

    with nvtx_range("sc_mask_compose"):
        border_mask = self._get_border_mask(parameters)

        # Create image mask. Per-thread reusable (1, 128, 128) buffer reset
        # to ones each frame; downstream multiplies (Occluder/FaceParser/
        # Diff) rebind to fresh tensors so the cached storage is only
        # used as the starting value.
        swap_mask = self._get_scratch('swap_mask', (1, 128, 128)).fill_(1.0)

        # Face Diffing
        if parameters["DiffSwitch"]:
            mask = self.apply_fake_diff(swap, pipeline_input_face, parameters["DiffSlider"])
            mask = self._get_gaussian_blur( parameters['BlendSlider']*2+1, (parameters['BlendSlider']+1)*0.2, )(mask.type(torch.float32))
            swap = swap*mask + pipeline_input_face*(1-mask)

        # Restorer
        mark_stage('preRestorer')
        parser_evidence_input = (
            swap
            if temporal_context
            and temporal_context.get('parserUsesPreRestorerBase', False)
            else None
        )
        reference_parser_evidence = None
        if parameters["RestorerSwitch"]:
            if bool(
                temporal_context
                and temporal_context.get('referenceParserMaskDiagnostic', False)
                and str(parameters.get('RestorerTypeTextSel', '')) == 'GPEN512'
                and hasattr(self.models, 'run_GPEN_512_reference')
            ):
                reference_restorer_context = temporal_context.setdefault(
                    '_referenceParserRestorerContext',
                    {},
                )
                for context_key in (
                    'enabled', 'maxInputMae', 'maxInputPatchMae',
                    'exactBlendEnabled', 'exactBlendCurrentWeight',
                    'pixelCenterReturnMap', 'boundedCubicReturnSampler',
                    'boundedCubicWeight', 'monotoneHermiteReturnSampler',
                    'bilinearInputAlignment', 'fusedInputAlignment',
                    'residualReturn', 'residualReturnWeight',
                    'residualReturnMinimumFaceSize',
                    'lowFrequencyAnchorStabilization',
                    'lowFrequencyAnchorStrength',
                    'lowFrequencyAnchorKernel',
                    'lowFrequencyAnchorMaxCorrection',
                    'exactPastebackRoundToNearest',
                    'returnGeometryCache', 'outputFractionalLevels',
                    'frameIndex', 'mediaTimeSeconds', 'maxAnchorFrames',
                    'frameDependencyAnchorFrame',
                    'frameDependencyAnchorTimeSeconds', 'forceExact',
                    'forceExactReasons',
                ):
                    if context_key in temporal_context:
                        reference_restorer_context[context_key] = temporal_context[context_key]
                reference_restorer_context['hybridReferenceReasons'] = (
                    'first-anchor', 'identity-deadline', 'pts-discontinuity',
                    'signature', 'nonpositive-age', 'frame-age',
                    'mean-disagreement', 'patch-disagreement',
                )
                reference_restorer_context['hybridReferenceCadenceByReason'] = {}
                reference_parser_evidence = self.apply_restorer(
                    swap,
                    parameters,
                    temporal_context=reference_restorer_context,
                ).detach().clone()
                temporal_context['referenceParserRestorerFrames'] = int(
                    temporal_context.get('referenceParserRestorerFrames', 0)
                ) + 1
            swap = self.apply_restorer(
                swap,
                parameters,
                temporal_context=temporal_context,
            )
            if bool(
                temporal_context
                and temporal_context.get(
                    'residualParserUsesLegacyAppearance', False
                )
            ):
                legacy_parser_evidence = temporal_context.pop(
                    '_residualReturnLegacyAppearance', None
                )
                if isinstance(legacy_parser_evidence, torch.Tensor):
                    parser_evidence_input = legacy_parser_evidence
                    temporal_context['residualLegacyParserEvidenceFrames'] = int(
                        temporal_context.get(
                            'residualLegacyParserEvidenceFrames', 0
                        )
                    ) + 1
        mark_stage('postRestorer')

        # Preserve real high-frequency texture from the aligned target
        # after restoration, so a restorer cannot blur the recovered
        # detail away. Identity, geometry and color remain generator-owned:
        # only a clamped 3x3 luminance residual is transferred. For the
        # 128px generator this runs on the independent up-to-256px
        # compositing crop above.
        if detail_strength > 0.0:
            with nvtx_range("sc_texture_preserve"):
                detail_gain = 1.35
                if (
                    temporal_context
                    and temporal_context.get('maskRuntimeBackend') == 'trt'
                ):
                    detail_gain += max(
                        0.0,
                        float(temporal_context.get(
                            'maskTrtDetailGainCompensation', 0.0
                        )),
                    )
                target = pipeline_input_face.to(torch.float32)
                if target.shape[-2:] != swap.shape[-2:]:
                    target = v2.functional.resize(
                        target,
                        list(swap.shape[-2:]),
                        interpolation=v2.InterpolationMode.BILINEAR,
                        antialias=False,
                    )
                luma = (
                    target[0:1] * 0.299
                    + target[1:2] * 0.587
                    + target[2:3] * 0.114
                )
                low = torch.nn.functional.avg_pool2d(
                    luma.unsqueeze(0), kernel_size=3, stride=1, padding=1,
                )[0]
                detail = (luma - low).clamp_(-28.0, 28.0)
                swap = (
                    swap.to(torch.float32)
                    + detail * (detail_gain * detail_strength)
                ).clamp_(0.0, 255.0)
                if isinstance(reference_parser_evidence, torch.Tensor):
                    reference_parser_evidence = (
                        reference_parser_evidence.to(torch.float32)
                        + detail * (detail_gain * detail_strength)
                    ).clamp_(0.0, 255.0)
                if isinstance(parser_evidence_input, torch.Tensor):
                    parser_evidence_input = (
                        parser_evidence_input.to(torch.float32)
                        + detail * (detail_gain * detail_strength)
                    ).clamp_(0.0, 255.0)

        # Occluder
        record_mask_substages = bool(
            diagnostics is not None
            and diagnostics.get('_enableMaskSubstageTimings', False)
        )
        if record_mask_substages:
            mark_stage('preOccluder')
        if parameters["OccluderSwitch"]:
            mask = self._temporal_mask_result(
                temporal_context,
                'occluder',
                pipeline_input_face,
                (
                    'occluder', int(parameters["OccluderSlider"]),
                    # The model result is normalized to 128x128 below and
                    # the 64x64 appearance probe independently rejects a
                    # real scene/occlusion change. Including the variable
                    # aligned-crop dimensions here invalidated the mask for
                    # harmless one-pixel detector jitter, causing both a
                    # visible mask pulse and an unnecessary inference.
                    str(
                        temporal_context.get('maskOccluderRuntimeBackend', 'inherit')
                        if temporal_context is not None else 'inherit'
                    ),
                ),
                lambda: v2.Resize((128, 128))(
                    self.apply_occlusion(
                        pipeline_input_face,
                        parameters["OccluderSlider"],
                    )
                ),
                allow_reuse=not bool(
                    temporal_context
                    and temporal_context.get(
                        'currentOccluder',
                        temporal_context.get('currentMasks', False),
                    )
                ),
                force_on_restorer_exact=not bool(
                    temporal_context
                    and temporal_context.get(
                        'occluderDecoupledFromRestorer', False
                    )
                ),
            )
            swap_mask = torch.mul(swap_mask, mask)
        if record_mask_substages:
            mark_stage('postOccluder')

        # DeepFaceLab XSeg (user-supplied occlusion model)
        if parameters["DFLXSegSwitch"]:
            def compute_dfl_xseg_mask():
                current_mask = self.apply_dfl_xseg(
                    pipeline_input_face,
                    parameters["DFLXSegSizeSlider"],
                )
                current_mask = v2.Resize((128, 128))(current_mask)
                if parameters["DFLXSegBlurSlider"] > 0:
                    current_mask = self._get_gaussian_blur(
                        parameters['DFLXSegBlurSlider']*2+1,
                        (parameters['DFLXSegBlurSlider']+1)*0.2,
                    )(current_mask)
                return current_mask

            if bool(
                temporal_context
                and temporal_context.get('dflXSegReuseEnabled', False)
            ):
                mask = self._temporal_mask_result(
                    temporal_context,
                    'dflXSeg',
                    pipeline_input_face,
                    (
                        'dflXSeg',
                        int(parameters["DFLXSegSizeSlider"]),
                        int(parameters["DFLXSegBlurSlider"]),
                        # XSeg is also returned on a fixed 128x128
                        # canonical grid. Appearance thresholds, not the
                        # transient crop size, decide whether it is safe to
                        # transport the prior mask.
                    ),
                    compute_dfl_xseg_mask,
                    allow_reuse=not bool(
                        temporal_context.get('currentMasks', False)
                    ),
                    force_on_restorer_exact=False,
                )
            else:
                mask = self._isolated_mask_overlap_consume('dflXSeg', compute_dfl_xseg_mask, temporal_context, pipeline_input_face, parameters=parameters)
            swap_mask = torch.mul(swap_mask, mask)

        if record_mask_substages:
            mark_stage('preFaceParser')
        # With both controls at zero apply_face_parser returns exactly
        # ones. Its temporal probes, history and final multiply cannot
        # affect pixels; do not synchronize the GPU to validate a no-op.
        parser_is_identity = (
            parameters["FaceParserSlider"] == 0
            and parameters['MouthParserSlider'] == 0
        )
        if parameters["FaceParserSwitch"] and not parser_is_identity:
            parser_decoupled = bool(
                temporal_context
                and temporal_context.get('parserDecoupledFromRestorer', False)
            )
            parser_input = (
                parser_evidence_input
                if isinstance(parser_evidence_input, torch.Tensor)
                else swap
            )
            parser_context = temporal_context
            if isinstance(reference_parser_evidence, torch.Tensor):
                reference_mask_context = temporal_context.setdefault(
                    '_referenceParserMaskContext',
                    {},
                )
                for context_key in (
                    'enabled', 'maxMaskInputMae', 'maxMaskPatchMae',
                    'frameIndex', 'mediaTimeSeconds', 'maxAnchorFrames',
                    'frameDependencyAnchorFrame',
                    'frameDependencyAnchorTimeSeconds', 'forceExact',
                    'forceExactReasons', 'faceParserSkipFrames',
                ):
                    if context_key in temporal_context:
                        reference_mask_context[context_key] = temporal_context[context_key]
                reference_mask_context['restorerExactThisFrame'] = bool(
                    reference_restorer_context.get('restorerExactThisFrame', False)
                )
                parser_context = reference_mask_context
                parser_input = reference_parser_evidence
            parser_quantization_step = float(
                parser_context.get('faceParserEvidenceQuantizationStep', 0.0)
                if parser_context is not None else 0.0
            )
            if parser_quantization_step > 0.0:
                parser_context['parserEvidenceQuantizedFrames'] = int(
                    parser_context.get('parserEvidenceQuantizedFrames', 0)
                ) + 1
                parser_input = torch.round(
                    parser_input / parser_quantization_step
                ).mul_(parser_quantization_step).clamp_(0.0, 255.0)
            def compute_parser_mask():
                if parser_quantization_step > 0.0:
                    parser_context['parserEvidenceQuantizedInferenceFrames'] = int(
                        parser_context.get('parserEvidenceQuantizedInferenceFrames', 0)
                    ) + 1
                return v2.Resize((128, 128))(
                    self.apply_face_parser(
                        parser_input,
                        parameters["FaceParserSlider"],
                        parameters['MouthParserSlider'],
                    )
                )

            mask = self._temporal_mask_result(
                parser_context,
                'faceParser',
                parser_input,
                (
                    'faceParser',
                    int(parameters["FaceParserSlider"]),
                    int(parameters['MouthParserSlider']),
                    *(() if parser_decoupled else (tuple(swap.shape),)),
                    str(
                        temporal_context.get('maskFaceParserRuntimeBackend', 'inherit')
                        if temporal_context is not None else 'inherit'
                    ),
                ),
                compute_parser_mask,
                allow_reuse=not bool(
                    temporal_context
                    and temporal_context.get(
                        'currentFaceParser',
                        temporal_context.get('currentMasks', False),
                    )
                ),
                # The parser classifies semantic regions after resizing to
                # its fixed 512px input.  A GPEN refresh or a small upstream
                # crop-size change is not by itself evidence of a semantic
                # topology change; the existing mean/patch checks remain
                # the authority for safe reuse.
                force_on_restorer_exact=not parser_decoupled,
                minimum_reuse_frames=(
                    int(temporal_context.get('faceParserSkipFrames', 0))
                    if temporal_context
                    else 0
                ),
            )
            swap_mask = torch.mul(swap_mask, mask)
        if record_mask_substages:
            mark_stage('postFaceParser')

        if self._isolated_mask_tail_eligible(
            swap, swap_mask, border_mask, pipeline_valid_mask,
            pipeline_size, parameters):
            swap, swap_mask = self._isolated_mask_tail_graph(
            swap, swap_mask, border_mask, pipeline_valid_mask,
            pipeline_size, parameters)
        else:
            # Add blur to swap_mask results
            swap_mask = self._get_gaussian_blur(
                parameters['BlendSlider']*2+1,
                (parameters['BlendSlider']+1)*0.2,
            )(swap_mask)


            # Combine border and swap mask, scale, and apply to swap
            swap_mask = torch.mul(swap_mask, border_mask)
            # swap_mask = t512(swap_mask)
            swap_mask = v2.Resize((pipeline_size, pipeline_size))(swap_mask)
            # Never blend generated pixels whose aligned target crop came
            # from grid_sample's synthetic zero padding.  This is especially
            # important for faces entering/leaving the frame, where padding
            # otherwise creates a dark edge and corrupts color statistics.
            if pipeline_valid_mask is not None:
                swap_mask = torch.mul(swap_mask, pipeline_valid_mask)
            swap = torch.mul(swap, swap_mask)
    mark_stage('masks')

    if not control['MaskViewButton']:
      with nvtx_range("paste_back"):
        # Reuse the source->aligned transform already estimated for the
        # input crop. Re-estimating the identical five-point transform in
        # every frame added CPU work and could introduce tiny independent
        # floating-point differences between crop and paste-back.
        IM512 = tform.inverse.params[0:2, :]
        corners = np.array([[0,0], [0,pipeline_size-1], [pipeline_size-1, 0], [pipeline_size-1, pipeline_size-1]])

        x = (IM512[0][0]*corners[:,0] + IM512[0][1]*corners[:,1] + IM512[0][2])
        y = (IM512[1][0]*corners[:,0] + IM512[1][1]*corners[:,1] + IM512[1][2])

        left = floor(np.min(x))
        if left<0:
            left=0
        top = floor(np.min(y))
        if top<0: 
            top=0
        right = ceil(np.max(x))
        if right>img.shape[2]:
            right=img.shape[2]            
        bottom = ceil(np.max(y))
        if bottom>img.shape[1]:
            bottom=img.shape[1]   

        # Inverse-warp swap + mask back onto the img canvas with
        # one grid_sample call sized to the destination bbox only.
        # Previous path padded swap to full-frame, warped the
        # full-frame, then cropped to bbox — most of the affine
        # output was thrown away. grid_sample samples directly at
        # the bbox-sized output. Stack swap (3 chan) + mask (1 chan)
        # so one warp handles both at the cost of an extra channel.
        # tform.params is the pixel-space matrix mapping img → swap,
        # which is exactly the "for each output, where to sample
        # from input" matrix grid_sample needs. Bake the (left, top)
        # offset into the matrix's translate column so the helper
        # can use plain output pixel coords [0, bbox_w/h).
        stacked = torch.cat((swap, swap_mask), dim=0)
        bbox_h = bottom - top
        bbox_w = right - left
        if bbox_h > 0 and bbox_w > 0:
            T = np.asarray(tform.params)[:2, :].astype(np.float32, copy=True)
            T[:, 2] = T[:, :2] @ np.array([left, top], dtype=np.float32) + T[:, 2]
            sampled = self._warp_grid_sample(
                stacked, T, (bbox_h, bbox_w),
            )
            swap = sampled[0:3].permute(1, 2, 0)
            swap_mask = sampled[3:4].permute(1, 2, 0)
        else:
            # Degenerate bbox (face entirely off-canvas after
            # clamping). Skip the warp; downstream composite is
            # a no-op anyway because torch.add with empty tensors
            # would error. Set swap/swap_mask to empty so the
            # in-place img assignment below is also no-op.
            swap = torch.empty(
                (0, 0, 3), dtype=torch.float32, device='cuda',
            )
            swap_mask = torch.empty(
                (0, 0, 1), dtype=torch.float32, device='cuda',
            )
        swap_mask = torch.sub(1, swap_mask)

        # Apply the mask to the original image areas. The opt-in FP64 arm
        # changes only this final three-operation composition diagnostic;
        # masks, warps, foreground pixels and truncation remain identical.
        img_crop = img[0:3, top:bottom, left:right]
        img_crop = img_crop.permute(1,2,0)
        float64_composite = bool(
            temporal_context
            and temporal_context.get('exactPastebackFloat64Composite', False)
        )
        if float64_composite:
            swap = torch.add(
                swap.to(torch.float64),
                torch.mul(
                    swap_mask.to(torch.float64),
                    img_crop.to(torch.float64),
                ),
            )
            temporal_context['exactPastebackFloat64Frames'] = int(
                temporal_context.get('exactPastebackFloat64Frames', 0)
            ) + 1
        else:
            img_crop = torch.mul(swap_mask,img_crop)
            swap = torch.add(swap, img_crop)
        swap = self._quantize_exact_pasteback(
            swap,
            round_to_nearest=bool(
                temporal_context
                and temporal_context.get('exactPastebackRoundToNearest', False)
            ),
        )
        if bool(
            temporal_context
            and temporal_context.get('exactPastebackRoundToNearest', False)
        ):
            temporal_context['exactPastebackRoundedFrames'] = int(
                temporal_context.get('exactPastebackRoundedFrames', 0)
            ) + 1
        swap = swap.permute(2,0,1)
        img[0:3, top:bottom, left:right] = swap  

    else:
        # Invert swap mask
        swap_mask = torch.sub(1, swap_mask)

        # Combine preswapped face with swap
        pipeline_input_face = torch.mul(swap_mask, pipeline_input_face)
        pipeline_input_face = torch.add(swap, pipeline_input_face)
        pipeline_input_face = pipeline_input_face.type(torch.uint8)
        pipeline_input_face = pipeline_input_face.permute(1, 2, 0)

        # Uninvert and create image from swap mask
        swap_mask = torch.sub(1, swap_mask) 
        swap_mask = torch.cat((swap_mask,swap_mask,swap_mask),0)
        swap_mask = swap_mask.permute(1, 2, 0)

        # Place them side by side
        img = torch.hstack([pipeline_input_face, swap_mask*255])
        img = img.permute(2,0,1)

    mark_stage('pasteBack')
    return img


# Source: rope.VideoManager.VideoManager._temporal_identity_residual
# SHA256: b4e94539b52a8284e5b5ca7fc64a4b9d8fabc0911370db4ef353d49795222505
def _temporal_identity_residual(
    self,
    swap,
    aligned_input,
    parameters,
    temporal_context,
):
    """Stabilize identity appearance without freezing current geometry.

    Both tensors are in the same canonical crop.  The aligned current
    source remains the base for every frame; only ``swap - source`` is
    temporally filtered.  A spatial source-change map drives the filter to
    full current-frame weight around motion, expression, and occlusion.
    Cuts and large changes replace the anchor outright.
    """
    if not bool(
        temporal_context
        and temporal_context.get(
            'identityResidualStabilizationEnabled', False
        )
    ):
        return swap
    if bool(temporal_context.get('identityResidualHighMotionOnly', False)):
        if str(temporal_context.get('adaptiveMaskMotionClass', '')) != 'cuda':
            temporal_context.pop('identityResidualAnchor', None)
            temporal_context['identityResidualReason'] = 'low-motion-bypass'
            return swap
    current_input = aligned_input.to(torch.float32)
    current_swap = swap.to(torch.float32)
    signature = (
        str(parameters.get('SwapperTypeTextSel', '128')),
        bool(parameters.get('StrengthSwitch', False)),
        int(parameters.get('StrengthSlider', 100)),
        int(parameters.get('LikenessSlider', 100)),
        int(parameters.get('EmbExtrapSlider', 0)),
        tuple(current_input.shape),
    )
    residual = current_swap - current_input
    state = temporal_context.get('identityResidualAnchor')

    def publish_anchor(reason):
        temporal_context['identityResidualAnchor'] = {
            'signature': signature,
            'frameIndex': temporal_context.get('frameIndex', 0),
            'mediaTimeSeconds': temporal_context.get('mediaTimeSeconds'),
            'input': aligned_input.detach().clone(),
            'residual': residual.detach().clone(),
        }
        temporal_context['identityResidualExactFrames'] = int(
            temporal_context.get('identityResidualExactFrames', 0)
        ) + 1
        temporal_context['identityResidualReason'] = reason
        return swap

    if not isinstance(state, dict) or state.get('signature') != signature:
        return publish_anchor('first-anchor')
    if _history_reset_requested(temporal_context):
        return publish_anchor('temporal-reset')
    if state.get('mediaTimeSeconds') is not None and _temporal_elapsed_seconds(temporal_context, state) <= 0:
        return publish_anchor('timestamp-reset')
    prior_input = state.get('input')
    prior_residual = state.get('residual')
    if (
        not isinstance(prior_input, torch.Tensor)
        or not isinstance(prior_residual, torch.Tensor)
        or prior_input.shape != aligned_input.shape
        or prior_residual.shape != residual.shape
        or prior_input.device != aligned_input.device
        or prior_residual.device != residual.device
    ):
        return publish_anchor('invalid-state')
    source_delta, (finite, input_mae, patch_mae) = self._isolated_identity_guard(
        temporal_context, aligned_input, state, prior_input,
    )
    if not bool(finite):
        return publish_anchor('nonfinite-input')
    temporal_context['identityResidualInputMae'] = input_mae
    temporal_context['identityResidualInputPatchMae'] = patch_mae
    if (
        input_mae > float(
            temporal_context.get('identityResidualMaxInputMae', 20.0)
        )
        or patch_mae > float(
            temporal_context.get(
                'identityResidualMaxInputPatchMae', 48.0
            )
        )
    ):
        return publish_anchor('appearance-change')
    fallback_current_weight = float(np.clip(
        temporal_context.get('identityResidualCurrentWeight', 0.70),
        0.0,
        1.0,
    ))
    try:
        nominal_delta_seconds = float(
            _temporal_elapsed_seconds(temporal_context, state)
        )
        half_life_seconds = float(
            temporal_context.get('identityResidualHalfLifeSeconds', 0.020)
        )
    except (TypeError, ValueError, OverflowError):
        nominal_delta_seconds = math.nan
        half_life_seconds = math.nan
    if (
        math.isfinite(nominal_delta_seconds)
        and math.isfinite(half_life_seconds)
        and nominal_delta_seconds > 0.0
        and half_life_seconds > 0.0
    ):
        current_weight = float(np.clip(
            1.0 - math.exp(
                -math.log(2.0)
                * nominal_delta_seconds
                / half_life_seconds
            ),
            0.0,
            1.0,
        ))
    else:
        current_weight = fallback_current_weight
    temporal_context['identityResidualEffectiveCurrentWeight'] = current_weight
    change_low = float(
        temporal_context.get('identityResidualChangeLow', 2.0)
    )
    change_high = max(
        change_low + 1e-6,
        float(temporal_context.get('identityResidualChangeHigh', 14.0)),
    )
    output, stabilized_residual = self._isolated_identity_graph_apply(
        current_input, prior_residual, residual, source_delta,
        current_weight, change_low, change_high,
    )
    temporal_context['identityResidualAnchor'] = {
        'signature': signature,
        'frameIndex': temporal_context.get('frameIndex', 0),
        'mediaTimeSeconds': temporal_context.get('mediaTimeSeconds'),
        'input': aligned_input.detach().clone(),
        'residual': stabilized_residual.detach().clone(),
    }
    temporal_context['identityResidualReusedFrames'] = int(
        temporal_context.get('identityResidualReusedFrames', 0)
    ) + 1
    temporal_context['identityResidualReason'] = 'accepted'
    return output


# Source: rope.VideoManager.VideoManager._apply_restorer_inner
# SHA256: f2815dcf7bc7f9ed0d015dc40db3caf67adcdf61ada74d96e2782cd0b2def102
def _apply_restorer_inner(self, swapped_face_upscaled, parameters, temporal_context=None):
    # Fixed-frame controls deliberately render without a playback temporal
    # history. Treat that absence as an empty read/write context so all
    # optional GPEN scheduling maps remain safe while temporal reuse stays
    # disabled. This also keeps the normal playback dictionary unchanged.
    temporal_context = temporal_context or {}
    face_size = swapped_face_upscaled.shape[1]
    face_dim = face_size / 128.0
    input_face = swapped_face_upscaled.clone()
    bilinear_input_alignment = bool(
        temporal_context
        and temporal_context.get('bilinearInputAlignment', False)
    )
    fused_input_alignment = bool(
        temporal_context
        and temporal_context.get('fusedInputAlignment', False)
        and str(parameters.get('RestorerTypeTextSel', '')) == 'GPEN512'
        and str(parameters.get('RestorerDetTypeTextSel', '')) == 'Blend'
    )
    residual_return = bool(
        temporal_context
        and temporal_context.get('residualReturn', False)
        and str(parameters.get('RestorerTypeTextSel', '')) in {'GPEN256', 'GPEN512'}
        and str(parameters.get('RestorerDetTypeTextSel', '')) == 'Blend'
        and int(face_size) >= int(
            temporal_context.get('residualReturnMinimumFaceSize', 0)
        )
    )
    if residual_return and temporal_context is not None:
        temporal_context['residualReturnFrames'] = int(
            temporal_context.get('residualReturnFrames', 0)
        ) + 1
    input_already_resized = False
    prepared_pixels = None

    # If using a separate detection mode
    transformed = False
    if parameters['RestorerDetTypeTextSel'] == 'Blend' or parameters['RestorerDetTypeTextSel'] == 'Reference':
        transformed = True
        if parameters['RestorerDetTypeTextSel'] == 'Blend':
            dst_init = self.arcface_dst

        elif parameters['RestorerDetTypeTextSel'] == 'Reference':
            try:
                dst_init = self.models.resnet50(input_face, score=parameters['DetectScoreSlider']/100.0)/4.0
            except:
                return

        dst = dst_init * face_dim
        dst[:, 0] += 8.0 * face_dim

        f_kps = self.FFHQ_kps * face_dim
        f_kps[:, 0] += 8.0 * face_dim

        tform = trans.SimilarityTransform.from_estimate(dst, f_kps)

        # Transform, scale, and normalize
        if fused_input_alignment:
            # Map GPEN512 output pixel centers directly into the original
            # compositing crop.  This is inverse(alignment) composed with
            # PyTorch's half-pixel resize contract; there is no aligned
            # uint8 intermediate and no second resize.
            aligned_to_input = np.linalg.inv(
                np.asarray(tform.params, dtype=np.float64)
            ).astype(np.float32)
            input_face = self._restorer_input_affine_resize(
                input_face.to(torch.float32).unsqueeze(0),
                aligned_to_input,
                aligned_size=int(face_size),
                out_size=512,
            )
            input_already_resized = True
        else:
            if (parameters['RestorerTypeTextSel'] == 'GPEN1024'
                    and parameters['RestorerDetTypeTextSel'] == 'Blend'
                    and input_face.is_cuda):
                input_face, prepared_pixels = self._isolated_restorer_prepare(
                    input_face, tform, face_size, bilinear_input_alignment)
                input_already_resized = True
            else:
                input_face = v2.functional.affine(
                    input_face,
                    tform.rotation * 57.2958,
                    (tform.translation[0], tform.translation[1]),
                    tform.scale,
                    0,
                    center=(0, 0),
                    interpolation=(
                        v2.InterpolationMode.BILINEAR
                        if bilinear_input_alignment
                        else v2.InterpolationMode.NEAREST
                    ),
                )
                input_face = v2.functional.crop(input_face, 0,0, face_size, face_size)

    if not input_already_resized:
        input_face = torch.unsqueeze(input_face, 0)
    if prepared_pixels is None:
        input_face = input_face.to(torch.float32).div(127.5).sub(1.0).contiguous()

    # Run the chosen restorer. GPEN temporal mode retains only the signed
    # restoration residual in canonical aligned model space. Every frame
    # still performs fresh detection/tracking, InSwapper, masks, texture,
    # and compositing; a validated intervening frame applies the last exact
    # GPEN correction to its own current aligned input. Exact anchor frames
    # use the untouched model output directly.
    restorer_type = str(parameters['RestorerTypeTextSel'])
    if restorer_type == 'GPEN256':
        out_size = 256
        run_restorer = self.models.run_GPEN_256
    elif restorer_type == 'GFPGAN1.3':
        out_size = 512
        run_restorer = self.models.run_GFPGAN13
    elif restorer_type == 'CodeFormer':
        out_size = 512
        run_restorer = self.models.run_codeformer
    elif restorer_type == 'GPEN512':
        out_size = 512
        run_restorer = self.models.run_GPEN_512
    elif restorer_type == 'GPEN1024':
        out_size = 1024
        run_restorer = self.models.run_GPEN_1024
    elif restorer_type == 'RestoreFormer++':
        out_size = 512
        run_restorer = self.models.run_restoreformer
    else:
        raise ValueError(f"Unsupported restorer: {restorer_type}")

    if not input_already_resized:
        input_face = v2.Resize((out_size, out_size), antialias=False)(input_face)
    if prepared_pixels is None:
        current_input_pixels = (
            torch.squeeze(input_face).to(torch.float32).add(1.0).mul(127.5).clamp(0.0, 255.0)
        )
    else:
        current_input_pixels = prepared_pixels
    temporal_supported = restorer_type in {'GPEN256', 'GPEN512', 'GPEN1024'}
    temporal_enabled = bool(temporal_context and temporal_context.get('enabled') and temporal_supported)
    if temporal_enabled:
        temporal_context['restorerExactThisFrame'] = False
    frame_index = int(temporal_context.get('frameIndex', 0)) if temporal_enabled else 0
    max_anchor_frames = max(1, int(temporal_context.get('maxAnchorFrames', 1))) if temporal_enabled else 1
    anchor_state = temporal_context.get('restorerAnchor') if temporal_enabled else None
    alignment_mode = str(parameters['RestorerDetTypeTextSel'])
    # GPEN corrections live on the fixed out_size canonical grid.  Blend
    # scales both templates with face_size, so a changing outer crop size
    # is not by itself a storage incompatibility; the unchanged appearance
    # gates below still decide whether its contents correspond.  Reference
    # uses a second landmark model whose cross-size coordinate contract is
    # not proven, so keep face_size in that mode's key.
    pixel_center_return_map = bool(
        temporal_context
        and temporal_context.get('pixelCenterReturnMap', False)
        and alignment_mode == 'Blend'
    )
    bounded_cubic_return_sampler = bool(
        temporal_context
        and temporal_context.get('boundedCubicReturnSampler', False)
        and restorer_type == 'GPEN512'
        and alignment_mode == 'Blend'
    )
    bounded_cubic_weight = float(np.clip(
        temporal_context.get('boundedCubicWeight', 1.0)
        if temporal_context is not None else 1.0,
        0.0,
        1.0,
    ))
    monotone_hermite_return_sampler = bool(
        temporal_context
        and temporal_context.get('monotoneHermiteReturnSampler', False)
        and restorer_type == 'GPEN512'
        and alignment_mode == 'Blend'
    )
    # Experimental samplers are mutually exclusive.  The Hermite flag is
    # the newer, explicitly selected contract when both appear in an old
    # benchmark configuration.
    if monotone_hermite_return_sampler:
        bounded_cubic_return_sampler = False
    return_sampler = (
        'minmod-hermite-symmetric-v1'
        if monotone_hermite_return_sampler
        else ('bounded-cubic-v1' if bounded_cubic_return_sampler else 'bilinear-v1')
    )
    return_geometry_cache = bool(
        temporal_context
        and temporal_context.get('returnGeometryCache', False)
    )
    expected_signature = (
        restorer_type,
        int(out_size),
        alignment_mode,
        (
            'gpen-canonical-return-center-v2'
            if pixel_center_return_map
            else 'gpen-canonical-v1'
        ),
        return_sampler,
        round(bounded_cubic_weight, 6),
        'input-bilinear-v1' if bilinear_input_alignment else 'input-nearest-v1',
        'input-fused-fp32-v1' if fused_input_alignment else 'input-two-pass-v1',
        'correction-return-v1' if residual_return else 'image-return-v1',
    )
    if alignment_mode == 'Reference':
        expected_signature += (int(face_size),)
    if temporal_enabled:
        spatial_controller_signature = (
            expected_signature,
            tuple(sorted(str(value) for value in temporal_context.get(
                'spatialExactBlendTriggerReasons', ()
            ))),
            int(temporal_context.get(
                'spatialExactBlendTriggerMaxGapFrames', 0
            )),
            int(temporal_context.get(
                'spatialExactBlendTriggerMinimumEvents', 2
            )),
            round(float(temporal_context.get(
                'spatialExactBlendTriggerMinimumPatchToMeanRatio', 0.0
            )), 6),
            int(temporal_context.get(
                'spatialExactBlendBurstHoldFrames', 0
            )),
            round(float(temporal_context.get(
                'spatialExactBlendCurrentWeight', 0.75
            )), 6),
            round(float(temporal_context.get(
                'spatialExactBlendChangeLow', 1.0
            )), 6),
            round(float(temporal_context.get(
                'spatialExactBlendChangeHigh', 8.0
            )), 6),
            round(float(temporal_context.get(
                'spatialExactBlendEdgeGuardFraction', 0.0
            )), 6),
        )
        spatial_state_signature = temporal_context.get(
            'spatialExactBlendStateSignature'
        )
        if spatial_state_signature != spatial_controller_signature:
            temporal_context.pop(
                'spatialExactBlendRecentTriggerFrames', None
            )
            temporal_context.pop(
                'spatialExactBlendBurstUntilFrame', None
            )
            temporal_context.pop(
                'spatialExactBlendLastTriggerFrame', None
            )
            temporal_context.pop(
                'spatialExactBlendLastObservedFrame', None
            )
            temporal_context['spatialExactBlendStateSignature'] = (
                spatial_controller_signature
            )
    reason_bits = []
    frame_age = (
        None
        if not anchor_state
        else frame_index - int(anchor_state.get('frameIndex', -1))
    )
    if temporal_enabled:
        if not anchor_state:
            reason_bits.append('first-anchor')
        if temporal_context.get('forceExact', False):
            force_reasons = temporal_context.get('forceExactReasons') or ('force-exact',)
            # Only GPEN may retain its confidence-gated correction after
            # strong same-frame detector/identity recovery. Mask stages
            # still see lk-failure and recompute current occlusion.
            recovered = temporal_context.get('restorerDetectorRecoveryConfirmed', False)
            reason_bits.extend(str(reason) for reason in force_reasons
                               if not (recovered and reason == 'lk-failure'))
        if anchor_state and anchor_state.get('signature') != expected_signature:
            reason_bits.append('signature')
        if frame_age is not None and frame_age <= 0:
            reason_bits.append('nonpositive-age')
        if frame_age is not None and frame_age >= max_anchor_frames:
            reason_bits.append('frame-age')
    can_reuse = bool(temporal_enabled and not reason_bits)
    metrics_evaluated = False
    prepared_confidence = None
    prepared_uncertain = None
    metric_values = {}
    residual_for_current = None
    reuse_reason = 'accepted'
    patch_max_x = None
    patch_max_y = None
    if can_reuse:
        anchor_input = anchor_state.get('inputPixels')
        residual = anchor_state.get('residual')
        if (
            not isinstance(anchor_input, torch.Tensor)
            or not isinstance(residual, torch.Tensor)
            or anchor_input.shape != current_input_pixels.shape
            or residual.shape != current_input_pixels.shape
        ):
            can_reuse = False
            reason_bits.append('invalid-state')
        else:
            residual_for_current = residual
            # Canonical-space image disagreement catches expressions,
            # lighting jumps and newly revealed occlusion before reuse.
            metrics_evaluated = True
            patch_grid, guard_values, prepared_confidence, prepared_uncertain = (
                self._isolated_restorer_guard_graph(
                    current_input_pixels, anchor_input, out_size,
                    temporal_context.get('correctionLocalGuardEnabled', False)))
            finite, mean_value, max_value, index_value = guard_values
            if not bool(finite):
                disagreement = math.inf
                patch_disagreement = math.inf
                reason_bits.append('nonfinite-input')
            else:
                disagreement = float(mean_value)
                patch_disagreement = float(max_value)
                patch_index_value = int(index_value)
                patch_columns = max(1, int(patch_grid.shape[-1]))
                patch_rows = max(1, int(patch_grid.shape[-2]))
                patch_max_x = (
                    (patch_index_value % patch_columns) + 0.5
                ) / float(patch_columns)
                patch_max_y = (
                    (patch_index_value // patch_columns) + 0.5
                ) / float(patch_rows)
            temporal_context['lastInputMae'] = disagreement
            temporal_context['lastInputPatchMae'] = patch_disagreement
            metric_values = {
                'inputMae': disagreement,
                'patchMae': patch_disagreement,
                'patchMaxX': patch_max_x,
                'patchMaxY': patch_max_y,
                'currentFaceSize': int(face_size),
                'anchorFaceSize': anchor_state.get('faceSize'),
            }
            if math.isfinite(disagreement) and disagreement > float(
                temporal_context.get('maxInputMae', 18.0)
            ):
                reason_bits.append('mean-disagreement')
            if math.isfinite(patch_disagreement) and patch_disagreement > float(
                temporal_context.get('maxInputPatchMae', 34.0)
            ):
                reason_bits.append('patch-disagreement')
                lower_center_min_x = float(
                    temporal_context.get('hybridLowerCenterMinX', 0.45)
                )
                lower_center_max_x = float(
                    temporal_context.get('hybridLowerCenterMaxX', 0.70)
                )
                lower_center_min_y = float(
                    temporal_context.get('hybridLowerCenterMinY', 0.70)
                )
                if (
                    patch_max_x is not None
                    and patch_max_y is not None
                    and lower_center_min_x <= patch_max_x <= lower_center_max_x
                    and patch_max_y >= lower_center_min_y
                ):
                    reason_bits.append('lower-center-disagreement')
            if (
                not math.isfinite(disagreement)
                or not math.isfinite(patch_disagreement)
                or disagreement > float(temporal_context.get('maxInputMae', 18.0))
                or patch_disagreement > float(temporal_context.get('maxInputPatchMae', 34.0))
            ):
                can_reuse = False

    if (
        not can_reuse
        and temporal_enabled
        and temporal_context.get('registeredResidualReuse', False)
        and anchor_state
        and reason_bits
        and set(reason_bits).issubset({'mean-disagreement', 'patch-disagreement'})
    ):
        registered_residual, registered_metrics = self._registered_restorer_residual(
            current_input_pixels,
            anchor_state.get('inputPixels'),
            anchor_state.get('residual'),
            temporal_context,
        )
        metric_values.update(registered_metrics)
        if isinstance(registered_residual, torch.Tensor):
            residual_for_current = registered_residual
            can_reuse = True
            reuse_reason = 'registered-accepted'

    reuse_confidence = None
    if (not can_reuse and temporal_context.get('localRefreshEnabled', False)
            and temporal_context.get('correctionLocalGuardEnabled', False)
            and anchor_state and reason_bits
            and set(reason_bits).issubset({'patch-disagreement', 'lower-center-disagreement'})):
        confidence = (prepared_confidence if prepared_confidence is not None else
                      _correction_confidence(current_input_pixels, anchor_state['inputPixels']))
        uncertain_fraction = (float(prepared_uncertain) if prepared_uncertain is not None else
                              float((confidence < 0.25).float().mean().item()))
        metric_values['uncertainCorrectionFraction'] = uncertain_fraction
        if math.isfinite(uncertain_fraction) and uncertain_fraction <= 0.15:
            # A small uncertain region gets the fresh swapper pixels now,
            # never an unrelated historical correction. Stable regions
            # keep full-resolution GPEN detail until the timed refresh.
            # Cuts, elapsed deadlines, global change and identity loss can
            # never enter this branch.
            can_reuse = True
            reuse_confidence = confidence
            residual_for_current = anchor_state['residual']
            reuse_reason = 'local-correspondence-guard'
    if can_reuse and temporal_context.get('correctionLocalGuardEnabled', False):
        if reuse_confidence is None:
            reuse_confidence = (prepared_confidence if prepared_confidence is not None else
                                _correction_confidence(current_input_pixels, anchor_state['inputPixels']))
        # Uncertain local correspondence uses the current swapper result,
        # not a stale GPEN correction at unrelated canonical coordinates.
        residual_for_current = residual_for_current * reuse_confidence

    if can_reuse:
        outpred = (current_input_pixels + residual_for_current).clamp(0.0, 255.0)
        self._mark_temporal_dependency(temporal_context, anchor_state)
        temporal_context['reusedFrames'] = int(temporal_context.get('reusedFrames', 0)) + 1
        self._record_temporal_stage_decision(
            temporal_context,
            'restorer',
            'reused',
            reuse_reason,
            metrics_evaluated=metrics_evaluated,
            metrics=metric_values,
            anchor_state=anchor_state,
        )
    else:
        model_output = self._get_scratch(
            f'restorer_output_{out_size}',
            (1, 3, out_size, out_size),
        )
        # Benchmark-only paired-backend calibration capture.  Production
        # contexts never provide this sink.  Capture the exact contiguous
        # normalized tensor consumed by GPEN, before either backend runs.
        capture_sink = (
            temporal_context.get('restorerCaptureSink')
            if temporal_context is not None
            else None
        )
        capture_limit = int(
            temporal_context.get('restorerCaptureLimit', 0)
            if temporal_context is not None
            else 0
        )
        capture_metadata_sink = (
            temporal_context.get('restorerCaptureMetadataSink')
            if temporal_context is not None
            else None
        )
        if (
            isinstance(capture_sink, list)
            and capture_limit > 0
            and len(capture_sink) < capture_limit
            and restorer_type == 'GPEN512'
        ):
            capture_sink.append(
                input_face.detach().to(
                    device='cpu', dtype=torch.float32
                ).numpy()[0].copy()
            )
            if isinstance(capture_metadata_sink, list):
                capture_metadata_sink.append({
                    'frameIndex': int(temporal_context.get('frameIndex', -1)),
                    'mediaTimeSeconds': (
                        float(temporal_context['mediaTimeSeconds'])
                        if temporal_context.get('mediaTimeSeconds') is not None
                        else None
                    ),
                    'exactRestorerInput': True,
                })
        hybrid_reasons = set(
            str(value)
            for value in (
                temporal_context.get('hybridReferenceReasons', ())
                if temporal_context is not None else ()
            )
        )
        matched_hybrid_reasons = [
            reason for reason in reason_bits if reason in hybrid_reasons
        ]
        selected_hybrid_reason = (
            matched_hybrid_reasons[0] if matched_hybrid_reasons else None
        )
        hybrid_cadence = 1
        hybrid_ordinal = 0
        if selected_hybrid_reason is not None and temporal_context is not None:
            cadence_by_reason = temporal_context.get(
                'hybridReferenceCadenceByReason', {}
            )
            hybrid_cadence = max(
                1,
                int(cadence_by_reason.get(selected_hybrid_reason, 1)),
            )
            counters = temporal_context.setdefault(
                'hybridReferenceReasonCounters', {}
            )
            hybrid_ordinal = int(counters.get(selected_hybrid_reason, 0))
            counters[selected_hybrid_reason] = hybrid_ordinal + 1
        phase_by_reason = temporal_context.get(
            'hybridReferencePhaseByReason', {}
        )
        hybrid_phase = 0
        if selected_hybrid_reason is not None:
            hybrid_phase = max(
                0,
                min(
                    hybrid_cadence - 1,
                    int(phase_by_reason.get(selected_hybrid_reason, 0)),
                ),
            )
        minimum_input_mae_by_reason = (
            temporal_context.get(
                'hybridReferenceMinimumInputMaeByReason', {}
            )
            if temporal_context is not None else {}
        )
        hybrid_minimum_input_mae = 0.0
        if selected_hybrid_reason is not None:
            hybrid_minimum_input_mae = max(
                0.0,
                float(
                    minimum_input_mae_by_reason.get(
                        selected_hybrid_reason, 0.0
                    )
                ),
            )
        hybrid_input_mae = float(metric_values.get('inputMae', 0.0))
        use_hybrid_reference = bool(
            restorer_type == 'GPEN512'
            and selected_hybrid_reason is not None
            and hybrid_ordinal % hybrid_cadence == hybrid_phase
            and hybrid_input_mae >= hybrid_minimum_input_mae
            and hasattr(self.models, 'run_GPEN_512_reference')
        )
        if hybrid_reasons:
            metric_values['hybridConfiguredReasons'] = sorted(hybrid_reasons)
            metric_values['hybridMatchedReasons'] = matched_hybrid_reasons
            metric_values['hybridSelectedReason'] = selected_hybrid_reason
            metric_values['hybridReasonOrdinal'] = hybrid_ordinal
            metric_values['hybridReasonCadence'] = hybrid_cadence
            metric_values['hybridReasonPhase'] = hybrid_phase
            metric_values['hybridMinimumInputMae'] = (
                hybrid_minimum_input_mae
            )
        if use_hybrid_reference:
            hybrid_reference_weight = float(np.clip(
                (temporal_context.get(
                    'hybridReferenceBlendWeightByReason'
                ) or {}).get(
                    selected_hybrid_reason,
                    temporal_context.get(
                        'hybridReferenceBlendWeight', 1.0
                    ),
                ),
                0.0,
                1.0,
            ))
            if hybrid_reference_weight >= 1.0:
                self.models.run_GPEN_512_reference(
                    input_face, model_output
                )
            else:
                # Both paths consume the identical canonical tensor. Keep
                # the selected fast output and cross-fade only this
                # explicitly scheduled reference anchor; default weight
                # one retains the historical byte path.
                run_restorer(input_face, model_output)
                reference_output = torch.empty_like(model_output)
                self.models.run_GPEN_512_reference(
                    input_face, reference_output
                )
                model_output.lerp_(
                    reference_output, hybrid_reference_weight
                )
            metric_values['hybridReference'] = True
            metric_values['hybridReferenceBlendWeight'] = (
                hybrid_reference_weight
            )
        else:
            run_restorer(input_face, model_output)
        # Format back to CxHxW @ 255 — still at native model size.
        outpred = torch.squeeze(model_output)
        outpred = torch.clamp(outpred, -1, 1)
        outpred = torch.add(outpred, 1)
        outpred = torch.div(outpred, 2)
        outpred = torch.mul(outpred, 255)
        fractional_levels = int(
            temporal_context.get('outputFractionalLevels', 0)
            if temporal_context is not None else 0
        )
        if fractional_levels > 0:
            temporal_context['outputFractionalFrames'] = int(
                temporal_context.get('outputFractionalFrames', 0)
            ) + 1
            outpred = torch.round(
                outpred * float(fractional_levels)
            ).div_(float(fractional_levels))
        if temporal_enabled:
            # A scheduled GPEN refresh can otherwise replace the complete
            # canonical correction in one frame, creating a visible
            # restoration pop even when source appearance is essentially
            # unchanged.  Blend corrections only for an ordinary age
            # refresh and only behind strict whole-face + local-patch
            # agreement. Identity, timestamp, cut, tracking and local
            # disagreement refreshes always keep the untouched exact
            # model output.
            exact_blended = False
            prior_residual = (
                anchor_state.get('residual') if anchor_state else None
            )
            raw_new_residual = outpred - current_input_pixels
            prior_raw_residual = (
                anchor_state.get('rawResidual') if anchor_state else None
            )
            prior_input = (
                anchor_state.get('inputPixels') if anchor_state else None
            )
            blend_reasons = set(reason_bits)
            low_frequency_stabilized = False
            spatial_exact_blended = False
            spatial_blend_trigger_reasons = set(
                str(value)
                for value in temporal_context.get(
                    'spatialExactBlendTriggerReasons', ()
                )
            )
            spatial_trigger_max_gap = max(
                0,
                int(temporal_context.get(
                    'spatialExactBlendTriggerMaxGapFrames', 0
                )),
            )
            spatial_trigger_ratio_minimum = max(
                0.0,
                float(temporal_context.get(
                    'spatialExactBlendTriggerMinimumPatchToMeanRatio', 0.0
                )),
            )
            spatial_trigger_input_mae = float(
                metric_values.get('inputMae', math.inf)
            )
            spatial_trigger_patch_mae = float(
                metric_values.get('patchMae', math.inf)
            )
            spatial_trigger_patch_to_mean_ratio = (
                spatial_trigger_patch_mae
                / max(spatial_trigger_input_mae, 1e-6)
                if math.isfinite(spatial_trigger_input_mae)
                and math.isfinite(spatial_trigger_patch_mae)
                else -math.inf
            )
            spatial_trigger_current = bool(
                bool(blend_reasons & spatial_blend_trigger_reasons)
                and spatial_trigger_patch_to_mean_ratio
                >= spatial_trigger_ratio_minimum
            )
            spatial_trigger_minimum_events = max(
                1,
                int(temporal_context.get(
                    'spatialExactBlendTriggerMinimumEvents', 2
                )),
            )
            last_spatial_observed_frame = temporal_context.get(
                'spatialExactBlendLastObservedFrame'
            )
            if (
                last_spatial_observed_frame is not None
                and frame_index < int(last_spatial_observed_frame)
            ):
                temporal_context.pop(
                    'spatialExactBlendBurstUntilFrame', None
                )
                recent_spatial_trigger_frames = []
            else:
                recent_spatial_trigger_frames = [
                int(value)
                for value in temporal_context.get(
                    'spatialExactBlendRecentTriggerFrames', ()
                )
                if spatial_trigger_max_gap <= 0
                or 0 <= frame_index - int(value) <= spatial_trigger_max_gap
                ]
            spatial_trigger_duplicate = bool(
                last_spatial_observed_frame is not None
                and frame_index == int(last_spatial_observed_frame)
            )
            temporal_context['spatialExactBlendLastObservedFrame'] = frame_index
            if spatial_trigger_current and not spatial_trigger_duplicate:
                recent_spatial_trigger_frames.append(frame_index)
            temporal_context['spatialExactBlendRecentTriggerFrames'] = (
                recent_spatial_trigger_frames[-spatial_trigger_minimum_events:]
            )
            spatial_trigger_density_qualified = bool(
                spatial_trigger_current
                and spatial_trigger_max_gap > 0
                and len(recent_spatial_trigger_frames)
                >= spatial_trigger_minimum_events
            )
            spatial_trigger_burst_hold = max(
                0,
                int(temporal_context.get(
                    'spatialExactBlendBurstHoldFrames', 0
                )),
            )
            spatial_trigger_burst_until = int(temporal_context.get(
                'spatialExactBlendBurstUntilFrame', -1
            ))
            if (
                spatial_trigger_density_qualified
                and spatial_trigger_burst_hold > 0
            ):
                spatial_trigger_burst_until = max(
                    spatial_trigger_burst_until,
                    frame_index + spatial_trigger_burst_hold,
                )
                temporal_context['spatialExactBlendBurstUntilFrame'] = (
                    spatial_trigger_burst_until
                )
            spatial_trigger_burst_active = bool(
                spatial_trigger_burst_hold > 0
                and frame_index <= spatial_trigger_burst_until
            )
            # A continued risky exact-anchor event renews an already
            # qualified burst.  It cannot start one by itself, so isolated
            # camera motion remains on the untouched rendering path.
            if (
                spatial_trigger_burst_active
                and spatial_trigger_current
            ):
                spatial_trigger_burst_until = (
                    frame_index + spatial_trigger_burst_hold
                )
                temporal_context['spatialExactBlendBurstUntilFrame'] = (
                    spatial_trigger_burst_until
                )
            spatial_trigger_gap_valid = bool(
                spatial_trigger_max_gap <= 0
                or spatial_trigger_density_qualified
                or spatial_trigger_burst_active
            )
            if (
                temporal_context.get(
                    'lowFrequencyAnchorStabilization', False
                )
                and anchor_state
                and anchor_state.get('signature') == expected_signature
                and blend_reasons
                and blend_reasons.issubset({
                    'frame-age', 'mean-disagreement', 'patch-disagreement',
                    'lower-center-disagreement',
                })
                and isinstance(prior_raw_residual, torch.Tensor)
                and prior_raw_residual.shape == raw_new_residual.shape
            ):
                kernel = max(
                    3,
                    int(temporal_context.get(
                        'lowFrequencyAnchorKernel', 15
                    )),
                )
                if kernel % 2 == 0:
                    kernel += 1
                previous_low = torch.nn.functional.avg_pool2d(
                    prior_raw_residual.unsqueeze(0),
                    kernel_size=kernel,
                    stride=1,
                    padding=kernel // 2,
                )[0]
                current_low = torch.nn.functional.avg_pool2d(
                    raw_new_residual.unsqueeze(0),
                    kernel_size=kernel,
                    stride=1,
                    padding=kernel // 2,
                )[0]
                maximum = max(
                    0.0,
                    float(temporal_context.get(
                        'lowFrequencyAnchorMaxCorrection', 3.0
                    )),
                )
                strength = float(np.clip(
                    temporal_context.get(
                        'lowFrequencyAnchorStrength', 0.15
                    ),
                    0.0,
                    1.0,
                ))
                low_frequency_correction = (
                    previous_low - current_low
                ).clamp_(-maximum, maximum)
                outpred = (
                    outpred + low_frequency_correction * strength
                ).clamp_(0.0, 255.0)
                low_frequency_stabilized = True
                temporal_context['lowFrequencyAnchorStabilizedFrames'] = int(
                    temporal_context.get(
                        'lowFrequencyAnchorStabilizedFrames', 0
                    )
                ) + 1
                metric_values['lowFrequencyAnchorStrength'] = strength
                metric_values['lowFrequencyAnchorCorrectionMae'] = float(
                    low_frequency_correction.abs().mean().item()
                )
            if (
                temporal_context.get('spatialExactBlendEnabled', False)
                and anchor_state
                and anchor_state.get('signature') == expected_signature
                and blend_reasons
                and spatial_trigger_gap_valid
                and (
                    not temporal_context.get(
                        'spatialExactBlendRequiresHybridReference', False
                    )
                    or use_hybrid_reference
                )
                and (
                    not spatial_blend_trigger_reasons
                    or bool(
                        blend_reasons & spatial_blend_trigger_reasons
                    )
                )
                and blend_reasons.issubset({
                    'frame-age', 'mean-disagreement', 'patch-disagreement',
                    'lower-center-disagreement',
                })
                and isinstance(prior_residual, torch.Tensor)
                and isinstance(prior_input, torch.Tensor)
                and prior_residual.shape == raw_new_residual.shape
                and prior_input.shape == current_input_pixels.shape
            ):
                change_low = max(
                    0.0,
                    float(temporal_context.get(
                        'spatialExactBlendChangeLow', 1.0
                    )),
                )
                change_high = max(
                    change_low + 1e-6,
                    float(temporal_context.get(
                        'spatialExactBlendChangeHigh', 8.0
                    )),
                )
                current_weight = float(np.clip(
                    temporal_context.get(
                        'spatialExactBlendCurrentWeight', 0.75
                    ),
                    0.0,
                    1.0,
                ))
                appearance_change = torch.mean(
                    torch.abs(current_input_pixels - prior_input),
                    dim=0,
                    keepdim=True,
                ).unsqueeze(0)
                # A small spatial average prevents single-pixel noise from
                # switching the temporal policy while preserving real
                # expression and occlusion boundaries.
                appearance_change = torch.nn.functional.avg_pool2d(
                    appearance_change,
                    kernel_size=5,
                    stride=1,
                    padding=2,
                )[0]
                change_weight = (
                    (appearance_change - change_low)
                    / (change_high - change_low)
                ).clamp_(0.0, 1.0)
                change_weight = change_weight * change_weight * (
                    3.0 - 2.0 * change_weight
                )
                effective_weight = (
                    current_weight
                    + (1.0 - current_weight) * change_weight
                )
                edge_guard_fraction = float(np.clip(
                    temporal_context.get(
                        'spatialExactBlendEdgeGuardFraction', 0.0
                    ),
                    0.0,
                    0.49,
                ))
                if edge_guard_fraction > 0.0:
                    height, width = appearance_change.shape[-2:]
                    y = torch.linspace(
                        0.0, 1.0, height,
                        device=appearance_change.device,
                        dtype=appearance_change.dtype,
                    ).reshape(1, height, 1)
                    x = torch.linspace(
                        0.0, 1.0, width,
                        device=appearance_change.device,
                        dtype=appearance_change.dtype,
                    ).reshape(1, 1, width)
                    edge_distance = torch.minimum(
                        torch.minimum(x, 1.0 - x),
                        torch.minimum(y, 1.0 - y),
                    )
                    edge_guard = (
                        (edge_guard_fraction - edge_distance)
                        / edge_guard_fraction
                    ).clamp_(0.0, 1.0)
                    edge_guard = edge_guard * edge_guard * (
                        3.0 - 2.0 * edge_guard
                    )
                    effective_weight = effective_weight + (
                        1.0 - effective_weight
                    ) * edge_guard
                blended_residual = (
                    prior_residual * (1.0 - effective_weight)
                    + raw_new_residual * effective_weight
                )
                outpred = (
                    current_input_pixels + blended_residual
                ).clamp_(0.0, 255.0)
                spatial_exact_blended = True
                temporal_context['restorerSpatialExactBlendedFrames'] = int(
                    temporal_context.get(
                        'restorerSpatialExactBlendedFrames', 0
                    )
                ) + 1
                metric_values.update({
                    'spatialExactBlendCurrentWeight': current_weight,
                    'spatialExactBlendChangeLow': change_low,
                    'spatialExactBlendChangeHigh': change_high,
                    'spatialExactBlendEdgeGuardFraction': (
                        edge_guard_fraction
                    ),
                    'spatialExactBlendTriggerPatchToMeanRatio': (
                        spatial_trigger_patch_to_mean_ratio
                    ),
                })
            if (
                temporal_context.get('exactBlendEnabled', False)
                and anchor_state
                and anchor_state.get('signature') == expected_signature
                and blend_reasons
                and blend_reasons.issubset(
                    {'frame-age', 'identity-deadline'}
                )
                and isinstance(prior_residual, torch.Tensor)
                and isinstance(prior_input, torch.Tensor)
                and prior_residual.shape == current_input_pixels.shape
                and prior_input.shape == current_input_pixels.shape
            ):
                blend_delta = torch.abs(current_input_pixels - prior_input)
                blend_mae = float(torch.mean(blend_delta).item())
                blend_local = torch.mean(
                    blend_delta, dim=0, keepdim=True
                ).unsqueeze(0)
                blend_kernel = max(8, int(out_size // 16))
                blend_patch_mae = float(
                    torch.nn.functional.avg_pool2d(
                        blend_local,
                        kernel_size=blend_kernel,
                        stride=blend_kernel,
                    ).max().item()
                )
                metric_values.update({
                    'exactBlendInputMae': blend_mae,
                    'exactBlendPatchMae': blend_patch_mae,
                })
                if (
                    math.isfinite(blend_mae)
                    and math.isfinite(blend_patch_mae)
                    and blend_mae
                    <= float(temporal_context.get('maxInputMae', 18.0))
                    and blend_patch_mae
                    <= float(temporal_context.get('maxInputPatchMae', 34.0))
                ):
                    current_weight = float(np.clip(
                        temporal_context.get(
                            'exactBlendCurrentWeight', 0.75
                        ),
                        0.0,
                        1.0,
                    ))
                    new_residual = outpred - current_input_pixels
                    blended_residual = torch.lerp(
                        prior_residual,
                        new_residual,
                        current_weight,
                    )
                    outpred = (
                        current_input_pixels + blended_residual
                    ).clamp(0.0, 255.0)
                    exact_blended = True
                    metric_values['exactBlendCurrentWeight'] = current_weight
            temporal_context['restorerExactBlendedThisFrame'] = exact_blended
            temporal_context['restorerSpatialExactBlendedThisFrame'] = (
                spatial_exact_blended
            )
            temporal_context['restorerLowFrequencyStabilizedThisFrame'] = (
                low_frequency_stabilized
            )
            temporal_context['restorerExactThisFrame'] = True
            temporal_context['restorerAnchor'] = {
                'signature': expected_signature,
                'faceSize': int(face_size),
                'frameIndex': frame_index,
                'anchorFrameIndex': frame_index,
                'anchorMediaTimeSeconds': temporal_context.get('mediaTimeSeconds'),
                'inputPixels': current_input_pixels.detach().clone(),
                'residual': (outpred - current_input_pixels).detach().clone(),
                'rawResidual': raw_new_residual.detach().clone(),
            }
            temporal_context['exactFrames'] = int(temporal_context.get('exactFrames', 0)) + 1
            self._record_temporal_stage_decision(
                temporal_context,
                'restorer',
                'exact',
                reason_bits[0] if reason_bits else 'unspecified',
                known_reasons=reason_bits,
                metrics_evaluated=metrics_evaluated,
                metrics=metric_values,
                anchor_state=anchor_state,
            )

    if temporal_enabled and temporal_context.get('correctionStabilizationEnabled', False):
        displayed_correction = _stabilize_restorer_correction(
            current_input_pixels, outpred - current_input_pixels,
            temporal_context, expected_signature, reuse_confidence)
        outpred = (current_input_pixels + displayed_correction).clamp(0.0, 255.0)

    blend_applied = False
    if transformed:
        # Combined inverse-affine + downsize from out_size to face_size
        # in one grid_sample. The original two-step path was:
        #   Resize(out_size -> face_size) at face_size_aligned
        #   v2.functional.affine(tform.inverse) at face_size_unaligned
        # v2.functional.affine treats its arg as a FORWARD transform
        # and inverts it for backward sampling, so passing tform.inverse
        # there resolves to sampling input at tform.forward(output_pixel).
        # Composing with the uniform (out_size/face_size) scale that
        # the prior Resize introduced gives the backward map our
        # grid_sample helper consumes: face_size_unaligned output ->
        # out_size_aligned input via scale * tform.forward.
        T = self._restorer_return_sample_matrix(
            tform.params,
            out_size=out_size,
            face_size=face_size,
            pixel_center_correct=pixel_center_return_map,
        )
        if temporal_context is not None:
            temporal_context['restorerReturnMapVersion'] = (
                'pixel-center-v2' if pixel_center_return_map else 'legacy-v1'
            )
            temporal_context['restorerReturnMapTranslation'] = [
                float(T[0, 2]), float(T[1, 2])
            ]
            temporal_context['restorerReturnMapFaceSize'] = int(face_size)
            temporal_context['restorerReturnMapOutputSize'] = int(out_size)
        return_input = (
            torch.cat((outpred, current_input_pixels), dim=0).unsqueeze(0)
            if residual_return
            else outpred.unsqueeze(0)
        )
        returned = self._affine_resize_grid_sample(
            return_input, T,
            in_h=out_size, in_w=out_size,
            out_h=face_size, out_w=face_size,
            sampler=return_sampler,
            bounded_cubic_weight=bounded_cubic_weight,
            cache_geometry=(
                bounded_cubic_return_sampler
                or monotone_hermite_return_sampler
                or return_geometry_cache
            ),
            temporal_context=temporal_context,
        ).squeeze(0)
        if residual_return:
            returned_prediction = returned[0:3]
            returned_current = returned[3:6]
            alpha = float(parameters["RestorerSlider"]) / 100.0
            residual_result = self._compose_restorer_residual_return(
                swapped_face_upscaled,
                returned_prediction,
                returned_current,
                alpha,
            )
            legacy_result = torch.add(
                torch.mul(returned_prediction, alpha),
                torch.mul(swapped_face_upscaled, 1.0 - alpha),
            )
            if bool(
                temporal_context
                and temporal_context.get(
                    'residualParserUsesLegacyAppearance', False
                )
            ):
                temporal_context['_residualReturnLegacyAppearance'] = (
                    legacy_result
                )
            residual_weight = float(np.clip(
                temporal_context.get('residualReturnWeight', 1.0)
                if temporal_context is not None else 1.0,
                0.0,
                1.0,
            ))
            outpred = torch.lerp(
                legacy_result,
                residual_result,
                residual_weight,
            )
            blend_applied = True
        else:
            outpred = returned
    elif out_size != face_size:
        # No alignment warp requested — still need to land on the
        # face_size pipeline buffer. Single Resize, no affine.
        outpred = v2.Resize((face_size, face_size), antialias=False)(outpred)

    # Blend
    if not blend_applied:
        alpha = float(parameters["RestorerSlider"])/100.0
        outpred = torch.add(torch.mul(outpred, alpha), torch.mul(swapped_face_upscaled, 1-alpha))

    return outpred


# Source: rope.VideoManager.VideoManager._match_color
# SHA256: e60a4b0666803f91c81b7d002a2b17159ff305a145901e0809a60fcdf208fd50
def _match_color(self, swap, target, valid_mask=None):
    # Graph replay changes launch scheduling only. Each frame supplies new
    # RGB pixels and its current validity mask; no color statistics freeze.
    if (not getattr(self, 'color_match_cuda_graph_enabled', False)
            or not swap.is_cuda or swap.dtype not in (torch.uint8, torch.float32)
            or target.dtype not in (torch.uint8, torch.float32)):
        return _match_lab_color(swap, target, valid_mask)
    # The original LAB conversion clamps FP32 inputs in place. Preserve
    # that side effect for downstream detail transfer as well as pixels.
    if swap.dtype == torch.float32:
        swap.clamp_(0, 255)
    if target.dtype == torch.float32:
        target.clamp_(0, 255)
    stream = torch.cuda.current_stream(swap.device)
    key = (str(swap.device), int(stream.cuda_stream), tuple(swap.shape), swap.dtype,
           tuple(target.shape), target.dtype, None if valid_mask is None else (tuple(valid_mask.shape), valid_mask.dtype))
    cache = getattr(self, '_color_match_graphs', None)
    if cache is None:
        cache = self._color_match_graphs = OrderedDict()
    if key not in cache:
        state = None
        try:
            source_buffer, target_buffer = swap.clone(), target.clone()
            mask_buffer = None if valid_mask is None else valid_mask.clone()
            for _ in range(3):
                _match_lab_color(source_buffer, target_buffer, mask_buffer)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                output = _match_lab_color(source_buffer, target_buffer, mask_buffer)
            state = (graph, source_buffer, target_buffer, mask_buffer, output)
        except Exception as exc:
            self.color_match_graph_error = f'{type(exc).__name__}: {exc}'
        cache[key] = state
        while len(cache) > 4:
            cache.popitem(last=False)
    state = cache[key]
    if state is None:
        return _match_lab_color(swap, target, valid_mask)
    cache.move_to_end(key)
    graph, source_buffer, target_buffer, mask_buffer, output = state
    source_buffer.copy_(swap)
    target_buffer.copy_(target)
    if mask_buffer is not None:
        mask_buffer.copy_(valid_mask)
    graph.replay()
    return output


# Source: rope.Models.Models._detect_retinaface_inner
# SHA256: 9b23800ff527d7281c14379190d9d3d61b2e941ce67962b4b20d5be9649135ac
def _detect_retinaface_inner(self, img, max_num, score, input_size=640):
    # Resize image to fit within the input_size. Model is fully
    # convolutional so it accepts any multiple-of-32 edge length;
    # smaller input → linearly less compute → faster detect at the
    # cost of recall on small faces.
    #
    # Clamp to the configured TRT-EP profile range (320-640) when
    # TRT is active. The session is configured with that explicit
    # profile in _create_retinaface_session, so requests outside
    # the range would error inside ORT.
    with nvtx_range("rf_preprocess"):
        original_height = int(img.shape[1])
        original_width = int(img.shape[2])
        if self._retinaface_uses_trt and hasattr(self, '_retinaface_trt_input_max'):
            lo = self._retinaface_trt_input_min
            hi = self._retinaface_trt_input_max
            req = int(input_size)
            if req < lo or req > hi:
                if not self._retinaface_engine_size_warned:
                    print(
                        '[Models] retinaface TRT-EP profile accepts '
                        f'sizes {lo}-{hi}; requested {req}. Clamping to '
                        f'{hi}.'
                    )
                    self._retinaface_engine_size_warned = True
                req = max(lo, min(hi, req))
            input_size = req
        input_size = (int(input_size), int(input_size))
        # Plain Python float math — the previous torch.div on int args
        # wrapped both in CUDA tensors for a single scalar divide, paid
        # tensor-allocation overhead, and forced a downstream sync via
        # `.numpy()`. None of that is needed; these are scalars.
        im_ratio = float(img.size()[1]) / float(img.size()[2])

        model_ratio = float(input_size[1]) / input_size[0]
        if im_ratio>model_ratio:
            new_height = input_size[1]
            new_width = int(new_height / im_ratio)
        else:
            new_width = input_size[0]
            new_height = int(new_width * im_ratio)
        det_scale = float(new_height) / float(img.size()[1])

        # Resize input to (3, new_h, new_w) uint8 on GPU. This kernel
        # is the dominant cost of preprocessing; the rest of the chain
        # below is cheap arithmetic on the resized tile.
        img_resized = v2.functional.resize(
            img, [new_height, new_width], antialias=True,
        )

        # Pre-allocated per-worker letterbox buffer (1, 3, H, W) float32.
        # Reusing it across calls avoids the torch.zeros allocator hit
        # every frame; keeping the canonical (1, 3, H, W) shape end-to-
        # end avoids the HWC↔CHW permute + .contiguous() round-trip
        # the legacy path needed before the io_binding bind_input call.
        det_img = self._get_retinaface_input_buffer(input_size[0])
        # Zero the previous frame's letterbox padding. zero_() on the
        # cached buffer is one kernel and small; restricting to the
        # padding strips would need more launches than just clearing
        # the whole thing.
        det_img.zero_()
        # BGR swap + uint8→float + normalize + slice-write fused into
        # one chained expression. img_resized[[2, 1, 0]] is the BGR
        # reindex (advanced indexing returns a contiguous copy);
        # .float() materializes a float32 buffer; .sub_()/.div_() are
        # in-place on that fresh buffer (no extra allocations); .copy_()
        # writes the result into det_img's letterbox slot. Total: one
        # gather + one type-cast + two in-place ops + one copy_, vs the
        # legacy six-op chain (zero, slice, BGR, sub, div, contiguous).
        det_img[0, :, :new_height, :new_width].copy_(
            img_resized[[2, 1, 0]].float().sub_(127.5).div_(128.0)
        )

    with nvtx_range("rf_ort_run"):
        # det_10g has 9 outputs — 3 scores, 3 bbox deltas, 3 kps deltas
        # at strides 8/16/32. The downstream loop consumes them by index.
        _RF_OUTPUT_ORDER = (
            '448', '471', '494',  # scores @ stride 8 / 16 / 32
            '451', '474', '497',  # bbox deltas
            '454', '477', '500',  # kps deltas
        )

        # Pre-allocate output buffers on GPU. Shapes are deterministic
        # from input_size + stride (det_10g has 2 anchors per cell).
        # Binding them as buffer_ptr lets ORT write directly into our
        # torch tensors, so the entire post-processing stays on GPU —
        # no copy_outputs_to_cpu, no host round-trip before NMS.
        input_height = det_img.shape[2]
        input_width = det_img.shape[3]
        strides = (8, 16, 32)
        retinaface_session = self._get_retinaface_session()
        persistent_state = self._get_retinaface_io_state(
            retinaface_session, input_height,
        )
        if persistent_state is not None:
            persistent_state['input'].copy_(det_img)
            score_bufs = persistent_state['score_bufs']
            bbox_bufs = persistent_state['bbox_bufs']
            kps_bufs = persistent_state['kps_bufs']
            io_binding = persistent_state['binding']
        else:
            score_bufs, bbox_bufs, kps_bufs = self._get_retinaface_output_buffers(
                input_height
            )
            io_binding = retinaface_session.io_binding()
            io_binding.bind_input(
                name='input.1', device_type='cuda', device_id=0,
                element_type=np.float32, shape=det_img.size(),
                buffer_ptr=det_img.data_ptr(),
            )
            for i, name in enumerate(_RF_OUTPUT_ORDER[:3]):
                buf = score_bufs[i]
                io_binding.bind_output(
                    name=name, device_type='cuda', device_id=0,
                    element_type=np.float32, shape=tuple(buf.shape),
                    buffer_ptr=buf.data_ptr(),
                )
            for i, name in enumerate(_RF_OUTPUT_ORDER[3:6]):
                buf = bbox_bufs[i]
                io_binding.bind_output(
                    name=name, device_type='cuda', device_id=0,
                    element_type=np.float32, shape=tuple(buf.shape),
                    buffer_ptr=buf.data_ptr(),
                )
            for i, name in enumerate(_RF_OUTPUT_ORDER[6:9]):
                buf = kps_bufs[i]
                io_binding.bind_output(
                    name=name, device_type='cuda', device_id=0,
                    element_type=np.float32, shape=tuple(buf.shape),
                    buffer_ptr=buf.data_ptr(),
                )

        # Conditional torch-stream drain. Skipped when the session was
        # built with user_compute_stream pointing at the worker's
        # current torch stream (Per-Thread + worker stream): same
        # stream means implicit ordering.
        if self._should_drain_syncvec():
            self.syncvec.cpu()
        self._run_owned_gpu_binding(retinaface_session, io_binding,
            persistent_state['input'] if persistent_state is not None else det_img,
            *score_bufs, *bbox_bufs, *kps_bufs)

    with nvtx_range("rf_postprocess"):
        # ===== GPU-side post-processing =====
        # Everything from here runs in torch on the worker's CUDA
        # stream — bbox decode, kps decode, score threshold, cross-
        # stride concat, sort, scale-back, NMS. The GIL is released
        # during the CUDA kernels, so other workers don't queue up
        # waiting for it during the bulk of detect_retinaface's tail
        # (which was the dominant source of "User Request" GIL waits
        # in the 2026-05-21 nsys trace).
        scores_list = []
        bboxes_list = []
        kpss_list = []
        for idx, stride in enumerate(strides):
            scores_t = score_bufs[idx].view(-1)              # (N,)
            bbox_preds = bbox_bufs[idx] * stride             # (N, 4)
            kps_preds = kps_bufs[idx] * stride               # (N, 10)
            height = input_height // stride
            width = input_width // stride
            anchor_centers = self._get_retinaface_gpu_anchors(
                height, width, stride,
            )                                                # (N, 2)

            # Single cross-stride threshold below.

            # Bbox decode: anchor ± delta. Sign pattern [-x1, -y1, +x2,
            # +y2] matches det_10g's FCOS-style face regression head.
            ax = anchor_centers[:, 0]
            ay = anchor_centers[:, 1]
            bboxes = torch.stack(
                [
                    ax - bbox_preds[:, 0],
                    ay - bbox_preds[:, 1],
                    ax + bbox_preds[:, 2],
                    ay + bbox_preds[:, 3],
                ],
                dim=-1,
            )                                                # (N, 4)

            # KPS decode: 5 (x, y) pairs per anchor, all sharing the
            # same anchor offset. The numpy original looped over pairs;
            # vectorized this is `view + broadcast-add`.
            kpss = kps_preds.view(-1, 5, 2) + anchor_centers.unsqueeze(1)

            scores_list.append(scores_t)
            bboxes_list.append(bboxes)
            kpss_list.append(kpss)

        all_scores, all_bboxes, all_kpss = _isolated_retinaface_compact(
            scores_list, bboxes_list, kpss_list, score,
        )

        if all_scores.numel() == 0:
            return np.zeros((0, 5, 2), dtype=np.float32)

        # Sort by score descending (matches the np.argsort()[::-1] in
        # the old code), then NMS in IoU space. det_scale division
        # rescales from the letterboxed model space back to original
        # image coordinates.
        order = torch.argsort(all_scores, descending=True)
        all_scores = all_scores[order]
        all_bboxes = all_bboxes[order] / det_scale
        all_kpss = all_kpss[order] / det_scale

        keep = torchvision.ops.nms(all_bboxes, all_scores, iou_threshold=0.4)

        # max_num truncation with area-minus-center-distance weighting.
        # Boxes are now in original-frame coordinates, so rank them
        # against the original frame center (not det_img's batch/channel
        # dimensions).
        if max_num > 0 and keep.shape[0] > max_num:
            kept_bboxes = all_bboxes[keep]
            values = _center_weighted_face_values(
                kept_bboxes,
                original_width,
                original_height,
            )
            bindex = torch.argsort(values, descending=True)[:max_num]
            keep = keep[bindex]

        # Single device boundary at the very end. Everything before
        # was queued on the worker's CUDA stream.
        # Baseline 1.12: keep the scores of the returned faces (same
        # order) for occlusion-aware landmark checks. Same sync point.
        self._last_detect_scores = all_scores[keep].cpu().numpy()
        return all_kpss[keep].cpu().numpy()


# Source: rope.gpen_runtime.GPENRuntime.prepare
# SHA256: 5e93a8f8cdbf9f04985085aeaa07e0592bae87f1045e6e38ece27cb521386332
def prepare(self, edge, *, allow_create=True):
    with self.lock:
        state = self._states.get(edge)
        if state is not None:
            self._check_stream(state)
            if not state['ready']:
                raise RuntimeError('GPEN state failed; unload before retrying')
            return
        if not allow_create:
            raise RuntimeError(f'GPEN{edge} is not ready; warm the selected restorer while idle')
        if self.owner._model_session_mode == 'Shared':
            self._check_stream({'stream': self.owner._shared_compute_stream})
        state = self._new_state(edge)
        self._states[edge] = state
        try:
            self._check_stream(state)
            shape = (1, 3, edge, edge)
            image = self.torch.zeros(shape, dtype=self.torch.float32, device='cuda:0')
            output = self.torch.empty(shape, dtype=self.torch.float32, device='cuda:0')
            output.fill_(float('nan'))
            binding = (
                None if state.get('native') is not None
                else self._binding(state['session'], image, output)
            )
            # Also retain unbound warm-up storage on failure; a failed GPU
            # fence must not leave a session referring to freed temporaries.
            state.update(input=image, output=output, binding=binding)
            if (
                state.get('native') is not None
                and state['native'].get('kind') == 'split-repair'
            ):
                self._prepare_split_buffers(state)
            # Shared Pong sessions are bound to the exact persistent torch
            # stream used for this call, so stream ordering is sufficient.
            # Retain the host fence for unbound/different-stream callers.
            if self._needs_producer_fence(state):
                self.owner.syncvec.cpu()
            if state.get('native') is not None:
                if state['native'].get('kind') == 'split-repair':
                    self._run_native_split(state, image, output)
                else:
                    context = state['native']['context']
                    if (not context.set_tensor_address('input', image.data_ptr())
                            or not context.set_tensor_address('output', output.data_ptr())
                            or not context.execute_async_v3(int(state['stream'].cuda_stream))):
                        raise RuntimeError('Native TensorRT GPEN warm-up submission failed')
                if state.get('staticResidual') is not None:
                    output.add_(state['staticResidual'])
            else:
                state['session'].run_with_iobinding(binding)
            if state.get('native') is not None:
                # Validate the candidate before the optional reference run
                # can overwrite the same public warm-up output buffer.
                self._synchronize(state)
                if not self.torch.isfinite(output).all().item():
                    raise RuntimeError('Native GPEN warm-up produced nonfinite output')
            if state.get('referenceSession') is not None:
                reference_binding = self._binding(
                    state['referenceSession'], image, output
                )
                state['referenceSession'].run_with_iobinding(reference_binding)
            self._synchronize(state)
            if not self.torch.isfinite(output).all().item():
                raise RuntimeError('GPEN warm-up produced nonfinite output')
            if (bool(getattr(self.owner, '_gpen_cuda_graph', False))
                    and state.get('native') is not None
                    and state['native'].get('kind') != 'split-repair'
                    and state['stream'] is not None):
                # Capture only the already-qualified engine submission.
                # Stable, owned I/O buffers keep every replay independent
                # of caller allocation lifetimes and changing face views.
                graph = self.torch.cuda.CUDAGraph()
                with self.torch.cuda.graph(graph, stream=state['stream'], capture_error_mode='thread_local'):
                    if not state['native']['context'].execute_async_v3(
                            int(state['stream'].cuda_stream)):
                        raise RuntimeError('Native GPEN graph capture failed')
                state['nativeGraph'] = graph
                state['metadata']['cudaGraph'] = True
                graph.replay()
                self._synchronize(state)
                if not self.torch.isfinite(output).all().item():
                    raise RuntimeError('Native GPEN graph produced nonfinite output')
            state['ready'] = True
            state['metadata']['ready'] = True
            if (
                state['stream'] is None
                or bool(state['metadata'].get('cudaDirectIo', False))
            ):
                state.update(input=None, output=None, binding=None)
            setattr(
                self.owner,
                f'GPEN_{edge}_model',
                state['native']['engine'] if state.get('native') is not None else state['session'],
            )
        except Exception as exc:
            # Keep failed state owned until a successful teardown fence.
            state['metadata']['error'] = f'{type(exc).__name__}: {exc}'
            raise
        finally:
            self._publish_status(edge, state)


# Source: pong_swap_engine.PongSwapEngine.process_frame
# SHA256: dd6f6b105ad489b58cca9905f62799b60cb6754e66e784d1703df75fbc3d3989
def process_frame(
    self,
    frame: Any,
    source_embedding: np.ndarray,
    anchor: np.ndarray | None,
    *,
    source_frame=None,
    verify_identity: bool = True,
    tracking_state: dict[str, Any] | None = None,
    cancel_event: threading.Event | None = None,
    config: dict[str, Any] | None = None,
    diagnostics: dict[str, list[float]] | None = None,
    temporal_context: dict[str, Any] | None = None,
    frame_evidence: FrameEvidence | None = None,
    manual_target_point: tuple[float, float] | None = None,
    tracking_lookahead: TrackingLookahead | None = None,
    next_frame: np.ndarray | None = None,
):
    frame_wall_started = time.perf_counter()
    effective_config = self._config if config is None else config
    # Cancellation can arrive while a stale card is waiting to enter this
    # method. It must not trigger model warmup or a host-to-device upload.
    if cancel_event is not None and cancel_event.is_set():
        return None, anchor
    # Do not run the full health/GPU-memory probe for every frame. Active
    # sessions prevent idle unload, so a cheap publication check is enough.
    if getattr(self, "_models", None) is None or getattr(self, "_vm", None) is None:
        self.warm(config=effective_config)
    else:
        self._last_used = time.time()
    torch = self._torch
    detect_interval = max(
        1,
        int(effective_config["runtime"].get("targetDetectIntervalFrames", 1)),
    )
    gray_started = time.perf_counter()
    current_gray = None
    if tracking_lookahead is not None and tracking_state is not None:
        prepared = tracking_lookahead.consume(frame, tracking_state)
        if prepared is not None:
            if frame_evidence is None:
                frame_evidence = FrameEvidence(
                    prior_track_revision=int(tracking_state.get("trackRevision", 0))
                )
            frame_evidence.gray, frame_evidence.lk_flow_evidence = prepared
            frame_evidence.lk_flow_prepared = True
    if tracking_state is not None and isinstance(frame, np.ndarray):
        current_gray = (
            frame_evidence.gray
            if frame_evidence is not None and isinstance(frame_evidence.gray, np.ndarray)
            else cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        )
        if frame_evidence is not None and frame_evidence.gray is None:
            frame_evidence.gray = current_gray
    if diagnostics is not None:
        diagnostics.setdefault("grayCpuMs", []).append((time.perf_counter() - gray_started) * 1000.0)
    lock_wait_started = time.perf_counter()
    with self._lock:
        if diagnostics is not None:
            diagnostics.setdefault("modelLockWaitMs", []).append((time.perf_counter() - lock_wait_started) * 1000.0)
        # A swipe can retire a producer while it is queued behind a GPU
        # inference owned by the prior card. Do not let that stale frame
        # consume even a host-to-device upload once the lock opens.
        if cancel_event is not None and cancel_event.is_set():
            return None, anchor
        compute_stream = self._compute_stream
        if compute_stream is None:
            raise RuntimeError("Pong Swap CUDA stream is not initialized")
        cuda_marks: list[tuple[str, Any]] = []

        def mark_cuda(name: str) -> None:
            if diagnostics is None:
                return
            event = torch.cuda.Event(enable_timing=True)
            event.record(compute_stream)
            cuda_marks.append((name, event))

        with torch.cuda.stream(compute_stream):
            mark_cuda("begin")
            # A new visual selection must be explicitly warmed before live
            # inference; never compile an unprepared GPEN inside a frame.
            self._warm_selected_restorer(
                self._models, torch, compute_stream, effective_config, allow_create=False,
            )
            img_chw = self._frame_tensor(frame)
            mark_cuda("upload")
            self._vm.parameters = dict(effective_config["parameters"])
            self._vm.color_match_cuda_graph_enabled = bool(effective_config['runtime'].get('colorMatchCudaGraph', False))
            kps = None
            raw_kps = None
            proposed_pose = None
            pending_track_advance = None
            detector_lk_prediction = None
            track_attempted = False
            track_failed = False
            track_generation_invalidated = False
            if temporal_context is not None:
                temporal_context['restorerDetectorRecoveryConfirmed'] = False
            # Standalone benchmark/preview callers also need the recognized
            # evidence used by the same conservative recovery contract.
            if frame_evidence is None:
                frame_evidence = FrameEvidence()
            if tracking_state is not None and isinstance(frame, np.ndarray):
                # Keep raw LK points separate from the lightly smoothed points
                # used for rendering. Feeding filtered points back into LK would
                # accumulate lag and eventually turn smoothing into drift.
                prior_kps = tracking_state.get(
                    "rawKps",
                    tracking_state.get("kps"),
                )
                prior_gray = tracking_state.get("gray")
                since_detect = int(tracking_state.get("sinceDetect", detect_interval))
                if (
                    prior_kps is not None
                    and prior_gray is not None
                    and since_detect < detect_interval
                    and not verify_identity
                ):
                    track_attempted = True
                    pending_track_advance = _advance_prefetch_tracking(
                        frame,
                        tracking_state,
                        detect_interval,
                        require_all_observed=False,
                        commit=False,
                        return_advance=True,
                        frame_evidence=frame_evidence,
                        media_time_seconds=(
                            temporal_context.get("mediaTimeSeconds")
                            if temporal_context is not None
                            else None
                        ),
                    )
                    if isinstance(pending_track_advance, LandmarkTrackAdvance):
                        raw_kps = pending_track_advance.evidence.points
                        kps = pending_track_advance.points
                        proposed_pose = pending_track_advance.pose
                    else:
                        track_failed = True
                elif (
                    prior_kps is not None
                    and prior_gray is not None
                    and (
                        bool(
                            effective_config["runtime"].get(
                                "temporalDetectorLkFusionEnabled",
                                False,
                            )
                        )
                        or bool(
                            effective_config["runtime"].get(
                                "temporalDetectorShapeContinuityEnabled",
                                False,
                            )
                        )
                    )
                ):
                    # A scheduled detector/identity frame still gets a
                    # same-frame LK prediction. It is never committed as
                    # raw tracking state; it can only preserve local feature
                    # geometry after the detector supplies absolute pose.
                    if frame_evidence.lk_flow_prepared:
                        prediction_evidence = frame_evidence.lk_flow_evidence
                    else:
                        prediction_evidence = _track_landmarks_lk(
                            prior_gray,
                            current_gray,
                            np.asarray(prior_kps, dtype=np.float32),
                            frame.shape,
                            return_evidence=True,
                        )
                    if isinstance(prediction_evidence, LandmarkTrackEvidence):
                        detector_lk_prediction = (
                            _transport_render_correction_with_lk(
                                prior_kps,
                                tracking_state.get("kps"),
                                prediction_evidence.points,
                            )
                        )
            if kps is None:
                if tracking_state is not None and track_attempted and track_failed:
                    # A detector observation may still be geometrically
                    # continuous with the active target. Force dependent
                    # stages exact, but preserve the pose long enough to
                    # evaluate that same-frame handoff.
                    if temporal_context is not None:
                        temporal_context["forceExact"] = True
                        force_reasons = temporal_context.setdefault(
                            "forceExactReasons", []
                        )
                        if "lk-failure" not in force_reasons:
                            force_reasons.append("lk-failure")
                stable_identity_anchor = (
                    tracking_state.get("targetIdentityAnchor")
                    if tracking_state is not None else None
                )
                selection_anchor = anchor
                if stable_identity_anchor is not None:
                    try:
                        stable_values = np.asarray(
                            stable_identity_anchor, dtype=np.float32
                        ).reshape(-1)
                        prior_values = np.asarray(prior_kps, dtype=np.float32).reshape(5, 2)
                        has_valid_prior = bool(np.isfinite(prior_values).all())
                        if (
                            stable_values.size > 0
                            and np.isfinite(stable_values).all()
                            and (selection_anchor is None or not has_valid_prior)
                        ):
                            selection_anchor = stable_values
                    except (TypeError, ValueError):
                        pass
                detected_kps, anchor = self._choose_target(
                    img_chw,
                    selection_anchor,
                    # A failed geometric track is exactly where an adjacent
                    # person could otherwise inherit the swap.  Re-identify
                    # immediately and fail closed on ambiguity. Successful
                    # tracks retain the configured sparse verification cadence.
                    # A Face Detect tap is an identity lock, not a moving
                    # screen coordinate. Once acquired, every exact
                    # detector frame re-associates against that recognized
                    # identity instead of geometry that can cross people.
                    verify_identity=(
                        verify_identity
                        or track_failed
                        or bool(
                            tracking_state is not None
                            and tracking_state.get("manualTargetIdentityLock")
                        )
                    ),
                    config=effective_config,
                    prior_kps=(
                        tracking_state.get("rawKps", tracking_state.get("kps"))
                        if tracking_state is not None
                        else None
                    ),
                    frame_shape=frame.shape if isinstance(frame, np.ndarray) else None,
                    frame_evidence=frame_evidence,
                    frame_rgb=(frame if isinstance(frame, np.ndarray) else None),
                    required_presentation=(
                        tracking_state.get("targetPresentation")
                        if tracking_state is not None
                        else None
                    ),
                    manual_target_point=(
                        manual_target_point if selection_anchor is None else None
                    ),
                    allow_anchor_adaptation=bool(
                        tracking_state is not None
                        and not tracking_state.get("manualTargetIdentityLock")
                    ),
                    reacquisition_anchors=(
                        tracking_state.get("targetIdentityGallery", ())
                        if tracking_state is not None else ()
                    ),
                )
                if (verify_identity and tracking_state is not None
                        and frame_evidence.recognition_complete
                        and frame_evidence.selected_target_embedding is not None
                        and effective_config['runtime'].get('temporalVerifiedIdentityRefreshReuseEnabled', False)):
                    _release_verified_identity_deadline(
                        temporal_context,
                        tracking_state.get('rawKps', tracking_state.get('kps')),
                        detected_kps, frame_evidence.selected_target_similarity,
                        temporal_context.get('nominalFrameSeconds', 0.0) if temporal_context else 0.0,
                    )
                if (
                    tracking_state is not None
                    and frame_evidence.selected_target_embedding is not None
                    and frame_evidence.selected_target_similarity is not None
                    and frame_evidence.selected_target_similarity
                        >= target_identity_lock_threshold(
                            effective_config["parameters"].get(
                                "DetectScoreSlider", 45
                            )
                        )
                ):
                    gallery = tracking_state.setdefault(
                        "targetIdentityGallery", []
                    )
                    observed_identity = np.asarray(
                        frame_evidence.selected_target_embedding,
                        dtype=np.float32,
                    ).reshape(-1).copy()
                    if (
                        observed_identity.size > 0
                        and np.isfinite(observed_identity).all()
                        and not any(
                            rope_similarity(observed_identity, item) >= 90.0
                            for item in gallery
                        )
                    ):
                        if len(gallery) >= 12:
                            del gallery[1]
                        gallery.append(observed_identity)
                if track_failed and temporal_context is not None:
                    recovered = bool(
                        effective_config['runtime'].get('temporalRestorerDetectorRecoveryEnabled', False)
                        and temporal_context.get('correctionLocalGuardEnabled', False)
                        and _restorer_detector_recovery_is_safe(
                            prior_kps, detected_kps,
                            frame_evidence.selected_target_similarity,
                            temporal_context.get('nominalFrameSeconds', 0.0),
                        )
                    )
                    temporal_context['restorerDetectorRecoveryConfirmed'] = recovered
                    if not recovered:
                        temporal_context.pop('restorerAnchor', None)
                    mask_recovered = recovered and effective_config['runtime'].get(
                        'temporalMaskDetectorRecoveryEnabled', False,
                    )
                    if mask_recovered:
                        # The current detector/recognizer recovered the
                        # track. Each stage still applies its own canonical
                        # appearance, occlusion and elapsed-age gates; no
                        # history is made valid merely by detector ordering.
                        reasons = [r for r in temporal_context.get('forceExactReasons', []) if r != 'lk-failure']
                        temporal_context['forceExactReasons'] = reasons
                        temporal_context['forceExact'] = bool(reasons)
                    else:
                        for state_key in ('occluderAnchor', 'faceParserAnchor'):
                            temporal_context.pop(state_key, None)
                # No still-pose fallback when both detector and optical
                # flow fail: old coordinates are not evidence that the
                # same face remains under those pixels.
                if (
                    detected_kps is None
                    and detector_lk_prediction is not None
                    and anchor is not None
                    and tracking_state is not None
                ):
                    # Brief, elapsed-time-bounded grace requires a valid
                    # current-frame optical-flow observation, never a
                    # frozen previous pose or a new detector index.
                    identity_grace = int(
                        tracking_state.get("identityGraceFrames", 0)
                    )
                    grace_points = np.asarray(
                        detector_lk_prediction,
                        dtype=np.float32,
                    ).reshape(-1, 2)
                    if (
                        identity_grace < max(1, int(round(
                            0.20 / max(1e-3, float(
                                (temporal_context or {}).get("nominalFrameSeconds", 1.0 / 30.0)
                            ))
                        )))
                        and grace_points.shape == (5, 2)
                        and np.isfinite(grace_points).all()
                    ):
                        detected_kps = grace_points
                        tracking_state["identityGraceFrames"] = identity_grace + 1
                        if frame_evidence is not None:
                            frame_evidence.selected_target_similarity = (
                                target_identity_continuity_threshold()
                            )
                            frame_evidence.rejection_reasons.append(
                                "target-identity-lk-grace"
                            )
                elif detected_kps is not None and tracking_state is not None:
                    tracking_state["identityGraceFrames"] = 0
                # Baseline 1.7: short occlusion bridge. When BOTH the
                # detector and optical flow lose an already-locked face
                # for a moment (hair whipping across the nose, a hand or a
                # cone), the frame used to flash back to the original face.
                # Carry the last observed motion forward for at most
                # ~0.15 s instead. Never bridges when the detector sees any
                # face where the prediction lands (a different person or a
                # rejected candidate), and never starts without a lock.
                if detected_kps is None:
                    import os as _debug_os
                    _debug_path = _debug_os.environ.get("PONG_BRIDGE_DEBUG_PATH", "")
                if detected_kps is None and _debug_path:
                    import json as _debug_json
                    try:
                        with open(_debug_path, "a", encoding="utf-8") as debug_log:
                            debug_log.write(_debug_json.dumps({
                                "frame": (temporal_context or {}).get("frameIndex"),
                                "anchor": anchor is not None,
                                "tracking": tracking_state is not None,
                                "trackFailed": bool(track_failed),
                                "lkPrediction": detector_lk_prediction is not None,
                                "reasons": list(getattr(frame_evidence, "rejection_reasons", []) or []),
                                "detections": len(getattr(frame_evidence, "detections", ()) or ()),
                                "lastKps": tracking_state.get("kps") is not None if tracking_state is not None else None,
                            }) + "\n")
                    except Exception:
                        pass
                if (
                    detected_kps is None
                    and anchor is not None
                    and tracking_state is not None
                    and bool(effective_config["runtime"].get("targetOcclusionBridgeEnabled", True))
                ):
                    bridge_frames = int(tracking_state.get("occlusionBridgeFrames", 0))
                    nominal_seconds = float(
                        (temporal_context or {}).get("nominalFrameSeconds", 1.0 / 30.0)
                    ) or (1.0 / 30.0)
                    bridge_limit = max(1, int(round(float(
                        effective_config["runtime"].get("targetOcclusionBridgeSeconds", 0.15)
                    ) / max(1e-3, nominal_seconds))))
                    try:
                        last_kps = np.asarray(tracking_state.get("kps"), dtype=np.float32).reshape(5, 2)
                    except (TypeError, ValueError):
                        last_kps = None
                    if (
                        bridge_frames < bridge_limit
                        and last_kps is not None
                        and np.isfinite(last_kps).all()
                    ):
                        span = max(1.0, _landmark_span(last_kps))
                        velocity = np.zeros_like(last_kps)
                        try:
                            before_kps = np.asarray(
                                tracking_state.get("bridgePrevKps"), dtype=np.float32
                            ).reshape(5, 2)
                            if np.isfinite(before_kps).all():
                                velocity = last_kps - before_kps
                        except (TypeError, ValueError):
                            pass
                        speed = float(np.median(np.linalg.norm(velocity, axis=1)))
                        if speed > 0.15 * span:
                            velocity *= (0.15 * span) / speed
                        predicted = last_kps + velocity
                        center = predicted.mean(axis=0)
                        # A face found at the predicted spot but rejected
                        # only for landmark geometry is the occluded target
                        # itself (hair/hands distort its points). Block the
                        # bridge when an identity check rejected a nearby
                        # face, or when several faces crowd the spot.
                        reasons = set(getattr(frame_evidence, "rejection_reasons", []) or [])
                        identity_rejected = any(
                            r.startswith("target-identity") or r.startswith("target-appearance")
                            for r in reasons
                        )
                        nearby = 0
                        for _area, other_kps, _embedding in tuple(
                            getattr(frame_evidence, "detections", ()) or ()
                        ):
                            try:
                                other = np.asarray(other_kps, dtype=np.float32).reshape(5, 2)
                            except (TypeError, ValueError):
                                continue
                            if float(np.linalg.norm(other.mean(axis=0) - center)) < span:
                                nearby += 1
                        crowded = nearby > 1 or (nearby == 1 and identity_rejected)
                        if not crowded:
                            detected_kps = predicted
                            tracking_state["occlusionBridgeFrames"] = bridge_frames + 1
                            if frame_evidence is not None:
                                frame_evidence.rejection_reasons.append(
                                    "target-occlusion-bridge"
                                )
                elif detected_kps is not None and tracking_state is not None:
                    tracking_state["occlusionBridgeFrames"] = 0
                if (
                    detected_kps is not None
                    and tracking_state is not None
                    and os.environ.get("PONG_LANDMARK_GUARD", "1") != "0"
                ):
                    # Baseline 1.12: repair detector guesses for covered
                    # face parts (hands, food, hair, objects) before they
                    # reach the LK fusion and the swap alignment.
                    from pong_landmark_guard import LandmarkGuard
                    guard = tracking_state.get("landmarkGuard")
                    now = time.monotonic()
                    if (
                        guard is None
                        or now - float(tracking_state.get("landmarkGuardSeenAt", 0.0)) > 1.0
                    ):
                        guard = tracking_state["landmarkGuard"] = LandmarkGuard()
                    tracking_state["landmarkGuardSeenAt"] = now
                    detected_points = np.asarray(detected_kps, dtype=np.float32).reshape(5, 2)
                    detected_score = getattr(self, "_detect_score_lookup", {}).get(
                        detected_points.tobytes()
                    )
                    if os.environ.get("PONG_LANDMARK106", "1") != "0":
                        # Baseline 1.15: average with 2d106det's points
                        # (real eye/nose/lip positions at side angles).
                        from pong_landmark106 import Landmark106
                        if getattr(self, "_landmark106", None) is None:
                            self._landmark106 = Landmark106(MODELS_DIR)
                        if self._landmark106.available():
                            detected_points = self._landmark106.fuse(
                                self._torch, img_chw, detected_points
                            )
                    detected_kps = guard.observe(detected_points, detected_score)
                    if detected_kps is None and frame_evidence is not None:
                        frame_evidence.rejection_reasons.append("landmark-guard-hold")
                if detected_kps is not None and tracking_state is not None:
                    raw_kps = np.asarray(detected_kps, dtype=np.float32)
                    if detector_lk_prediction is not None:
                        if bool(
                            effective_config["runtime"].get(
                                "temporalDetectorShapeContinuityEnabled",
                                False,
                            )
                        ):
                            kps = _reconcile_detector_pose_with_lk_shape(
                                raw_kps,
                                detector_lk_prediction,
                                detector_detail_weight=float(
                                    effective_config["runtime"].get(
                                        "temporalDetectorShapeContinuityWeight",
                                        0.20,
                                    )
                                ),
                                max_local_residual_ratio=float(
                                    effective_config["runtime"].get(
                                        "temporalDetectorShapeContinuityMaxResidualRatio",
                                        0.05,
                                    )
                                ),
                            )
                        else:
                            kps = _fuse_detector_with_lk_prediction(
                                raw_kps,
                                detector_lk_prediction,
                                minimum_detector_gain=float(
                                    effective_config["runtime"].get(
                                        "temporalDetectorLkFusionWeight",
                                        0.5,
                                    )
                                ),
                                high_innovation_ratio=float(
                                    effective_config["runtime"].get(
                                        "temporalDetectorLkFusionMaxResidualRatio",
                                        0.02,
                                    )
                                ),
                            )
                    else:
                        # Detector observations remain the absolute
                        # authority whenever no strictly valid same-frame
                        # prediction exists.
                        kps = raw_kps
                else:
                    kps = detected_kps
                if tracking_state is not None:
                    tracking_state["sinceDetect"] = 1
                    tracking_state["rawKps"] = (
                        None if raw_kps is None else np.asarray(raw_kps, dtype=np.float32)
                    )
                    if kps is None and not track_generation_invalidated:
                        tracking_state["trackGeneration"] = int(
                            tracking_state.get("trackGeneration", 0)
                        ) + 1
                        tracking_state.pop("renderPose", None)
                        if temporal_context is not None:
                            for state_key in (
                                "restorerAnchor",
                                "occluderAnchor",
                                "faceParserAnchor",
                                "spatialExactBlendRecentTriggerFrames",
                                "spatialExactBlendBurstUntilFrame",
                                "spatialExactBlendLastTriggerFrame",
                                "spatialExactBlendLastObservedFrame",
                            ):
                                temporal_context.pop(state_key, None)
                            temporal_context["forceExact"] = True
                            force_reasons = temporal_context.setdefault(
                                "forceExactReasons", []
                            )
                            if "target-loss" not in force_reasons:
                                force_reasons.append("target-loss")
            if tracking_state is not None:
                if isinstance(pending_track_advance, LandmarkTrackAdvance):
                    _commit_tracking_advance(tracking_state, pending_track_advance)
                else:
                    if proposed_pose is not None:
                        tracking_state["renderPose"] = proposed_pose
                    if raw_kps is not None:
                        tracking_state["trackRevision"] = int(
                            tracking_state.get("trackRevision", 0)
                        ) + 1
                # Baseline 1.7: previous pose for the occlusion bridge's
                # one-frame motion estimate.
                tracking_state["bridgePrevKps"] = tracking_state.get("kps")
                tracking_state["kps"] = (
                    None if kps is None else np.asarray(kps, dtype=np.float32)
                )
                if current_gray is not None:
                    tracking_state["gray"] = current_gray
            mark_cuda("target")
            if tracking_lookahead is not None and tracking_state is not None:
                tracking_lookahead.prepare(tracking_state, next_frame)
            adaptive_mask_backend = None
            if kps is not None:
                if effective_config["parameters"].get("RestorerSwitch"):
                    self._vm.parameters["RestorerTypeTextSel"] = select_restorer(effective_config, kps)
                adaptive_mask_backend = _selected_adaptive_mask_backend(
                    effective_config["runtime"], tracking_state
                )
                default_mask_backend = (
                    adaptive_mask_backend
                    or str(
                        effective_config["runtime"].get(
                            "maskBackendPreference", "cuda"
                        )
                    ).lower()
                )
                occluder_backend = str(
                    effective_config["runtime"].get(
                        "maskOccluderBackendPreference", "inherit"
                    )
                ).lower()
                face_parser_backend = str(
                    effective_config["runtime"].get(
                        "maskFaceParserBackendPreference", "inherit"
                    )
                ).lower()
                occluder_backend = (
                    occluder_backend
                    if occluder_backend in {"cuda", "trt"}
                    else default_mask_backend
                )
                face_parser_backend = (
                    face_parser_backend
                    if face_parser_backend in {"cuda", "trt"}
                    else default_mask_backend
                )
                mask_backend_selection = {
                    "occluder": occluder_backend,
                    # Models._get_mask_session uses the canonical lowercase
                    # family name ``faceparser``.  A mixed-case key silently
                    # fell back to the global CUDA preference and produced
                    # an unintended TRT-occluder/CUDA-parser pipeline.
                    "faceparser": face_parser_backend,
                }
                prior_mask_backend = self._models._mask_runtime_backend
                self._models._mask_runtime_backend = mask_backend_selection
                if temporal_context is not None:
                    temporal_context["adaptiveMaskMotionClass"] = (
                        adaptive_mask_backend or "unclassified"
                    )
                    temporal_context["maskRuntimeBackend"] = (
                        f"occluder:{occluder_backend}|faceParser:{face_parser_backend}"
                    )
                    temporal_context["maskOccluderRuntimeBackend"] = occluder_backend
                    temporal_context["maskFaceParserRuntimeBackend"] = face_parser_backend
                if adaptive_mask_backend is not None:
                    if diagnostics is not None:
                        diagnostics.setdefault(
                            f"maskAdaptiveBackend.{adaptive_mask_backend}", []
                        ).append(1.0)
                try:
                    img_chw = self._vm.swap_core(
                        img_chw,
                        kps,
                        source_embedding,
                        self._vm.parameters,
                        self._vm.control,
                        slot=None,
                        source_frame=source_frame,
                        diagnostics=diagnostics,
                        temporal_context=temporal_context,
                    )
                finally:
                    self._models._mask_runtime_backend = prior_mask_backend
            mark_cuda("swap")
            img_chw = self._enhance_frame(img_chw, kps, effective_config)
            if adaptive_mask_backend == "trt":
                img_chw = self._micro_sharpen_face_roi(
                    img_chw,
                    kps,
                    float(
                        effective_config["runtime"].get(
                            "maskTrtPostSharpenAmount", 0.0
                        )
                    ),
                )
                img_chw = self._sparse_edge_boost_face_roi(
                    img_chw,
                    kps,
                    float(
                        effective_config["runtime"].get(
                            "maskTrtSparseEdgeBoostThreshold", 0.0
                        )
                    ),
                )
            result = img_chw.permute(1, 2, 0).to(torch.uint8).contiguous()
            mark_cuda("output")
        # The caller downloads/encodes ``result`` immediately, commonly
        # from a different/default stream. Retain one frame-boundary wait
        # for correctness while removing the old per-model host fences.
        if not getattr(self, "_isolated_async_readback_active", False):
            compute_stream.synchronize()
        if diagnostics is not None and len(cuda_marks) >= 2:
            for (prior_name, prior_event), (name, event) in zip(cuda_marks, cuda_marks[1:]):
                diagnostics.setdefault(f"cuda_{prior_name}_to_{name}Ms", []).append(
                    float(prior_event.elapsed_time(event))
                )
        if diagnostics is not None:
            swap_events = diagnostics.pop("_swapCudaEvents", [])
            for (prior_name, prior_event), (name, event) in zip(swap_events, swap_events[1:]):
                diagnostics.setdefault(f"cuda_swap_{prior_name}_to_{name}Ms", []).append(
                    float(prior_event.elapsed_time(event))
                )
        self._last_used = time.time()
    if diagnostics is not None:
        diagnostics.setdefault("frameWallMs", []).append((time.perf_counter() - frame_wall_started) * 1000.0)
    return result, anchor


# Source: pong_swap_engine.PongSwapEngine._produce_session
# SHA256: 8a9220299b452b384142874325b0f4c4041b43533dd9728227982c73fd78f075
def _produce_session(self, session: SwapSession) -> None:
    session.state = "starting"
    session.started_at = time.time()
    # Backward compatibility is useful for in-process tests constructing a
    # SwapSession directly; service-created sessions always have a snapshot.
    session_config = session.config or self._config_snapshot()[0]
    container = None
    process = None
    decoder = None
    feeder = None
    source_opener = None
    stderr_thread = None
    stderr_tail = bytearray()
    feeder_error: queue.Queue[Any] = queue.Queue(maxsize=1)
    decode_stop = threading.Event()
    # Source negotiation can outlive the producer's bounded teardown wait.
    # Close publication before reclaiming a not-yet-decoded container.
    source_open_cancel = threading.Event()
    try:
        if session.stop.is_set():
            session.state = "stopped"
            return
        import av

        source_open_result: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

        def open_source() -> None:
            # Two speculative sessions may negotiate their media sources in
            # parallel, but additional hidden work waits here. Promotion
            # turns this into foreground work and must never wait on a
            # speculative networking slot.
            source_gate_owned = False
            if session.prefetch and not session.activation_requested:
                while not session.stop.is_set():
                    with session.condition:
                        promoted = bool(
                            not session.prefetch
                            or session.activation_requested
                            or session.playback_started_at
                        )
                    if promoted:
                        break
                    if self._prefetch_source_open_gate.acquire(timeout=0.10):
                        source_gate_owned = True
                        break
            if session.stop.is_set():
                try:
                    source_open_result.put_nowait(("stopped", None))
                except queue.Full:
                    pass
                if source_gate_owned:
                    self._prefetch_source_open_gate.release()
                return

            source_candidates = tuple(dict.fromkeys(
                session.source_candidates or (session.source_url,)
            ))[:2]
            race_lock = threading.Lock()
            race_state: dict[str, Any] = {
                "winner": False,
                "remaining": len(source_candidates),
                "errors": [],
            }

            def open_candidate(candidate_url: str) -> None:
                opened = None
                reused = False
                candidate_error: BaseException | None = None
                won = False
                try:
                    # A source can now be negotiated while the approved-face
                    # menu is open, including first playback at time zero.
                    opened = self._standby_sources.take(candidate_url)
                    reused = opened is not None
                    if opened is None:
                        opened = av.open(candidate_url, timeout=(10.0, 5.0))
                except Exception as exc:
                    candidate_error = exc
                with race_lock:
                    with session.lifecycle_lock:
                        if (
                            opened is not None
                            and not session.stop.is_set()
                            and not source_open_cancel.is_set()
                            and not race_state["winner"]
                        ):
                            race_state["winner"] = True
                            won = True
                            session.container = opened
                            session.source_url = candidate_url
                            session.source_opened_at = time.time()
                            session.source_decoder_reused = reused
                    if candidate_error is not None:
                        race_state["errors"].append(candidate_error)
                    race_state["remaining"] -= 1
                    remaining = int(race_state["remaining"])
                    winner_exists = bool(race_state["winner"])
                    final_error = (
                        race_state["errors"][0]
                        if race_state["errors"]
                        else RuntimeError("source opening stopped")
                    )
                if won:
                    try:
                        source_open_result.put_nowait(("ok", opened))
                    except queue.Full:
                        won = False
                if opened is not None and not won:
                    try:
                        opened.close()
                    except Exception:
                        pass
                if remaining == 0 and not winner_exists:
                    try:
                        source_open_result.put_nowait((
                            "stopped" if session.stop.is_set() else "error",
                            None if session.stop.is_set() else final_error,
                        ))
                    except queue.Full:
                        pass

            candidate_threads = [
                threading.Thread(
                    target=open_candidate,
                    args=(candidate_url,),
                    name=f"PongSwapRoute-{session.channel}-{index + 1}",
                    daemon=True,
                )
                for index, candidate_url in enumerate(source_candidates)
            ]
            try:
                for candidate_thread in candidate_threads:
                    candidate_thread.start()
                for candidate_thread in candidate_threads:
                    candidate_thread.join()
            finally:
                if source_gate_owned:
                    self._prefetch_source_open_gate.release()

        # Source/CDN negotiation is independent of model warmup and the
        # selected-face embedding. Start it before speculative GPU admission
        # so both predicted videos can negotiate concurrently while model
        # execution remains strictly foreground-prioritized.
        source_opener = threading.Thread(
            target=open_source,
            name=f"PongSwapOpen-{session.channel}",
            daemon=True,
        )
        with session.lifecycle_lock:
            session.source_opener = source_opener
        source_opener.start()
        # Admit speculative GPU work only after network preparation has
        # started. Foreground sessions bypass this gate and promotion
        # releases it immediately; no face-quality behavior changes here.
        if session.prefetch and not session.activation_requested:
            admitted = self._acquire_prefetch_admission(session)
            if not admitted and session.error_code == "GPU_HEADROOM":
                return
        if session.stop.is_set():
            session.state = "stopped"
            return
        # Selected-session startup is latency-sensitive.  Signal priority
        # before waiting on the model lock so the speculative all-face
        # primer yields after its current identity, and automatically resumes
        # when this selected embedding is available.
        with self._foreground_embedding_priority():
            self._run_gpu_work(
                self.warm,
                priority=(10 if session.prefetch else 0),
                queue_cancel_event=session.stop,
                work_label="session-warm",
                config=session_config,
                allow_create_selected=bool(session_config["runtime"].get("tiktokRestorerProfile")),
            )
            session.models_ready_at = time.time()
            if session.stop.is_set():
                session.state = "stopped"
                return
            prepared_candidates: list[CandidateIdentity] = []
            for candidate_face_id in (
                session.candidate_face_ids or (session.face_id,)
            ):
                if session.stop.is_set():
                    session.state = "stopped"
                    return
                candidate_embedding = self.embedding_for_face(
                    candidate_face_id,
                    session_config,
                    queue_cancel_event=session.stop,
                )
                candidate_source_frame = self.source_frame_for_face(
                    candidate_face_id,
                    session_config,
                )
                candidate_presentation = self.presentation_for_face(
                    candidate_face_id,
                    session_config,
                    queue_cancel_event=session.stop,
                )
                prepared_candidates.append(
                    CandidateIdentity(
                        face_id=candidate_face_id,
                        embedding=candidate_embedding,
                        presentation=candidate_presentation,
                        source_frame=candidate_source_frame,
                    )
                )
            if not prepared_candidates:
                raise ValueError("No approved face could be prepared")
            candidates = tuple(prepared_candidates)
            # The first candidate provides a harmless placeholder until a
            # compatible target locks one source identity for this video.
            source_embedding = candidates[0].embedding
            source_frame = candidates[0].source_frame
            session.embedding_ready_at = time.time()
        if session.stop.is_set():
            session.state = "stopped"
            return

        while True:
            if session.stop.is_set():
                session.state = "stopped"
                return
            try:
                source_status, source_value = source_open_result.get(timeout=0.10)
                break
            except queue.Empty:
                continue
        if source_status == "error":
            raise source_value
        if source_status != "ok" or source_value is None:
            session.state = "stopped"
            return
        container = source_value
        if session.stop.is_set():
            self._interrupt_session_resources(session)
            session.state = "stopped"
            return
        video_stream = highest_quality_video_stream(container)
        if video_stream is None:
            raise ValueError("source URL has no decodable video stream")
        source_duration = 0.0
        try:
            if container.duration is not None and int(container.duration) > 0:
                source_duration = float(container.duration) / float(av.time_base)
            elif video_stream.duration is not None and video_stream.time_base:
                source_duration = float(video_stream.duration * video_stream.time_base)
        except (TypeError, ValueError, OverflowError):
            source_duration = 0.0
        session.source_duration = max(0.0, source_duration)
        source_fps = max(1.0, float(video_stream.average_rate or video_stream.base_rate or 30.0))
        fps, frame_stride = _quality_preserving_output_cadence(
            source_fps, session_config['runtime'].get('qualityPreservingMaxFps', 0.0),
        )
        session.source_fps = source_fps
        session.source_frame_stride = frame_stride
        width, height = int(video_stream.codec_context.width), int(video_stream.codec_context.height)
        output_width, output_height = self.output_dimensions(
            width,
            height,
            session_config,
        )
        session.width = output_width
        session.height = output_height
        session.fps = fps
        if session.prebuffer_seconds > 0:
            # The scheduler's minimum-headroom clamp is a safety target,
            # not a reason to leave terminal seeks permanently unprepared.
            # Once source metadata is known, advertise and encode only the
            # whole-frame duration that can actually exist after the seek.
            with session.condition:
                session.prebuffer_seconds = self._attainable_prebuffer_seconds(
                    session.prebuffer_seconds,
                    source_duration=session.source_duration,
                    start_seconds=session.start_seconds,
                    fps=fps,
                )
                session.condition.notify_all()
        if session.start_seconds > 0 and video_stream.time_base:
            try:
                container.seek(
                    int(session.start_seconds / float(video_stream.time_base)),
                    stream=video_stream, backward=True, any_frame=False,
                )
            except Exception:
                if not session.source_decoder_reused or session.stop.is_set():
                    raise
                # A standby HTTP connection may have expired. Retry once
                # through the unchanged cold path before failing the seek.
                container.close()
                container = av.open(session.source_url, timeout=(10.0, 5.0))
                with session.lifecycle_lock:
                    session.container = container
                    session.source_decoder_reused = False
                    session.source_opened_at = time.time()
                video_stream = highest_quality_video_stream(container)
                if video_stream is None:
                    raise ValueError("source URL has no decodable video stream")
                container.seek(
                    int(session.start_seconds / float(video_stream.time_base)),
                    stream=video_stream, backward=True, any_frame=False,
                )
        runtime = session_config["runtime"]
        _apply_source_fps_runtime_cadence(runtime, fps)
        # A speculative reader can decode only after FFmpeg has closed the
        # first moof/mdat pair. Fragment cadence is independent from total
        # prepared lead: short fragments improve first-presentation and
        # seek latency while production continues to the full safety target.
        fragment_seconds = session.fragment_seconds
        if fragment_seconds <= 0:
            # 27.38 compatibility path when Pipeline 2 is disabled.
            fragment_seconds = (
                session.prebuffer_seconds if session.prefetch else 1.0
            )
        gop_frames = max(
            1,
            round(fps * max(1.0 / fps, fragment_seconds)),
        )
        # `-g` continues to control random-access/keyframe cadence. MP4
        # packaging closes every encoded sample independently, allowing a
        # slow high-quality restorer to become playable after frame one
        # rather than waiting for an entire GOP. CQ and pixels are unchanged.
        session.fragment_frame_target = self._mux_fragment_frame_target(fps)
        ffmpeg = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{output_width}x{output_height}",
            "-r", f"{fps:.6f}", "-i", "pipe:0",
        ]
        include_audio = bool(runtime.get("swapAudioEnabled", False))
        if include_audio:
            # Audio requires a second source connection because PyAV owns
            # the decoded video connection. Keep this opt-in for users who
            # need sound; Pong's normal muted swap path avoids the extra
            # request, CDN seek, and startup dependency entirely.
            ffmpeg.extend([
                "-ss", f"{session.start_seconds:.6f}", "-i", session.source_url,
                "-map", "0:v:0", "-map", "1:a:0?",
            ])
        else:
            ffmpeg.extend(["-map", "0:v:0", "-an"])
        ffmpeg.extend([
            # PyAV has already converted the decoded source into full-range
            # RGB.  Declare the RGB->YUV matrix explicitly so mobile
            # decoders do not guess BT.601 for HD video and shift skin tones.
            "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
            "-c:v", "h264_nvenc", "-preset", str(runtime.get("encoderPreset", "p1")),
            "-tune", "ll",
        ])
        # Prepared and direct streams use the exact same configured quality
        # policy. Readiness is derived from complete fragments, not a fixed
        # bitrate assumption, so promotion cannot silently change quality.
        ffmpeg.extend([
            "-rc", "vbr", "-cq", str(runtime.get("encoderCq", 23)),
            "-b:v", "0",
        ])
        ffmpeg.extend([
            "-g", str(gop_frames), "-keyint_min", str(gop_frames),
            "-bf", "0", "-rc-lookahead", "0", "-delay", "0", "-zerolatency", "1",
            "-color_range", "tv", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709",
            "-movflags", "frag_every_frame+empty_moov+default_base_moof",
            "-flush_packets", "1",
            "-f", "mp4", "pipe:1",
        ])
        if include_audio:
            # Insert audio encoding before the muxer options. FFmpeg accepts
            # output options in either order before the output URL, but
            # keeping them adjacent makes generated diagnostics clearer.
            mux_index = ffmpeg.index("-movflags")
            ffmpeg[mux_index:mux_index] = [
                "-c:a", "aac", "-b:a", "128k", "-shortest",
            ]
        process = subprocess.Popen(
            ffmpeg,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        session.encoder_started_at = time.time()

        def drain_stderr() -> None:
            stream = process.stderr
            if stream is None:
                return
            try:
                while True:
                    diagnostic = stream.read(4096)
                    if not diagnostic:
                        break
                    stderr_tail.extend(diagnostic)
                    if len(stderr_tail) > 64 * 1024:
                        del stderr_tail[: len(stderr_tail) - (64 * 1024)]
            except (OSError, ValueError):
                pass

        # Drain concurrently: a native error must never fill stderr and
        # block FFmpeg before its stdout pipe can reach EOF.
        stderr_thread = threading.Thread(
            target=drain_stderr,
            name=f"PongSwapStderr-{session.channel}",
            daemon=True,
        )
        stderr_thread.start()
        with session.lifecycle_lock:
            session.process = process
        if session.stop.is_set():
            self._interrupt_session_resources(session)
            session.state = "stopped"
            return
        lead_buffer_seconds = max(
            1.0,
            float(runtime.get("leadBufferSeconds", 3.0)),
        )

        # Keep CPU/network decode one small bounded step ahead of the GPU.
        # PyAV conversion and CUDA inference otherwise serialize even though
        # they use independent resources. Three RGB frames are enough to
        # hide ordinary decode jitter without allowing a background or
        # abandoned session to consume unbounded memory/work.
        mask_preflight_enabled = bool(
            runtime.get("maskAdaptiveBackendEnabled", False)
            and runtime.get("maskAdaptivePreflightEnabled", False)
        )
        mask_preflight_frame_count = max(
            2,
            int(runtime.get("maskAdaptivePreflightFrames", 5)),
        )
        mask_preflight_threshold = max(
            0.0,
            float(runtime.get("maskAdaptiveFlowP90Threshold", 0.80)),
        )
        mask_preflight_ready = threading.Event()
        mask_preflight_result: dict[str, Any] = {}
        mask_motion_preflight = MaskMotionPreflight(
            frame_count=mask_preflight_frame_count,
            flow_p90_threshold=mask_preflight_threshold,
        )
        decode_queue: queue.Queue[Any] = queue.Queue(
            maxsize=(
                max(3, mask_preflight_frame_count)
                if mask_preflight_enabled else 3
            )
        )
        decode_sentinel = object()

        def publish_decoded(item: Any) -> bool:
            while not decode_stop.is_set() and not session.stop.is_set():
                try:
                    decode_queue.put(item, timeout=0.05)
                    return True
                except queue.Full:
                    continue
            return False

        def decode_source() -> None:
            try:
                eligible_source_frames = 0
                for decoded in container.decode(video_stream):
                    if decode_stop.is_set() or session.stop.is_set():
                        break
                    timeline_seconds = None
                    if decoded.pts is not None and video_stream.time_base:
                        timestamp = float(decoded.pts * video_stream.time_base)
                        if timestamp + (1.0 / source_fps) < session.start_seconds:
                            continue
                        timeline_seconds = max(0.0, timestamp - session.start_seconds)
                    take_frame = eligible_source_frames % frame_stride == 0
                    eligible_source_frames += 1
                    if not take_frame:
                        session.cadence_skipped_frames += 1
                        continue
                    frame = decoded.to_ndarray(format="rgb24")
                    if mask_preflight_enabled and not mask_preflight_ready.is_set():
                        if mask_motion_preflight.add(frame, rgb=True):
                            mask_preflight_result.update(
                                mask_motion_preflight.result()
                            )
                            mask_preflight_ready.set()
                    if not publish_decoded((frame, timeline_seconds)):
                        break
            except Exception as exc:
                if not decode_stop.is_set() and not session.stop.is_set():
                    publish_decoded(exc)
            finally:
                if mask_preflight_enabled and not mask_preflight_ready.is_set():
                    mask_preflight_result.update(
                        mask_motion_preflight.result()
                    )
                    mask_preflight_ready.set()
                publish_decoded(decode_sentinel)
                # PyAV/native decoder ownership is singular. Closing from
                # this owner avoids a close-vs-decode race during rapid
                # swipes while the configured read timeout still bounds a
                # blocked network source.
                try:
                    container.close()
                except Exception:
                    pass
                with session.lifecycle_lock:
                    if session.container is container:
                        session.container = None

        decoder = threading.Thread(
            target=decode_source,
            name=f"PongSwapDecode-{session.channel}",
            daemon=True,
        )
        with session.lifecycle_lock:
            session.decoder = decoder
            if not session.stop.is_set():
                decoder.start()
        if decoder.ident is None:
            session.state = "stopped"
            return

        def feed() -> None:
            nonlocal source_embedding, source_frame
            anchor = None
            identity_locked = False
            multi_face_consensus = MultiFaceConsensus() if len(candidates) > 1 else None
            multi_choice_key = multi_video_key(session.channel, session.client_epoch,
                session.source_url, session.candidate_face_ids, session.config_revision,
                manual=session.manual_target_x is not None or session.manual_target_embedding is not None)
            next_compatibility_probe_frame = 0
            pending_source_switch: tuple[CandidateIdentity, float] | None = None
            switch_challenger_id = ""
            switch_challenger_confirmations = 0
            foreground_oom_retry_used = False
            tracking_state: dict[str, Any] = {
                "trackGeneration": 0,
                "sharedLandmarkEstimator": bool(
                    runtime.get("temporalDetectorLkFusionEnabled", False)
                ),
                "disableLkSmoothing": bool(
                    runtime.get("temporalDisableLkSmoothing", False)
                ),
            }

            def seed_mask_preflight_state() -> None:
                if not mask_preflight_enabled or not mask_preflight_result:
                    return
                tracking_state["maskAdaptiveBackend"] = {
                    "generation": int(tracking_state.get("trackGeneration", 0)),
                    "backend": str(
                        mask_preflight_result.get("backend", "cuda")
                    ),
                    "locked": True,
                    "samples": [],
                    "preflightMedianFlowP90": float(
                        mask_preflight_result.get("medianFlowP90", math.inf)
                    ),
                    "preflightSampleCount": int(
                        mask_preflight_result.get("sampleCount", 0)
                    ),
                }

            if mask_preflight_enabled:
                while (
                    not mask_preflight_ready.wait(timeout=0.05)
                    and not session.stop.is_set()
                    and decoder.is_alive()
                ):
                    pass
                if session.stop.is_set():
                    return
                seed_mask_preflight_state()
            previous_source_frame: np.ndarray | None = None
            previous_swapped_frame: np.ndarray | None = None
            previous_swap_kps: np.ndarray | None = None
            previous_canonical_transform: np.ndarray | None = None
            previous_render_signature: tuple[Any, ...] | None = None
            last_exact_frame = -1
            last_exact_timeline_seconds: float | None = None
            previous_timeline_seconds: float | None = None
            configured_identity_interval = max(
                1,
                int(runtime.get("identityCheckIntervalFrames", 12)),
            )
            full_anchor_frames_for_identity = max(
                1,
                int(
                    math.ceil(
                        fps
                        / max(
                            0.25,
                            float(runtime.get("temporalFullAnchorHz", 5.0)),
                        )
                    )
                ),
            )
            # Align identity verification with an already-exact render
            # boundary.  Round down, never up: identity is checked at least
            # as often as configured while avoiding an extra GPEN frame a
            # few milliseconds after a scheduled exact anchor.
            # Identity verification rides on the existing full-quality
            # anchor cadence.  The strictness change previously made it
            # true on *every* locked frame, which disabled the temporal
            # path and reduced a measured 30-fps phone stream to 8.9 fps.
            # Checking every exact anchor keeps the all-face identity gate
            # at 5 Hz while the intervening frames retain fail-closed
            # geometric, appearance, and optical-flow guards.
            identity_interval = min(
                configured_identity_interval,
                full_anchor_frames_for_identity,
            )
            parameters = session_config.get("parameters", {})
            selected_source_policy = face_switch_policy(
                100 if multi_face_consensus is not None else parameters.get("FaceLockSlider", 100)
            )
            source_match_threshold = max(
                0.0,
                min(100.0, float(parameters.get("DetectScoreSlider", 45))),
            )
            temporal_context = build_temporal_restorer_context(
                runtime,
                enabled=bool(
                    runtime.get("adaptiveRestorer", False)
                    and parameters.get("RestorerSwitch", False)
                    and str(parameters.get("RestorerTypeTextSel", "")) in {"GPEN256", "GPEN512", "GPEN1024"}
                ),
            )
            semantic_mesh_configured = bool(
                runtime.get("temporalSemanticMeshEnabled", False)
            )
            semantic_feature_configured = bool(
                runtime.get("temporalSemanticFeaturePatchesEnabled", False)
            )
            semantic_motion_allowed = bool(
                not runtime.get("temporalSemanticHighMotionOnly", False)
                or str(mask_preflight_result.get("backend", "")) == "cuda"
            )
            semantic_mesh_enabled_for_session = bool(
                semantic_mesh_configured and semantic_motion_allowed
            )
            semantic_feature_enabled_for_session = bool(
                semantic_feature_configured and semantic_motion_allowed
            )
            sparse_mesh_enabled_for_session = bool(
                runtime.get("temporalFullSparseMeshResidual", False)
                and (
                    not semantic_mesh_configured
                    or semantic_mesh_enabled_for_session
                )
            )
            semantic_landmark_estimator = (
                self._semantic_landmark_estimator
                if (
                    semantic_mesh_enabled_for_session
                    or semantic_feature_enabled_for_session
                )
                else None
            )
            if (
                semantic_mesh_enabled_for_session
                or semantic_feature_enabled_for_session
            ) and semantic_landmark_estimator is None:
                raise RuntimeError("semantic landmark graph is not warm")
            semantic_refresh_frames = max(
                1,
                int(
                    math.ceil(
                        fps
                        / max(
                            0.1,
                            float(
                                runtime.get(
                                    "temporalSemanticLandmarkRefreshHz", 1.0
                                )
                            ),
                        )
                    )
                ),
            )
            last_semantic_refresh_frame = -semantic_refresh_frames

            def invalidate_temporal_chain(
                *,
                clear_tracking: bool,
                reason: str,
            ) -> None:
                nonlocal previous_source_frame
                nonlocal previous_swapped_frame
                nonlocal previous_swap_kps
                nonlocal previous_canonical_transform
                nonlocal previous_render_signature
                nonlocal last_exact_frame
                nonlocal last_exact_timeline_seconds
                nonlocal last_semantic_refresh_frame
                tracking_generation = int(tracking_state.get("trackGeneration", 0)) + 1
                if clear_tracking:
                    tracking_state.clear()
                tracking_state["trackGeneration"] = tracking_generation
                tracking_state["sharedLandmarkEstimator"] = bool(
                    runtime.get("temporalDetectorLkFusionEnabled", False)
                )
                tracking_state["disableLkSmoothing"] = bool(
                    runtime.get("temporalDisableLkSmoothing", False)
                )
                seed_mask_preflight_state()
                previous_source_frame = None
                previous_swapped_frame = None
                previous_swap_kps = None
                previous_canonical_transform = None
                previous_render_signature = None
                last_exact_frame = -1
                last_exact_timeline_seconds = None
                last_semantic_refresh_frame = -semantic_refresh_frames
                for state_key in (
                    "restorerAnchor",
                    "occluderAnchor",
                    "faceParserAnchor",
                    "spatialExactBlendRecentTriggerFrames",
                    "spatialExactBlendBurstUntilFrame",
                    "spatialExactBlendLastTriggerFrame",
                    "spatialExactBlendLastObservedFrame",
                ):
                    temporal_context.pop(state_key, None)
                temporal_context["forceExact"] = True
                temporal_context["lastInvalidationReason"] = str(reason)
                temporal_context.setdefault("pendingInvalidationReasons", []).append(
                    str(reason)
                )

            def record_temporal_rejection(
                reason: str,
                sample: dict[str, Any] | None = None,
            ) -> None:
                session.temporal_reuse_rejections[reason] = int(
                    session.temporal_reuse_rejections.get(reason, 0)
                ) + 1
                if sample and len(session.temporal_appearance_samples) < 64:
                    session.temporal_appearance_samples.append(dict(sample))

            residual_overlap_enabled = bool(
                runtime.get("exactCpuResidualOverlap", False)
                and not runtime.get("temporalFullDenseFlowResidual", False)
                and not sparse_mesh_enabled_for_session
                and not semantic_feature_enabled_for_session
            )
            output_executor = (
                concurrent.futures.ThreadPoolExecutor(
                    max_workers=1,
                    thread_name_prefix=f"PongResidual-{session.channel}",
                )
                if residual_overlap_enabled else None
            )
            # Speculate only the next decoded frame's unchanged CPU LK
            # calculation. The helper is bounded, validates frame/track
            # ownership, and stays disabled for cheap small-frame work.
            tracking_lookahead = TrackingLookahead(_track_landmarks_lk)
            pending_outputs: list[dict[str, Any]] = []
            isolated_output_union = {"intervals": [], "seconds": 0.0, "seenLease": False}
            isolated_output_failed = threading.Event()
            isolated_output_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="PongAsyncReadback"
            )
            isolated_output_futures = []
            isolated_unqueued_lease = None

            def render_residual_plan(
                plan: ResidualWarpPlan,
                diagnostics: dict[str, Any],
            ) -> tuple[np.ndarray | None, float]:
                started = time.perf_counter()
                rendered = _render_prior_swap_residual(
                    plan,
                    diagnostics=diagnostics,
                )
                return rendered, time.perf_counter() - started

            def emit_pending_output(record: dict[str, Any]) -> None:
                rendered = record.get("result")
                render_seconds = 0.0
                future = record.get("future")
                if future is not None:
                    rendered, render_seconds = future.result()
                    session.residual_warp_seconds += render_seconds
                    session.reuse_work_seconds += render_seconds
                if rendered is None:
                    raise RuntimeError("temporal residual render returned no frame")
                if session.stop.is_set():
                    return
                contiguous_output = np.ascontiguousarray(rendered)
                if (
                    session.navigation_class in {"seek", "foreground"}
                    and int(record.get("frameIndex", -1)) == 0
                    and not session.first_rendered_frame_webp
                ):
                    _start_seek_preview(session, contiguous_output, bool(record.get("transformed")))
                encoder_write_started = time.perf_counter()
                process.stdin.write(memoryview(contiguous_output).cast("B"))
                if record.get("transformed"):
                    session.transformed_frames += 1
                    from pong_frame_ranges import append_transformed_range
                    append_transformed_range(session.transformed_frame_ranges, record["frameIndex"])
                encoder_write_seconds = (
                    time.perf_counter() - encoder_write_started
                )
                session.encoder_write_seconds += encoder_write_seconds
                session.frame_work_seconds += float(
                    record.get("frameWorkSeconds", 0.0)
                ) + render_seconds + encoder_write_seconds

            original_emit_pending_output = emit_pending_output

            def emit_pending_output(record: dict[str, Any]) -> None:
                lease = record.get("result")
                has_lease = isinstance(lease, AsyncReadbackLease)
                if has_lease:
                    isolated_output_union["seenLease"] = True
                if isolated_output_failed.is_set() or session.stop.is_set():
                    if has_lease:
                        lease.output_observer = None
                        lease.release()
                    return
                before_write = session.encoder_write_seconds
                started = time.perf_counter()
                try:
                    if has_lease:
                        record["result"] = lease.materialize()
                    if session.stop.is_set():
                        return
                    original_emit_pending_output(record)
                    finished = time.perf_counter()
                    segments = ([(record["frameWorkStartedAt"], finished)] if has_lease else
                                [*record["frameWorkIntervals"], (started, finished)])
                    if _account_output_segments(
                            isolated_output_union, segments,
                            emitted=session.encoder_write_seconds > before_write):
                        if isolated_output_union["seenLease"]:
                            session.frame_work_seconds = isolated_output_union["seconds"]
                        if has_lease:
                            lease.observe()
                except BaseException:
                    isolated_output_failed.set()
                    raise
                finally:
                    if has_lease:
                        ended = time.perf_counter()
                        stats = lease.session_stats
                        if session.encoder_write_seconds > before_write:
                            stats["completed"] += 1
                            stats["lastCompleteAt"] = ended
                            stats["latencyMs"].append(
                                (ended - lease.frame_started_at) * 1000.0
                            )
                            stats["completionFps"] = (
                                stats["completed"]
                                / max(1e-9, ended - stats["firstStartAt"])
                            )
                        stats["waitSeconds"] += lease.wait_seconds
                        stats["copyGpuMs"] += lease.copy_gpu_ms
                        stats["gpuFrameMs"] += lease.gpu_frame_ms
                        stats["outputSeconds"] += ended - started
                        lease.release()

            def flush_pending_outputs() -> None:
                while pending_outputs:
                    record = pending_outputs.pop(0)
                    if isinstance(record.get("result"), AsyncReadbackLease):
                        isolated_output_futures.append(
                            isolated_output_executor.submit(emit_pending_output, record)
                        )
                        if len(isolated_output_futures) >= 2:
                            isolated_output_futures.pop(0).result()
                    else:
                        while isolated_output_futures:
                            isolated_output_futures.pop(0).result()
                        emit_pending_output(record)

            acquisition_hold_frames = (
                3
                if session.manual_target_embedding is None
                and session.manual_target_x is None
                and session.manual_target_y is None
                else 0
            )

            def backfill_automatic_acquisition_frames() -> None:
                """Swap a tiny held entry window after automatic identity acquisition."""

                if not acquisition_hold_frames or anchor is None:
                    return
                target_presentation = tracking_state.get("targetPresentation")
                for record in pending_outputs:
                    input_frame = record.pop("inputFrame", None)
                    if input_frame is None or not record.get("compatibilityPassthrough"):
                        continue
                    evidence = FrameEvidence(
                        frame_index=int(record.get("frameIndex", -1)),
                        media_time_seconds=float(record.get("timelineSeconds", 0.0)),
                    )
                    backfill_tracking = {
                        "targetPresentation": target_presentation,
                        # Keep the confirmed automatic anchor immutable while
                        # rendering earlier frames out of chronological order.
                        "manualTargetIdentityLock": True,
                    }
                    started = time.perf_counter()
                    rendered, _ = self._run_gpu_work(
                        self._process_frame_to_rgb,
                        input_frame,
                        source_embedding,
                        np.asarray(anchor, dtype=np.float32).copy(),
                        priority=0,
                        queue_cancel_event=session.stop,
                        cancelled_value=(None, anchor),
                        work_label="automatic-acquisition-backfill",
                        source_frame=source_frame,
                        verify_identity=True,
                        tracking_state=backfill_tracking,
                        cancel_event=session.stop,
                        config=session_config,
                        diagnostics=None,
                        temporal_context=None,
                        frame_evidence=evidence,
                    )
                    if rendered is not None:
                        record["result"] = rendered
                        record["future"] = None
                        record["transformed"] = True
                        frame_index = int(record.get("frameIndex", -1))
                        if frame_index >= 0:
                            session.automatic_acquisition_backfilled_frames.append(
                                frame_index
                            )
                    backfill_finished = time.perf_counter()
                    record["frameWorkSeconds"] = float(
                        record.get("frameWorkSeconds", 0.0)
                    ) + (backfill_finished - started)
                    record["frameWorkIntervals"].append((started, backfill_finished))

            try:
                while not session.stop.is_set():
                    try:
                        decoded_item = decode_queue.get(timeout=0.10)
                    except queue.Empty:
                        if not decoder.is_alive():
                            break
                        continue
                    if decoded_item is decode_sentinel:
                        break
                    if isinstance(decoded_item, BaseException):
                        raise decoded_item
                    frame, decoded_timeline_seconds = decoded_item
                    if session.stop.is_set():
                        break
                    # A progress-bar gesture needs WebView/compositor GPU
                    # responsiveness more than additional old-timeline
                    # headroom. Finish at most the in-flight frame, then
                    # yield until the replacement activates or a failed
                    # seek explicitly resumes this session.
                    while session.scrub_suspended.is_set() and not session.stop.is_set():
                        with session.condition:
                            session.condition.wait(timeout=0.025)
                    if session.stop.is_set():
                        break
                    timeline_reliable = False
                    timeline_seconds = session.frames / fps
                    if decoded_timeline_seconds is not None:
                        try:
                            decoded_time = float(decoded_timeline_seconds)
                            if math.isfinite(decoded_time):
                                timeline_seconds = decoded_time
                                timeline_reliable = True
                        except (TypeError, ValueError, OverflowError):
                            timeline_reliable = False
                    frame_delta_seconds = 1.0 / max(1.0, fps)
                    pts_discontinuity = not timeline_reliable
                    if timeline_reliable and previous_timeline_seconds is not None:
                        pts_delta = timeline_seconds - previous_timeline_seconds
                        max_pts_gap = max(
                            3.5 / max(1.0, fps),
                            float(runtime.get("temporalMaxPtsGapSeconds", 0.25)),
                        )
                        pts_discontinuity = bool(
                            not math.isfinite(pts_delta)
                            or pts_delta <= 0.0
                            or pts_delta > max_pts_gap
                        )
                        if not pts_discontinuity:
                            frame_delta_seconds = pts_delta
                    if pts_discontinuity:
                        invalidate_temporal_chain(
                            clear_tracking=True,
                            reason="pts-discontinuity",
                        )
                    previous_timeline_seconds = (
                        timeline_seconds if timeline_reliable else None
                    )
                    if (
                        session.prefetch_gate_owned
                        and (
                            session.activation_requested
                            or session.playback_started_at
                            or not session.prefetch
                        )
                    ):
                        self._release_prefetch_admission(session)
                    if session.prefetch and not session.playback_started_at:
                        while not session.stop.is_set():
                            with session.condition:
                                if session.activation_requested:
                                    session.playback_started_at = time.monotonic()
                                    session.prefetch = False
                                    self._release_prefetch_admission(session)
                                    session.condition.notify_all()
                                    break
                                # Reaching the requested frame count is not
                                # enough: the stdout reader must have parsed
                                # a complete moof followed by its complete
                                # mdat payload. Continue producing until
                                # both the temporal and container boundaries
                                # are satisfied.
                                if not self._prefetch_has_safe_lead(session):
                                    break
                                self._release_prefetch_admission(session)
                                session.condition.wait(timeout=0.20)
                        if session.stop.is_set():
                            break

                    # Keep only a small ephemeral lead on disk.  Without this
                    # gate a fast RTX GPU can encode several minutes while the
                    # phone has played only a few seconds, wasting storage and
                    # making a reconnect unnecessarily expensive.
                    # Pace against complete encoded media and the browser's
                    # sparse playback position. A paused/background reader
                    # therefore stops consuming credit instead of silently
                    # drifting forward on a server wall clock.
                    pacing_wait_started = time.perf_counter()
                    while not session.stop.is_set():
                        # Do not let an early pause/load event cap a low-
                        # entropy stream at a tiny body Android WebView has
                        # already proven it may reject as FORMAT_ERROR.
                        # This bypass ends as soon as the measured startup
                        # byte floor and a complete fragment are available.
                        if not session.browser_startup_ready():
                            break
                        produced_seconds = self._playable_media_seconds(session)
                        played_seconds = (
                            self._estimated_playback_position_seconds(
                                session,
                                time.monotonic(),
                            )
                            if session.playback_started_at
                            else 0.0
                        )
                        excess_lead = (
                            produced_seconds
                            - played_seconds
                            - render_ahead_ceiling_seconds(
                                base_seconds=lead_buffer_seconds,
                                max_foreground_seconds=max(12.0, lead_buffer_seconds),
                                foreground_pacing_wait_seconds=session.foreground_pacing_wait_seconds,
                                active_foreground=bool(session.playback_started_at and session.activation_requested and not session.prefetch),
                                playback_paused=session.playback_paused,
                                startup_ready=True,
                                scrub_suspended=session.scrub_suspended.is_set(),
                            )
                        )
                        session.render_ahead_ceiling_seconds = produced_seconds - played_seconds - excess_lead
                        if excess_lead <= 0:
                            break
                        bank_idle_time = bool(
                            session.playback_started_at and session.activation_requested
                            and not session.prefetch and not session.playback_paused
                            and not session.scrub_suspended.is_set()
                        )
                        lead_wait_started = time.perf_counter()
                        with session.condition:
                            session.condition.wait(
                                timeout=min(0.05, max(0.005, excess_lead)),
                            )
                        if bank_idle_time and not session.playback_paused and not session.scrub_suspended.is_set():
                            session.foreground_pacing_wait_seconds += time.perf_counter() - lead_wait_started
                    session.pacing_wait_seconds += (
                        time.perf_counter() - pacing_wait_started
                    )
                    if session.stop.is_set():
                        break
                    # The prefetch gate still admits only one speculative
                    # producer, but frame-level priority belongs to a viewed
                    # stream until its safety buffer is healthy.  Waiting
                    # outside process_frame's global model lock prevents a
                    # fast prefetch loop from starving the growing fMP4 and
                    # making Android WebView seek back to its live edge.
                    self._yield_prefetch_for_foreground(session)
                    if session.stop.is_set():
                        break
                    if pending_source_switch is not None:
                        next_candidate, next_similarity = pending_source_switch
                        pending_source_switch = None
                        source_embedding = next_candidate.embedding
                        source_frame = next_candidate.source_frame
                        session.face_id = next_candidate.face_id
                        session.selected_face_id = next_candidate.face_id
                        apply_face_restoration(session_config, next_candidate.face_id)
                        session.selected_face_similarity = float(next_similarity)
                        tracking_state["sourcePresentation"] = (
                            next_candidate.presentation
                        )
                        # Retain the immutable target-person anchor and its
                        # geometric track, but prevent any temporal output
                        # made with the prior approved source from crossing
                        # this boundary.
                        invalidate_temporal_chain(
                            clear_tracking=False,
                            reason="approved-source-switch",
                        )
                    if not session.first_source_frame_at:
                        session.first_source_frame_at = time.time()
                    frame_work_started = time.perf_counter()
                    # Prove the immutable target identity on every exact
                    # anchor. Between anchors, the temporal path advances
                    # the already-verified face only while its geometry and
                    # appearance remain continuous; any uncertainty falls
                    # back to an exact all-face identity check.
                    verify_identity = bool(
                        session.frames % identity_interval == 0
                    )
                    restorer_anchor_hz = max(
                        0.25,
                        float(runtime.get("temporalRestorerAnchorHz", 3.0)),
                    )
                    temporal_context["frameIndex"] = int(session.frames)
                    temporal_context["mediaTimeSeconds"] = float(timeline_seconds)
                    temporal_context["nominalFrameSeconds"] = frame_delta_seconds
                    temporal_context["frameDependencyAnchorFrame"] = int(session.frames)
                    temporal_context["frameDependencyAnchorTimeSeconds"] = float(timeline_seconds)
                    temporal_context["frameHadStageReuse"] = False
                    temporal_context["maxAnchorFrames"] = max(
                        1,
                        int(math.ceil(fps / restorer_anchor_hz)),
                    )
                    force_exact_reasons = []
                    if verify_identity:
                        force_exact_reasons.append("identity-deadline")
                    if pts_discontinuity:
                        force_exact_reasons.append("pts-discontinuity")
                    force_exact_reasons.extend(
                        str(reason)
                        for reason in temporal_context.pop(
                            "pendingInvalidationReasons", []
                        )
                        if reason
                    )
                    # Preserve insertion order while removing duplicates so
                    # stage provenance has a stable primary reason.
                    temporal_context["forceExactReasons"] = list(
                        dict.fromkeys(force_exact_reasons)
                    )
                    temporal_context["forceExact"] = bool(
                        temporal_context["forceExactReasons"]
                    )
                    tracking_state['frameDeltaSeconds'] = frame_delta_seconds
                    frame_evidence = FrameEvidence(
                        frame_index=int(session.frames),
                        media_time_seconds=float(timeline_seconds),
                        prior_track_revision=int(
                            tracking_state.get("trackRevision", 0)
                        ),
                    )
                    output_frame = None
                    output_future = None
                    frame_was_transformed = False
                    compatibility_passthrough = False
                    identity_just_locked = False
                    if (
                        not identity_locked
                        and int(session.frames) >= int(next_compatibility_probe_frame)
                    ):
                        session.compatibility_checks += 1
                        selection = self._run_gpu_work(
                            self._select_compatible_identity_for_frame,
                            frame,
                            candidates,
                            session_config,
                            frame_evidence,
                            session.stop,
                            (
                                (session.manual_target_x, session.manual_target_y)
                                if session.manual_target_x is not None
                                and session.manual_target_y is not None
                                else None
                            ),
                            session.manual_target_embedding,
                            session.manual_target_presentation,
                            priority=(10 if session.prefetch else 0),
                            queue_cancel_event=session.stop,
                            cancelled_value=None,
                            work_label="identity-compatibility",
                            multi_source_face_id=self._multi_video_sources.bind(multi_choice_key),
                        )
                        if multi_face_consensus is not None:
                            session.multi_face_decision = getattr(frame_evidence, "multi_face_decision", {})
                            selection = multi_face_consensus.observe(selection, float(timeline_seconds))
                            if selection is not None:
                                bound = self._multi_video_sources.bind(multi_choice_key, selection.candidate.face_id)
                                if bound != selection.candidate.face_id:
                                    # Another prepared session established this video's
                                    # source while inference was in flight. Reacquire the
                                    # bound source; never paint a transient different face.
                                    multi_face_consensus = MultiFaceConsensus()
                                    selection = None
                                else:
                                    session.multi_face_decision = {**session.multi_face_decision, "reason": "locked-for-video", "sourceChoiceRetainedAcrossSeeks": multi_choice_key is not None}
                        if selection is not None:
                            identity_locked = True
                            identity_just_locked = True
                            source_embedding = selection.candidate.embedding
                            source_frame = selection.candidate.source_frame
                            anchor = np.asarray(
                                session.manual_target_embedding
                                if session.manual_target_embedding is not None
                                else selection.target.embedding,
                                dtype=np.float32,
                            ).reshape(-1).copy()
                            tracking_state["targetIdentityAnchor"] = anchor.copy()
                            tracking_state["targetIdentityGallery"] = [anchor.copy()]
                            session.face_id = selection.candidate.face_id
                            session.selected_face_id = selection.candidate.face_id
                            apply_face_restoration(session_config, selection.candidate.face_id)
                            session.selected_face_similarity = float(selection.similarity)
                            locked_target_presentation = (
                                session.manual_target_presentation
                                if isinstance(
                                    session.manual_target_presentation,
                                    FacePresentation,
                                )
                                else selection.target.presentation
                            )
                            session.selected_target_presentation = (
                                locked_target_presentation.label
                            )
                            if session.manual_target_embedding is None:
                                session.automatic_target_lock_frame = int(
                                    session.frames
                                )
                                session.automatic_target_lock_seconds = float(
                                    timeline_seconds
                                )
                            session.compatibility_status = "locked"
                            tracking_state["targetPresentation"] = (
                                locked_target_presentation
                            )
                            tracking_state["lastTargetVerifiedFrame"] = int(
                                session.frames
                            )
                            tracking_state["sourcePresentation"] = (
                                selection.candidate.presentation
                            )
                            # The tap is used once to acquire a person.
                            # Persist that person's recognized identity so
                            # later motion cannot move the swap to a nearby
                            # face. Loss fails closed until they return.
                            if session.manual_target_embedding is not None:
                                tracking_state["manualTargetIdentityLock"] = True
                                tracking_state["manualTargetEmbedding"] = np.asarray(
                                    session.manual_target_embedding,
                                    dtype=np.float32,
                                )
                            switch_challenger_id = ""
                            switch_challenger_confirmations = 0
                        else:
                            session.compatibility_rejections += 1
                            session.compatibility_status = "no-compatible-face"
                            # Foreground acquisition checks every frame so
                            # the first confident appearance is not skipped
                            # between 5 Hz probes. Speculative work remains
                            # sparse because it is not yet user-visible.
                            next_compatibility_probe_frame = int(session.frames) + acquisition_probe_step(
                                fps, session.prefetch,
                                multi_face_consensus is not None and multi_face_consensus.pending is not None,
                            )
                    if not identity_locked:
                        output_frame = np.ascontiguousarray(frame)
                        if output_frame.shape[:2] != (output_height, output_width):
                            output_frame = cv2.resize(
                                output_frame,
                                (output_width, output_height),
                                interpolation=cv2.INTER_LINEAR,
                            )
                        compatibility_passthrough = True
                    output_render_diagnostics: dict[str, Any] | None = None
                    foreground_temporal_reuse = bool(
                        identity_locked
                        and
                        temporal_context.get("enabled")
                        and self._foreground_reuse_allowed_for_source(
                            session,
                            runtime,
                            frame.shape,
                        )
                        and not bool(
                            runtime.get("temporalCurrentGeometryEnabled", False)
                        )
                        and self._session_temporal_frame_may_reuse(
                            session,
                            runtime,
                            verify_identity=verify_identity,
                            last_exact_frame=last_exact_frame,
                            current_timeline_seconds=timeline_seconds,
                            last_exact_timeline_seconds=last_exact_timeline_seconds,
                            timeline_reliable=timeline_reliable,
                        )
                    )
                    try:
                        temporal_anchor_frames = max(
                            1,
                            int(
                                math.ceil(
                                    max(1.0, session.fps)
                                    / max(
                                        0.25,
                                        float(
                                            runtime.get(
                                                "temporalFullAnchorHz", 5.0
                                            )
                                        ),
                                    )
                                )
                            ),
                        )
                    except (TypeError, ValueError, OverflowError):
                        temporal_anchor_frames = 1
                    temporal_grace_frame = bool(
                        foreground_temporal_reuse
                        and bool(runtime.get("temporalFullAdaptiveGraceEnabled", False))
                        and int(session.frames) - int(last_exact_frame)
                        == temporal_anchor_frames
                    )
                    legacy_prefetch_reuse = self._prefetch_frame_may_reuse(
                        session,
                        runtime,
                        verify_identity=verify_identity,
                    ) if identity_locked else False
                    current_render_signature = (
                        int(tracking_state.get("trackGeneration", 0)),
                        int(session.config_revision),
                        str(session.face_id),
                        str(parameters.get("SwapperTypeTextSel", "128")),
                        str(parameters.get("RestorerTypeTextSel", "")),
                    )
                    reuse_requested = bool(
                        foreground_temporal_reuse or legacy_prefetch_reuse
                    )
                    reuse_anchor_available = bool(
                        previous_source_frame is not None
                        and previous_swapped_frame is not None
                        and previous_swap_kps is not None
                    )
                    if reuse_requested and not reuse_anchor_available:
                        record_temporal_rejection("missing-anchor")
                    elif reuse_requested and previous_render_signature != current_render_signature:
                        record_temporal_rejection("signature")
                    elif reuse_requested:
                        detect_interval = max(
                            1,
                            int(runtime.get("targetDetectIntervalFrames", 1)),
                        )
                        if foreground_temporal_reuse:
                            detect_interval = max(
                                detect_interval,
                                int(temporal_anchor_frames) + 1,
                            )
                        pending_advance = _advance_prefetch_tracking(
                            frame,
                            tracking_state,
                            detect_interval,
                            require_all_observed=foreground_temporal_reuse,
                            commit=False,
                            return_advance=True,
                            frame_evidence=frame_evidence,
                            media_time_seconds=float(timeline_seconds),
                        )
                        if (
                            not isinstance(pending_advance, LandmarkTrackAdvance)
                            and foreground_temporal_reuse
                        ):
                            redetect_started = time.perf_counter()
                            pending_advance = self._run_gpu_work(
                                self._redetect_landmarks_for_temporal_reuse,
                                frame,
                                tracking_state,
                                priority=(10 if session.prefetch else 0),
                                queue_cancel_event=session.stop,
                                cancelled_value=None,
                                work_label="temporal-redetect",
                                config=session_config,
                                cancel_event=session.stop,
                                frame_evidence=frame_evidence,
                                media_time_seconds=float(timeline_seconds),
                            )
                            session.redetect_seconds += (
                                time.perf_counter() - redetect_started
                            )
                            if isinstance(pending_advance, LandmarkTrackAdvance):
                                session.temporal_redetect_recoveries += 1
                        appearance_diagnostics: dict[str, Any] = {}
                        appearance_started = time.perf_counter()
                        dense_flow_residual = bool(
                            foreground_temporal_reuse
                            and runtime.get("temporalFullDenseFlowResidual", False)
                        )
                        semantic_feature_residual = bool(
                            foreground_temporal_reuse
                            and semantic_feature_enabled_for_session
                        )
                        sparse_mesh_residual = bool(
                            foreground_temporal_reuse
                            and sparse_mesh_enabled_for_session
                        )
                        appearance_safe = bool(
                            isinstance(pending_advance, LandmarkTrackAdvance)
                            and (
                                dense_flow_residual
                                or
                                sparse_mesh_residual
                                or
                                not foreground_temporal_reuse
                                or _full_frame_reuse_appearance_is_safe(
                                    frame,
                                    previous_source_frame,
                                    previous_swap_kps,
                                    pending_advance.points,
                                    max_face_mae=float(runtime.get("temporalFullMaxFaceMae", 14.0)),
                                    max_face_p90=float(runtime.get("temporalFullMaxFaceP90", 32.0)),
                                    max_patch_mae=float(runtime.get("temporalFullMaxPatchMae", 46.0)),
                                    diagnostics=appearance_diagnostics,
                                )
                            )
                        )
                        if isinstance(pending_advance, LandmarkTrackAdvance):
                            session.appearance_guard_seconds += (
                                time.perf_counter() - appearance_started
                            )
                        if not isinstance(pending_advance, LandmarkTrackAdvance):
                            record_temporal_rejection("tracking")
                        elif not appearance_safe:
                            record_temporal_rejection(
                                str(appearance_diagnostics.get("reason") or "appearance"),
                                appearance_diagnostics,
                            )
                        else:
                            warp_started = time.perf_counter()
                            warp_diagnostics: dict[str, Any] = {}
                            next_sparse_mesh_state = None
                            if semantic_feature_residual:
                                # The semantic feature path used to be
                                # warmed and rebased below but was never
                                # selected here, so enabling its setting
                                # could not affect a live frame. Keep the
                                # established whole-face residual as the
                                # authoritative result, then admit only
                                # appearance-safe eye/nose/mouth islands.
                                # Any missing or unsafe semantic evidence
                                # falls back inside the helper without
                                # interrupting playback.
                                output_frame, next_sparse_mesh_state = (
                                    _warp_prior_swap_with_semantic_features(
                                        frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        tracking_state.get("sparseResidualMesh"),
                                        max_landmark_residual_ratio=float(
                                            runtime.get(
                                                "temporalFullMaxLandmarkResidualRatio",
                                                0.12,
                                            )
                                        ),
                                        interpolation=(
                                            cv2.INTER_CUBIC
                                            if bool(runtime.get(
                                                "temporalFullBicubicResidual",
                                                False,
                                            ))
                                            else cv2.INTER_LINEAR
                                        ),
                                        feature_strength=float(runtime.get(
                                            "temporalFullFeaturePatchLockStrength",
                                            0.65,
                                        )),
                                        feature_max_mae=float(runtime.get(
                                            "temporalFullFeaturePatchMaxMae",
                                            16.0,
                                        )),
                                        feature_max_p90=float(runtime.get(
                                            "temporalFullFeaturePatchMaxP90",
                                            34.0,
                                        )),
                                        feature_groups=tuple(
                                            str(value)
                                            for value in runtime.get(
                                                "temporalSemanticFeatureGroups",
                                                ("leftEye", "rightEye"),
                                            )
                                        ),
                                        diagnostics=warp_diagnostics,
                                    )
                                )
                            elif sparse_mesh_residual:
                                output_frame, next_sparse_mesh_state = (
                                    _warp_prior_swap_residual_sparse_mesh(
                                        frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        tracking_state.get("sparseResidualMesh"),
                                        mesh_size=int(
                                            runtime.get("temporalFullSparseMeshSize", 128)
                                        ),
                                        diagnostics=warp_diagnostics,
                                    )
                                )
                            elif dense_flow_residual:
                                output_frame = _warp_prior_swap_residual_dense_flow(
                                    frame,
                                    previous_source_frame,
                                    previous_swapped_frame,
                                    previous_swap_kps,
                                    pending_advance.points,
                                    flow_size=int(
                                        runtime.get("temporalFullDenseFlowSize", 192)
                                    ),
                                    diagnostics=warp_diagnostics,
                                )
                            else:
                                current_canonical_transform = None
                                canonical_transport_enabled = bool(
                                    runtime.get(
                                        "temporalCanonicalResidualTransport",
                                        False,
                                    )
                                )
                                if bool(runtime.get(
                                    "temporalCanonicalResidualLowMotionOnly", False
                                )):
                                    canonical_transport_enabled = bool(
                                        canonical_transport_enabled
                                        and _selected_adaptive_mask_backend(
                                            runtime, tracking_state
                                        ) == "trt"
                                    )
                                if (
                                    canonical_transport_enabled
                                    and previous_canonical_transform is not None
                                ):
                                    try:
                                        current_canonical_transform, _pipeline_size = (
                                            self._vm.canonical_face_transform_matrix(
                                                pending_advance.points,
                                                parameters,
                                            )
                                        )
                                    except (TypeError, ValueError, ArithmeticError):
                                        current_canonical_transform = None
                                residual_arguments = {
                                    "max_landmark_residual_ratio": float(
                                        runtime.get(
                                            "temporalFullMaxLandmarkResidualRatio",
                                            0.12,
                                        )
                                    ),
                                    "interpolation": (
                                        cv2.INTER_CUBIC
                                        if bool(runtime.get(
                                            "temporalFullBicubicResidual", False
                                        ))
                                        else cv2.INTER_LINEAR
                                    ),
                                    "continuous_linear": bool(
                                        runtime.get(
                                            "temporalContinuousResidualWarp",
                                            False,
                                        )
                                    ),
                                    "feature_patch_lock_strength": (
                                        float(runtime.get(
                                            "temporalFullFeaturePatchLockStrength",
                                            0.0,
                                        ))
                                        if bool(runtime.get(
                                            "temporalFullFeaturePatchLockEnabled",
                                            False,
                                        ))
                                        else 0.0
                                    ),
                                    "feature_patch_max_mae": float(
                                        runtime.get(
                                            "temporalFullFeaturePatchMaxMae", 16.0
                                        )
                                    ),
                                    "feature_patch_max_p90": float(
                                        runtime.get(
                                            "temporalFullFeaturePatchMaxP90", 34.0
                                        )
                                    ),
                                    "source_to_canonical": previous_canonical_transform,
                                    "target_to_canonical": current_canonical_transform,
                                    "canonical_blend_weight": float(runtime.get(
                                        "temporalCanonicalResidualBlendWeight", 1.0
                                    )),
                                    "pose_aware_affine": bool(runtime.get(
                                        "temporalPoseAwareAffineResidual", False
                                    )),
                                    "pose_aware_affine_max_anisotropy": float(
                                        runtime.get(
                                            "temporalPoseAwareAffineMaxAnisotropy",
                                            1.12,
                                        )
                                    ),
                                    "pose_aware_affine_min_improvement": float(
                                        runtime.get(
                                            "temporalPoseAwareAffineMinImprovement",
                                            0.12,
                                        )
                                    ),
                                    "pose_aware_affine_min_residual_ratio": float(
                                        runtime.get(
                                            "temporalPoseAwareAffineMinResidualRatio",
                                            0.008,
                                        )
                                    ),
                                    "diagnostics": warp_diagnostics,
                                }
                                if residual_overlap_enabled:
                                    output_frame = _plan_prior_swap_residual(
                                        frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        **residual_arguments,
                                    )
                                else:
                                    output_frame = _warp_prior_swap_residual(
                                        frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        **residual_arguments,
                                    )
                            _record_adaptive_mask_motion(
                                runtime,
                                tracking_state,
                                warp_diagnostics,
                            )
                            if output_frame is not None and temporal_grace_frame:
                                grace_safe = bool(
                                    float(appearance_diagnostics.get("faceMae", math.inf))
                                    <= float(runtime.get("temporalFullMaxFaceMae", 14.0)) * 0.5
                                    and float(appearance_diagnostics.get("faceP90", math.inf))
                                    <= float(runtime.get("temporalFullMaxFaceP90", 32.0)) * 0.5
                                    and float(appearance_diagnostics.get("patchMae", math.inf))
                                    <= float(runtime.get("temporalFullMaxPatchMae", 46.0)) * 0.5
                                    and float(warp_diagnostics.get("landmarkResidualRatio", math.inf))
                                    <= min(
                                        0.015,
                                        float(
                                            runtime.get(
                                                "temporalFullMaxLandmarkResidualRatio",
                                                0.12,
                                            )
                                        ) * 0.5,
                                    )
                                )
                                if not grace_safe:
                                    output_frame = None
                                    record_temporal_rejection("adaptive-grace")
                            session.residual_warp_seconds += (
                                time.perf_counter() - warp_started
                            )
                            if output_frame is not None:
                                if next_sparse_mesh_state is not None:
                                    tracking_state["sparseResidualMesh"] = next_sparse_mesh_state
                                _commit_tracking_advance(
                                    tracking_state,
                                    pending_advance,
                                )
                                if (
                                    residual_overlap_enabled
                                    and output_executor is not None
                                    and isinstance(output_frame, ResidualWarpPlan)
                                ):
                                    output_render_diagnostics = warp_diagnostics
                                    output_future = output_executor.submit(
                                        render_residual_plan,
                                        output_frame,
                                        output_render_diagnostics,
                                    )
                                    output_frame = None
                            else:
                                record_temporal_rejection(
                                    str(warp_diagnostics.get("reason") or "warp"),
                                    warp_diagnostics,
                                )
                        # The legacy prefetch-only shortcut must not cross a
                        # promotion boundary. The quality-gated temporal
                        # path is explicitly valid for foreground playback.
                        if (
                            not foreground_temporal_reuse
                            and (session.activation_requested or session.playback_started_at)
                        ):
                            if output_future is not None:
                                _discard_residual_future_for_promotion(
                                    output_future
                                )
                                output_future = None
                            output_frame = None
                    if output_frame is None and output_future is None:
                        exact_work_started = time.perf_counter()
                        temporal_context.pop("fullCanonicalTransform", None)
                        temporal_context.pop("fullCanonicalPipelineSize", None)
                        next_tracking_frame = None
                        if not session.prefetch:
                            # Never wait for another frame or remove it from
                            # the decoder. First-frame and seek latency keep
                            # their ordinary immediate rendering path.
                            with decode_queue.mutex:
                                next_decoded = (
                                    decode_queue.queue[0]
                                    if decode_queue.queue else None
                                )
                                if isinstance(next_decoded, tuple):
                                    next_tracking_frame = next_decoded[0]
                        try:
                            output_frame, anchor = self._run_gpu_work(
                                self._process_frame_to_rgb,
                                frame,
                                source_embedding,
                                anchor,
                                priority=(10 if session.prefetch else 0),
                                queue_cancel_event=session.stop,
                                cancelled_value=(None, anchor),
                                work_label="frame-render",
                                _isolated_async_session=session,
                                _isolated_async_readback=bool(identity_locked and session.frames > 0 and not session.prefetch and len(candidates) == 1),
                                tracking_lookahead=tracking_lookahead,
                                next_frame=next_tracking_frame,
                                source_frame=source_frame,
                                verify_identity=verify_identity,
                                tracking_state=tracking_state,
                                cancel_event=session.stop,
                                config=session_config,
                                diagnostics=(
                                    session.frame_diagnostics
                                    if session.diagnostics_enabled
                                    else None
                                ),
                                temporal_context=(
                                    temporal_context
                                    if temporal_context.get("enabled")
                                    else None
                                ),
                                frame_evidence=frame_evidence,
                            )
                        except Exception as exc:
                            if (
                                foreground_oom_retry_used
                                or session.prefetch
                                or not self._gpu_oom_error(exc)
                            ):
                                raise
                            # Preserve every configured quality stage. The
                            # visible card gets one retry after optional work
                            # and allocator caches have been reclaimed.
                            foreground_oom_retry_used = True
                            self._record_gpu_oom(session, exc)
                            self._recover_foreground_gpu_memory(session)
                            anchor = None
                            invalidate_temporal_chain(
                                clear_tracking=True,
                                reason="gpu-oom-retry",
                            )
                            output_frame, anchor = self._run_gpu_work(
                                self._process_frame_to_rgb,
                                frame,
                                source_embedding,
                                anchor,
                                priority=(10 if session.prefetch else 0),
                                queue_cancel_event=session.stop,
                                cancelled_value=(None, anchor),
                                work_label="frame-render-oom-retry",
                                _isolated_async_session=session,
                                _isolated_async_readback=bool(identity_locked and session.frames > 0 and not session.prefetch and len(candidates) == 1),
                                source_frame=source_frame,
                                verify_identity=True,
                                tracking_state=tracking_state,
                                cancel_event=session.stop,
                                config=session_config,
                                diagnostics=(
                                    session.frame_diagnostics
                                    if session.diagnostics_enabled
                                    else None
                                ),
                                temporal_context=(
                                    temporal_context
                                    if temporal_context.get("enabled")
                                    else None
                                ),
                                frame_evidence=frame_evidence,
                            )
                        if isinstance(output_frame, AsyncReadbackLease):
                            isolated_unqueued_lease = output_frame
                        if output_frame is None or session.stop.is_set():
                            break
                        session.inference_frames += 1
                        # Re-rank the selected approved faces only when the
                        # existing target-identity verification has already
                        # produced an ArcFace embedding. This is at most five
                        # vector dot products and adds no detector, recognizer,
                        # swapper, or restorer inference. A confirmed change
                        # takes effect on the next frame; the target-person
                        # anchor itself is never replaced.
                        if (
                            identity_locked
                            and len(candidates) > 1
                            and not selected_source_policy.disabled
                            and frame_evidence.selected_target_embedding is not None
                        ):
                            target_presentation = tracking_state.get(
                                "targetPresentation"
                            )
                            if not isinstance(target_presentation, FacePresentation):
                                target_presentation = FacePresentation(
                                    str(session.selected_target_presentation or "unknown"),
                                    1.0,
                                )
                            current_candidate = next(
                                (
                                    candidate
                                    for candidate in candidates
                                    if candidate.face_id == session.selected_face_id
                                ),
                                None,
                            )
                            target_identity = TargetIdentity(
                                keypoints=np.asarray(
                                    tracking_state.get(
                                        "kps",
                                        np.zeros((5, 2), dtype=np.float32),
                                    ),
                                    dtype=np.float32,
                                ),
                                embedding=np.asarray(
                                    frame_evidence.selected_target_embedding,
                                    dtype=np.float32,
                                ),
                                presentation=target_presentation,
                            )
                            ranked_sources = compatible_identity_rankings(
                                candidates,
                                target_identity,
                                minimum_similarity=source_match_threshold,
                                minimum_presentation_confidence=presentation_confidence_for_strictness(
                                    source_match_threshold
                                ),
                            )
                            best_source = ranked_sources[0] if ranked_sources else None
                            current_similarity = (
                                rope_similarity(
                                    current_candidate.embedding,
                                    target_identity.embedding,
                                )
                                if current_candidate is not None
                                else -math.inf
                            )
                            if math.isfinite(current_similarity):
                                session.selected_face_similarity = float(
                                    current_similarity
                                )
                            should_challenge = bool(
                                not selected_source_policy.disabled
                                and current_candidate is not None
                                and best_source is not None
                                and best_source.candidate.face_id
                                != current_candidate.face_id
                                and best_source.similarity - current_similarity
                                > selected_source_policy.minimum_gain
                            )
                            if should_challenge:
                                challenger_id = best_source.candidate.face_id
                                if challenger_id == switch_challenger_id:
                                    switch_challenger_confirmations += 1
                                else:
                                    switch_challenger_id = challenger_id
                                    switch_challenger_confirmations = 1
                                if (
                                    switch_challenger_confirmations
                                    >= selected_source_policy.confirmations
                                ):
                                    pending_source_switch = (
                                        best_source.candidate,
                                        float(best_source.similarity),
                                    )
                                    switch_challenger_id = ""
                                    switch_challenger_confirmations = 0
                            else:
                                switch_challenger_id = ""
                                switch_challenger_confirmations = 0
                        current_kps = tracking_state.get("kps")
                        if identity_locked and frame_evidence.recognition_complete:
                            session.target_identity_checks += 1
                            target_similarity = frame_evidence.selected_target_similarity
                            if current_kps is None or target_similarity is None:
                                session.target_identity_rejections += 1
                                samples = session.target_identity_rejection_samples
                                reasons = list(dict.fromkeys(frame_evidence.rejection_reasons))
                                if (not samples
                                    or float(timeline_seconds) - samples[-1]["seconds"] >= 0.25
                                    or reasons != samples[-1]["reasons"]):
                                    session.target_identity_rejection_samples.append(
                                        {
                                            "frame": int(session.frames),
                                            "seconds": float(timeline_seconds),
                                            "sourceSeconds": float(session.start_seconds + timeline_seconds),
                                            "detectedFaces": len(frame_evidence.detections),
                                            "bestRawSimilarity": frame_evidence.best_target_raw_similarity,
                                            "bestSimilarity": frame_evidence.best_target_similarity,
                                            "reasons": reasons,
                                        }
                                    )
                                    del samples[:-80]
                            else:
                                similarity_value = float(target_similarity)
                                if (
                                    frame_evidence.selected_target_embedding
                                    is not None
                                ):
                                    tracking_state[
                                        "lastTargetVerifiedFrame"
                                    ] = int(session.frames)
                                if session.target_identity_min_similarity <= 0:
                                    session.target_identity_min_similarity = similarity_value
                                else:
                                    session.target_identity_min_similarity = min(
                                        session.target_identity_min_similarity,
                                        similarity_value,
                                    )
                                session.target_identity_max_similarity = max(
                                    session.target_identity_max_similarity,
                                    similarity_value,
                                )
                        frame_was_transformed = current_kps is not None
                        if frame_was_transformed and not session.first_transformed_frame_at:
                            session.first_transformed_frame_at = time.time()
                        # PyAV's ndarray and the downloaded CUDA result own
                        # their storage. Retaining those arrays is safe and
                        # avoids two extra full-frame copies on every model
                        # frame; ascontiguousarray copies only an unusual
                        # non-contiguous input.
                        if current_kps is None:
                            invalidate_temporal_chain(
                                clear_tracking=False,
                                reason="target-loss",
                            )
                        else:
                            if (
                                bool(runtime.get(
                                    "temporalExactOutputStabilizationEnabled",
                                    False,
                                ))
                                and previous_source_frame is not None
                                and previous_swapped_frame is not None
                                and previous_swap_kps is not None
                                and previous_render_signature
                                == (
                                    int(tracking_state.get("trackGeneration", 0)),
                                    int(session.config_revision),
                                    str(session.face_id),
                                    str(parameters.get("SwapperTypeTextSel", "128")),
                                    str(parameters.get("RestorerTypeTextSel", "")),
                                )
                            ):
                                exact_stabilization_diagnostics = (
                                    {} if session.diagnostics_enabled else None
                                )
                                output_frame = _stabilize_exact_output_with_prior(
                                    frame,
                                    output_frame,
                                    previous_source_frame,
                                    previous_swapped_frame,
                                    previous_swap_kps,
                                    np.asarray(current_kps, dtype=np.float32),
                                    current_weight=float(runtime.get(
                                        "temporalExactOutputCurrentWeight", 0.85
                                    )),
                                    max_face_mae=float(runtime.get(
                                        "temporalFullMaxFaceMae", 14.0
                                    )),
                                    max_face_p90=float(runtime.get(
                                        "temporalFullMaxFaceP90", 32.0
                                    )),
                                    max_patch_mae=float(runtime.get(
                                        "temporalFullMaxPatchMae", 46.0
                                    )),
                                    max_landmark_residual_ratio=float(runtime.get(
                                        "temporalFullMaxLandmarkResidualRatio", 0.12
                                    )),
                                    dense_flow=bool(runtime.get(
                                        "temporalExactOutputDenseFlowEnabled", False
                                    )),
                                    delta_seconds=frame_delta_seconds,
                                    half_life_seconds=float(runtime.get(
                                        "temporalExactOutputHalfLifeSeconds", 0.020
                                    )),
                                    local_change_low=float(runtime.get(
                                        "temporalExactOutputLocalChangeLow", 3.0
                                    )),
                                    local_change_high=float(runtime.get(
                                        "temporalExactOutputLocalChangeHigh", 18.0
                                    )),
                                    motion_low_per_second=float(runtime.get(
                                        "temporalExactOutputMotionLowPerSecond", 0.20
                                    )),
                                    motion_high_per_second=float(runtime.get(
                                        "temporalExactOutputMotionHighPerSecond", 1.50
                                    )),
                                    pose_aware_affine=bool(runtime.get(
                                        "temporalExactOutputPoseAwareAffine", True
                                    )),
                                    diagnostics=exact_stabilization_diagnostics,
                                )
                                if exact_stabilization_diagnostics is not None:
                                    for key, value in (
                                        exact_stabilization_diagnostics.items()
                                    ):
                                        session.frame_diagnostics.setdefault(
                                            key, []
                                        ).append(value)
                            if (
                                bool(runtime.get(
                                    "temporalExactMouthStabilizationEnabled",
                                    False,
                                ))
                                and previous_source_frame is not None
                                and previous_swapped_frame is not None
                                and previous_swap_kps is not None
                                and previous_render_signature
                                == (
                                    int(tracking_state.get("trackGeneration", 0)),
                                    int(session.config_revision),
                                    str(session.face_id),
                                    str(parameters.get("SwapperTypeTextSel", "128")),
                                    str(parameters.get("RestorerTypeTextSel", "")),
                                )
                            ):
                                mouth_diagnostics: dict[str, Any] = {}
                                output_frame = _stabilize_exact_mouth_with_prior(
                                    frame,
                                    output_frame,
                                    previous_source_frame,
                                    previous_swapped_frame,
                                    previous_swap_kps,
                                    np.asarray(current_kps, dtype=np.float32),
                                    current_weight=float(runtime.get(
                                        "temporalExactMouthCurrentWeight", 0.80
                                    )),
                                    max_mae=float(runtime.get(
                                        "temporalExactMouthMaxMae", 10.0
                                    )),
                                    max_p90=float(runtime.get(
                                        "temporalExactMouthMaxP90", 24.0
                                    )),
                                    diagnostics=mouth_diagnostics,
                                )
                                if session.diagnostics_enabled:
                                    for key, value in mouth_diagnostics.items():
                                        session.frame_diagnostics.setdefault(
                                            key, []
                                        ).append(value)
                            previous_source_frame = np.ascontiguousarray(frame)
                            previous_swapped_frame = (
                                None if isinstance(output_frame, AsyncReadbackLease)
                                else np.ascontiguousarray(output_frame)
                            )
                            previous_swap_kps = np.asarray(
                                current_kps,
                                dtype=np.float32,
                            ).copy()
                            exact_canonical_transform = temporal_context.get(
                                "fullCanonicalTransform"
                            )
                            if exact_canonical_transform is None:
                                previous_canonical_transform = None
                            else:
                                canonical_matrix = np.asarray(
                                    exact_canonical_transform,
                                    dtype=np.float64,
                                )
                                previous_canonical_transform = (
                                    canonical_matrix.copy()
                                    if canonical_matrix.shape == (3, 3)
                                    and np.isfinite(canonical_matrix).all()
                                    else None
                                )
                            if bool(
                                sparse_mesh_enabled_for_session
                                or semantic_feature_enabled_for_session
                            ):
                                semantic_landmarks = None
                                refresh_due = bool(
                                    semantic_landmark_estimator is not None
                                    and session.frames - last_semantic_refresh_frame
                                    >= semantic_refresh_frames
                                )
                                if refresh_due:
                                    try:
                                        semantic_result = self._run_gpu_work(
                                            semantic_landmark_estimator.detect,
                                            frame,
                                            current_kps,
                                            priority=(10 if session.prefetch else 0),
                                            queue_cancel_event=session.stop,
                                            cancelled_value=None,
                                            work_label="semantic-landmarks",
                                        )
                                        if semantic_result is not None:
                                            session.semantic_landmark_seconds += max(
                                                0.0,
                                                float(semantic_result.inference_ms)
                                                / 1000.0,
                                            )
                                            session.semantic_landmark_last_score = float(
                                                semantic_result.score
                                            )
                                            session.semantic_landmark_provider = str(
                                                semantic_result.provider
                                            )
                                            tracking_state[
                                                "semanticLandmarkProvider"
                                            ] = str(semantic_result.provider)
                                            tracking_state[
                                                "semanticLandmarkInferenceMs"
                                            ] = float(semantic_result.inference_ms)
                                            tracking_state[
                                                "semanticLandmarkScore"
                                            ] = float(semantic_result.score)
                                            if float(semantic_result.score) >= float(
                                                runtime.get(
                                                    "temporalSemanticMinimumScore",
                                                    0.75,
                                                )
                                            ):
                                                semantic_landmarks = (
                                                    semantic_result.points
                                                )
                                                last_semantic_refresh_frame = int(
                                                    session.frames
                                                )
                                                tracking_state[
                                                    "semanticLandmarkRefreshes"
                                                ] = int(
                                                    tracking_state.get(
                                                        "semanticLandmarkRefreshes",
                                                        0,
                                                    )
                                                ) + 1
                                                session.semantic_landmark_refreshes += 1
                                            else:
                                                session.semantic_landmark_failures += 1
                                                record_temporal_rejection(
                                                    "semantic-landmark-score",
                                                    {
                                                        "score": float(
                                                            semantic_result.score
                                                        )
                                                    },
                                                )
                                    except Exception as exc:
                                        # Semantic refresh is a sparse
                                        # stabilizer, never a reason to stop
                                        # playback. Keep the last valid mesh
                                        # and retry at the next exact anchor.
                                        tracking_state[
                                            "semanticLandmarkError"
                                        ] = f"{type(exc).__name__}: {exc}"
                                        session.semantic_landmark_failures += 1
                                        record_temporal_rejection(
                                            "semantic-landmark-error"
                                        )
                                tracking_state["sparseResidualMesh"] = (
                                    _rebase_sparse_residual_mesh(
                                        frame,
                                        current_kps,
                                        tracking_state.get(
                                            "sparseResidualMesh"
                                        ),
                                        semantic_landmarks=semantic_landmarks,
                                        maximum_features=(
                                            0
                                            if semantic_feature_enabled_for_session
                                            else 40
                                        ),
                                        semantic_indices_to_keep=(
                                            np.arange(36, 48, dtype=np.int16)
                                            if semantic_feature_enabled_for_session
                                            and set(
                                                str(value)
                                                for value in runtime.get(
                                                    "temporalSemanticFeatureGroups",
                                                    ("leftEye", "rightEye"),
                                                )
                                            )
                                            == {"leftEye", "rightEye"}
                                            else None
                                        ),
                                    )
                                )
                            last_exact_frame = int(
                                temporal_context.get(
                                    "frameDependencyAnchorFrame",
                                    session.frames,
                                )
                            )
                            try:
                                last_exact_timeline_seconds = float(
                                    temporal_context.get(
                                        "frameDependencyAnchorTimeSeconds",
                                        timeline_seconds,
                                    )
                                )
                            except (TypeError, ValueError, OverflowError):
                                last_exact_timeline_seconds = None
                            previous_render_signature = (
                                int(tracking_state.get("trackGeneration", 0)),
                                int(session.config_revision),
                                str(session.face_id),
                                str(parameters.get("SwapperTypeTextSel", "128")),
                                str(parameters.get("RestorerTypeTextSel", "")),
                            )
                        session.exact_work_seconds += (
                            time.perf_counter() - exact_work_started
                        )
                    elif not compatibility_passthrough:
                        frame_was_transformed = True
                        session.temporal_reuse_frames += 1
                        session.reuse_work_seconds += (
                            time.perf_counter() - frame_work_started
                        )
                    pending_outputs.append({
                        "result": output_frame,
                        "future": output_future,
                        "transformed": frame_was_transformed,
                        "compatibilityPassthrough": compatibility_passthrough,
                        "inputFrame": (
                            np.ascontiguousarray(frame)
                            if acquisition_hold_frames and not identity_locked
                            else None
                        ),
                        "frameIndex": int(session.frames),
                        "timelineSeconds": float(timeline_seconds),
                        "frameWorkSeconds": (
                            time.perf_counter() - frame_work_started
                        ),
                        "frameWorkStartedAt": frame_work_started,
                        "frameWorkIntervals": [(
                            frame_work_started,
                            frame_work_started + (time.perf_counter() - frame_work_started),
                        )],
                    })
                    isolated_unqueued_lease = None
                    session.frames += 1
                    # Keep encoded output strictly ordered. A reuse frame's
                    # CPU materialization may overlap the next exact GPU
                    # render; the next non-overlapped frame drains both in
                    # original timeline order.
                    if identity_just_locked:
                        backfill_automatic_acquisition_frames()
                        flush_pending_outputs()
                    elif not identity_locked and acquisition_hold_frames:
                        while len(pending_outputs) > acquisition_hold_frames:
                            emit_pending_output(pending_outputs.pop(0))
                    elif not residual_overlap_enabled or output_future is None:
                        flush_pending_outputs()
                flush_pending_outputs()
                while isolated_output_futures:
                    isolated_output_futures.pop(0).result()
            except Exception as exc:
                if not session.stop.is_set():
                    try:
                        feeder_error.put_nowait(exc)
                    except queue.Full:
                        pass
            finally:
                tracking_lookahead.close()
                isolated_output_failed.set()
                if isolated_unqueued_lease is not None:
                    pending_outputs.append({"result": isolated_unqueued_lease})
                    isolated_unqueued_lease = None
                _drain_abandoned_outputs(
                    self, pending_outputs, isolated_output_futures,
                    session, feeder_error,
                )
                isolated_output_executor.shutdown(wait=True, cancel_futures=False)
                if output_executor is not None:
                    output_executor.shutdown(
                        wait=True,
                        cancel_futures=True,
                    )
                self._release_prefetch_admission(session)
                decode_stop.set()
                # Decoder owns the container and observes decode_stop at
                # its next native boundary. Keep BufferedWriter.close
                # outside the lock because its final flush can briefly wait
                # for FFmpeg to consume data.
                if decoder is not threading.current_thread() and decoder.is_alive():
                    decoder.join(timeout=0.75)
                try:
                    process.stdin.close()
                except Exception:
                    pass

        feeder = threading.Thread(target=feed, name=f"PongSwapFeed-{session.channel}", daemon=True)
        with session.lifecycle_lock:
            session.feeder = feeder
            if not session.stop.is_set():
                feeder.start()
        if feeder.ident is None:
            session.state = "stopped"
            return
        if session.spool_path is None:
            raise RuntimeError("swap spool path was not initialized")
        with session.spool_path.open("wb", buffering=0) as spool:
            transport_writer = _FragmentedMp4TransportWriter(
                spool,
                minimum_fragment_bytes=int(
                    runtime.get("transportMinimumFragmentBytes", 0) or 0
                ),
                padding_interval_fragments=int(
                    runtime.get("transportPaddingIntervalFragments", 1) or 1
                ),
                duration_seconds=max(0.0, session.source_duration - session.start_seconds),
            )
            standby_source_requested = False
            while True:
                # BufferedReader.read(n) waits for the full n bytes on a
                # pipe. A sub-second preview is often smaller than 256 KiB,
                # which left playable MP4 bytes trapped inside this reader
                # forever. os.read returns as soon as any encoder output is
                # available, allowing the phone to open the first fragment.
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    break
                complete_fragment = transport_writer.write(chunk)
                with session.condition:
                    session.bytes_written = transport_writer.bytes_written
                    session.transport_padding_bytes = transport_writer.padding_bytes
                    session.complete_fragments = transport_writer.probe.complete_fragment_count
                    if not session.first_byte_at:
                        session.first_byte_at = time.time()
                    if complete_fragment and not session.media_fragment_ready:
                        session.media_fragment_ready = True
                        session.playable_at = time.time()
                    if not session.stop.is_set():
                        session.state = "streaming"
                    session.condition.notify_all()
                if (session.media_fragment_ready and not standby_source_requested
                        and not session.prefetch and session.source_duration > 0
                        and not session.stop.is_set()):
                    standby_source_requested = True
                    self._standby_sources.warm(session.source_url)
            complete_fragment = transport_writer.finish()
            if complete_fragment:
                with session.condition:
                    session.bytes_written = transport_writer.bytes_written
                    session.transport_padding_bytes = transport_writer.padding_bytes
                    session.complete_fragments = transport_writer.probe.complete_fragment_count
                    if not session.media_fragment_ready:
                        session.media_fragment_ready = True
                        session.playable_at = time.time()
                    session.condition.notify_all()
        if feeder is not None:
            feeder.join(timeout=5.0)
        if not feeder_error.empty() and not session.stop.is_set():
            feeder_exception = feeder_error.get_nowait()
            if isinstance(feeder_exception, BaseException):
                raise feeder_exception
            raise RuntimeError(str(feeder_exception))
        return_code = process.wait(timeout=5.0)
        if stderr_thread is not None:
            stderr_thread.join(timeout=1.0)
        stderr_text = bytes(stderr_tail).decode(
            "utf-8",
            errors="replace",
        ).strip()
        if return_code and not session.stop.is_set():
            raise RuntimeError(stderr_text or f"ffmpeg exited with status {return_code}")
        session.state = "stopped" if session.stop.is_set() else "finished"
    except Exception as exc:
        if session.stop.is_set():
            session.state = "stopped"
        else:
            session.error = f"{type(exc).__name__}: {exc}"
            if self._gpu_oom_error(exc):
                session.error_code = "GPU_OOM"
                self._record_gpu_oom(session, exc)
            elif isinstance(exc, ValueError) and "No usable face was detected" in str(exc):
                session.error_code = "FACE_SOURCE_INVALID"
            else:
                session.error_code = "SWAP_FAILED"
            session.state = "error"
            session.stop.set()
    finally:
        decode_stop.set()
        source_open_cancel.set()
        self._release_prefetch_admission(session)
        self._interrupt_session_resources(session)
        if source_opener is not None and source_opener.is_alive():
            source_opener.join(timeout=0.25)
        if stderr_thread is not None and stderr_thread.is_alive():
            stderr_thread.join(timeout=0.5)
        if (
            decoder is not None
            and decoder is not threading.current_thread()
            and decoder.is_alive()
        ):
            decoder.join(timeout=2.0)
        # A winner may be registered before the producer consumes its
        # queue result, leaving local `container` None during cancellation.
        # Publication is closed above, so reclaim the registered resource;
        # never close a container owned by a started native decoder.
        if decoder is None or decoder.ident is None:
            with session.lifecycle_lock:
                unclaimed_container = session.container
                session.container = None
            if unclaimed_container is not None:
                try:
                    unclaimed_container.close()
                except Exception:
                    pass
        if (
            feeder is not None
            and feeder is not threading.current_thread()
            and feeder.is_alive()
        ):
            feeder.join(timeout=2.0)
        with session.lifecycle_lock:
            if (
                session.source_opener is source_opener
                and not self._thread_is_alive(source_opener)
            ):
                session.source_opener = None
            if session.feeder is feeder and not self._thread_is_alive(feeder):
                session.feeder = None
            if session.decoder is decoder and not self._thread_is_alive(decoder):
                session.decoder = None
            if session.process is process and not self._process_is_alive(process):
                session.process = None
        with session.condition:
            session.complete = True
            if (
                not self._thread_is_alive(source_opener)
                and not self._thread_is_alive(decoder)
                and not self._thread_is_alive(feeder)
                and not self._process_is_alive(process)
                and session.container is None
            ):
                session.resources_released_at = time.time()
            session.condition.notify_all()
        with self._sessions_lock:
            if self._active_by_channel.get(session.channel) == session.id:
                self._active_by_channel.pop(session.channel, None)
        # Once the last producer releases the graph, retire any swapper or
        # restorer that is no longer the selected production choice. This
        # is deliberately after native teardown so an in-flight ORT call
        # can never lose its session underneath it.
        if self._models is not None:
            try:
                reconcile = self._reconcile_idle_model_residency
                if hasattr(self, "_gpu_worker_queue"):
                    self._run_gpu_work(
                        reconcile,
                        session.id,
                        priority=20,
                        work_label="idle-model-reconcile",
                    )
                else:
                    reconcile(session.id)
            except Exception:
                pass
        self._schedule_spool_cleanup(
            session,
            # Keep unexpected failures queryable for a few seconds. The UI
            # can report the real cause and avoid turning one bad stream
            # into a rapid create/404/retry loop. Explicitly cancelled
            # swipe-away work is still removed immediately.
            delay=0.0 if session.delete_requested else (5.0 if session.state == "error" else 120.0),
        )


# Source: rope.VideoManager.<module>._match_lab_color
# SHA256: 3b1420fa6085c32372f31d2d459df979e6e4d2769a98fa4f27bc2ce60601afce
def _match_lab_color(swap, target, valid_mask=None):
    """The original Reinhard transform, also used as the graph parity oracle."""
    swap_lab = _rgb_chw_to_lab(swap)
    target_lab = _rgb_chw_to_lab(target)
    if valid_mask is None:
        s_mean = swap_lab.mean(dim=(1, 2), keepdim=True)
        s_std = swap_lab.std(dim=(1, 2), keepdim=True) + 1e-6
        t_mean = target_lab.mean(dim=(1, 2), keepdim=True)
        t_std = target_lab.std(dim=(1, 2), keepdim=True)
    else:
        s_mean, s_std = _masked_channel_stats(swap_lab, valid_mask)
        t_mean, t_std = _masked_channel_stats(target_lab, valid_mask)
        s_std = s_std + 1e-6
    return _isolated_lab_transfer(swap_lab, s_mean, s_std, t_mean, t_std)


# Source: rope.VideoManager.VideoManager._temporal_mask_result_core
# SHA256: 57aafcc51922b5f156473126c7e393989b9cd12e0ebc1122fe7cbe32819b6751
def _temporal_mask_result_core(
    self,
    temporal_context,
    key,
    input_tensor,
    signature,
    compute,
    *,
    allow_reuse=True,
    force_on_restorer_exact=True,
    minimum_reuse_frames=0,
):
    """Reuse a canonical-space mask only while its source stays stable.

    Occluder and face-parser masks are generated after alignment, so their
    coordinates are stable across tracked frames.  Store a small current
    input probe and the exact mask in the session-owned temporal context;
    any meaningful visual change or anchor boundary executes the original
    model path.  The shared VideoManager never owns cross-session state.
    """
    if not temporal_context or not temporal_context.get('enabled'):
        return compute()
    frame_index = int(temporal_context.get('frameIndex', 0))
    max_anchor_frames = max(1, int(temporal_context.get('maxAnchorFrames', 1)))
    probe = self._isolated_mask_overlap_probe(
        temporal_context, key, input_tensor,
    )
    state_key = f'{key}Anchor'
    state = temporal_context.get(state_key)
    reason_bits = []
    frame_age = (
        None if not state else frame_index - int(state.get('frameIndex', -1))
    )
    if not state:
        reason_bits.append('first-anchor')
    if not allow_reuse:
        reason_bits.append('current-frame-policy')
    if temporal_context.get('forceExact', False):
        force_reasons = temporal_context.get('forceExactReasons') or ('force-exact',)
        reason_bits.extend(str(reason) for reason in force_reasons)
    if (
        force_on_restorer_exact
        and temporal_context.get('restorerExactThisFrame', False)
    ):
        reason_bits.append('restorer-exact')
    if state and state.get('signature') != signature:
        reason_bits.append('signature')
    if frame_age is not None and frame_age <= 0:
        reason_bits.append('nonpositive-age')
    if frame_age is not None and frame_age >= max_anchor_frames:
        reason_bits.append('frame-age')
    mask_hz = float(temporal_context.get('maskAnchorHz', 0.0) or 0.0)
    if state and mask_hz > 0 and _temporal_elapsed_seconds(temporal_context, state) >= (1.0 / mask_hz) - 1e-6:
        reason_bits.append('mask-time-deadline')
    can_reuse = not reason_bits
    metrics_evaluated = False
    metric_values = {}
    local_guard = bool(temporal_context.get('maskLocalChangeGuardEnabled', False)) and key in {'occluder', 'dflXSeg'}
    within_minimum_reuse = bool(
        can_reuse
        and frame_age is not None
        and frame_age <= max(0, int(minimum_reuse_frames))
    )
    if can_reuse and not within_minimum_reuse:
        prior_probe = state.get('probe')
        prior_mask = state.get('mask')
        if (
            not isinstance(prior_probe, torch.Tensor)
            or not isinstance(prior_mask, torch.Tensor)
            or prior_probe.shape != probe.shape
        ):
            can_reuse = False
            reason_bits.append('invalid-state')
        else:
            metrics_evaluated = True
            guard_values = self._isolated_mask_overlap_guard_values(
                temporal_context, key, input_tensor, state, prior_probe,
                probe, local_guard,
            )
            if not bool(guard_values[0]):
                can_reuse = False
                disagreement = math.inf
                patch_disagreement = math.inf
                reason_bits.append('nonfinite-input')
            else:
                disagreement = float(guard_values[1])
                patch_disagreement = float(guard_values[2])
                if local_guard:
                    # Overlapping small patches catch thin foreground
                    # boundaries anywhere in the face, including changes
                    # split across the old non-overlapping 8x8 grid.
                    local_disagreement = float(guard_values[3])
                    metric_values['localPatchMae'] = local_disagreement
                    if local_disagreement > float(temporal_context.get('maxMaskLocalPatchMae', 30.0)):
                        can_reuse = False
                        reason_bits.append('local-patch-disagreement')
            temporal_context[f'{key}InputMae'] = disagreement
            temporal_context[f'{key}PatchMae'] = patch_disagreement
            metric_values.update({
                'inputMae': disagreement,
                'patchMae': patch_disagreement,
            })
            if math.isfinite(disagreement) and disagreement > float(
                temporal_context.get('maxMaskInputMae', 16.0)
            ):
                reason_bits.append('mean-disagreement')
            if math.isfinite(patch_disagreement) and patch_disagreement > float(
                temporal_context.get('maxMaskPatchMae', 30.0)
            ):
                reason_bits.append('patch-disagreement')
            if (
                not math.isfinite(disagreement)
                or not math.isfinite(patch_disagreement)
                or disagreement > float(temporal_context.get('maxMaskInputMae', 16.0))
                or patch_disagreement > float(temporal_context.get('maxMaskPatchMae', 30.0))
            ):
                can_reuse = False
    if can_reuse:
        self._mark_temporal_dependency(temporal_context, state)
        temporal_context[f'{key}ReusedFrames'] = int(
            temporal_context.get(f'{key}ReusedFrames', 0)
        ) + 1
        self._record_temporal_stage_decision(
            temporal_context,
            key,
            'reused',
            'accepted',
            metrics_evaluated=metrics_evaluated,
            metrics=metric_values,
            anchor_state=state,
        )
        return state['mask']
    result = compute()
    if (
        key == 'faceParser'
        and state
        and state.get('signature') == signature
        and bool(temporal_context.get('maskExactParserBlendEnabled', False))
        and not _history_reset_requested(temporal_context)
        and _temporal_elapsed_seconds(temporal_context, state) > 0.0
    ):
        prior_mask = state.get('mask')
        if (
            isinstance(prior_mask, torch.Tensor)
            and prior_mask.shape == result.shape
            and prior_mask.device == result.device
        ):
            current_weight = float(np.clip(
                temporal_context.get('maskExactParserBlendCurrentWeight', 0.80),
                0.0,
                1.0,
            ))
            nominal_frame_seconds = float(
                _temporal_elapsed_seconds(temporal_context, state)
            )
            half_life_seconds = float(
                temporal_context.get('maskExactParserBlendHalfLifeSeconds', 0.0) or 0.0
            )
            if nominal_frame_seconds > 0.0 and half_life_seconds > 0.0:
                history_weight = 0.5 ** (nominal_frame_seconds / half_life_seconds)
                current_weight = float(np.clip(1.0 - history_weight, 0.0, 1.0))
            # Reject history locally on moving/occluded regions, including
            # boundary changes anywhere in the face, not selected features.
            change = torch.mean(torch.abs(probe - state['probe']), dim=0, keepdim=True)
            change = v2.functional.resize(change, list(result.shape[-2:]), antialias=False)
            confidence = (1.0 - change / 12.0).clamp(0.0, 1.0)
            result = result + (prior_mask - result) * ((1.0 - current_weight) * confidence)
            temporal_context['maskExactParserEffectiveCurrentWeight'] = current_weight
            temporal_context['faceParserExactBlendedFrames'] = int(
                temporal_context.get('faceParserExactBlendedFrames', 0)
            ) + 1
    temporal_context[state_key] = {
        'signature': signature,
        'frameIndex': frame_index,
        'mediaTimeSeconds': temporal_context.get('mediaTimeSeconds'),
        'anchorFrameIndex': int(
            temporal_context.get('frameDependencyAnchorFrame', frame_index)
        ),
        'anchorMediaTimeSeconds': temporal_context.get(
            'frameDependencyAnchorTimeSeconds',
            temporal_context.get('mediaTimeSeconds'),
        ),
        'probe': probe.detach().clone(),
        'mask': result.detach().clone(),
    }
    temporal_context[f'{key}ExactFrames'] = int(
        temporal_context.get(f'{key}ExactFrames', 0)
    ) + 1
    self._record_temporal_stage_decision(
        temporal_context,
        key,
        'exact',
        reason_bits[0] if reason_bits else 'unspecified',
        known_reasons=reason_bits,
        metrics_evaluated=metrics_evaluated,
        metrics=metric_values,
        anchor_state=state,
    )
    return result


# Source: rope.VideoManager.VideoManager._warp_grid_sample_core
# SHA256: 52ae17728d3e810a0356973878c0e985817f2d1ae086d10e3d6ac94e03a2b4e2
def _warp_grid_sample_core(
    self,
    src,
    sample_matrix,
    output_size,
    padding_mode='zeros',
    *,
    return_valid_mask=False,
):
    """Affine-warp `src` into `output_size` by building a sampling
    grid from a pixel-space 2x3 matrix.

    sample_matrix maps OUTPUT pixel coords (x, y) → INPUT pixel
    coords (x_in, y_in) — i.e. it's the matrix the GPU consults
    when filling each output pixel ('inverse warp'). For us that
    comes straight from `skimage.SimilarityTransform.inverse.params`
    (input affine case) or `tform.params` (paste-back case).

    Why this beats v2.functional.affine + crop: torchvision's
    affine output has the same H×W as input — for a 1080p frame
    warped to a 256×256 face crop, the affine still computes ~6M
    pixels and we discard all but the corner. grid_sample with a
    target-sized grid only computes the pixels we keep (~65K),
    which is the chunk we were leaving on the table per the
    2026-05-21 nsys trace's swap_core breakdown.

    align_corners=False matches torchvision's affine semantics
    so output is bit-similar (modulo bilinear-vs-bilinear rounding
    in the last decimal place) to the path it replaces."""
    src_h = src.shape[-2]
    src_w = src.shape[-1]
    out_h, out_w = int(output_size[0]), int(output_size[1])

    # Output coordinate grid in pixel space.
    y_coords = torch.arange(out_h, dtype=torch.float32, device='cuda')
    x_coords = torch.arange(out_w, dtype=torch.float32, device='cuda')
    yy, xx = torch.meshgrid(y_coords, x_coords, indexing='ij')

    # Apply pixel-space matrix: in_xy = M[:, :2] @ (x, y) + M[:, 2]
    if isinstance(sample_matrix, torch.Tensor):
        M = sample_matrix.to('cuda').to(torch.float32)
    else:
        M = torch.from_numpy(
            np.ascontiguousarray(sample_matrix, dtype=np.float32)
        ).to('cuda')
    flat = torch.stack([xx, yy], dim=-1).reshape(-1, 2)
    in_xy = flat @ M[:, :2].T + M[:, 2]
    in_xy = in_xy.reshape(out_h, out_w, 2)

    valid_mask = None
    if return_valid_mask:
        # A sample is fully image-backed only when its bilinear sampling
        # center is inside the original image.  Keep this in pixel space
        # before in_xy is normalized in-place below.  The result is a
        # cheap geometry mask (no second image warp) used by color stats
        # and final blending for clipped/offscreen faces.
        valid_mask = (
            (in_xy[..., 0] >= 0.0)
            & (in_xy[..., 0] <= float(src_w - 1))
            & (in_xy[..., 1] >= 0.0)
            & (in_xy[..., 1] <= float(src_h - 1))
        ).to(torch.float32).unsqueeze(0)

    # Normalize to [-1, 1] using align_corners=False semantics
    # (pixel center 0 → -1 + 1/W, pixel center W-1 → 1 - 1/W).
    in_xy[..., 0] = ((in_xy[..., 0] + 0.5) / src_w) * 2.0 - 1.0
    in_xy[..., 1] = ((in_xy[..., 1] + 0.5) / src_h) * 2.0 - 1.0

    grid = in_xy.unsqueeze(0)  # (1, out_h, out_w, 2)

    # grid_sample needs float input; src may be uint8.
    src_4d = src.unsqueeze(0) if src.ndim == 3 else src
    if (src_4d.dtype == torch.uint8 and src_4d.is_cuda
            and src_4d.device.index == 0 and src_4d.shape[0] == 1
            and padding_mode == 'zeros' and grid.is_cuda
            and grid.device == src_4d.device and grid.dtype == torch.float32
            and grid.ndim == 4 and grid.shape[0] == 1
            and grid.shape[-1] == 2 and grid.is_contiguous()):
        sampled = self._isolated_u8_grid_sample(src_4d, grid)
    else:
        if src_4d.dtype != torch.float32:
            src_4d = src_4d.float()

        sampled = torch.nn.functional.grid_sample(
            src_4d, grid,
            mode='bilinear',
            padding_mode=padding_mode,
            align_corners=False,
        )
    sampled = sampled.squeeze(0)  # (C, out_h, out_w)
    if return_valid_mask:
        return sampled, valid_mask
    return sampled
