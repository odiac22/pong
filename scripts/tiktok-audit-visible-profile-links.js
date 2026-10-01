(() => {
  const visible = e => {
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';
  };
  return {
    challenge:!!document.querySelector('[id^="captcha-verify-container"]'),
    links:[...document.querySelectorAll('a[href]')].filter(visible).map(e=>{
      let path;try{const u=new URL(e.href);if(u.hostname!=='www.tiktok.com')return null;path=u.pathname;}catch{return null;}
      if(!/^\/@[^/]+\/?$/.test(path))return null;
      const r=e.getBoundingClientRect();
      return {e2e:e.getAttribute('data-e2e'),path,x:r.x,y:r.y,width:r.width,height:r.height};
    }).filter(Boolean).slice(0,15)
  };
})()
