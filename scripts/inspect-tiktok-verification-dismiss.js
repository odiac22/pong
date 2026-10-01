(() => {
 const panel=document.querySelector('[id^="captcha-verify-container"]');
 if(!panel)return {challenge:false};
 // Only inspect dismiss/navigation controls, never challenge media or answers.
 return {challenge:true,controls:[...panel.querySelectorAll('button,[role=button],[class*=close],[aria-label]')]
  .filter(e=>e.getClientRects().length).slice(0,35).map(e=>({tag:e.tagName,
    label:e.getAttribute('aria-label')||'',title:e.getAttribute('title')||'',
    className:typeof e.className==='string'?e.className:'',text:e.tagName==='BUTTON'?(e.textContent||'').trim().slice(0,80):''}))};
})()
