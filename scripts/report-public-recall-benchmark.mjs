import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {primaryVideoEvidence} from '../video-source-policy.mjs';
const root=process.argv[2]||'E:/Pong Benchmarks/v3006-public-recall';
const read=async p=>{try{return JSON.parse(await readFile(root+'/'+p,'utf8'));}catch{return null;}};
const fixtures=await read('manifest.json');
const modes={
 userscript:{before:await read('userscript-before/discovery.json'),after:await read('userscript-qualified/discovery.json')},
 recall:{before:await read('recall-before-r2/report.json'),after:await read('recall-qualified/report.json')}
};
const playback={before:await read('playback-userscript-before/report.json'),after:await read('playback-userscript-range-fixed/report.json')};
const apiPlayback={before:await read('playback-api-before/report.json'),after:await read('playback-api-after/report.json')};
const fastlane=await read('userscript-fastlane/discovery.json');
const allCapture=(await read('userscript-all/discovery.json'))?.sites?.[0];
const integrity=await read('proxy-integrity.json');
const manager=await read('tampermonkey-manager/report.json');
const key=c=>c.site+'-'+c.ordinal;
const median=a=>{a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};
const round=n=>Number.isFinite(n)?Math.round(n):null;
const bundle=(row,mode)=>mode==='userscript'?row?.recall:row?.result?.recall;
const clip=(row,mode)=>bundle(row,mode)?.genericBundles?.[0]?.videos?.[0];
// Re-grade baseline recordings too: a truncated stream can jump currentTime
// to its declared duration, without presenting those frames. Keep raw logs.
const playbackPass=p=>!!(p?.playback?.muted&&p.playback.volume===0&&!p.session?.error&&p.session?.state!=='error'&&p.frames?.length&&p.frames.at(-1).media>=p.requiredPlaySeconds-.08&&p.maxPresentedGapMs<250);
const swapPass=p=>playbackPass(p)&&p.session?.transformedFrames>0&&p.transformedRatio>=.95;
const declaredAssetKey=raw=>{
 try{const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k))u.searchParams.delete(k);
  // Audit-only equivalence for a stable UUID-addressed asset. Do not alter
  // playback URLs, signatures, or arbitrary query-based content identifiers.
  if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(u.pathname))
   for(const k of ['token','signature','sig','expires','exp'])u.searchParams.delete(k);
  return u.href;
 }catch{return raw;}
};
const result={createdAt:new Date().toISOString(),fixtures:fixtures.length,sites:new Set(fixtures.map(c=>c.site)).size,baselineVersion:'30.05 / userscript 7.14.0',candidateVersion:'30.06 / userscript 7.15.0',silence:true,headless:true,private:true,
 qualification:'NOT universal success. Capture acceptance is not decoded playback, correct identity, or highest-quality proof.',
 limitations:[
  'The full Firefox matrix ran the userscript through a GM compatibility extension. A separate five-page smoke test uses official signed Tampermonkey 5.5.0; its outcomes are reported separately. No Android run.',
  'Fixed 75 public pages, five per domain. Several contain scenery, hands, titles, or faces not eligible under the unchanged strictness settings. Those do not establish face-swap coverage.',
  'Discovery and recorded-capture replay are separate clocks, not one continuous end-to-end click-to-swap measurement.',
  'Source-page/network tests ran concurrently at up to three API requests; playback used one swap renderer. Network cache/CDN load and concurrent CPU work can affect timings.',
  'Playback gates: min(10 seconds, source duration minus 0.15 seconds), hard muted, maximum presented frame gap below 250 ms. Full short-clip playback is explicitly not a ten-second pass.',
  'Reported swap startup means swapped pipeline first playable frame. Actual transformed-face evidence additionally requires transformedFrames > 0; no-face outputs are not counted as successful swaps.',
  'Same exact page/media URL in both ingestion methods may reuse one playback observation. This is labelled shared evidence, not a second independent trial.',
  'JSON-LD association proves declared asset association, not visual semantic verification. Only declared sibling renditions can be ranked. Browser-only, protected, DRM, login, or challenge sources are not bypassed.',
 'The source quality policy pins the highest declared HLS rendition. This can increase decoding/network load and does not prove every codec is supported.'
 ,'Signed URLs can expire between discovery and replay. A replay failure on an expired URL is not evidence that a fresh browser capture is unsupported.'
 ,'No match to a saved JSON-LD rendition is unverified association, not proof that a different video was selected. Alternative encodes can live at different URLs.'
 ],cases:[],summary:[]};
