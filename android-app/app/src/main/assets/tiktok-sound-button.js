javascript:(()=>{
  // Owner layout (29.48): one TikTok sound button on the left, above the native
  // Exit button, which sits above Pong's eye (eye centre = 50% - 42px; Exit is
  // 22px tall with a 6px gap). TikTok's own Volume button lives inside each
  // feed card, so it cannot be pinned; this proxy taps the current card's
  // button and falls back to the video element's muted flag.
  if(window.__pongTikTokSoundButton)return;
  const style=document.createElement('style');
  style.id='pong-tiktok-sound-style';
  style.textContent='button[aria-label="Volume"]{visibility:hidden!important}'+
    '#pong-tiktok-sound{position:fixed;left:12px;top:calc(50% - 118px);width:28px;height:28px;z-index:2147483000;'+
    'display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid rgba(255,255,255,.28);'+
    'background:rgba(0,0,0,.45);color:#fff;font-size:14px;line-height:1;padding:0;margin:0;-webkit-tap-highlight-color:transparent}'+
    '#pong-tiktok-sound:active{transform:scale(1.08)}';
  const button=document.createElement('button');
  button.id='pong-tiktok-sound';button.type='button';button.setAttribute('aria-label','TikTok sound');
  const area=v=>{const r=v.getBoundingClientRect();return Math.max(0,Math.min(r.right,innerWidth)-Math.max(r.left,0))*Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0));};
  const current=()=>{let best=null,size=0;for(const v of document.querySelectorAll('video')){
    if(v.classList.contains('pong-tiktok-swap-stream'))continue;const a=area(v);if(a>size){best=v;size=a;}}return best;};
  const paint=()=>{const v=current();button.textContent=!v||v.muted||v.volume===0?'\u{1F507}':'\u{1F50A}';};
  button.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();
    const v=current();if(!v)return;
    const card=v.closest('article,section,[data-e2e="recommend-list-item-container"]');
    const native=card&&card.querySelector('button[aria-label="Volume"]');
    const before=v.muted;
    if(native)native.click();
    // TikTok can ignore a synthetic click on some builds; make the tap count.
    setTimeout(()=>{if(v.muted===before){v.muted=!before;if(!v.muted&&v.volume===0)v.volume=1;}paint();},120);
  },true);
  const mount=()=>{if(!style.isConnected)(document.head||document.documentElement).appendChild(style);
    if(!button.isConnected&&document.body)document.body.appendChild(button);};
  mount();paint();
  document.addEventListener('volumechange',paint,true);
  document.addEventListener('playing',paint,true);
  const timer=setInterval(()=>{mount();paint();},1500);
  window.__pongTikTokSoundButton={dispose(){clearInterval(timer);button.remove();style.remove();
    document.removeEventListener('volumechange',paint,true);document.removeEventListener('playing',paint,true);
    delete window.__pongTikTokSoundButton;}};
})()
