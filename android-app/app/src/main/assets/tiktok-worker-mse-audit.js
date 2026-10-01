// Main-thread half of the emulator-only exact-path dedicated Worker MSE trial.
// The Worker is never sent a session URL until its bundled ready/echo handshake
// and the native interceptor's numeric hit counter both advance.
(() => {
  'use strict';
  const WORKER_URL='https://www.tiktok.com/webapp-desktop/static/worker/pong-swap-media-audit.js';
  const status=()=>{try{return JSON.parse(window.PongTikTokSwap?.workerAuditStatus?.()||'{}')}catch{return {}}};
  window.__pongCreateWorkerMseAudit=(s,{owned,fail,sync})=>{
    const before=status();
    if(before.version!==1){fail('Worker audit interceptor unavailable');return;}
    let worker=null,closed=false,started=false,challenge=null,nativeNonce=null,nativeListener=null,nativeTimer=0;
    const close=()=>{if(closed)return;closed=true;clearTimeout(handshakeTimer);
      clearTimeout(nativeTimer);
      if(nativeListener)window.removeEventListener('message',nativeListener);
      if(nativeNonce){try{window.PongTikTokBinaryAudit?.postMessage(JSON.stringify({type:'close',sessionId:s.sessionId,nonce:nativeNonce}))}catch{}}
      try{worker?.postMessage({type:'close'})}catch{}
      worker?.terminate();};
    s.worker={close};s.abort.signal.addEventListener('abort',close,{once:true});
    const handshakeTimer=setTimeout(()=>{if(!closed&&!started){close();fail('Worker audit handshake timed out')}},1500);
    const timestampKeys=new Set(['requestAt','headersAt','firstChunkAt','sourceOpenAt','firstAppendAt']);
    try{
      // Module-worker credentials omit prevents a fall-through script request
      // from carrying TikTok cookies if this WebView lacks native interception.
      worker=new Worker(WORKER_URL,{type:'module',credentials:'omit',name:'pong-swap-media-audit'});
      worker.onmessage=event=>{
        if(closed||!owned(s))return;
        const message=event.data||{};
        if(!started&&challenge===null){
          const after=status();
          if(message.type!=='ready'||message.version!==1||after.version!==1||
              !Number.isInteger(after.hits)||after.hits<=before.hits){
            close();fail('Worker audit native handshake failed');return;
          }
          if(!globalThis.crypto?.getRandomValues){close();fail('Worker audit challenge unavailable');return;}
          const words=new Uint32Array(4);crypto.getRandomValues(words);
          challenge=Array.from(words,x=>x.toString(16).padStart(8,'0')).join('');
          worker.postMessage({type:'challenge',nonce:challenge});return;
        }
        if(!started){
          const after=status();
          if(message.type!=='echo'||message.version!==1||message.nonce!==challenge||
              after.version!==1||!Number.isInteger(after.hits)||after.hits<=before.hits){
            close();fail('Worker audit echo failed');return;
          }
          started=true;clearTimeout(handshakeTimer);
          const binary=window.__pongBinaryMediaAuditTrial===true&&!s.warm&&after.binaryAvailable===true&&
            typeof window.PongTikTokBinaryAudit?.postMessage==='function';
          if(binary){
            nativeNonce=challenge;
            nativeListener=event=>{
              if(closed||!owned(s)||typeof event.data!=='string')return;
              let data;try{data=JSON.parse(event.data)}catch{return;}
              if(data.type!=='pong-native-media-port'||data.sessionId!==s.sessionId||data.nonce!==nativeNonce||event.ports?.length!==1)return;
              window.removeEventListener('message',nativeListener);nativeListener=null;clearTimeout(nativeTimer);
              worker.postMessage({type:'native-port',port:event.ports[0]},[event.ports[0]]);
            };
            window.addEventListener('message',nativeListener);
            nativeTimer=setTimeout(()=>{if(!closed&&nativeListener){close();fail('Native media channel timed out')}},1500);
          }
          worker.postMessage({type:'start',url:s.url,...(binary?{native:true}:{})});
          if(binary)window.PongTikTokBinaryAudit.postMessage(JSON.stringify({type:'open',sessionId:s.sessionId,nonce:nativeNonce}));
          challenge=null;return;
        }
        if(message.type==='handle'){
          try{s.overlay.srcObject=message.handle;s.overlay.load()}
          catch{close();fail('Worker media handle rejected')}
        }
        else if(message.type==='transport'){
          for(const [key,value] of Object.entries(message.stats||{}))
            s.transport[key]=timestampKeys.has(key)?value-performance.timeOrigin:value;
        }else if(message.type==='failure'){close();fail(message.reason||'Worker media failed')}
      };
      worker.onerror=()=>{if(!closed&&owned(s)){close();fail('Worker audit startup failed')}};
      for(const event of ['loadedmetadata','loadeddata','canplay','playing'])s.overlay.addEventListener(event,()=>{
        s.transport[event]??=performance.now();
        if(event==='loadedmetadata'&&!closed)worker.postMessage({type:'metadata'});
        if(!s.warm)sync();
      },{passive:true});
      s.overlay.addEventListener('error',()=>{if(!closed){close();fail('Worker media element error')}},{once:true});
      s.overlay.addEventListener('ended',()=>{
        if(window.__pongDomSwap!==s)return;
        if(s.start<.1){try{s.overlay.currentTime=0;s.overlay.play().catch(()=>{})}catch{}}
        else window.__pongDomSwapClear();
      });
    }catch{close();fail('Worker audit unavailable')}
  };
})();
