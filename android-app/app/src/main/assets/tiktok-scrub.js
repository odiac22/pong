(() => {
  window.PongTikTokScrub?.dispose();
  let gesture=null, frame=0, pending=null, suppressUntil=0;
  const clamp=(v,t)=>{
    if(!Number.isFinite(v.duration)||v.duration<=0)return null;
    let result=Math.max(0,Math.min(v.duration-.05,t));
    if(v.seekable?.length){let best=null,dist=Infinity;for(let i=0;i<v.seekable.length;i++){const x=Math.max(v.seekable.start(i),Math.min(v.seekable.end(i)-.01,result));if(Math.abs(x-result)<dist){best=x;dist=Math.abs(x-result);}}result=best;}
    return Math.max(0,result);
  };
  const activeVideo=()=>[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].map(v=>{const r=v.getBoundingClientRect();return {v,r,area:Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.left))*Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.top))};}).sort((a,b)=>b.area-a.area)[0];
  const start=e=>{
    gesture=null;
    if(e.touches.length!==1||e.target.closest('button,a,input,textarea,select,[role="button"],[role="slider"],[contenteditable="true"]'))return;
    const t=e.touches[0],item=activeVideo();
    if(!item||item.area<innerWidth*innerHeight*.2||!Number.isFinite(item.v.duration)||item.v.duration<=0)return;
    if(t.clientY<Math.max(60,item.r.top)||t.clientY>Math.min(innerHeight*.8,item.r.bottom)||t.clientX<item.r.left||t.clientX>item.r.right)return;
    gesture={v:item.v,source:item.v.currentSrc,x:t.clientX,y:t.clientY,time:item.v.currentTime,width:Math.max(1,item.r.width),claimed:false};
  };
  const flush=()=>{frame=0;if(pending){const {v,t}=pending;pending=null;try{v.currentTime=t;window.__pongTikTokScan?.();}catch{}}};
  const move=e=>{
    if(!gesture)return;
    if(e.touches.length!==1||!gesture.v.isConnected||gesture.v.currentSrc!==gesture.source){gesture=null;pending=null;return;}
    const t=e.touches[0],dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;
    if(!gesture.claimed){if(Math.abs(dy)>10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}if(Math.abs(dx)<12||Math.abs(dx)<Math.abs(dy)*1.5)return;gesture.claimed=true;}
    e.preventDefault();e.stopImmediatePropagation();
    const value=clamp(gesture.v,gesture.time+dx/gesture.width*Math.min(60,gesture.v.duration));
    if(value!==null){pending={v:gesture.v,t:value};if(!frame)frame=requestAnimationFrame(flush);}
  };
  const end=e=>{if(gesture?.claimed){e.preventDefault();e.stopImmediatePropagation();if(frame)cancelAnimationFrame(frame);flush();suppressUntil=performance.now()+400;}gesture=null;};
  const cancel=()=>{gesture=null;pending=null;if(frame)cancelAnimationFrame(frame);frame=0;};
  const click=e=>{if(performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}};
  addEventListener('touchstart',start,{capture:true,passive:true});
  addEventListener('touchmove',move,{capture:true,passive:false});
  addEventListener('touchend',end,{capture:true,passive:false});
  addEventListener('touchcancel',cancel,true);addEventListener('click',click,true);
  window.PongTikTokScrub={clamp,dispose(){cancel();removeEventListener('touchstart',start,true);removeEventListener('touchmove',move,true);removeEventListener('touchend',end,true);removeEventListener('touchcancel',cancel,true);removeEventListener('click',click,true);delete window.PongTikTokScrub;}};
  return {installed:true,gesture:'horizontal upper-video drag',verticalSwipesUnchanged:true};
})()
