import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const base='http://127.0.0.1:8792';
const json=path=>fetch(base+path).then(r=>r.json());
const hash=()=>createHash('sha256').update(readFileSync('Pong Swap/presets/current.json')).digest('hex');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/profile-warm-${Date.now()}.json`;
const report={functionalOnly:true,playbackLatencyQualified:false,passed:false,requests:[]};
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const pageState='({origin:performance.timeOrigin,path:location.pathname,challenge:!!document.querySelector("[id^=captcha-verify-container],[class*=captcha-drag-icon]")})';
try{
  const settings=await json('/settings'),before=await json('/health');
  assert.equal(before.activeSessions,0,'Must not run profile warm over an active video');
  report.presetBefore=hash();report.before={ready:before.ready,models:Object.keys(before.restorers||{})};
  report.pageBefore=await tik.read(pageState);assert.equal(report.pageBefore.challenge,false);
  const detach=pong.onEvent(e=>{if(e.method==='Network.requestWillBeSent'){
    const url=new URL(e.params.request.url);
    if(url.pathname==='/pong-swap/warm')report.requests.push(url.pathname+url.search);
  }});
  await pong.call('Network.enable');
  const start=performance.now();
  await pong.read('document.getElementById("tiktok-live").click();true');
  report.entryDispatchMs=performance.now()-start;
  let after;
  while(performance.now()-start<30000){
    after=await json('/health');
    if(after.restorers?.['512']?.ready&&after.restorers?.['1024']?.ready)break;
    await new Promise(r=>setTimeout(r,200));
  }
  report.bothModelsReadyMs=performance.now()-start;
  detach();await pong.call('Network.disable');
  report.after={ready:after.ready,models:Object.keys(after.restorers||{}),sessions:after.activeSessions};
  report.pageAfter=await tik.read(pageState);
  report.presetAfter=hash();
  assert.deepEqual((await json('/settings')).config,settings.config);
  assert.equal(report.presetBefore,report.presetAfter);
  assert.ok(report.requests.includes('/pong-swap/warm?profile=tiktok-face-size'));
  assert.equal(after.restorers?.['512']?.ready,true);assert.equal(after.restorers?.['1024']?.ready,true);
  assert.equal(after.activeSessions,0,'Warmup must not create render sessions');
  assert.deepEqual(report.pageAfter,report.pageBefore,'Entry must preserve the already open page and login');
  report.passed=true;
}catch(e){report.error=String(e.message);process.exitCode=1;}
finally{pong.close();tik.close();writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));}
