(() => {
  if(document.querySelector('[id^="captcha-verify-container"]'))return {clicked:false,verification:true};
  const choices=[...document.querySelectorAll('a[href]')].filter(e=>{
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    if(e.getAttribute('data-e2e')==='nav-profile'||r.width<=0||r.height<=0||r.top<0||r.bottom>innerHeight||s.display==='none'||s.visibility==='hidden')return false;
    try{const u=new URL(e.href);return u.hostname==='www.tiktok.com'&&/^\/@[^/]+\/?$/.test(u.pathname);}catch{return false;}
  });
  if(choices.length!==1)return {clicked:false,visibleCreatorLinks:choices.length};
  choices[0].click();return {clicked:true};
})()
