import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root='E:/Pong Benchmarks/v3029-overnight/userscript';
const runs=['run-30','refined-30','extra-20','sample-4','pexels-fix','pexels-playback-long2',
  'pexels-4k-watch-3248785','vecteezy-touch-fix','inline-integrated','archive-8','nps-watch','hlsjs-pong','cultural-5','pixabay-recheck','archive-nav-fix','mdn-live-example','videojs-pong','plyr-pong'];
const originalGroups=new Set(['run-30','extra-20','sample-4','archive-8','cultural-5']);
const canonicalSite={
  'wikimedia-commons':'wikimedia','archive-org':'archive','blender-open-movie':'blender',
  'nasa-jpl':'nasa','nasa-gov':'nasa','videvo':'magnific'
};
const groups=new Map();
const attempted=new Set();
for(const run of runs){
  let data;try{data=JSON.parse(await readFile(path.join(root,run,'report.json'),'utf8'));}catch{continue;}
  for(const row of data.cases||[]){
    const site=canonicalSite[row.site]||row.site;
    if(originalGroups.has(run))attempted.add(site);
    const list=groups.get(site)||[];
    list.push({run,status:row.status,url:row.page?.url||row.url,
      pageTitle:row.page?.title||'',challenge:row.page?.challenge===true,
      navigationWarning:row.navigationWarning||'',videoCount:row.page?.videoCount??null,
      redBoxes:row.selection?.boxes?.length||0,
      visibleBoxes:(row.selection?.boxes||[]).filter(box=>!box.hidden).length,
      selectedKind:row.chosen?.kind||'',selectedUrl:row.chosen?.url||'',
      selectionInput:row.selectionInput||'not recorded',
      submittedHash:row.submittedPayload?.targets?.[0]?.mediaIdentityHash||'',
      receiptId:row.receipt?.id||'',receiptState:row.receipt?.state||'',deliveredVideos:row.receipt?.deliveredVideos||0,
      recallVideoCount:row.recallVideoCount||0,
      mediaUrl:row.videos?.[0]?.videoUrl||'',
      playback:row.playback||null,playbackPass:row.playbackPass===true,
      elapsedMs:row.elapsedMs,error:row.error||''});
    groups.set(site,list);
  }
}
const sites=[...attempted].sort().map(site=>{
  const attempts=groups.get(site)||[];
  const receipts=attempts.filter(a=>a.deliveredVideos>0&&a.recallVideoCount>0);
  const touchReceipts=receipts.filter(a=>a.selectionInput==='WebDriver touch pointer');
  const playbacks=attempts.filter(a=>a.playbackPass);
  const best=touchReceipts.find(a=>a.playbackPass)||touchReceipts[0]||receipts.find(a=>a.playbackPass)||receipts[0]||attempts.at(-1);
  const finalStatus=site==='pixabay'&&touchReceipts.length?'intermittent-touch-receipt; signed-manager-empty':
    touchReceipts.length?'touch-receipt':receipts.length?'mouse-receipt':
    attempts.some(a=>a.challenge)?'site-access-challenge':
    attempts.some(a=>a.status==='accepted-no-video'&&['empty','failed'].includes(a.receiptState))?'pc-finished-no-video':
    attempts.some(a=>a.status==='accepted-no-video'||a.status==='accepted-pending-unverified')?'pc-accepted-unverified':
    attempts.some(a=>a.status==='no-credible-video-box'||a.status==='no-visible-video-box')?'detection-or-visibility-failed':
    attempts.at(-1)?.status||'unknown';
  return {site,finalStatus,bestEvidenceRun:best?.run||'',anyReceipt:receipts.length>0,
    touchReceipt:touchReceipts.length>0,mutedPlaybackPass:playbacks.length>0,
    attempts};
});
const pongPlayback=[];
for(const [site,run] of [['nps','nps-watch'],['hlsjs','hlsjs-pong'],['mdn','mdn-live-example'],['videojs','videojs-pong'],['plyr','plyr-pong']]){
  try{
    const check=JSON.parse(await readFile(path.join(root,run,'pong-player.json'),'utf8'));
    pongPlayback.push({site,passed:check.passed===true,elapsedMs:check.elapsedMs,
      finalSample:check.samples?.at(-1)||null,artifact:path.join(run,'pong-player.json')});
  }catch{}
}
const signedTampermonkeyChecks=[];
for(const [file,artifact] of [
  ['E:/Pong Benchmarks/v3029-overnight/signed-tampermonkey-7350/multi-site-r1/report.json','signed-tampermonkey-7350/multi-site-r1/report.json'],
  ['E:/Pong Benchmarks/v3029-overnight/signed-tampermonkey-7350/multi-site-r2/report.json','signed-tampermonkey-7350/multi-site-r2/report.json'],
  ['E:/Pong Benchmarks/v3029-overnight/signed-tampermonkey-7350/multi-site-r3/report.json','signed-tampermonkey-7350/multi-site-r3/report.json'],
  ['E:/Pong Benchmarks/v3031-tampermonkey-v735-touch-video-r1/report.json','v3031-tampermonkey-v735-touch-video-r1/report.json']
]){
  try{
    const check=JSON.parse(await readFile(file,'utf8'));
    for(const site of check.sites||[]){
      signedTampermonkeyChecks.push({site:String(site.site||''),touchSelected:site.selectionMethod==='WebDriver touch pointer'&&site.afterSelection?.selected>0,
        receiptState:site.receipt?.state||'',deliveredVideos:site.receipt?.deliveredVideos||0,
        artifact});
    }
  }catch{}
}
let pongVideoJsLong=null;
try{
  const check=JSON.parse(await readFile(path.join(root,'videojs-pong','pong-player-90s-original.json'),'utf8'));
  const firstFrame=check.samples?.find(sample=>sample.time>0)||null;
  pongVideoJsLong={passed1p5Within90Seconds:check.passed===true,
    firstFrameAtMs:firstFrame?.atMs||null,decodedWidth:firstFrame?.width||0,
    decodedHeight:firstFrame?.height||0,lastMediaTime:check.samples?.at(-1)?.time||0,
    artifact:'videojs-pong/pong-player-90s-original.json'};
}catch{}
const report={scope:'Distinct public non-adult websites; actual page visits with production userscript in Firefox GM compatibility extension; isolated Pong PC helper, not Tampermonkey manager or live Recall. Related NASA subdomains count once.',
  generatedAt:new Date().toISOString(),sitesAttempted:sites.length,
  sitesWithAnyReceipt:sites.filter(s=>s.anyReceipt).length,
  sitesWithTouchReceipt:sites.filter(s=>s.touchReceipt).length,
  sitesWithMutedPlaybackPass:sites.filter(s=>s.mutedPlaybackPass).length,
  realPongPlayerChecks:pongPlayback,
  realPongLong4kCheck:pongVideoJsLong,
  signedTampermonkeyChecks,
  '4kRawDecode':JSON.parse(await readFile(path.join(root,'four-k-decode.json'),'utf8')).cases.map(c=>({name:c.name,passed:c.passed,playback:c.playback})),
  sites};