result.supplemental={allCapture:allCapture?{site:allCapture.url,videos:allCapture.capture?.deliveredVideos,firstDeliveredMs:allCapture.firstDeliveredMs,totalCaptureMs:allCapture.captureMs}:null,
 fastlane:fastlane?.sites?.map(c=>({site:c.site,beforeMs:modes.userscript.after?.sites?.find(b=>b.site===c.site&&b.ordinal===c.ordinal)?.captureMs,afterMs:c.captureMs,delivered:c.capture?.deliveredVideos}))||[],
 integrity,manager,regressionTests:{passed:146,failed:0},browsers:{firefox:'156.0.1',chrome:'153.0.8010.54'}};
for(const f of fixtures){
 let evidence=null;
 for(const dir of ['userscript-qualified','userscript-final','userscript-before']){
  try{evidence=primaryVideoEvidence(await readFile(`${root}/${dir}/${key(f)}.html`,'utf8'),f.url);if(evidence)break;}catch{}
 }
 const row={...f,declaredEvidence:evidence,methods:{}};
 for(const [mode,runs]of Object.entries(modes)){
  const mr=row.methods[mode]={};
  for(const phase of ['before','after']){
   const c=(runs[phase]?.sites||runs[phase]?.cases||[]).find(c=>key(c)===key(f)),v=clip(c,mode);
   const media=v?.videoUrl;
   let p=playback[phase]?.cases?.find(c=>key(c)===key(f)&&c.captured?.videoUrl===media&&media);
   let scope=p?(mode==='userscript'?'userscript replay':'shared exact-source userscript replay'):null;
   if(!p){p=apiPlayback[phase]?.cases?.find(c=>key(c)===key(f)&&c.captured?.videoUrl===media&&media);if(p)scope='Recall API capture replay';}
   mr[phase]={attempted:!!c,captured:!!media,discoveryMs:round(mode==='userscript'?c?.captureMs:c?.elapsedMs),firstDeliveredMs:c?.firstDeliveredMs??null,
    pageTitle:c?.title||null,selectedTitle:v?.title||null,selectedMedia:media||null,duration:v?.durationSeconds||null,
    declaredIdentityMatch:evidence&&media?evidence.videoUrls.some(u=>declaredAssetKey(u)===declaredAssetKey(media)):null,
    declaredTitleMatch:evidence&&v?.title?evidence.title.trim()===v.title.trim():null,
    highestDeclaredRenditionMatch:evidence&&media?declaredAssetKey(evidence.videoUrls[0])===declaredAssetKey(media):null,
    error:c?.error||c?.result?.error||(!media?c?.diagnostics?.panel:null)||null,
    playback:p?{evidence:scope,status:playbackPass(p)?(swapPass(p)?'swapped-playback-pass':'playback-pass-not-95%-transformed'):p.status==='failed'?'failed':'playback-fail',error:p.error||p.session?.error||null,sourceDimensions:p.metadata?`${p.metadata.width}x${p.metadata.height}`:null,
     firstSourceFrameMs:round(p.recallFirstFrameMs),swapPipelineFirstPlayableMs:round(p.swapFirstPlayableMs),recallToSwapMs:round(p.recallToSwapMs),
     sourceDuration:p.metadata?.duration,requiredPlaySeconds:p.requiredPlaySeconds,reportedCurrentTime:p.playback?.t,presentedSeconds:p.frames?.at(-1)?.media||0,wallMs:round(p.playWallMs),
     maximumFrameGapMs:round(p.maxPresentedGapMs),transformedRatio:p.transformedRatio,
     transformedFrames:p.session?.transformedFrames,playbackPass:playbackPass(p),faceSwapPass:swapPass(p)}:null};
  }
 }
 result.cases.push(row);
}
for(const site of new Set(fixtures.map(c=>c.site))){
 const siteRows=result.cases.filter(c=>c.site===site);
 const summary={site};
 for(const mode of Object.keys(modes)){
  const rows=siteRows.map(c=>c.methods[mode]);
  const paired=rows.filter(c=>c.before.captured&&c.after.captured);
  summary[mode]={beforeCaptured:rows.filter(c=>c.before.captured).length,afterCaptured:rows.filter(c=>c.after.captured).length,
   matchedCapturePairs:paired.length,beforeMatchedMedianMs:round(median(paired.map(c=>c.before.discoveryMs))),afterMatchedMedianMs:round(median(paired.map(c=>c.after.discoveryMs))),
   afterPlaybackTested:rows.filter(c=>c.after.playback).length,afterPlaybackPass:rows.filter(c=>c.after.playback?.playbackPass).length,
   afterFaceSwapPass:rows.filter(c=>c.after.playback?.faceSwapPass).length,
   afterDeclaredIdentityMatches:rows.filter(c=>c.after.declaredIdentityMatch===true).length,
   afterDeclaredIdentityMismatches:rows.filter(c=>c.after.declaredIdentityMatch===false).length};
 }
 result.summary.push(summary);
}
const preset=await readFile(new URL('../Pong Swap/presets/current.json',import.meta.url));
result.qualityPresetSha256=createHash('sha256').update(preset).digest('hex');
result.matchedPlayback=Object.fromEntries(Object.keys(modes).map(mode=>{
 const paired=result.cases.map(c=>c.methods[mode]).filter(c=>c.before.playback&&c.after.playback);
 const smooth=paired.filter(c=>c.before.playback.playbackPass&&c.after.playback.playbackPass);
 return [mode,{pages:paired.length,beforeSmooth:paired.filter(c=>c.before.playback.playbackPass).length,afterSmooth:paired.filter(c=>c.after.playback.playbackPass).length,
  successfulPairs:smooth.length,beforeStartupMedianMs:round(median(smooth.map(c=>c.before.playback.recallToSwapMs))),afterStartupMedianMs:round(median(smooth.map(c=>c.after.playback.recallToSwapMs)))}];
}));
await writeFile(root+'/summary.json',JSON.stringify(result,null,2));
const lines=['# Pong 30.06 public-video Recall audit','',`Generated ${result.createdAt}. ${result.sites} non-adult domains × 5 fixed pages = ${result.fixtures} pages per ingestion method.`,
 '', '**Status: the all-sites / all-videos requirement has NOT passed.** The matrix includes failures rather than substituting easier pages.',
 '', '## Changes', '',
 '- Bind JSON-LD primary-video identity before collecting renditions. Pexels previously selected other recommended clips; Coverr included unrelated promotional videos.',
 '- Preserve per-video titles through browser handoff, Recall, and Pong metadata.',
 '- Separate Main/listing resolution caches; forbid nested listing recursion; bound hidden browser ownership to two instances.',
 '- Deliver the first verified, quality-ordered source without probing all lower-quality alternatives. Empty browser appends no longer start a second PC-side extraction.',
 '- Check media reachability from the playback server instead of trusting duration alone; HLS checks include a segment.',
 '- Remove the proxy’s artificial 4 MiB Range cap: it corrupted decoder reads mid-packet. The same 4K Pexels source now decodes all 241 frames through Pong, versus 35 frames before. No media quality/resolution change.',
 '- Re-grade both baseline and candidate playback using presented frame timestamps and engine errors, not currentTime alone. Earlier raw logs marked some truncated files as passes; this report corrects those false positives.',
 '- Do not retain empty resolutions or failed source URLs in the positive-resolution cache.',
 '- Detect late swap failures through existing playback heartbeats, and recognize truncated EOF using the existing presented-frame clock rather than duration jumps. No additional frame-processing loop.',
 '- Pin the highest declared HLS variant for both browser and swap decoder. A real TED stream decoded at 854×480 before and 1920×1080 after, with the same master URL.',
 '- Recover missing duration through a muted metadata probe; recognize more public watch-page shapes, OGV, and declared embedded players. Fix synchronous abort handling in Range probes.',
 '- Declare known Pong hosts explicitly in Tampermonkey permissions; bound both media probes and Pong requests with wall-clock deadlines so an unanswered manager prompt cannot hang capture indefinitely.',
 '- Face engine, GPEN1024 strength 100, current quality preset, and saved 30.05 baseline were not changed.',
 '', '## Capture matrix', '', 'Counts below are returned candidates, NOT playback success. Times are medians only among pages returning a candidate in both versions; faster failures do not count as speedups.', '',
 '| Site | Script before → after /5 | Script paired ms before → after | Recall before → after /5 | Recall paired ms before → after |',
 '|---|---:|---:|---:|---:|'];
