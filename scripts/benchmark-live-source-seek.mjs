// Silent source-only A/B probe. URLs stay in memory; no swap generation or display.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const snapshot=JSON.parse(await readFile('.pong-local-ai/recall-restart-1790550172338.json','utf8'));
const raw=snapshot.channels.find(c=>c.channel===1).recall.genericBundles[0].videos[0].videoUrl;
const url=`http://127.0.0.1:8787/generic-media/hls?url=${encodeURIComponent(raw)}`;
const targets=(process.argv.find(v=>v.startsWith('--targets='))?.slice(10)||'25,120,340').split(',').map(Number);
const code=`import sys,json,time,hashlib,av,statistics
from pong_swap_source_pool import StandbySourcePool
payload=json.load(sys.stdin);url=payload['url']; pool=StandbySourcePool(); results=[];phase='init';target=None
def probe(c,t):
 s=c.streams.video[0];c.seek(int(t/float(s.time_base)),stream=s,backward=True,any_frame=False)
 for f in c.decode(s):
  if f.pts is not None and float(f.pts*s.time_base)+1/float(s.average_rate)<t:continue
  return hashlib.sha256(f.to_ndarray(format='rgb24').tobytes()).hexdigest(),f.width,f.height
 raise RuntimeError('no target frame')
try:
 for target in payload['targets']:
  phase='cold-open-seek-decode'
  begin=time.perf_counter()
  with av.open(url,timeout=(10.,5.)) as c:expected=probe(c,target)
  cold=(time.perf_counter()-begin)*1000
  phase='standby-preparation';begin=time.perf_counter();pool.warm(url)
  while not pool.status()['ready'] and time.perf_counter()-begin<12:time.sleep(.02)
  warm=(time.perf_counter()-begin)*1000
  begin=time.perf_counter();c=pool.take(url)
  if c is None:raise RuntimeError('standby unavailable')
  phase='standby-seek-decode'
  try:actual=probe(c,target)
  finally:c.close()
  elapsed=(time.perf_counter()-begin)*1000
  assert actual==expected
  r=dict(target=target,coldMs=round(cold,1),standbySeekMs=round(elapsed,1),preparationMs=round(warm,1),speedup=round(cold/elapsed,2),identicalPixels=True,width=actual[1],height=actual[2]);results.append(r);print(json.dumps(r),flush=True)
except Exception as e:print(json.dumps(dict(error=type(e).__name__,phase=phase,target=target)),flush=True)
finally:pool.clear()
`;
const rows=await new Promise((resolve,reject)=>{
 const p=spawn('runtime/venv/Scripts/python.exe',['-c',code],{cwd:'Pong Swap',windowsHide:true,stdio:['pipe','pipe','pipe']});
 let out='';const timer=setTimeout(()=>{p.kill();reject(Error('benchmark timeout'));},90000);
 p.stdout.on('data',d=>{out+=d;process.stdout.write(d);});p.stderr.on('data',()=>{});p.on('error',reject);
 p.on('exit',()=>{clearTimeout(timer);resolve(out.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));});
 p.stdin.end(JSON.stringify({url,targets}));
});
await mkdir('artifacts/scrub-30.17',{recursive:true});
await writeFile(`artifacts/scrub-30.17/live-source-seek-${targets.join('-')}.json`,JSON.stringify({scope:'PC input open+seek+decode only; not phone presentation or face generation',rows},null,2));
if(rows.length!==targets.length||rows.some(r=>r.error))process.exitCode=1;
