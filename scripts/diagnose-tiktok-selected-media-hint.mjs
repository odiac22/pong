// Read-only, one-selected-post diagnostic. Does not enable Pong's media-hint trial.
// Usage: node scripts/diagnose-tiktok-selected-media-hint.mjs [--port 60195] [--out report.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWebView } from './lib/tiktok-audit-cdp.mjs';
import {
  boundedSelectedRangeProbe, buildSelectedSnapshotExpression,
  planSelectedMediaProbes, sameSelectedSnapshot, sanitizedSelectedMetadata,
  tiktokMediaHostClass
} from './lib/tiktok-selected-hint-probe.mjs';

const args=process.argv.slice(2),option=name=>{
  const index=args.indexOf(name);
  return index<0?'':args[index+1]||'';
};
if (args.some(arg=>!['--port','--out'].includes(arg) &&
    args[args.indexOf(arg)-1]!=='--port' && args[args.indexOf(arg)-1]!=='--out')) {
  throw Error('Only --port and --out are supported');
}
const port=option('--port')?Number(option('--port')):60195;
if (!Number.isInteger(port)||port<1024||port>65535) throw Error('Invalid CDP port');
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=readFileSync(resolve(root,'android-app/app/src/main/assets/tiktok-mobile.js'),'utf8');
const expression=buildSelectedSnapshotExpression(source);
const result={schema:'pong-selected-media-hint-diagnostic-v1',at:new Date().toISOString(),
  selected:null,probes:[],conclusion:'not-started'};
let client;
try {
  client=await connectWebView(port,'tiktok');
  const selected=await client.read(expression);
  if (!selected) result.conclusion='no-identity-bound-visible-video';
  else {
    result.selected=sanitizedSelectedMetadata(selected);
    const candidates=planSelectedMediaProbes(selected).slice(0,2);
    result.conclusion=candidates.length?'probed':'no-allowed-media-url';
    for (const candidate of candidates) {
      const before=await client.read(expression);
      if (!sameSelectedSnapshot(selected,before)) {result.conclusion='selection-changed';break;}
      const probe=await boundedSelectedRangeProbe(candidate.url,{
        expectedSize:candidate.kind==='advertised-highest-h264'?Number(selected.hint?.size)||0:0
      });
      const after=await client.read(expression);
      if (!sameSelectedSnapshot(selected,after)) {
        result.conclusion='selection-changed';result.probes=[];break;
      }
      result.probes.push({kind:candidate.kind,hostClass:tiktokMediaHostClass(candidate.url),...probe});
    }
  }
} catch {
  result.conclusion='diagnostic-failed';
} finally {
  client?.close();
}
const serialized=JSON.stringify(result,null,2);
const output=option('--out');
if (output) writeFileSync(resolve(output),serialized+'\n',{flag:'wx'});
console.log(serialized);
