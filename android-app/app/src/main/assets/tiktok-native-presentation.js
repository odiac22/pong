// Emulator-only native-decoder trial. TikTok still owns navigation, audio and
// the playhead. No video URLs, cookies or playback data are rewritten.
(() => {
  if(window.__pongNativePresentationInstalled)return;
  window.__pongNativePresentationInstalled=true;
  const saved=new Map();let original=null,owner='',firstPresentAt=0;
  const restore=()=>{
    for(const [node,properties] of saved)for(const [name,value,priority] of properties)
      value?node.style.setProperty(name,value,priority):node.style.removeProperty(name);
    saved.clear();original=null;owner='';firstPresentAt=0;
  };
  const change=(node,names)=>{
    if(!saved.has(node))saved.set(node,names.map(name=>[name,node.style.getPropertyValue(name),node.style.getPropertyPriority(name)]));
  };
  window.__pongNativeSnapshot=page=>{
    const observed=window.__pongTikTokObservedVideo,v=observed?.video;
    if(!v?.isConnected||observed.pageUrl!==page)return null;
    const r=v.getBoundingClientRect();
    if(r.width<3||r.height<3||r.bottom<=0||r.top>=innerHeight)return null;
    return {time:v.currentTime,paused:v.paused,rate:v.playbackRate,
      bounds:{x:r.left/innerWidth,y:r.top/innerHeight,w:r.width/innerWidth,h:r.height/innerHeight},
      objectFit:getComputedStyle(v).objectFit};
  };
  window.__pongNativePresent=(session,page,state)=>{
    const observed=window.__pongTikTokObservedVideo,v=observed?.video;
    if(!v?.isConnected||observed.pageUrl!==page)return false;
    if(original!==v||owner!==session){
      restore();original=v;owner=session;
      firstPresentAt=performance.now();
      // Clear only the active video's ancestor backgrounds, preserving exact
      // values and !important flags. Controls remain in TikTok's foreground.
      for(let node=v.parentElement;node;node=node.parentElement){
        change(node,['background','background-color','background-image']);
        node.style.setProperty('background','transparent','important');
      }
      change(v,['opacity']);v.style.setProperty('opacity','0','important');
    }
    window.__pongNativeState={...state,sessionId:session,pageUrl:page,visible:true,firstPresentAt,receivedAt:performance.now()};
    return true;
  };
  window.__pongNativeClearPresentation=()=>{restore();window.__pongNativeState=null;};
  const depart=window.__pongDomSwapDepart;
  window.__pongDomSwapDepart=()=>{const session=owner;restore();window.__pongNativeState=null;window.PongTikTokSwap?.nativeDepart?.(session);return depart?.();};
  // Retire a native layer as soon as the real site identifies another post.
  const observe=window.__pongDomSwapObserveVideo;
  window.__pongDomSwapObserveVideo=(page,v)=>{
    if(original&&(original!==v||window.__pongNativeState?.pageUrl!==page)){
      const session=owner;restore();window.__pongNativeState=null;window.PongTikTokSwap?.nativeDepart?.(session);
    }
    return observe?.(page,v);
  };
})()
