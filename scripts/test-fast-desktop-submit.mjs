import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { inlineMediaIdentityHash, resolveInlineVideoIdentityFromHtml } from '../inline-video-identity.mjs';
const script=readFileSync(new URL('../universal-video-scraper.user.js',import.meta.url),'utf8');
const start=script.indexOf('  async function sendCaptureToRecall(');
const source=script.slice(start,script.indexOf('  // Historical capture implementation',start));
const server=readFileSync(new URL('../local-ai-server.mjs',import.meta.url),'utf8');
async function run({vpn=false,badReceipt=false}={}){
 const calls=[];let clock=0,accepted=false;
 const action=Symbol('explicit action');
 const targets=Array.from({length:12},(_,i)=>({url:`https://fixture.invalid/video/${i}`}));
 const job={id:'fixture-job',state:'running',targets:targets.map((_,index)=>({index,state:'queued'}))};
 if(badReceipt)job.targets.pop();
 const ctx=vm.createContext({busy:false,performance:{now:()=>clock},location:{href:'https://fixture.invalid/'},PONG_ENDPOINTS:['http://pc'],VPN_USER_ACTION:action,crypto:{randomUUID:()=>job.id},
   diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},diagnosticNumber:v=>v,diagnosticFailure:v=>v,
   requiresCaliforniaVpn:()=>vpn,vpnEndpoint:()=> 'http://pc',
   vpnRequest:async action=>{calls.push('vpn:'+action);clock+=40;return {busy:true}},
   runVpnAction:()=>{throw Error('Phone must not wait for VPN')},
   browserRelayRequest:async req=>{calls.push(req.method);clock+=40;return {status:req.method==='POST'?202:200,responseText:JSON.stringify({ok:true,desktopOwned:true,backgroundNetworkPreparation:true,job})}},
   sleep:async()=>{clock+=120001},
   selection:{targets,vpnAuthorization:action,onAccepted:r=>{calls.push('accepted');accepted=r}}
 });
 vm.runInContext(source,ctx);
 let error;try{await vm.runInContext("sendCaptureToRecall('all',2,false,selection)",ctx)}catch(e){error=e}
 return {calls,accepted,error};
}
test('Twelve links use one batch POST with no helper preflight',async()=>{
 const r=await run();assert.ifError(r.error);assert.deepEqual(r.calls.slice(0,2),['POST','accepted']);assert.equal(r.accepted.total,12);assert.equal(r.accepted.acceptedMs,40);
});
test('VPN connection can remain busy when all twelve links are accepted',async()=>{
 const r=await run({vpn:true});assert.ifError(r.error);assert.deepEqual(r.calls.slice(0,3),['vpn:connect','POST','accepted']);assert.equal(r.accepted.acceptedMs,80);
});
test('Incomplete PC receipt cannot display the safe-to-close message',async()=>{
 const r=await run({badReceipt:true});assert.ok(r.error);assert.equal(r.accepted,false);
});
test('Production desktop resolver waits for queued VPN operation before source access',()=>{
 const body=server.slice(server.indexOf('const desktopCaptureJobs ='),server.indexOf('function resetSimpCityRecallState'));
 assert.match(body,/if \(requiresCaliforniaVpn\(target.pageUrl\)\) await vpnControl.controller.operation;\s*await requireMediaVpn\(target.pageUrl\)/);
 assert.ok(body.indexOf('await vpnControl.controller.operation')<body.indexOf('await resolveGenericMediaPage'));
});

test('Production resolver continues after PC VPN completes without any phone polling',async()=>{
 const jobsStart=server.indexOf('const desktopCaptureJobs =');
 const start=server.indexOf('resolve: async',jobsStart)+'resolve: '.length;
 const end=server.indexOf('\n  commit:',start);
 const resolver=server.slice(start,end).trim().replace(/,$/,'');
 let completeNetwork;let networkReady=false,sourceRequests=0;
 const operation=new Promise(resolve=>{completeNetwork=()=>{networkReady=true;resolve()}});
 const context=vm.createContext({URL,Date,requiresCaliforniaVpn:()=>true,youtubeVideoIdFromPage:()=>'',
  vpnControl:{controller:{operation}},requireMediaVpn:async()=>assert.equal(networkReady,true),
  resolveGenericMediaPage:async()=>{sourceRequests++;return {durationSeconds:45,videoUrls:['https://fixture.invalid/media.mp4']}},
  preferredDesktopCaptureMediaUrls:urls=>urls,inspectRecallMediaSource:async()=>({playable:true}),simpCityRecallState:()=>({mediaCapture:{id:'job'}})
 });
 const resolve=vm.runInContext('('+resolver+')',context);
 const result=resolve({pageUrl:'https://fixture.invalid/watch/one'},{id:'job',channel:2},()=>{});
 await Promise.resolve();assert.equal(sourceRequests,0);
 completeNetwork();assert.ok((await result).video);assert.equal(sourceRequests,1);
});

for (const validHash of [true,false]) {
 test(`production inline resolver ${validHash?'commits the selected same-page player':'rejects mismatched player evidence'}`,async()=>{
  const jobsStart=server.indexOf('const desktopCaptureJobs =');
  const start=server.indexOf('resolve: async',jobsStart)+'resolve: '.length;
  const end=server.indexOf('\n  commit:',start);
  const resolver=server.slice(start,end).trim().replace(/,$/,'');
  const page='https://example.org/two-players';
  const wanted='https://cdn.example.org/second-1080.mp4';
  const inspected=[];
  const context=vm.createContext({URL,Date,requiresCaliforniaVpn:()=>false,youtubeVideoIdFromPage:()=>'',
   requireMediaVpn:async()=>{},resolveInlineVideoIdentityFromHtml,
   fetchPublicMediaPage:async()=>({url:page,html:'<video src="https://cdn.example.org/first.mp4"></video><video src="'+wanted+'"></video>'}),
   authorizeGenericMediaUrl:url=>new URL(url),resolveGenericMediaPage:()=>{throw Error('Must not use page-wide fallback');},
   preferredDesktopCaptureMediaUrls:urls=>urls,inspectRecallMediaSource:async(url)=>{inspected.push(url);return {playable:true};},
   simpCityRecallState:()=>({mediaCapture:{id:'inline-job'}})
  });
  const resolve=vm.runInContext('('+resolver+')',context);
  const result=await resolve({pageUrl:page,logicalVideoId:'inline-video-2',
   mediaIdentityHash:validHash?inlineMediaIdentityHash(wanted,page):'0'.repeat(64),durationSeconds:45},
   {id:'inline-job',channel:2},()=>{});
  if(validHash){assert.equal(result.video.videoUrl,wanted);assert.deepEqual(inspected,[wanted]);}
  else {assert.equal(result.error,'identity_unverified');assert.equal(inspected.length,0);}
 });
}
