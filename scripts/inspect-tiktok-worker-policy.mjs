import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'tiktok');const entries=[];
const unsubscribe=page.onEvent(event=>{
 if(event.method!=='Log.entryAdded')return;
 const entry=event.params.entry;
 if(!/worker|content security policy/i.test(entry.text))return;
 entries.push({source:entry.source,level:entry.level,text:entry.text.replace(/https?:\/\/[^\s'"]+/g,x=>{try{const u=new URL(x);return u.origin+u.pathname}catch{return '[resource]'}}).slice(0,1800)});
});
try{await page.call('Log.enable');await new Promise(r=>setTimeout(r,500));console.log(JSON.stringify(entries));}
finally{await page.call('Log.disable');unsubscribe();page.close()}
