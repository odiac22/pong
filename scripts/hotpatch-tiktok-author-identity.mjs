// Update the already-loaded observer function without navigation, duplicate
// listeners or touching the user's login. Fail closed if the old source differs.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {readFileSync} from 'node:fs';
const page=await connectWebView(60196,'tiktok'),scripts=[];
const off=page.onEvent(e=>{if(e.method==='Debugger.scriptParsed')scripts.push(e.params)});
try{
 await page.call('Debugger.enable');
 const candidates=scripts.filter(s=>!s.url&&s.length>20000&&s.length<60000);
 const current=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const start=current.indexOf("      let author=typeof rawAuthor"),end=current.indexOf('      // A recognized photo',start);
 if(start<0||end<0)throw Error('Replacement block missing');
 const replacement=current.slice(start,end).replace(/\r\n/g,'\n');
 const old="      const author=typeof rawAuthor==='string'?rawAuthor:own(rawAuthor,'uniqueId');\n      if(!(typeof id==='string'&&/^\\d{15,22}$/.test(id)&&typeof author==='string'&&/^[A-Za-z0-9._-]{2,64}$/.test(author)))return null;\n";
 const handle=await page.call('Runtime.evaluate',{expression:'window.__pongTikTokScan'});
 const properties=await page.call('Runtime.getProperties',{objectId:handle.result.objectId});
 const owner=properties.internalProperties?.find(p=>p.name==='[[FunctionLocation]]')?.value?.value?.scriptId;
 await page.call('Runtime.releaseObject',{objectId:handle.result.objectId});
 if(!owner)throw Error('Could not establish the active observer owner');
 const matches=[];
 for(const s of candidates.filter(s=>s.scriptId===owner)){const r=await page.call('Debugger.getScriptSource',{scriptId:s.scriptId});const text=r.scriptSource.replace(/\r\n/g,'\n');if(text.includes('window.__pongMobileTikTokInstalled')&&text.includes(old))matches.push({id:s.scriptId,text});}
 if(matches.length!==1)throw Error('Expected one exact observer source, found '+matches.length);
 const m=matches[0],scriptSource=m.text.replace(old,replacement);
 const dry=await page.call('Debugger.setScriptSource',{scriptId:m.id,scriptSource,dryRun:true});
 if(dry.status!=='Ok')throw Error('Live-edit preflight: '+dry.status);
 const applied=await page.call('Debugger.setScriptSource',{scriptId:m.id,scriptSource,dryRun:false});
 console.log(JSON.stringify({status:applied.status,changedBlock:'author-less post identity only'}));
 if(applied.status!=='Ok')throw Error('Live edit was not applied');
 await page.read('window.__pongTikTokScan?.()');
}finally{off();await page.call('Debugger.disable').catch(()=>{});page.close()}
