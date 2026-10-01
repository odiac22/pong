import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {reconcileRunCadence} from './lib/tiktok-painted-cadence.mjs';
const input=resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Pass an existing swipe report');
const output=input.replace(/\.json$/i,'-cadence-reconciled.json');
if(output===input)throw Error('Expected a .json input report');
const run=JSON.parse(readFileSync(input,'utf8'));
const trials=reconcileRunCadence(run,30);
const videos=run.trials.filter(t=>t.distinctVideo);
const report={input,originalUnmodified:true,measurementSchema:5,pass:false,
  note:'Reassigns retained drain events by time/session. Missing drains remain unqualified. Decoder presentations are not physical-display proof.',
  summary:{videos:videos.length,swipes:run.trials.length,
    underOneSecond:videos.filter(t=>t.underOneSecond).length,
    noQualifiedSwapPaint:videos.filter(t=>!Number.isFinite(t.firstPaintUpperMs)).length,
    completeCadenceWindows:trials.filter(t=>t.collectionComplete).length,
    decoderFloorMet:trials.filter(t=>t.floorMet).length},trials};
writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({saved:output,...report.summary}));
