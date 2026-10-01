// Explicit, one-frame diagnostic. Reads only the original video already visible
// in the authorized TikTok WebView. It never fetches a media URL, paints a swap,
// stores pixels, or sends the private service token into the WebView.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {
  decodeCapturedChunk, frameByteLengths, rgbaToRgb,
  validateCreatedSession, validateOwnedResponse,
  ownedRestorationEvidence,
} from './lib/visible-frame-roundtrip.mjs';

const args = process.argv.slice(2);
if ((args.length !== 3 && args.length !== 4) ||
    args[0] !== '--run-visible-frame-roundtrip' || args[1] !== '--face-id' ||
    !args[2] || args[2].length > 256 ||
    (args.length === 4 && args[3] !== '--tiktok-adaptive')) {
  throw Error('Usage: node scripts/diagnose-tiktok-visible-frame-roundtrip.mjs --run-visible-frame-roundtrip --face-id APPROVED_FACE_ID [--tiktok-adaptive]');
}

const FACE_ID = args[2];
const RESTORATION_PROFILE = args[3] === '--tiktok-adaptive' ? 'tiktok-face-size' : 'default';
const SERVICE = 'http://127.0.0.1:8792';
const TOKEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../Pong Swap/cache/remote-bridge-token');
const runId = randomUUID();
const marker = 'window.__pongVisibleFrameRoundtrip';
const idLiteral = JSON.stringify(runId);
const CHUNK_BYTES = 96 * 1024;
const trace = {phase: 'starting', phaseStart: performance.now(), timingsMs: {}, errorPhase: null};
function enterPhase(next) {
  trace.timingsMs[trace.phase] = Math.round((performance.now() - trace.phaseStart) * 1000) / 1000;
  trace.phase = next;
  trace.phaseStart = performance.now();
}
const sameSource = `(()=>{
  const d=${marker},v=d?.video,o=window.__pongTikTokObservedVideo;
  if(!d||d.runId!==${idLiteral}||!v?.isConnected||o?.video!==v||
     o?.pageUrl!==d.pageUrl||v.paused||v.ended||v.readyState<2||
     v.videoWidth!==d.width||v.videoHeight!==d.height||
     window.__pongDomSwap||window.__pongDomSwapWarm||
     document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'))return false;
  const r=v.getBoundingClientRect(),s=getComputedStyle(v);
  return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&
    r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&
    s.visibility==='visible'&&Number(s.opacity)>0;
})()`;

function evaluated(expression) {
  return `(async()=>{${expression}})()`;
}

async function checkedFetch(url, options, timeoutMs) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw Error(`remote session API returned HTTP ${response.status}`);
  return response;
}

