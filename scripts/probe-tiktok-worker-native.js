(async()=>{
 const status=()=>{try{return JSON.parse(window.PongTikTokSwap?.workerAuditStatus?.()||'{}')}catch{return {}}};
 const before=status(),violations=[];
 const violation=e=>violations.push({directive:e.effectiveDirective,blocked:String(e.blockedURI||'').split('?')[0]});
 document.addEventListener('securitypolicyviolation',violation);
 let worker;
 try{return await new Promise(resolve=>{
  let phase='ready';const nonce=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
  const timer=setTimeout(()=>resolve({ok:false,before,after:status(),reason:'timeout',violations}),2500);
  const finish=data=>{clearTimeout(timer);resolve({before,after:status(),violations,...data})};
  try{
   worker=new Worker('https://www.tiktok.com/webapp-desktop/static/worker/pong-swap-media-audit.js',{type:'module',credentials:'omit',name:'pong-audit-handshake-only'});
   worker.onmessage=({data})=>{
    if(phase==='ready'&&data?.type==='ready'&&data.version===1&&status().hits>before.hits){phase='echo';worker.postMessage({type:'challenge',nonce});return}
    finish({ok:phase==='echo'&&data?.type==='echo'&&data.version===1&&data.nonce===nonce,phase});
   };
   worker.onerror=e=>finish({ok:false,reason:'worker-error',message:e.message||''});
  }catch(e){finish({ok:false,reason:e.name,message:e.message})}
 })}finally{worker?.terminate();document.removeEventListener('securitypolicyviolation',violation)}
})()
