(async()=>{const s=window.__pongDomSwap;if(!s)return {missing:true};const started=performance.now(),stop=new AbortController();let bytes=0;
try{const response=await fetch('/__pong_swap/'+s.sessionId,{cache:'no-store',signal:stop.signal});const headersMs=performance.now()-started,reader=response.body.getReader();
while(bytes<1048576&&performance.now()-started<4000){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;}return{headersMs,totalMs:performance.now()-started,bytes,status:response.status};}finally{stop.abort();}})()
