import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
for(const kind of ['pong','tiktok']){
 const page=await connectWebView(60195,kind);
 try{console.log(JSON.stringify({kind,value:await page.read(`(()=>{
  const inspect=(x,y)=>{let e=document.elementFromPoint(x,y);const out=[];for(let i=0;e&&i<9;i++,e=e.parentElement){const c=getComputedStyle(e),r=e.getBoundingClientRect();out.push({tag:e.tagName,id:e.id,cls:String(e.className).slice(0,160),background:c.backgroundColor,image:c.backgroundImage==='none'?'none':'present',opacity:c.opacity,rect:[r.x,r.y,r.width,r.height]});}return out;};
  return {size:[innerWidth,innerHeight],left:inspect(7,innerHeight*.5),center:inspect(innerWidth*.5,innerHeight*.5),overlayStats:window.PongTikTokOverlayStats};})()`)}));}finally{page.close();}
}