await writeFile(path.join(root,'SUMMARY.json'),JSON.stringify(report,null,2));
const lines=[
  '# Public userscript benchmark',
  '',
  `Attempted ${report.sitesAttempted} distinct non-adult websites. ${report.sitesWithAnyReceipt} had a real isolated Recall receipt; ${report.sitesWithTouchReceipt} of those used a WebDriver touch-pointer tap on a red box. ${report.sitesWithMutedPlaybackPass} domains advanced at least 1.5 seconds in a separate native Firefox video element with audio muted.`,
  '',
  'The production userscript ran in a Firefox GM compatibility extension, not the Tampermonkey manager. Receipt and playback are separate checks. A PC acknowledgement without a resolved video is a failure. The Pexels 4K direct-source decodes are separate from the website handoff count; Wikimedia Commons had a 4K decode through the full userscript handoff.',
  '',
  'Separate signed Tampermonkey 5.5.0 spot checks are listed in SUMMARY.json. They do not turn the 58-site GM-shim matrix into a signed-manager pass. In particular, Pixabay had a correct signed-manager touch but an empty PC result; independent page fetch later returned HTTP 403 challenge. It is intermittent, not a robust cross-run pass.',
  '',
  'Actual isolated Pong controller checks: '+pongPlayback.map(c=>`${c.site} ${c.passed?'passed':'failed'} (${c.finalSample?.width||0}×${c.finalSample?.height||0}, ${Number(c.finalSample?.time||0).toFixed(2)}s, muted=${c.finalSample?.muted})`).join('; ')+'. A native Firefox `<video>` cannot by itself model Pong’s HLS.js player.',
  '',
  'Video.js Pong HLS: its Mux master was filtered to one 3840×2160 level. The first 4-second video segment advertised 19,352,034 bytes; direct and isolated-proxy reads delivered only about 7.6–8.7 MB in 15 seconds. It did not play within the 35-second check. In a separate bounded 90-second run, the first 4K video fragment finished around 90.12 seconds, 3840×2160 metadata appeared at 90.27 seconds and media advanced at 90.77 seconds; it reached 1.22 seconds by the cutoff, just short of the 1.5-second pass threshold. No silent resolution downgrade was applied.',
  '',
  '| Site | Result | Touch receipt | Muted play | Best evidence |',
  '| --- | --- | --- | --- | --- |',
  ...sites.map(s=>`| ${s.site} | ${s.finalStatus} | ${s.touchReceipt?'yes':'no'} | ${s.mutedPlaybackPass?'yes':'no'} | ${s.bestEvidenceRun} |`),
  '',
  'Source detail and every attempt, including blocked or failed runs, are preserved in SUMMARY.json and each run/report.json. No screenshots or media recordings were saved.',
  '',
  '4K direct-source checks: '+report['4kRawDecode'].map(c=>`${c.name} ${c.passed?`${c.playback.width}×${c.playback.height}, ${c.playback.mediaTime.toFixed(2)}s muted play`:`not 4K decoded (${c.playback?.width||0}×${c.playback?.height||0})`}`).join('; ')+'.'
];
await writeFile(path.join(root,'REPORT.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({sitesAttempted:report.sitesAttempted,receipts:report.sitesWithAnyReceipt,touchReceipts:report.sitesWithTouchReceipt,mutedPlaybacks:report.sitesWithMutedPlaybackPass}));
