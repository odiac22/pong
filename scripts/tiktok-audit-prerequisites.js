(async()=>{
 const r=await pongFaceSwapControlFetch('/pong-swap/faces',{cache:'no-store'});
 const data=await r.json();
 const faces=data.faces||[];
 return {http:r.status,faceCount:faces.length,faces:faces.map(f=>({id:f.id,name:f.name})),overlay:document.documentElement.classList.contains('pong-tiktok-original-overlay')};
})()
