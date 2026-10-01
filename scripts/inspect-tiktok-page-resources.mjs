// Counts only: no page text, cookies, media URLs, or login data.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
for (const kind of ['tiktok','pong']) {
  const client=await connectWebView(60195,kind);
  try {
    await client.call('Performance.enable');
    const page=await client.read(`({
      dom:document.getElementsByTagName('*').length,
      videos:document.querySelectorAll('video').length,
      playing:[...document.querySelectorAll('video')].filter(v=>!v.paused).length,
      activeSwap:!!window.__pongDomSwap,warmSwap:!!window.__pongDomSwapWarm,
      originalObserved:!!window.__pongTikTokObservedVideo,
      auditInstalled:typeof window.__pongAuditSnapshot==='function'
    })`);
    const metrics=await client.call('Performance.getMetrics');
    const keep=new Set(['Timestamp','Documents','Frames','Nodes','JSEventListeners',
      'LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration',
      'ScriptDuration','TaskDuration','JSHeapUsedSize','JSHeapTotalSize']);
    console.log(JSON.stringify({kind,page,metrics:Object.fromEntries(
      metrics.metrics.filter(m=>keep.has(m.name)).map(m=>[m.name,m.value]))}));
  } finally {
    await client.call('Performance.disable').catch(()=>{});
    client.close();
  }
}
