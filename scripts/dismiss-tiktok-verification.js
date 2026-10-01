(() => {
 const panel=document.querySelector('[id^="captcha-verify-container"]');
 const close=panel?.querySelector('button[aria-label="Close"]');
 if(!close||!close.getClientRects().length)return {closed:false};
 // User requested closing this optional modal and continuing, not solving it.
 close.click();return {closed:true};
})()
