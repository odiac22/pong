import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {reconcileFaceVisibleTiming} from './lib/tiktok-face-visible-timing.mjs';
import {summarizePlaybackEvents} from './lib/tiktok-playback-events.mjs';
const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
if(input===output)throw Error('Keep the original benchmark immutable; choose a separate correction report');
const run=JSON.parse(await readFile(input,'utf8'));
const reviews=process.argv[4]?JSON.parse(await readFile(process.argv[4],'utf8')).videos||{}:{};
const corrected={sourceReport:input,createdAt:new Date().toISOString(),
  supersedes:'Any interpretation of swipe-to-first-swap as face-visible-to-swap delay',
  faceVisibleTiming:reconcileFaceVisibleTiming(run,reviews),
  playback:run.measurementSchema>=6?summarizePlaybackEvents(run):null,
  caveat:'Older runs without reviewed original visibility cannot establish face-response latency. Their navigation and raw frame timestamps remain diagnostic evidence.'};
await writeFile(output,JSON.stringify(corrected,null,2),{flag:'wx'});
console.log(JSON.stringify({saved:output,measured:corrected.faceVisibleTiming.measuredVideoVisits,
  unreviewed:corrected.faceVisibleTiming.unreviewedVisits,excluded:corrected.faceVisibleTiming.excludedVisits,
  pass:corrected.faceVisibleTiming.pass}));
