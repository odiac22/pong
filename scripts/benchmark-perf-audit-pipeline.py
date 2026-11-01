"""Real acquisition/decoder/renderer/NVENC/spool with a clocked silent consumer.

Counts complete received MP4 fragments. Playback credit advances only when a
frame is actually consumed; no fake render-speed credit and no extra prebuffer.
This does not measure Android compositor or Wi-Fi presentation.
"""
from pathlib import Path
from gpu_trial_mutex import acquire
acquire()
import sys,os,json,copy,time,threading,subprocess,re,argparse
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(os.environ.get('PONG_AUDIT_ROOT','F:/CodexProjects/pong')).resolve();REFERENCE=ROOT/'artifacts/swap-audit-20261031';OUT=Path(os.environ.get('PONG_AUDIT_OUTPUT',str(ROOT/'artifacts/perf-audit-20261101/runs')))
p=argparse.ArgumentParser();p.add_argument('--label',required=True);p.add_argument('--cadence',type=int,default=4);p.add_argument('--baseline',action='store_true');p.add_argument('--rapid-only',action='store_true');p.add_argument('--profile',default='tiktok-3x-adapt');p.add_argument('--cold',type=int,default=3);a=p.parse_args()
sys.path.insert(0,str(ROOT/'Pong Swap'));os.environ['PONG_SWAP_SPOOL_DIR']='E:/Pong Benchmarks/perf-audit-20261101/pipeline-spool'
if os.environ.get('PONG_AUDIT_OVERLAY'):sys.path.insert(0,os.environ['PONG_AUDIT_OVERLAY'])
if a.baseline:
 import importlib.abc,importlib.util,importlib.machinery
 class FrozenSource(importlib.machinery.SourceFileLoader):
  def __init__(self,name,path,snapshot):super().__init__(name,path);self.snapshot=snapshot
  def get_code(self,fullname):return compile(self.snapshot.read_text(encoding='utf-8-sig'),self.path,'exec')
 class Baseline(importlib.abc.MetaPathFinder):
  def find_spec(self,fullname,path=None,target=None):
   name=fullname.rsplit('.',1)[-1];relative='engine/Rope/rope/VideoManager.py' if name=='VideoManager' else name+'.py';before=OUT/'source-before'/relative
   if name in ('VideoManager','pong_swap_engine','pong_acceleration_warm','pong_attachment','pong_face_patch','pong_three_x','pong_landmark106','pong_batch_presentation') and before.is_file():
    original=ROOT/'Pong Swap'/relative
    return importlib.util.spec_from_file_location(fullname,original,loader=FrozenSource(fullname,str(original),before))
 sys.meta_path.insert(0,Baseline())
import cv2,numpy as np
cv2.setNumThreads(1)
import pong_swap_config as cfg
base=json.loads((REFERENCE/'attachmentstockgrassmatrix4.json').read_text())
config=json.loads(Path(os.environ['PONG_AUDIT_CONFIG']).read_text(encoding='utf-8-sig')) if os.environ.get('PONG_AUDIT_CONFIG') else base['config']
config=config.get('config',config);config['runtime']['swapAudioEnabled']=False
for key in ('tiktokRestorerProfile','tiktokRestorerState','threeXForce256','crowdRestorerModel','frameReuseCadence'):config['runtime'].pop(key,None)
cfg.load_config=lambda:copy.deepcopy(config);cfg.save_config=lambda *x,**kw:(_ for _ in ()).throw(RuntimeError('Benchmark preset write forbidden'))
import pong_swap_engine as pe
from pong_appearance_client import APPEARANCE,install_acquisition_classifier
fixtures=json.loads((REFERENCE/'pipeline-fixtures.json').read_text());files={x['stock']:Path(x['file']) for x in fixtures};ids=base['selectedFaceIds']
class Media(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_HEAD(self):self.serve(False)
 def do_GET(self):self.serve(True)
 def serve(self,body):
  path=files.get(self.path.strip('/'))
  if path is None:self.send_error(404);return
  size=path.stat().st_size;start=0;end=size-1;range_header=self.headers.get('Range','')
  if range_header:
   m=re.fullmatch(r'bytes=(\d+)-(\d*)',range_header)
   if not m:self.send_error(416);return
   start=int(m[1]);end=min(end,int(m[2])) if m[2] else end
  self.send_response(206 if range_header else 200);self.send_header('Content-Type','video/mp4');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
  if range_header:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
  self.end_headers()
  if body:
   try:
    with path.open('rb') as f:
     f.seek(start);remaining=end-start+1
     while remaining:
      data=f.read(min(65536,remaining))
      if not data:break
      self.wfile.write(data);remaining-=len(data)
   except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Media);threading.Thread(target=server.serve_forever,daemon=True).start()
report={'label':a.label,'cadence':a.cadence,'config':config,'runs':[],'scope':'loopback HTTP + lossless benchmark RGB + actual decode/render/NVENC/spool + clocked fragment consumer; Android and Wi-Fi unmeasured'}
sequence=0;engine=None
def save(): (OUT/(a.label+'.json')).write_text(json.dumps(report,indent=2))
def make_engine():
 e=pe.PongSwapEngine();install_acquisition_classifier(e);return e
