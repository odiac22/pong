import {readFileSync} from 'node:fs';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {normalizeTikTokMediaHint} from '../tiktok-media-hints.mjs';
const c=await connectWebView(60195,'tiktok');
try {
 const source=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const canonical=source.slice(source.indexOf('  const canonical ='),source.indexOf('  const area ='));
 const helpers=source.slice(source.indexOf('  const reactVideo ='),source.indexOf('  const scan ='));
 const rows=await c.read(`(()=>{${canonical}${helpers}return [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].filter(c=>c.querySelector('video')).slice(0,2).map(mediaHint).filter(Boolean)})()`);
 for(const row of rows){
  const hint=normalizeTikTokMediaHint(row.pageUrl,row);if(!hint)continue;
  for(const url of hint.urls){
   const start=performance.now();
   if(process.argv.includes('--browser-transport')) {
    // URL stays on stdin; never echo signed media URLs in command/error logs.
    const result=spawnSync('.pong-local-ai/lora-venv/Scripts/python.exe',['-c',`
import json,sys,time
from curl_cffi import requests
x=json.load(sys.stdin)
try:
 r=requests.get(x['url'],impersonate='chrome',headers={'Range':'bytes=0-1023','Referer':'https://www.tiktok.com/','Accept-Encoding':'identity'},timeout=4,stream=True,allow_redirects=False)
 print(json.dumps({'http':r.status_code,'type':r.headers.get('content-type'),'length':r.headers.get('content-length'),'range':r.headers.get('content-range')}))
 r.close()
except Exception as e: print(json.dumps({'error':type(e).__name__}))
`],{input:JSON.stringify({url}),encoding:'utf8',timeout:6000,windowsHide:true});
    let status;try{status=JSON.parse(result.stdout)}catch{status={error:'browser-transport-unavailable'}}
    console.log(JSON.stringify({videoId:hint.videoId,...status,ms:performance.now()-start}));continue;
   }
   const status=await new Promise(resolve=>{
    const request=https.request(url,{headers:{range:'bytes=0-1023',referer:'https://www.tiktok.com/','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36','accept-encoding':'identity'}},r=>{
     resolve({http:r.statusCode,length:r.headers['content-length'],type:r.headers['content-type'],range:r.headers['content-range'],encoding:r.headers['content-encoding']});r.destroy();
    });request.setTimeout(3000,()=>request.destroy(new Error('timeout')));request.once('error',e=>resolve({error:e.code||'request-failed'}));request.end();
   });
   console.log(JSON.stringify({videoId:hint.videoId,expectedSize:hint.size,width:hint.width,height:hint.height,...status,ms:performance.now()-start}));
  }
 }
} finally {c.close();}
