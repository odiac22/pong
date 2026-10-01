// Diagnostic only. Survive the overlay re-publishing its state function, then
// restore the latest real function (not the stale copy present at test start).
(() => {
  const key='PongTikTokLiveIntegratedState';
  if(window.__pongAuditTunnelRestore)throw Error('Existing tunnel trial');
  if(location.origin!=='http://192.168.1.124:8787')throw Error('Unexpected trusted overlay');
  const descriptor=Object.getOwnPropertyDescriptor(window,key);
  if(!descriptor?.configurable||descriptor.get||descriptor.set||typeof descriptor.value!=='function')
    throw Error('State function is not a replaceable data property');
  let latest=descriptor.value;
  const stats={calls:0,rewrites:0,replacements:0};
  const wrapped=function(...args){
    stats.calls++;
    const value=Reflect.apply(latest,this,args);let state;
    try{state=JSON.parse(value)}catch{return value}
    if(state?.streamUrl&&state.sessionId){
      const url=new URL(state.streamUrl,location.href);
      if(url.origin===location.origin&&url.pathname==='/pong-swap/sessions/'+state.sessionId+'/stream'){
        url.hostname='127.0.0.1';url.port='18787';state.streamUrl=url.href;stats.rewrites++;
      }
    }
    return JSON.stringify(state);
  };
  const get=()=>wrapped,set=value=>{if(typeof value!=='function')throw Error('Unexpected state publisher');latest=value;stats.replacements++;};
  Object.defineProperty(window,key,{configurable:true,enumerable:descriptor.enumerable,get,set});
  window.__pongAuditTunnelStats=stats;
  window.__pongAuditTunnelRestore=()=>{
    const current=Object.getOwnPropertyDescriptor(window,key);
    const owned=current?.get===get&&current?.set===set;
    if(owned)Object.defineProperty(window,key,{...descriptor,value:latest});
    delete window.__pongAuditTunnelRestore;delete window.__pongAuditTunnelStats;
    return owned;
  };
  return true;
})()
