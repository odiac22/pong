// SurfaceFlinger's bounded per-surface present-fence history. Diagnostic only.
import {execFileSync} from 'node:child_process';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const shell=(...args)=>execFileSync(adb,['-s','emulator-5582','shell',...args],{encoding:'utf8',timeout:5000,windowsHide:true});
export function surfaceBootNs(){
 const value=shell('cat','/proc/uptime').trim().split(' ')[0];
 if(!/^\d+\.\d{2}$/.test(value))throw Error('Unexpected emulator boot clock');
 return String(BigInt(value.replace('.',''))*10000000n);
}
export function parseSurfaceLatency(raw,startNs,endNs){
 const lines=raw.trim().split(/\r?\n/),refreshNs=lines.shift();
 if(!/^\d+$/.test(refreshNs))throw Error('Missing SurfaceFlinger refresh period');
 const start=BigInt(startNs),end=BigInt(endNs),pending=9223372036854775807n;
 const frames=[];
 for(const line of lines){
   const row=line.trim().split(/\s+/);
   if(row.length!==3||row.some(x=>!/^\d+$/.test(x)))throw Error('Malformed SurfaceFlinger latency row');
   const actual=BigInt(row[1]);
   if(actual===0n||actual===pending||actual<start||actual>=end)continue;
   frames.push(row[1]);
 }
 const times=[...new Set(frames)].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
 const gaps=times.slice(1).map((t,i)=>Number(t-times[i])/1e6);
 return {refreshPeriodNs:refreshNs,presentedBufferTimesNs:times.map(String),count:times.length,
   maxInterPresentMs:gaps.length?Math.max(...gaps):null,
   clockUncertaintyMs:10,physicalVideoFpsFloorProven:false,
   note:'Bounded SurfaceFlinger history; includes hidden native buffers and may omit overwritten ring entries. Not source-content or face eligibility proof.'};
}
export function collectNativeSurfaceLatency(startNs,endNs){
 const list=shell('dumpsys','SurfaceFlinger','--list');
 const layers=[...list.matchAll(/RequestedLayerState\{(SurfaceView\[com\.odiac22\.pong2\/com\.odiac22\.pong\.MainActivity\]\(BLAST\)#\d+)/g)].map(m=>m[1]);
 if(layers.length!==1)return {available:false,matchingLayers:layers.length};
 // The anchored pattern above permits no shell metacharacters or quotes.
 const raw=shell('dumpsys','SurfaceFlinger','--latency',"'"+layers[0]+"'");
 return {available:true,layer:layers[0],...parseSurfaceLatency(raw,startNs,endNs)};
}