def create(stock):
 global sequence
 sequence+=1
 return engine.create_session(channel='audit-pipeline',source_url=f'http://127.0.0.1:{server.server_port}/{stock}',face_id=ids[0],face_ids=ids,start_seconds=0,prefetch=False,prebuffer_seconds=.25,navigation_class='foreground',restoration_profile=a.profile,frame_reuse_cadence=a.cadence,client_epoch=f'{a.label}-{sequence}',activation_sequence=sequence)
def run(stock,kind,full=False):
 request=time.perf_counter();wall=time.time()
 if not a.baseline or os.environ.get('PONG_AUDIT_BASELINE_APPEARANCE')=='1':APPEARANCE.request_warm()
 s=create(stock);probe=pe._FragmentedMp4Probe();done=threading.Event();received={'first':None,'error':None,'bytes':0};ticks=[]
 def receive():
  try:
   for chunk in engine.stream_session(s.id,activate=True,media_source=True):
    probe.feed(chunk);received['bytes']+=len(chunk)
    if probe.media_fragment_ready and received['first'] is None:received['first']=time.perf_counter()
   probe.feed(b'',eof=True)
  except Exception as exc:received['error']=str(exc)
  finally:done.set()
 reader=threading.Thread(target=receive,daemon=True);reader.start()
 played=0;play_start=None;next_due=None;stall_start=None;stalls=[];last_credit=0.;max_frames=next(x['frames'] for x in fixtures if x['stock']==stock)
 try:
  while time.perf_counter()-request<90:
   now=time.perf_counter();fps=max(1.,s.fps);available=min(s.frames,probe.complete_fragment_count*max(1,s.fragment_frame_target))
   if not full and received['first'] is not None:break
   if full and play_start is None and available/fps+1/fps>=s.prebuffer_seconds and received['first'] is not None:
    play_start=next_due=now
   if next_due is not None and now>=next_due:
    if played<available:
     if stall_start is not None:
      stalls.append({'start':stall_start-request,'seconds':now-stall_start});stall_start=None;next_due=now
     played+=1;next_due+=1/fps
    elif played<max_frames and stall_start is None:stall_start=next_due
   if now-last_credit>.05:
    engine.update_playback(s.id,position_seconds=played/fps,paused=play_start is None)
    if full:ticks.append({'seconds':now-request,'deliveredSeconds':available/fps,'playedSeconds':played/fps,'queueAgeMs':s.decoder_queue_age_ms[-1] if s.decoder_queue_age_ms else 0})
    last_credit=now
   if full and played>=max_frames:break
   if done.is_set() and (received['error'] or s.error):break
   time.sleep(.005)
 finally:
  stopped=time.perf_counter();engine.stop_session(s.id,deferred=False)
  if s.producer:s.producer.join(10)
  reader.join(10)
 row={'kind':kind,'stock':stock,'requestTime':wall,'firstFragmentMs':None if received['first'] is None else (received['first']-request)*1000,
      'firstSwapMs':None if not s.first_transformed_frame_at else (s.first_transformed_frame_at-wall)*1000,
      'playStartMs':None if play_start is None else (play_start-request)*1000,'playedFrames':played,'expectedFrames':max_frames,
      'bufferingSeconds':sum(x['seconds'] for x in stalls),'stalls':stalls,'consumer':ticks,'cancelMs':(time.perf_counter()-stopped)*1000,'received':received,'session':s.public()}
 report['runs'].append(row);save();print(json.dumps({k:row[k] for k in ('kind','stock','firstSwapMs','firstFragmentMs','bufferingSeconds','playedFrames')}),flush=True)
try:
 for i in range(0 if a.rapid_only else a.cold):
  engine=make_engine();run('4769378','cold-'+str(i));engine.unload();engine.shutdown_gpu_worker();APPEARANCE.close();engine=None
 engine=make_engine()
 if not a.baseline or os.environ.get('PONG_AUDIT_BASELINE_APPEARANCE')=='1':APPEARANCE.request_warm()
 started=time.perf_counter();engine._run_gpu_work(engine.warm,config=config,allow_create_selected=True);report['warmPreparationMs']=(time.perf_counter()-started)*1000
 for fixture in ([] if a.rapid_only else fixtures):
  for i in range(3):run(fixture['stock'],'warm-'+str(i))
  run(fixture['stock'],'playback',True)
 rapid=[];deadline=time.perf_counter()
 for i in range(6):
  if rapid:
   try:engine.stop_session(rapid[-1].id,deferred=True)
   except KeyError:pass # Navigation may already have removed its predecessor.
  s=create(fixtures[i%3]['stock']);rapid.append(s);engine.activate_session(s.id);deadline+=1;time.sleep(max(0,deadline-time.perf_counter()))
 for s in rapid:
  try:engine.stop_session(s.id,deferred=True)
  except KeyError:pass
  if s.producer:s.producer.join(10)
  report['runs'].append({'kind':'rapid','session':s.public()})
 report['gpuWorkTimings']=getattr(engine,'_gpu_work_timings',{})
finally:
 if engine is not None:
  for s in list(getattr(engine,'_sessions',{}).values()):
   if not s.stop.is_set():engine.stop_session(s.id,deferred=False)
  engine.unload();engine.shutdown_gpu_worker()
 APPEARANCE.close();server.shutdown();server.server_close();save()
