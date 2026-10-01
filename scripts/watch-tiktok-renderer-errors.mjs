const start=Date.now(),seen=new Map();
while(Date.now()-start<22000){
 const p=await fetch('http://127.0.0.1:8792/sessions').then(r=>r.json());
 for(const s of p.sessions||[]){const row={id:s.id,state:s.state,frames:s.frames,transformed:s.transformedFrames,error:s.error,profile:s.restorationProfile,adaptive:s.adaptiveRestoration};const key=JSON.stringify(row);if(seen.get(s.id)!==key){seen.set(s.id,key);console.log(key);}}
 await new Promise(r=>setTimeout(r,100));
}
