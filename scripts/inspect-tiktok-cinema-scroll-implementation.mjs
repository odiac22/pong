import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok');
const scripts=[];const stop=tik.onEvent(m=>{if(m.method==='Debugger.scriptParsed'&&m.params.url.includes('/modules-cinema-mode.'))scripts.push(m.params)});
try{
 await tik.call('Debugger.enable');
 const script=scripts.at(-1);if(!script)throw Error('Loaded cinema script not found');
 const {scriptSource}=await tik.call('Debugger.getScriptSource',{scriptId:script.scriptId});
 const line=scriptSource.split('\n')[1];
 const uses=[...line.matchAll(/nD\(|nA\(|rS\(/g)].map(m=>line.slice(Math.max(0,m.index-180),m.index+350));
 console.log(JSON.stringify({aroundSetter:line.slice(45400,47000),aroundAnimation:line.slice(64400,65700),uses}));
}finally{await tik.call('Debugger.disable').catch(()=>{});stop();tik.close()}
