// Read-only same-DOM microbenchmark. No page/account content is retained.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'pong');
const source=readFileSync('android-app/app/src/main/assets/tiktok-pong-overlay.js','utf8');
const from=source.indexOf('  function visibleRect('),to=source.indexOf('  function report()',from);
const baseline=source.slice(from,to);
const trial=baseline.replace('    const visited=[];',`    // display:none subtrees have no client rect, so none of their ancestor
    // style reads or bounding-box work can affect native touch routing.
    if(node.getClientRects&&node.getClientRects().length===0)return null;
    const visited=[];`);
const selector=source.match(/  const selector = ('[^']+');/)[1];
try{
 const result=await p.read(`(()=>{
  const nodes=[...document.querySelectorAll(${selector})];
  const baseline=(()=>{${baseline};return visibleRect})(),trial=(()=>{${trial};return visibleRect})();
  const samples={baseline:[],trial:[]};let equal=true;
  for(let i=0;i<30;i++)for(const [name,fn] of i%2?[['trial',trial],['baseline',baseline]]:[['baseline',baseline],['trial',trial]]){
   const before=performance.now(),visibility=new WeakMap();
   const rects=nodes.map(n=>fn(n,visibility)).filter(Boolean).slice(0,256);
   samples[name].push(performance.now()-before);
   equal&&=JSON.stringify(rects)===JSON.stringify(nodes.map(n=>baseline(n,new WeakMap())).filter(Boolean).slice(0,256));
  }
  return {diagnosticOnly:true,targets:nodes.length,equal,samples};
 })()`);
 const file=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/overlay-visibility-${Date.now()}.json`;
 writeFileSync(file,JSON.stringify(result,null,2));
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 console.log(JSON.stringify({saved:file,equal:result.equal,targets:result.targets,
  baselineMedianMs:median(result.samples.baseline),trialMedianMs:median(result.samples.trial)}));
}finally{p.close()}
