(() => {
  if(window.__pongAuditStepWrapper!==window.__pongTikTokStep){const original=window.__pongTikTokStep;window.__pongAuditStepWrapper=d=>{const result=original(d);window.__pongAuditLastGesture={direction:d,result,at:performance.now()};return result;};window.__pongTikTokStep=window.__pongAuditStepWrapper;}
  const box=e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,label:e.getAttribute('aria-label'),x:r.x,y:r.y,w:r.width,h:r.height}};
  return {path:location.pathname,last:window.__pongAuditLastGesture,viewport:[innerWidth,innerHeight],hit:document.elementsFromPoint(innerWidth*650/1080,innerHeight*1550/2340).slice(0,5).map(box),video:[...document.querySelectorAll('video')].map(box),next:[...document.querySelectorAll('button[aria-label="Next video"]')].map(e=>({...box(e),disabled:e.disabled,aria:e.getAttribute('aria-disabled')}))};
})()
