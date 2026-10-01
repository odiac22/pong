(async()=>{
 const failures=[];
 const violated=e=>failures.push({directive:e.effectiveDirective,blocked:e.blockedURI?.split('?')[0],disposition:e.disposition});
 document.addEventListener('securitypolicyviolation',violated);
 const url=URL.createObjectURL(new Blob(['postMessage("pong-worker-ready")'],{type:'text/javascript'}));
 let worker;
 try{
  return await new Promise(resolve=>{
   let timer=setTimeout(()=>resolve({ok:false,reason:'timeout',failures}),1500);
   try{
    worker=new Worker(url,{name:'pong-readiness-probe'});
    worker.onmessage=e=>{clearTimeout(timer);resolve({ok:e.data==='pong-worker-ready',failures})};
    worker.onerror=e=>{clearTimeout(timer);resolve({ok:false,error:e.message,failures})};
   }catch(e){clearTimeout(timer);resolve({ok:false,name:e.name,message:e.message,failures})}
  });
 }finally{worker?.terminate();URL.revokeObjectURL(url);document.removeEventListener('securitypolicyviolation',violated)}
})()