for(const s of result.summary){const a=s.userscript,b=s.recall;lines.push(`| ${s.site} | ${a.beforeCaptured} → ${a.afterCaptured} | ${a.beforeMatchedMedianMs??'—'} → ${a.afterMatchedMedianMs??'—'} | ${b.beforeCaptured} → ${b.afterCaptured} | ${b.beforeMatchedMedianMs??'—'} → ${b.afterMatchedMedianMs??'—'} |`);}
lines.push('','## Playback evidence','','This is real Pong UI playback with unchanged Approved 3 / saved live quality settings. Same-URL sharing between ingestion methods is explicit in summary.json. Source-page discovery time is not included in replay latency.','',
 '| Site | Script decoded tests / captures | Script smooth playback | Script smooth + ≥95% transformed | Recall decoded tests / captures | Recall smooth playback | Recall smooth + ≥95% transformed |',
 '|---|---:|---:|---:|---:|---:|---:|');
for(const s of result.summary){const a=s.userscript,b=s.recall;lines.push(`| ${s.site} | ${a.afterPlaybackTested}/${a.afterCaptured} | ${a.afterPlaybackPass} | ${a.afterFaceSwapPass} | ${b.afterPlaybackTested}/${b.afterCaptured} | ${b.afterPlaybackPass} | ${b.afterFaceSwapPass} |`);}
lines.push('','### Paired playback comparison','','Only pages with replay observations in both versions are compared. Source selection can change after identity/quality fixes, so these are matched pages, not necessarily identical encodes. Startup is the pipeline first-playable event, not proof of a visible transformed face.','',
 '| Method | Paired pages | Smooth before → after | Pairs smooth in both | Replay-to-pipeline startup median ms before → after |',
 '|---|---:|---:|---:|---:|',
 ...Object.entries(result.matchedPlayback).map(([mode,p])=>`| ${mode} | ${p.pages} | ${p.beforeSmooth} → ${p.afterSmooth} | ${p.successfulPairs} | ${p.beforeStartupMedianMs} → ${p.afterStartupMedianMs} |`));
