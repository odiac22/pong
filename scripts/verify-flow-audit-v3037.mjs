// Offline regressions only. Never starts production or touches live Recall.
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.PONG_AUDIT_OUT || 'E:/Pong Benchmarks/v3037-flow-audit';
const python=path.join(root,'Pong Swap/runtime/venv/Scripts/python.exe');
const groups=[
  {name:'renderer-regressions',exe:python,cwd:path.join(root,'Pong Swap'),args:['-m','unittest',
    'test_pong_swap_temporal_safety','test_pong_swap_config_sessions','test_pong_swap_gpu_worker',
    'test_pong_swap_embedding_priority','test_pong_swap_foreground_priority','test_pong_swap_source_pool',
    'test_pong_swap_buffer_policy','test_pong_swap_pipeline2','test_pong_swap_lookahead',
    'test_pong_swap_frame_preview','test_pong_detection_learning','test_pong_swap_lifecycle','test_pong_swap_prefetch_stride',
    'test_pong_multi_face','test_pong_swap_identity','test_pong_swap_remote','test_pong_remote_gateway',
    'test_benchmark_multi_face_labels','-q']},
  {name:'remote-regressions',exe:python,args:['-m','unittest','discover','-s','scripts/tiktok_remote','-q'],env:{PYTHONPATH:'E:/Pong Benchmarks/tiktok-remote/deps'}},
  {name:'receipt-regressions',exe:python,args:['-m','unittest','discover','-s','scripts','-p','test_qualify_current_tampermonkey_manager.py','-q']},
  {name:'player-regressions',exe:process.execPath,args:['--test',
    'scripts/test-tiktok-remote-client-lifecycle.mjs',
    'scripts/test-swap-media-callback-ownership.mjs','scripts/test-face-swap-prefetch-seek-contract.mjs',
    'scripts/test-smooth-scrub-playback-intent.mjs','scripts/test-face-swap-editor-cancellation.mjs','scripts/test-detect-fast-path.mjs',
    'scripts/test-preload-inflight-ownership.mjs','scripts/test-foreground-progress-lease.mjs',
    'scripts/test-cache-endpoint-fallback.mjs','scripts/test-cache-source-idempotence.mjs',
    'scripts/test-recall-cache-preference.mjs','scripts/test-recall-restart-cache-contract.mjs',
    'scripts/test-video-readiness-status.mjs','scripts/test-modern-ui.mjs']},
  {name:'multi-ui-contract',exe:process.execPath,args:['scripts/test-face-swap-multi-selection.mjs']},
  {name:'audio-ownership-contract',exe:process.execPath,args:['scripts/test-playback-audio-ownership.mjs']},
  {name:'helper-syntax',exe:process.execPath,args:['--check','local-ai-server.mjs']}
];
await mkdir(out,{recursive:true});
const report={version:'30.38',scope:'offline regressions; not website or app performance',groups:[],passed:true};
for(const group of groups){
  const began=performance.now();
  const result=spawnSync(group.exe,group.args,{cwd:group.cwd||root,windowsHide:true,encoding:'utf8',timeout:60000,
    env:{...process.env,PYTHONWARNINGS:'ignore::DeprecationWarning',...group.env}});
  const output=(result.stdout||'')+(result.stderr||'');
  const count=output.match(/Ran (\d+) tests/)?.[1] || output.match(/tests (\d+)/)?.[1] || null;
  const row={name:group.name,exitCode:result.status,elapsedMs:performance.now()-began,testCount:count?Number(count):null,output};
  report.groups.push(row);report.passed&&=result.status===0;
  console.log(JSON.stringify({...row,output:undefined}));
}
const html=await readFile(path.join(root,'scripts/tiktok_remote/client.html'),'utf8');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
report.remoteClientSyntax=true;
report.testCount=report.groups.reduce((sum,g)=>sum+(g.testCount||0),0);
await writeFile(path.join(out,'regressions.json'),JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
