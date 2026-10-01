// Emulator-only, manually invoked binary audit of one already-visible frame.
// Optional native PC render; page sees no endpoint/capability and never paints.
(() => {
  'use strict';
  if (window.__pongVisibleFrameAuditRun) return;
  const HEADER = 64, MAX_PIXELS = 16 * 1024 * 1024;
  let active = false, seriesActive = false;
  let currentSeries = null;
  const hash = bytes => {
    let value = 2166136261;
    for (let index = 0; index < bytes.length; index++)
      value = Math.imul(value ^ bytes[index], 16777619);
    return value >>> 0;
  };
  const newNonce = () => {
    const words = new Uint32Array(4);
    crypto.getRandomValues(words);
    return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
  };
  const runFrame = (mode, series = null, sequence = 1) => {
    if (active) return Promise.resolve({ok:false,reason:'busy'});
    if (mode !== 'echo' && mode !== 'pc-render')
      return Promise.resolve({ok:false,reason:'invalid-mode'});
    const observed = series || window.__pongTikTokObservedVideo;
    const video = observed?.video, page = observed?.page || observed?.pageUrl;
    const same = () => video?.isConnected &&
      document.visibilityState !== 'hidden' &&
      window.__pongTikTokObservedVideo?.video === video &&
      window.__pongTikTokObservedVideo?.pageUrl === page &&
      (!series || (video.videoWidth === series.width &&
        video.videoHeight === series.height)) &&
      !video.paused && !video.ended && video.readyState >= 2 &&
      !document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]');
    const style = video ? getComputedStyle(video) : null;
    const rect = video?.getBoundingClientRect?.();
    if (!page || !same() || !video.videoWidth || !video.videoHeight ||
        video.videoWidth > 4096 || video.videoHeight > 4096 ||
        video.videoWidth < 16 || video.videoHeight < 16 ||
        video.videoWidth * video.videoHeight * 4 > MAX_PIXELS ||
        !rect || rect.width <= 0 || rect.height <= 0 || rect.right <= 0 ||
        rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight ||
        !style || style.display === 'none' || style.visibility !== 'visible' ||
        Number(style.opacity) <= 0 ||
        typeof window.PongVisibleFrameAudit?.postMessage !== 'function' ||
        typeof video.requestVideoFrameCallback !== 'function' ||
        !globalThis.crypto?.getRandomValues) {
      return Promise.resolve({ok:false,reason:'need-visible-original-video-and-native-audit'});
    }
    active = true;
    const nonce = series?.nonce || newNonce();
    const started = performance.now();
    return new Promise(resolve => {
      let done = false, port = null, frameCallback = 0, canvas = null, payload = null;
      const finish = result => {
        if (done) return;
        done = true;active = false;
        if (series && series.cancelFrame === cancelFrame) series.cancelFrame = null;
        clearTimeout(deadline);
        window.removeEventListener('message', openPort);
        document.removeEventListener('visibilitychange', onVisibility);
        if (frameCallback) video.cancelVideoFrameCallback?.(frameCallback);
        try { port?.postMessage('close'); } catch (_) {}
        try { port?.close(); } catch (_) {}
        if (payload?.byteLength) new Uint8Array(payload).fill(0);
        if (canvas) { canvas.width = canvas.height = 0;canvas.remove(); }
        const safe = {...result,totalMs:performance.now()-started};
        window.__pongVisibleFrameAuditLast = safe;
        resolve(safe);
      };
      const cancelFrame = reason => finish({ok:false,reason});
      if (series) series.cancelFrame = cancelFrame;
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') finish({ok:false,reason:'page-hidden'});
      };
      const deadline = setTimeout(() => finish({ok:false,reason:'timeout'}),
        mode === 'pc-render' ? 15000 : 10000);
      const openPort = event => {
        if (done || typeof event.data !== 'string' || event.ports?.length !== 1) return;
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type !== 'pong-visible-frame-audit-port' ||
            message.nonce !== nonce || message.mode !== mode ||
            !Number.isInteger(message.sceneEpoch) ||
            message.sceneEpoch < 0) return;
        window.removeEventListener('message',openPort);
        port = event.ports[0];
        port.onmessage = reply => {
          if (!done && mode === 'pc-render' && typeof reply.data === 'string' && sent) {
            let control = null;
            try { control = JSON.parse(reply.data); } catch (_) {}
            if (control?.type === 'pong-visible-frame-audit-error' &&
                control.reason === 'pc-request-failed') {
              finish({ok:false,reason:same()?'pc-request-failed':'source-changed'});
              return;
            }
          }
          if (done || !(reply.data instanceof ArrayBuffer) || !sent) {
            finish({ok:false,reason:'invalid-binary-echo'});return;
          }
          const receivedAt = performance.now();
          const echoed = new Uint8Array(reply.data);
          const hashStarted = performance.now();
          let valid = echoed.byteLength === sent.bytes;
          let transformed = false;
          if (valid) {
            for (let index = 0; index < HEADER; index++) {
              if (index !== 6 && index !== 7 && echoed[index] !== sent.header[index]) {
                valid = false;break;
              }
            }
          }
          if (valid && mode === 'echo')
            valid = echoed[6] === 0 && echoed[7] === 0 && hash(echoed) === sent.checksum;
          if (valid && mode === 'pc-render') {
            transformed = echoed[6] === 1;
            valid = (echoed[6] === 0 || transformed) && echoed[7] === 1 &&
              (!transformed || hash(echoed.subarray(HEADER)) !== sent.pixelHash);
          }
          const echoHashMs = performance.now()-hashStarted;
          echoed.fill(0);
          finish(valid && same()
            ? {ok:true,mode,transformed,sequence:sent.sequence,
               width:sent.width,height:sent.height,bytes:sent.bytes,
               mediaTime:sent.mediaTime,presentedFrames:sent.presentedFrames,
               drawMs:sent.drawMs,readMs:sent.readMs,packMs:sent.packMs,
               sendHashMs:sent.sendHashMs,echoHashMs,
               nativeBinaryRoundtripMs:receivedAt-sent.sentAt}
            : {ok:false,reason:valid?'source-changed':'response-mismatch'});
        };
        port.start?.();
        frameCallback = video.requestVideoFrameCallback((_, metadata) => {
          frameCallback = 0;
          if (done || !same()) { finish({ok:false,reason:'source-changed'});return; }
          const width = video.videoWidth, height = video.videoHeight;
          if (width * height * 4 > MAX_PIXELS) {
            finish({ok:false,reason:'source-size-changed'});return;
          }
          if (series && (metadata.mediaTime <= series.lastMediaTime ||
              Number(metadata.presentedFrames) <= series.lastPresentedFrames)) {
            finish({ok:false,reason:'stale-source-frame'});return;
          }
          canvas = document.createElement('canvas');
          canvas.width = width;canvas.height = height;
          const context = canvas.getContext('2d',{willReadFrequently:true});
          if (!context) { finish({ok:false,reason:'canvas-unavailable'});return; }
          let rgba = null;
          try {
            const captureAt = performance.now();
            context.drawImage(video,0,0,width,height);
            const drawnAt = performance.now();
            rgba = context.getImageData(0,0,width,height).data;
            const readAt = performance.now();
            if (!same()) { rgba.fill(0);finish({ok:false,reason:'source-changed'});return; }
            if (!Number.isFinite(metadata.mediaTime) || metadata.mediaTime < 0) {
              finish({ok:false,reason:'invalid-media-time'});return;
            }
            const box = video.getBoundingClientRect();
            payload = new ArrayBuffer(HEADER+rgba.byteLength);
            const bytes = new Uint8Array(payload), header = new DataView(payload);
            header.setUint32(0,0x50564641,false);header.setUint8(4,1);
            header.setUint8(5,1); // RGBA, exact intrinsic source dimensions.
            for (let index=0;index<16;index++)
              bytes[8+index]=parseInt(nonce.slice(index*2,index*2+2),16);
            header.setUint32(24,sequence,false);
            header.setInt32(28,message.sceneEpoch,false);
            header.setFloat64(32,Number(metadata.mediaTime),false);
            header.setUint32(40,Number(metadata.presentedFrames)>>>0,false);
            header.setUint16(44,width,false);header.setUint16(46,height,false);
            header.setFloat32(48,box.left,false);header.setFloat32(52,box.top,false);
            header.setFloat32(56,box.width,false);header.setFloat32(60,box.height,false);
            bytes.set(rgba,HEADER);rgba.fill(0);
            const packedAt = performance.now();
            const hashAt = performance.now(), checksum = hash(bytes);
            const sendHashMs = performance.now()-hashAt;
            sent = {sequence,width,height,bytes:bytes.byteLength,checksum,
              pixelHash:hash(bytes.subarray(HEADER)),header:bytes.slice(0,HEADER),
              mediaTime:Number(metadata.mediaTime),
              presentedFrames:Number(metadata.presentedFrames),
              drawMs:drawnAt-captureAt,readMs:readAt-drawnAt,
              packMs:packedAt-readAt,sendHashMs,sentAt:performance.now()};
            port.postMessage(payload,[payload]);
            // Keep a reference until finish so even a non-detaching implementation is zeroed.
            canvas.width=canvas.height=0;canvas.remove();canvas=null;
          } catch (error) {
            finish({ok:false,reason:error?.name==='SecurityError'
              ? 'origin-readback-denied':'capture-or-binary-send-failed'});
          } finally {
            rgba?.fill(0);
          }
        });
      };
      let sent = null;
      window.addEventListener('message',openPort);
      document.addEventListener('visibilitychange',onVisibility);
      try { window.PongVisibleFrameAudit.postMessage(JSON.stringify({type:'open',nonce,page,mode})); }
      catch (_) { finish({ok:false,reason:'native-open-failed'}); }
    });
  };
  window.__pongVisibleFrameAuditRun = (options = {}) =>
    seriesActive ? Promise.resolve({ok:false,reason:'busy'}) :
      runFrame(options?.mode || 'echo');
  window.__pongVisibleFrameAuditSeriesCancel = () => {
    if (!seriesActive || !currentSeries) return false;
    currentSeries.cancelled = 'series-cancelled';
    currentSeries.cancelFrame?.('series-cancelled');
    return true;
  };
  window.__pongVisibleFrameAuditSeries = async (count, options = {}) => {
    if (active || seriesActive) return {ok:false,reason:'busy',records:[],totalMs:0,rafIntervalsMs:[]};
    if (!Number.isInteger(count) || count < 1 || count > 120)
      return {ok:false,reason:'invalid-count',records:[],totalMs:0,rafIntervalsMs:[]};
    const mode = options?.mode || 'pc-render';
    if (mode !== 'echo' && mode !== 'pc-render')
      return {ok:false,reason:'invalid-mode',records:[],totalMs:0,rafIntervalsMs:[]};
    const observed = window.__pongTikTokObservedVideo;
    if (!observed?.video || !observed.pageUrl || !globalThis.crypto?.getRandomValues)
      return {ok:false,reason:'need-visible-original-video-and-native-audit',
        records:[],totalMs:0,rafIntervalsMs:[]};
    const video = observed.video;
    const context = {video,page:observed.pageUrl,width:video.videoWidth,
      height:video.videoHeight,nonce:newNonce(),lastMediaTime:-1,
      lastPresentedFrames:-1,cancelFrame:null,cancelled:null};
    const readQuality = () => {
      const quality = video.getVideoPlaybackQuality?.();
      return quality && Number.isFinite(quality.totalVideoFrames) &&
        Number.isFinite(quality.droppedVideoFrames)
        ? {decoded:quality.totalVideoFrames,dropped:quality.droppedVideoFrames} : null;
    };
    const beforeQuality = readQuality();
    const records = [], rafIntervalsMs = [];
    let rafCount = 0, rafLongFrames = 0, priorRaf = null, rafId = 0;
    let failure = null;
    seriesActive = true;currentSeries = context;
    const started = performance.now();
    const onRaf = stamp => {
      if (!seriesActive) return;
      if (priorRaf !== null) {
        const interval = stamp - priorRaf;
        if (Number.isFinite(interval) && interval >= 0) {
          rafCount++;
          if (interval > 32) rafLongFrames++;
          if (rafIntervalsMs.length < 2048) rafIntervalsMs.push(interval);
        }
      }
      priorRaf = stamp;
      rafId = requestAnimationFrame(onRaf);
    };
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(onRaf);
    const deadline = setTimeout(() => {
      context.cancelled = 'series-timeout';
      context.cancelFrame?.('series-timeout');
    },30000);
    try {
      for (let sequence = 1; sequence <= count; sequence++) {
        if (context.cancelled) { failure = context.cancelled;break; }
        const result = await runFrame(mode, context, sequence);
        if (!result.ok) { failure = context.cancelled || result.reason;break; }
        context.lastMediaTime = result.mediaTime;
        context.lastPresentedFrames = result.presentedFrames;
        records.push({sequence:result.sequence,transformed:result.transformed,
          width:result.width,height:result.height,bytes:result.bytes,
          mediaTime:result.mediaTime,presentedFrames:result.presentedFrames,
          drawMs:result.drawMs,readMs:result.readMs,packMs:result.packMs,
          sendHashMs:result.sendHashMs,echoHashMs:result.echoHashMs,
          nativeBinaryRoundtripMs:result.nativeBinaryRoundtripMs,totalMs:result.totalMs});
      }
    } finally {
      clearTimeout(deadline);
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      seriesActive = false;currentSeries = null;
    }
    const afterQuality = readQuality();
    const result = {ok:records.length === count && !failure,
      records,totalMs:performance.now()-started,rafIntervalsMs,rafCount,rafLongFrames};
    if (failure) result.reason = failure;
    if (records.length > 1) {
      result.sourceAdvancedSeconds = records.at(-1).mediaTime - records[0].mediaTime;
      result.sourceFramesPresentedDelta =
        records.at(-1).presentedFrames - records[0].presentedFrames;
    }
    if (beforeQuality && afterQuality) {
      result.decodedFrames = Math.max(0, afterQuality.decoded-beforeQuality.decoded);
      result.droppedFrames = Math.max(0, afterQuality.dropped-beforeQuality.dropped);
    }
    return result;
  };
})();
