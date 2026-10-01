(async()=>{
 const v=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].find(v=>{const r=v.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0&&v.paused&&v.readyState>=1;});
 if(!v)return {tested:false,reason:'No paused loaded video; avoiding audible playback changes'};
 const initial=v.currentTime,r=v.getBoundingClientRect(),x=Math.max(20,r.left+Math.min(r.width/2,200)),y=Math.max(70,r.top+150);
 const send=(type,tx,ty)=>{const touch=new Touch({identifier:7,target:v,clientX:tx,clientY:ty});v.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));};
 let horizontal,vertical;
 try{
   send('touchstart',x,y);send('touchmove',x+40,y+1);send('touchend',x+40,y+1);
   horizontal=v.currentTime;
   v.currentTime=initial;
   send('touchstart',x,y);send('touchmove',x+1,y+40);send('touchend',x+1,y+40);
   vertical=v.currentTime;
   return {tested:true,initial,horizontal,vertical,horizontalSeek:Math.abs(horizontal-initial)>.1,verticalDidNotSeek:Math.abs(vertical-initial)<.05,paused:v.paused};
 }finally{v.currentTime=initial;}
})()
