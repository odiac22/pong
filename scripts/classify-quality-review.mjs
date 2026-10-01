// Read-only historical evidence audit. This does not qualify or promote a model.
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join,dirname,basename,resolve,isAbsolute} from 'node:path';
const root='E:/Pong Benchmarks/user-quality-review-2026-09-30';
const repo=resolve('.');
const inventory=JSON.parse(await readFile(join(root,'historical-inventory.json'),'utf8'));
const groups=new Map(),counts={qualityEvidence:0,invalidComparison:0,passedQuality:0,unattributed:0};
function brief(x){if(x===undefined)return null;const s=JSON.stringify(x);return s.length<4000?x:{truncated:true,preview:s.slice(0,4000)}}
function family(p){if(p.includes('original_models'))return 'Alternative trained renderers/restorers';if(/conv-(trial|islands)/i.test(p))return 'GPEN mixed-precision convolution';if(/spatial-student/i.test(p))return 'GPEN spatial correction students';if(/fp16/i.test(p))return 'GPEN FP16';if(/temporal|anchor|restorer\d|hybrid|maskcache/i.test(p))return 'Temporal reuse, tracking and interpolation';if(/native-trt/i.test(p))return 'Native TensorRT variants';return 'Other renderer/runtime experiments'}
for(const r of inventory.rows){
 const j=JSON.parse(await readFile(r.path,'utf8')),reasons=[],invalid=[];
 if(j.phases?.some(x=>/rejected_numerical_quality/.test(x.phase)))reasons.push({key:'phases',kind:'explicit numerical quality rejection'});
 if(j.qualityPass===false)reasons.push({key:'qualityPass',kind:'numeric quality gate failed',value:false});
 if(j.checks&&j.fidelity)for(const[k,v]of Object.entries(j.checks))if(v===false&&/mae|absolute|psnr|ssim|fidelity|temporal/i.test(k))reasons.push({key:'checks.'+k,kind:'numeric quality gate failed',value:false});
 for(const f of j.promotionGate?.failures||[])if(/quality.regression/i.test(f.kind))reasons.push({key:'promotionGate.failures',kind:'relative quality regression',value:f});
 for(const[key,q]of Object.entries(j.quality||{}))if(q&&typeof q==='object'&&q.pass===false){
  if(q.errors?.length&&!q.comparisons?.length)invalid.push({key:'quality.'+key,errors:q.errors});
  else reasons.push({key:'quality.'+key,kind:'quality comparison failed',value:brief(q)});
 }
 if(j.exportGate?.passed===false)reasons.push({key:'exportGate',kind:'trained-model export gate failed',value:j.exportGate});
 if(j.selected?.gate?.passed===false&&r.path.includes('original_models'))reasons.push({key:'selected.gate',kind:'selected trained-model gate failed; inspect individual checks',value:brief(j.selected.gate)});
 if(j.gates?.testTemporalNonincrease===false)reasons.push({key:'gates.testTemporalNonincrease',kind:'temporal error increased',value:j.gates});
 if(j.gate?.passed===false&&r.path.includes('original_models'))reasons.push({key:'gate',kind:'trained-model challenge gate failed',value:brief(j.gate)});
 // qualification:false alone means unqualified, not an observed rejection.
 const category=reasons.length?'qualityEvidence':invalid.length?'invalidComparison':j.qualityPass===true?'passedQuality':'unattributed';counts[category]++;
 if(!reasons.length&&!invalid.length)continue;
 const key=dirname(r.path);if(!groups.has(key))groups.set(key,{name:basename(key),directory:key,family:family(key),reports:[],artifacts:[],qualityDecision:'Awaiting user review; not rendered for this comparison'});
 const g=groups.get(key);
 const numerical={};for(const k of ['candidateOrtVsOriginal','candidateTrtVsOriginal','candidateTrtVsAdopted'])if(j[k]){const f=j[k].frames||[];numerical[k]={pass:j[k].pass,samples:f.length,failedSamples:f.filter(x=>x.pass===false).length,failedStockSamples:f.filter(x=>x.pass===false&&/^clip-/.test(x.kind)).length,failedGeneratedSamples:f.filter(x=>x.pass===false&&!/^clip-/.test(x.kind)).length,maxTemporalMae:j[k].temporalMae?.length?Math.max(...j[k].temporalMae):null};}
 g.reports.push({path:r.path,classification:category,reasons,invalidComparison:invalid,numerical,historicalTiming:brief({speedup:j.speedup,reference:j.reference,baseline:j.baseline,candidate:j.candidate,summary:j.summary,gates:j.gates}),configuration:brief(j.configuration||j.settings),note:'Historical timings are not a current five-clip comparison and may measure only one stage.'});
 const artifactPaths=new Set();
 for(const k of ['model','plan','checkpoint'])if(typeof j[k]==='string'&&/\.(onnx|plan|pt|pth|engine)$/i.test(j[k]))artifactPaths.add(isAbsolute(j[k])?j[k]:resolve(/^Pong Swap[\\/]/.test(j[k])?repo:dirname(r.path),j[k]));
 for(const e of await readdir(dirname(r.path),{withFileTypes:true}))if(e.isFile()&&/\.(onnx|plan|pt|pth|engine)$/i.test(e.name))artifactPaths.add(join(dirname(r.path),e.name));
 if(/gpen512-fp16-candidate/.test(r.path))artifactPaths.add(join(repo,'Pong Swap/runtime/models-candidates/gpen512-fp16/GPEN-BFR-512.onnx'));
 for(const p of artifactPaths)if(!g.artifacts.some(x=>x.path===p)){let s;try{s=await stat(p)}catch{}g.artifacts.push({path:p,exists:!!s,bytes:s?.size??null,loadTested:false})}
}
const items=[...groups.values()];
const families=[...new Set(items.map(x=>x.family))].map(name=>({name,variantDirectories:items.filter(x=>x.family===name).length,withSavedArtifacts:items.filter(x=>x.family===name&&x.artifacts.some(a=>a.exists)).length}));
const curated=[
 {name:'GFPGAN 1.2 / 1.3 / 1.4',status:'Saved Sept 18 comparison measured complete restoration calls around 59 ms versus 89 ms for its old GPEN512 reference. GFPGAN 1.2 was not promoted because its measured detail ratio was lower. All three remain visual-review candidates; this does not prove a speed gain over current TensorRT GPEN.',source:'Pong Swap/benchmarks/MODEL_RESTORER_BASELINE.md'},
 {name:'GPEN256',status:'Saved comparison measured 23.6 ms complete restoration versus 89.0 ms for old GPEN512. Previously withheld for loss of detail. Include as an explicitly labelled lower-native-resolution comparison, not a silent live substitution.',source:'Pong Swap/benchmarks/MODEL_RESTORER_BASELINE.md'},
 {name:'GPEN512 full FP16',status:'58.09 to 45.56 ms per model call in the saved CUDA test (1.275x throughput). Failed MAE/PSNR/SSIM and the old speed threshold. Saved model found. Visual review pending; current TensorRT baseline is different.',source:'Pong Swap/benchmarks/gpen512-fp16-candidate/report.json'},
 {name:'GPEN512 mixed-precision convolution engines',status:'Two saved TensorRT plans were stopped at numerical quality checks, before timing. Original-vs-candidate and adopted-vs-candidate differences will be reported without vetoing visual review.',source:'E:/Pong Benchmarks/tiktok-webview-2026-09-29/gpen512-conv-trial-all-aux0-r1/report.json'},
 {name:'Temporal reuse / cubic interpolation / anchor schedules / residual sharpening / support cropping',status:'Earlier variants were rejected for pose, feature-drift, flicker or detail regressions, sometimes despite higher processing FPS. Keep distinct configurations; some hooks were removed and need reconstruction before a faithful rerun.',source:'Pong Swap/benchmarks/temporal-attachment-20260919/FINAL_AUDIT_20260919.md'},
 {name:'Alternative trained V8–V11 renderers',status:'Historical model-only calls around 5–6 ms were reported. Candidates failed teacher-feature or identity gates. Those timings exclude detection, restoration, compositing and video transport; they are not 5 ms Pong playback. Saved trained variants remain candidates for labelled review.',source:'Pong Swap/original_models/V8_V10_RESEARCH_REPORT.md'},
 {name:'Causal V12/V13 restorer variants and later trained ablations',status:'Some scored very close to strict identity thresholds; independent temporal tests still failed. Include saved variants and cold/reset behavior in visual review, rather than judging them solely by small numerical differences.',source:'Pong Swap/original_models/README.md'},
 {name:'GPEN spatial correction students v2/v3',status:'Saved correction checkpoints exist. Temporal/pixel-tail gates failed. Their roughly 2 ms stage cost is additional correction work, not the cost of the entire renderer.',source:'Pong Swap/benchmarks/gpen512-spatial-student-v2/report.json'},
 {name:'HyperSwap 1A/1B/1C and other swapper models',status:'Not all were quality rejections. HyperSwap had faster isolated model calls but slower complete swap calls in the old benchmark. Keep as separate model alternatives; do not advertise isolated inference as an end-to-end win.',source:'Pong Swap/benchmarks/MODEL_RESTORER_BASELINE.md'},
 {name:'Persistent binding and removing the inner restorer lock',status:'Old rejections were primarily inconclusive speed improvements, not visible quality loss. Record separately from quality-rejected candidates; some device-resident infrastructure has changed since those tests.',source:'Pong Swap/benchmarks/onnx-runtime-profiles/FINAL_RUNTIME_OPTIMIZATION_REPORT.md'}
];
const report={createdAt:new Date().toISOString(),scope:inventory.scope,reportCount:inventory.rows.length,counts,families,curated,items,skipped:inventory.skipped,completeClaim:false,notes:['Grouped only by exact directory; repeated runs in separate directories remain visible. Counts are not unique optimization counts.','A failed or missing-reference comparison is kept separate from observed visual/numeric degradation.','No candidate is excluded from user visual review for a numeric quality threshold. Artifacts are not yet load-tested.','Temporal settings often reuse existing weights, so no separate model artifact is required; an absent adjacent checkpoint does not mean the experiment is impossible.','Search covers retained report files from September 18 onward, not proof of every conversation or deleted experiment.']};
await writeFile(join(root,'quality-review-ledger.json'),JSON.stringify(report,null,2));
const gallery=JSON.parse(await readFile(join(root,'gallery.json'),'utf8'));
gallery.pendingFaceChoice=true;gallery.baselineFaceName='Approved 3 (previous run)';
for(const f of gallery.faces)f.selected=false;
gallery.note='Choose an Approved face for new matched before/after runs. The existing five baseline files used Approved 3; no new candidate comparisons have been rendered yet.';
gallery.inventory={note:`Scanned ${report.reportCount} retained reports. ${counts.qualityEvidence} contain attributable numerical/quality gate failures; these are reports, not unique optimizations. No new five-clip comparisons yet.`,items:curated.map(({name,status})=>({name,status}))};
await writeFile(join(root,'gallery.json'),JSON.stringify(gallery,null,2));
console.log(JSON.stringify({reports:report.reportCount,counts,families,directories:items.length,artifacts:items.reduce((n,x)=>n+x.artifacts.filter(a=>a.exists).length,0)},null,2));