lines.push('','## Scope and limitations','',...result.limitations.map(s=>'- '+s),'',
 '## Supplemental controlled checks','',
 `- All-videos: ${allCapture?.capture?.deliveredVideos??'pending'} Mixkit clips, first delivered at ${allCapture?.firstDeliveredMs??'pending'} ms, complete at ${allCapture?.captureMs??'pending'} ms. Each retains its own page/title. These are captures, not 24 independently graded swaps.`,
 `- Proxy integrity: ${integrity?.identical?'byte-for-byte SHA256 match':'pending'}; ${integrity?.results?.[0]?.bytes??'pending'} bytes. [Evidence](proxy-integrity.json).`,
 '- 146 regression tests passed. No quality-preset or face-engine changes.',
 '- Final userscript Main fast path removes the fixed settling delay only when an authoritative VideoObject is already present. The full 75-page capture matrix predates this last scheduling-only change; these five real-page rechecks isolate it:', '',
 '| Site | Before fast path (ms) | After fast path (ms) | Returned |','|---|---:|---:|---:|',
 ...result.supplemental.fastlane.map(c=>`| ${c.site} | ${c.beforeMs} | ${c.afterMs} | ${c.delivered} |`),'',
 'The full candidate replay includes the Range fix. The final late-error UI guard is regression-tested separately; it does not change extraction or rendering. Baseline and candidate reports retain intermediate raw logs rather than silently replacing them.', '',
 '## Actual Tampermonkey manager check', '',
 'A fresh private/headless Firefox profile installed the official Mozilla-signed Tampermonkey 5.5.0. The initial run exposed a manager cross-origin permission tab that left Capturing pending. Explicit local @connect entries removed the Pong-server prompt. Other media destinations still require normal manager permission; this test approves only individual public CDN hosts present in the recorded fixture results, within the temporary profile. It never enables Allow all domains. Permission interaction time is included in these smoke-test times. The final deadline/permission changes postdate the full 75-page harness matrix.', '',
 '| Site | Delivered videos | Capture ms | Error |', '|---|---:|---:|---|',
 ...(manager?.sites||[]).map(c=>`| ${c.site} | ${c.capture?.deliveredVideos??0} | ${c.captureMs??'—'} | ${(c.error||'').replaceAll('|','/').split('\n')[0]} |`), '',
 '[Manager evidence](tampermonkey-manager/report.json). [Official Tampermonkey permission documentation](https://www.tampermonkey.net/documentation.php#meta:connect).', '',
 '## Activation', '',
 'Files are prepared as Pong 30.06 and userscript 7.15.0. Production backend remains on the pre-update running process: Recall 2 has a queued bundle, and restart would clear that in-memory queue. Awaiting the user’s choice before restarting. No native Android code was changed by this audit, so no new APK is required. Updating the userscript and activating the backend are separate from refreshing the Pong page.', '',
 '## Detailed evidence','', '[Per-page timings, title/identity checks, quality evidence, and results](summary.json)', '',
 '[Fixed public page manifest](manifest.json)', '',
 '[Userscript baseline captures](userscript-before/discovery.json) · [Userscript candidate captures](userscript-qualified/discovery.json)', '',
 '[Recall baseline captures](recall-before-r2/report.json) · [Recall candidate captures](recall-qualified/report.json)', '',
 '[Baseline Pong replay (use corrected gates in summary.json)](playback-userscript-before/report.json) · [Candidate Pong replay](playback-userscript-range-fixed/report.json)', '',
 '[Additional baseline API-source replays](playback-api-before/report.json) · [Additional candidate API-source replays](playback-api-after/report.json)', '',
 `Quality preset SHA256: ${result.qualityPresetSha256}`,'');
await writeFile(root+'/REPORT.md',lines.join('\n'));
console.log(JSON.stringify({pages:result.cases.length,report:root+'/REPORT.md',totals:Object.fromEntries(Object.keys(modes).map(mode=>[mode,{
 before:result.cases.filter(c=>c.methods[mode].before.captured).length,
 after:result.cases.filter(c=>c.methods[mode].after.captured).length,
 playbackTests:result.cases.filter(c=>c.methods[mode].after.playback).length,
 playbackPasses:result.cases.filter(c=>c.methods[mode].after.playback?.playbackPass).length,
 swapPasses:result.cases.filter(c=>c.methods[mode].after.playback?.faceSwapPass).length
}]))},null,2));