async function run() {
  // The private token never leaves this PC process except in its loopback header.
  enterPhase('private-token');
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  if (token.length < 32) throw Error('private remote bridge token is invalid');
  const auth = {Authorization: `Bearer ${token}`};
  enterPhase('cdp-connect');
  const client = await connectWebView(60195, 'tiktok');
  let sessionId = null;
  let cleanupFailed = false;
  let transientRgba = null;
  let transientRgb = null;
  let output;
  let failure;
  try {
    enterPhase('visible-source-preflight');
    const preflight = await client.read(evaluated(`
      if(${marker})return {valid:false,reason:'another-diagnostic-owns-page'};
      const o=window.__pongTikTokObservedVideo,v=o?.video;
      if(!v?.isConnected)return {valid:false,reason:'no-observed-video'};
      const d={runId:${idLiteral},video:v,pageUrl:o.pageUrl,
        width:v.videoWidth,height:v.videoHeight};
      d.expire=()=>{
        if(${marker}!==d)return;
        d.cancelled=true;d.cancelPending?.('diagnostic-expired');
        d.pixels?.fill(0);d.pixels=null;
        if(d.canvas){d.canvas.width=d.canvas.height=0;d.canvas.remove();d.canvas=null;}
        delete ${marker};
      };
      ${marker}=d;
      d.expiryTimer=setTimeout(d.expire,150000);
      if(!(${sameSource})){clearTimeout(d.expiryTimer);d.expire();
        return {valid:false,reason:'need-visible-original-playing-video'};}
      return {valid:true,width:v.videoWidth,height:v.videoHeight};
    `));
    if (!preflight?.valid) throw Error(`WebView preflight: ${preflight?.reason || 'unavailable'}`);
    const {width, height} = preflight;
    frameByteLengths(width, height); // The full-resolution source must fit the raw API.

    enterPhase('remote-session-create');
    const createStarted = performance.now();
    const createResponse = await checkedFetch(`${SERVICE}/remote-sessions`, {
      method: 'POST', headers: {...auth, 'Content-Type': 'application/json'},
      body: JSON.stringify({faceId: FACE_ID, width, height, fps: 30,
        restorationProfile: RESTORATION_PROFILE}),
    }, 120000);
    const created = await createResponse.json();
    if (typeof created?.session?.id === 'string' &&
        /^[A-Za-z0-9_-]{20,80}$/.test(created.session.id)) sessionId = created.session.id;
    validateCreatedSession(created, FACE_ID, width, height, RESTORATION_PROFILE);
    const createMs = performance.now() - createStarted;

    enterPhase('browser-frame-capture');
    const cdpStarted = performance.now();
    const captured = await client.read(evaluated(`
      if(!(${sameSource}))return {valid:false,reason:'source-changed-before-capture'};
      const d=${marker},v=d.video,canvas=document.createElement('canvas');
      d.canvas=canvas;
      canvas.width=d.width;canvas.height=d.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      if(!context){canvas.width=canvas.height=0;
        return {valid:false,reason:'canvas-unavailable'};}
      try {
        const metadata=await new Promise((resolve,reject)=>{
          d.cancelPending=reason=>{
            if(d.callbackHandle)v.cancelVideoFrameCallback?.(d.callbackHandle);
            clearTimeout(d.callbackTimer);
            d.callbackHandle=0;d.callbackTimer=0;d.cancelPending=null;
            reject(Error(reason||'frame-cancelled'));
          };
          d.callbackTimer=setTimeout(()=>d.cancelPending?.('frame-timeout'),1500);
          d.callbackHandle=v.requestVideoFrameCallback((_,m)=>{
            clearTimeout(d.callbackTimer);d.callbackTimer=0;
            d.callbackHandle=0;d.cancelPending=null;resolve(m);
          });
        });
        if(d.cancelled||!(${sameSource}))return {valid:false,reason:'source-changed-at-capture'};
        const began=performance.now();
        context.drawImage(v,0,0,d.width,d.height);
        const drawn=performance.now();
        const rgba=context.getImageData(0,0,d.width,d.height).data;
        const read=performance.now();
        if(d.cancelled||!(${sameSource})){
          rgba.fill(0);return {valid:false,reason:'source-changed-after-read'};
        }
        d.pixels=rgba;
        clearTimeout(d.expiryTimer);
        d.expiryTimer=setTimeout(d.expire,60000);
        return {valid:true,width:d.width,height:d.height,
          mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,
          timestampMs:began,byteLength:rgba.byteLength,
          drawMs:drawn-began,readMs:read-drawn};
      }catch(e){d.cancelPending?.('capture-failed');d.pixels?.fill(0);d.pixels=null;
        return {valid:false,reason:e.name==='SecurityError'?
        'origin-readback-denied':e.message==='frame-timeout'?'frame-timeout':'capture-failed'};}
      finally{canvas.width=canvas.height=0;canvas.remove();d.canvas=null;}
    `));
    const cdpMs = performance.now() - cdpStarted;
    if (!captured?.valid) throw Error(`WebView capture: ${captured?.reason || 'unavailable'}`);
    const {rgba: rgbaBytes} = frameByteLengths(width, height);
    if (captured.width !== width || captured.height !== height ||
        captured.byteLength !== rgbaBytes) {
      throw Error('source dimensions changed during capture');
    }

    enterPhase('cdp-chunk-transfer');
    transientRgba = Buffer.alloc(rgbaBytes);
    const chunksStarted = performance.now();
    let browserChunkEncodeMs = 0;
    for (let offset = 0; offset < rgbaBytes; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, rgbaBytes - offset);
      const chunk = await client.read(`(()=>{
        const d=${marker},offset=${offset},length=${length};
        if(!d||d.runId!==${idLiteral}||d.cancelled||
           d.pixels?.byteLength!==${rgbaBytes})return {valid:false};
        const began=performance.now(),parts=[];
        const bytes=d.pixels.subarray(offset,offset+length);
        for(let i=0;i<bytes.length;i+=16384)
          parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
        return {valid:true,offset,length,pixelsBase64:btoa(parts.join('')),
          encodeMs:performance.now()-began};
      })()`);
      if (!chunk?.valid || chunk.offset !== offset || chunk.length !== length) {
        throw Error('captured chunk ownership changed');
      }
      if (!Number.isFinite(chunk.encodeMs) || chunk.encodeMs < 0) {
        throw Error('invalid browser chunk timing');
      }
      const decoded = decodeCapturedChunk(chunk.pixelsBase64, length);
      decoded.copy(transientRgba, offset);
      decoded.fill(0);
      browserChunkEncodeMs += chunk.encodeMs;
    }
    const chunkTransferMs = performance.now() - chunksStarted;
    enterPhase('browser-pixel-release');
    const released = await client.read(`(()=>{
      const d=${marker};
      if(!d||d.runId!==${idLiteral}||!d.pixels)return false;
      d.pixels.fill(0);d.pixels=null;return true;
    })()`);
    if (released !== true) throw Error('browser pixel release was not confirmed');
    enterPhase('pc-rgba-to-rgb');
    const decodeStarted = performance.now();
    transientRgb = rgbaToRgb(transientRgba, width, height);
    transientRgba.fill(0);transientRgba = null;
    const convertMs = performance.now() - decodeStarted;

    enterPhase('remote-frame-submit-and-render');
    let response;
    const submitStarted = performance.now();
    try {
      response = await checkedFetch(
        `${SERVICE}/remote-sessions/${encodeURIComponent(sessionId)}/frame?seq=1&cut=true&timestampMs=${encodeURIComponent(captured.timestampMs)}`,
        {method: 'PUT', headers: {...auth, 'Content-Type': 'application/octet-stream'}, body: transientRgb},
        180000,
      );
    } finally {
      transientRgb.fill(0);transientRgb = null;
    }
    const submitMs = performance.now() - submitStarted;
    enterPhase('remote-frame-receive-and-validate');
    const receiveStarted = performance.now();
    const rendered = new Uint8Array(await response.arrayBuffer());
    let owned;
    try {
      owned = validateOwnedResponse(response.headers, rendered, 1, width, height);
    } finally {
      rendered.fill(0);
    }
    const receiveMs = performance.now() - receiveStarted;

    enterPhase('remote-restoration-evidence');
    const status = await checkedFetch(`${SERVICE}/remote-sessions/${encodeURIComponent(sessionId)}`,
      {headers: auth}, 5000).then(r => r.json());
    const restorationEvidence = ownedRestorationEvidence(status, sessionId, FACE_ID,
      width, height, RESTORATION_PROFILE);

    enterPhase('source-postflight');
    const postflight = await client.read(evaluated(`
      return {sameSource:Boolean(${sameSource}),
        mediaTime:${marker}?.video?.currentTime??null};
    `));
    if (!postflight?.sameSource) throw Error('source changed before diagnostic response validation');
    output = {
      ok: true, width, height, transformed: owned.transformed,
      restorationProfile: RESTORATION_PROFILE,
      restorationEvidence,
      note: 'One offscreen frame only; not a live overlay, throughput, or latency benchmark.',
      timingsMs: {
        sessionCreate: createMs, browserDraw: captured.drawMs,
        browserReadback: captured.readMs, browserChunkBase64: browserChunkEncodeMs,
        cdpCaptureRoundtrip: cdpMs, cdpChunkTransfer: chunkTransferMs,
        pcRgbConversion: convertMs,
        pcSubmitAndRender: submitMs, engineRender: owned.renderMs,
        pcReceiveAndValidate: receiveMs,
      },
      sourceFrameAdvanceSeconds: Number.isFinite(postflight.mediaTime) &&
        Number.isFinite(captured.mediaTime)
        ? postflight.mediaTime - captured.mediaTime : null,
    };
  } catch (error) {
    failure = error;
    trace.errorPhase = trace.phase;
    trace.errorPhaseElapsedMs = Math.round((performance.now() - trace.phaseStart) * 1000) / 1000;
  } finally {
    transientRgba?.fill(0);
    transientRgb?.fill(0);
    enterPhase('cleanup-page');
    let pageReleased = false;
    for (let attempt = 0; attempt < 3 && !pageReleased; attempt++) {
      try {
        const result = await client.call('Runtime.evaluate', {
          expression: `(()=>{
            const d=${marker};
            if(!d)return true;
            if(d.runId!==${idLiteral})return false;
            d.cancelled=true;
            d.cancelPending?.('diagnostic-cleanup');
            if(d.callbackHandle)d.video?.cancelVideoFrameCallback?.(d.callbackHandle);
            if(d.callbackTimer)clearTimeout(d.callbackTimer);
            if(d.expiryTimer)clearTimeout(d.expiryTimer);
            d.pixels?.fill(0);d.pixels=null;
            if(d.canvas){d.canvas.width=d.canvas.height=0;d.canvas.remove();d.canvas=null;}
            delete ${marker};
            return true;
          })()`,
          returnByValue: true, awaitPromise: false,
        }, 5000);
        pageReleased = result.result?.value === true && !result.exceptionDetails;
      } catch {
        // A timed-out capture may still occupy the renderer; bounded retries.
      }
    }
    if (!pageReleased) cleanupFailed = true;
    enterPhase('cleanup-remote-session');
    if (sessionId) {
      try {
        await checkedFetch(`${SERVICE}/remote-sessions/${encodeURIComponent(sessionId)}`,
          {method: 'DELETE', headers: auth}, 15000);
      } catch {
        cleanupFailed = true;
      }
    }
    client.close();
  }
  enterPhase('complete');
  if (cleanupFailed) throw Error(`diagnostic cleanup could not confirm session/page release${failure ? ` after: ${failure.message}` : ''}`);
  if (failure) throw failure;
  output.phaseTimingsMs = trace.timingsMs;
  return output;
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  const phase = trace.errorPhase || trace.phase;
  const phaseElapsedMs = trace.errorPhaseElapsedMs ??
    Math.round((performance.now() - trace.phaseStart) * 1000) / 1000;
  console.error(JSON.stringify({ok: false, phase, phaseElapsedMs,
    phaseTimingsMs: trace.timingsMs,
    error: String(error.message).replace(/https?:\/\/\S+/g, '[redacted-url]').slice(0, 240)}));
  process.exitCode = 1;
}
