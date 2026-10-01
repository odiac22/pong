/* Presentation only. Playback, source selection and swap ownership stay in Pong. */
(() => {
  'use strict';
  const clock = seconds => {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return '0:00';
    const s = Math.floor(n), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}` : `${m}:${String(s%60).padStart(2,'0')}`;
  };
  const states = new WeakMap();
  // Keep at most three full-resolution snapshots. No encoding/readback and no
  // second media reader: even a cross-origin (tainted) canvas can be displayed.
  const snapshots = new Map();
  const body = document.body;
  const container = document.getElementById('video-container');
  if (!container) return;
  body.classList.add('pong-compact');
  document.getElementById('video-urls')?.setAttribute('aria-label','Video links, one per line');
  document.getElementById('erome-url')?.setAttribute('aria-label','Album links');
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!body.classList.contains('controls-hidden')) { hideControls(); document.querySelector('.show-controls-button')?.focus(); }
  });
  const labels = {
    'random-sort-button':'Shuffle', 'duration-sort-button':'Duration', 'refresh-button':'Clean refresh',
    'autoplay-button':'Autoplay', 'update-app-button':'Reload app', 'auto-scroll-button':'Auto advance',
    'erome-checkpoint-button':'Saved position', 'clear-played-history-button':'Played history',
    'unwatched-videos-button':'Unwatched', 'next-batch-button':'Next batch',
    'played-skip-control-button':'Skip played', 'remove-saved-button':'Remove saved'
  };
  function accessible(el, label) {
    if (el.tagName !== 'BUTTON') {
      el.setAttribute('role','button'); el.tabIndex = 0;
      if (!el.dataset.pmKeyboard) {
        el.dataset.pmKeyboard = 'true';
        el.addEventListener('keydown', e => {
          if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('aria-disabled') !== 'true') { e.preventDefault(); el.click(); }
        });
      }
    }
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label',label);
  }
  // Existing controls retain their original parent, icon, handlers and coordinates.
  function arrange() {
    const lib = document.querySelector('.show-controls-button');
    if (lib) accessible(lib,'Open or close controls');
    for (const [cls,label] of Object.entries(labels)) {
      const el = document.querySelector('.'+cls);
      if (el) accessible(el,label);
    }
    for (const [selector,label] of [
      ['#github-token-button','Sync'],['.auto-skip-video-button','Auto skip'],
      ['#repair-saved-links-button','Repair'],['#paste-prev-button','Previous collection'],
      ['#paste-nav-button','Next collection'],['#simpcity-tiktok-button','TikTok'],
      ['#pong-server-toggle','Local server']
    ]) {
      const el = document.querySelector(selector);
      if (el) accessible(el,label);
    }
  }
  let arrangementPending = false;
  const queueArrange = () => {
    if (arrangementPending) return;
    arrangementPending = true;
    requestAnimationFrame(() => { arrangementPending = false; arrange(); });
  };
  // Observe structural changes only, not per-frame progress or the whole subtree.
  new MutationObserver(queueArrange).observe(body,{childList:true});
  function libraryState() {
    const closed = body.classList.contains('controls-hidden');
    const overlay = document.querySelector('.controls-overlay');
    if (overlay) overlay.inert = closed;
    document.querySelector('.show-controls-button')?.setAttribute('aria-expanded',String(!closed));
  }
  new MutationObserver(libraryState).observe(body,{attributes:true,attributeFilter:['class']});
  function updateTime(wrapper, video, pending) {
    const state = states.get(wrapper);
    if (!state) return;
    const progress = pongFaceSwapProgressState(wrapper,video);
    const current = Number.isFinite(pending) ? pending : progress.currentTime;
    const text = clock(current);
    if (state.elapsed.textContent !== text) state.elapsed.textContent = text;
    const total = progress.duration > 0 ? clock(progress.duration) : '—:—';
    if (state.duration && state.duration.textContent !== total) state.duration.textContent = total;
    state.bar.setAttribute('aria-valuemax',String(progress.duration || 0));
    state.bar.setAttribute('aria-valuenow',String(Math.floor(current || 0)));
    state.bar.setAttribute('aria-valuetext',`${text} of ${total}`);
  }
  const mediaKey = wrapper => wrapper.dataset.canonicalMediaUrl || wrapper.dataset.originalVideoUrl || '';
  const desiredFace = () => typeof pongFaceSwapState === 'object' && pongFaceSwapState.enabled
    ? String(pongFaceSwapState.selectedFaceId || '') : '';
  function frameOwner(wrapper, video) {
    const match = String(video.currentSrc || '').match(/\/pong-swap\/sessions\/([^/?]+)\/stream(?:[/?]|$)/);
    if (!match) return {swapped:false,face:''};
    const session = decodeURIComponent(match[1]);
    if (session === wrapper.dataset.pongFaceSwapSessionId) {
      return {swapped:true,face:String(wrapper.dataset.pongFaceSwapFaceId || ''),session};
    }
    if (session === wrapper.dataset.pongFaceSwapPreloadSessionId && typeof pongFaceSwapState === 'object') {
      const entry = [...pongFaceSwapState.prefetches.values()].find(item=>item.sessionId===session);
      if (entry) return {swapped:true,face:String(entry.faceId || ''),session};
    }
    return null; // A superseded stream is not the selected identity's preview.
  }
  function clearPreview(wrapper, state) {
    if (state.canvas) { state.canvas.width=0; state.canvas.height=0; state.canvas.remove(); }
    state.canvas=null; state.preview=null; snapshots.delete(wrapper);
  }
  function syncPreview(wrapper) {
    const state=states.get(wrapper);
    if (!state) return;
    const face=desiredFace(), key=mediaKey(wrapper), {video}=state;
    if (state.preview && (state.preview.face!==face || state.preview.key!==key)) clearPreview(wrapper,state);
    const owner=frameOwner(wrapper,video);
    const wrongFrame=!owner || owner.face!==face || owner.swapped!==Boolean(face);
    const hold=state.hold || video.paused || video.seeking || video.readyState<2 || Boolean(video.error) || wrongFrame;
    // Evicting a cached offscreen poster must not cover an already-decoded
    // native paused frame with a loading label.
    state.poster.hidden=!hold || (!state.preview && !wrongFrame && video.readyState>=2 && !video.error);
    state.message.hidden=Boolean(state.preview);
    state.message.textContent=video.error ? 'Preview unavailable — retry video'
      : face ? 'Preparing swapped preview…' : 'Loading video preview…';
    state.poster.dataset.swapped=String(Boolean(state.preview?.swapped));
  }
  function capturePreview(wrapper, frame, transformed, sessionId) {
    const state=states.get(wrapper);
    if (!state || !wrapper.isConnected) return false;
    const face=desiredFace(), video=state.video;
    let owner;
    const sessionImage=frame!==video;
    if (!sessionImage) {
      if (video.readyState<2 || video.seeking || video.error) return false;
      owner=frameOwner(wrapper,video);
    } else {
      // This is an exact frame from the owned session, but it can still be an
      // original passthrough when no compatible face was in the first frame.
      // Preserve its poster immediately without claiming transformed pixels.
      if (!sessionId || sessionId!==wrapper.dataset.pongFaceSwapSessionId) return false;
      owner={swapped:transformed===true,face:String(wrapper.dataset.pongFaceSwapFaceId || ''),session:sessionId};
    }
    if (!owner || owner.face!==face || (!sessionImage && owner.swapped!==Boolean(face))) return false;
    const width=Number(frame.videoWidth || frame.naturalWidth || 0);
    const height=Number(frame.videoHeight || frame.naturalHeight || 0);
    if (!width || !height) return false;
    let canvas=state.canvas;
    if (!canvas) { canvas=document.createElement('canvas'); canvas.setAttribute('aria-hidden','true'); }
    try {
      canvas.width=width; canvas.height=height;
      canvas.getContext('2d',{alpha:false}).drawImage(frame,0,0,width,height);
    } catch (_) {
      clearPreview(wrapper,state); syncPreview(wrapper); return false;
    }
    if (!state.canvas) state.poster.prepend(canvas);
    state.canvas=canvas;
    state.preview={key:mediaKey(wrapper),face,swapped:owner.swapped,
      source:sessionImage?'exact-session-image':'video',sessionId:sessionImage?sessionId:null};
    snapshots.delete(wrapper); snapshots.set(wrapper,state);
    while (snapshots.size>3) {
      const [oldWrapper,oldState]=snapshots.entries().next().value;
      clearPreview(oldWrapper,oldState); syncPreview(oldWrapper);
    }
    syncPreview(wrapper); return true;
  }
  function reconcileSessionPreview(wrapper, sessionId, transformed) {
    const state=states.get(wrapper), preview=state?.preview;
    if (!wrapper?.isConnected || typeof transformed!=='boolean' ||
        preview?.source!=='exact-session-image' || preview.sessionId!==sessionId ||
        wrapper.dataset.pongFaceSwapSessionId!==sessionId ||
        preview.face!==desiredFace() || preview.key!==mediaKey(wrapper)) return false;
    preview.swapped=transformed;
    syncPreview(wrapper);
    return true;
  }
  function framePresented(wrapper, video) {
    const state=states.get(wrapper);
    if (!state) return;
    // Existing playback callback invokes this, but copying is limited to the
    // first frame and recovery from a hold. Never copy each playing frame.
    const stamp=`${video.dataset.pongSourceGeneration || ''}|${desiredFace()}|${mediaKey(wrapper)}`;
    if (!state.hold && state.presentedStamp===stamp) return;
    state.hold=false;
    state.presentedStamp=stamp;
    capturePreview(wrapper,video); syncPreview(wrapper);
  }
  function holdPreview(wrapper) {
    const state=states.get(wrapper);
    if (!state) return;
    capturePreview(wrapper,state.video);
    state.hold=true; syncPreview(wrapper);
  }
  function refreshPreviews() {
    for (const wrapper of container.querySelectorAll('.video-wrapper')) syncPreview(wrapper);
  }
  function mount(wrapper) {
    if (states.has(wrapper)) return;
    const video = wrapper.querySelector('video'), transport = wrapper.querySelector('.video-progress-container');
    if (!video || !transport) return;
    const elapsed = document.createElement('span'); elapsed.className = 'pm-elapsed'; elapsed.textContent = '0:00';
    const abort = new AbortController(), options = {signal:abort.signal};
    const state = {video,elapsed,abort,duration:transport.querySelector('.video-duration'),bar:transport.querySelector('.video-progress-bar')};
    const clockGroup=document.createElement('div'); clockGroup.className='pm-clock';
    clockGroup.appendChild(elapsed); if(state.duration)clockGroup.appendChild(state.duration); transport.appendChild(clockGroup);
    states.set(wrapper,state);
    const poster=document.createElement('div'); poster.className='pm-video-poster';
    const message=document.createElement('span'); poster.appendChild(message);
    poster.setAttribute('role','img'); poster.setAttribute('aria-label','Video preview');
    Object.assign(state,{poster,message,hold:true,canvas:null,preview:null});
    wrapper.appendChild(poster);
    const capture=()=>{ capturePreview(wrapper,video); syncPreview(wrapper); };
    for (const event of ['loadeddata','seeked','pause','ended']) video.addEventListener(event,capture,options);
    for (const event of ['waiting','seeking']) video.addEventListener(event,()=>holdPreview(wrapper),options);
    for (const event of ['emptied','error']) video.addEventListener(event,()=>{state.hold=true;syncPreview(wrapper);},options);
    video.addEventListener('playing',()=>{framePresented(wrapper,video);syncPreview(wrapper);},options);
    state.ownerObserver=new MutationObserver(()=>syncPreview(wrapper));
    state.ownerObserver.observe(wrapper,{attributes:true,attributeFilter:[
      'data-canonical-media-url','data-original-video-url','data-pong-face-swap-face-id',
      'data-pong-face-swap-session-id','data-pong-face-swap-preload-session-id'
    ]});
    capture();
    for (const event of ['timeupdate','loadedmetadata','durationchange','seeked']) video.addEventListener(event,()=>updateTime(wrapper,video),options);
    const bar = state.bar;
    bar.setAttribute('role','slider'); bar.setAttribute('aria-label','Video position'); bar.setAttribute('aria-valuemin','0'); bar.tabIndex=0;
    bar.addEventListener('keydown',e=>{
      const p=pongFaceSwapProgressState(wrapper,video);
      if (!p.duration || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const target=Math.max(0,Math.min(p.duration,e.key==='Home'?0:e.key==='End'?p.duration:p.currentTime+(e.key==='ArrowLeft'?-5:5)));
      updateTime(wrapper,video,target); void seekPongVideoTo(wrapper,video,target);
    },options);
    const audio = wrapper.querySelector('.audio-toggle-button');
    if (audio) accessible(audio,'Toggle video audio');
    updateTime(wrapper,video);
  }
  function unmount(wrapper) {
    const state = states.get(wrapper);
    if (!state || wrapper.isConnected) return;
    state.abort.abort();
    state.ownerObserver.disconnect(); clearPreview(wrapper,state); state.poster.remove();
    state.elapsed.closest('.pm-clock')?.replaceWith(...[state.duration].filter(Boolean));
    states.delete(wrapper);
  }
  new MutationObserver(records=>{
    for (const record of records) {
      for (const el of record.removedNodes) if (el.nodeType===1 && el.matches('.video-wrapper')) unmount(el);
      for (const el of record.addedNodes) if (el.nodeType===1 && el.matches('.video-wrapper')) mount(el);
    }
    queueArrange();
  }).observe(container,{childList:true});
  window.PongModernUI = {clock,updateTime,capturePreview,reconcileSessionPreview,framePresented,holdPreview,refreshPreviews};
  for (const wrapper of container.querySelectorAll('.video-wrapper')) mount(wrapper);
  arrange(); libraryState();
})();
