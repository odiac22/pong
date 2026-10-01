import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const client=await connectWebView(60195,'tiktok');
try {
 const source=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const helper=source.slice(source.indexOf('  const reactVideo ='),source.indexOf('  const itemUrl ='));
 const result=await client.read(`(()=>{const canonical=x=>x;${helper};return {mobile:!!window.__pongMobileTikTokInstalled,legacy:!!window.__pongTikTokObserverInstalled,scan:String(window.__pongTikTokScan),cards:[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].map(card=>({id:card.id,url:reactVideo(card),top:Math.round(card.getBoundingClientRect().top)}))};})()`);
 console.log(JSON.stringify(result));
 const ids=[];client.onEvent(e=>{if(e.method==='Debugger.scriptParsed')ids.push(e.params.scriptId)});
 await client.call('Debugger.enable');
 let live=[];
 for(const scriptId of ids){
  const {scriptSource}=await client.call('Debugger.getScriptSource',{scriptId});
  if(scriptSource?.includes('window.__pongMobileTikTokInstalled = true'))live.push({scriptId,propsFirst:scriptSource.includes('for(const primary of [true,false])'),length:scriptSource.length});
 }
 console.log(JSON.stringify({liveObserverScripts:live}));
 await client.call('Debugger.disable');
} finally {client.close();}
