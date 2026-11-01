"""perf-audit-20261101 offline render harness.

Derived from scripts/benchmark-swap-audit.py (same clip/source/cadence contract) with:
- PONG_AUDIT_ROOT    live repository root whose "Pong Swap" tree is imported (default F:/CodexProjects/pong)
- PONG_AUDIT_CONFIG  JSON file holding {"config":{...}} or a raw {parameters,runtime} config (e.g. GET /settings)
- PONG_AUDIT_SOURCE  explicit source mp4 path (treated like a stock clip; first PONG_AUDIT_SECONDS seconds)
- PONG_AUDIT_PROFILE restoration profile for stock runs (default tiktok-3x-gpen1024); PONG_AUDIT_ADAPT=1 enables Adapt
- per-frame fresh/reuse/tracked deltas, quality level, restorer mode and GPU-wait (stream synchronize) time
"""
from pathlib import Path
from gpu_trial_mutex import acquire
acquire()
from fractions import Fraction
from types import SimpleNamespace
import copy,json,sys,time,threading,os,hashlib
import cv2,numpy as np,av
ROOT=Path(os.environ.get('PONG_AUDIT_ROOT','F:/CodexProjects/pong')).resolve();OUT=Path(os.environ.get('PONG_AUDIT_OUTPUT',str(ROOT/'artifacts/perf-audit-20261101')));PREV=ROOT/'artifacts/attachment-baseline-20261030'
OUT.mkdir(parents=True,exist_ok=True)
MEDIA=Path(os.environ.get('PONG_AUDIT_MEDIA','E:/Pong Benchmarks/swap-audit-20261031/renders'));MEDIA.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(ROOT/'Pong Swap'));cv2.setNumThreads(1)
# PONG_AUDIT_OVERLAY: a directory of candidate modules imported ahead of the live tree
# (the perf-audit worktree). Everything not present there still comes from the live tree.
if os.environ.get('PONG_AUDIT_OVERLAY'):sys.path.insert(0,os.environ['PONG_AUDIT_OVERLAY'])
if os.environ.get('PONG_AUDIT_BASELINE')=='1':
 import importlib.abc,importlib.util,importlib.machinery
 class FrozenSource(importlib.machinery.SourceFileLoader):
  def __init__(self,name,path,snapshot):super().__init__(name,path);self.snapshot=snapshot
  def get_code(self,fullname):return compile(self.snapshot.read_text(encoding='utf-8-sig'),self.path,'exec')
 class BaselineModules(importlib.abc.MetaPathFinder):
  def find_spec(self,fullname,path=None,target=None):
   name=fullname.rsplit('.',1)[-1]
   relative='engine/Rope/rope/VideoManager.py' if name=='VideoManager' else name+'.py'
   before=OUT/'source-before'/relative
   if name in ('VideoManager','pong_swap_engine','pong_acceleration_warm','pong_attachment','pong_face_patch','pong_three_x','pong_landmark106','pong_batch_presentation') and before.is_file():
    original=ROOT/'Pong Swap'/relative
    return importlib.util.spec_from_file_location(fullname,original,loader=FrozenSource(fullname,str(original),before))
 sys.meta_path.insert(0,BaselineModules())
label=sys.argv[1];limit=int(sys.argv[2]) if len(sys.argv)>2 else 629
assert label.replace('-','').isalnum()
m=json.loads((PREV/'capture.json').read_text())
config_path=os.environ.get('PONG_AUDIT_CONFIG')
if config_path:
 loaded=json.loads(Path(config_path).read_text(encoding='utf-8-sig'))
 config=copy.deepcopy(loaded['config'] if 'config' in loaded else loaded)
 config.setdefault('runtime',{});config.setdefault('parameters',{})
 for key in ('tiktokRestorerProfile','tiktokRestorerState','threeXForce256','crowdRestorerModel','frameReuseCadence','threeXVideoKey','threeXCorrections'):
  config['runtime'].pop(key,None)
else:
 config=json.loads((PREV/'attachmentflowprofile.json').read_text())['config'];config['parameters']['SwapperTypeTextSel']='128'
 if label!='before':config['parameters']['StrengthSlider']=100
config['runtime']['swapAudioEnabled']=False
requested_restorer=os.environ.get('PONG_AUDIT_RESTORER') or ('GPEN1024' if '1024' in label else ('GPEN512' if '512' in label else None))
if requested_restorer:
 config['runtime'].pop('threeXOriginalRestorer',None)
 config['parameters']['RestorerTypeTextSel']=requested_restorer
if 'occluder' in label:config['parameters'].update(OccluderSwitch=True,OccluderSlider=0)
if 'noflow' in label:os.environ['PONG_ATTACHMENT']='0'
if label=='poseoff':os.environ['PONG_HEAD_POSE']='0'
if label.startswith('attachment') and not config_path:config['runtime']['attachmentStabilityEnabled']=True
if os.environ.get('PONG_AUDIT_ATTACHMENT') in ('0','1'):config['runtime']['attachmentStabilityEnabled']=os.environ['PONG_AUDIT_ATTACHMENT']=='1'
if 'precise' in label:os.environ['PONG_ATTACHMENT_PRECISE']='1'
if 'nosnap' in label:os.environ['PONG_ATTACHMENT_NOSNAP']='1'
if 'compact' in label:os.environ['PONG_ATTACHMENT_COMPACT']='1'
if 'identity' in label:os.environ['PONG_ATTACHMENT_IDENTITY']='1'
if 'trained' in label:os.environ['PONG_ATTACHMENT_TRAINED']='1'
if 'graph' in label:os.environ['PONG_SWAPPER_BATCH_GRAPH']='1'
if 'cuda' in label:config['runtime']['maskFaceParserBackendPreference']='cuda'
import pong_swap_config as cfg
cfg.load_config=lambda:copy.deepcopy(config)
cfg.save_config=lambda *a,**kw:(_ for _ in ()).throw(RuntimeError('Trial cannot write presets'))
if os.environ.get('PONG_AUDIT_ATTACHMENT_MODULE'):
 import importlib.util
 path=ROOT/'experiments'/os.environ['PONG_AUDIT_ATTACHMENT_MODULE'];spec=importlib.util.spec_from_file_location('pong_attachment',path);module=importlib.util.module_from_spec(spec);sys.modules['pong_attachment']=module;spec.loader.exec_module(module)
from pong_swap_engine import PongSwapEngine,FrameEvidence
from pong_swap_identity import CandidateIdentity
from pong_three_x import ThreeXRenderer
from pong_appearance_client import install_acquisition_classifier,APPEARANCE
from pong_tiktok_restorer import session_config_for_profile,apply_frame_reuse_cadence
stock=os.environ.get('PONG_AUDIT_STOCK')
explicit_source=os.environ.get('PONG_AUDIT_SOURCE')
if explicit_source:
 source_path=Path(explicit_source);stock=stock or source_path.stem
else:
 source_path=Path('E:/Pong Benchmarks/swap-audit-20261031/stock')/(stock+'.mp4') if stock else PREV/'original.mp4'
cadence=int(os.environ.get('PONG_AUDIT_CADENCE','3'))
adapt_env=os.environ.get('PONG_AUDIT_ADAPT')
default_profile='tiktok-3x-gpen1024' if stock or adapt_env=='0' else m['session']['session']['restorationProfile']
profile=os.environ.get('PONG_AUDIT_PROFILE') or default_profile
adapt=(adapt_env=='1') if adapt_env in ('0','1') else (not stock)
if adapt and profile=='tiktok-3x-gpen1024':profile='tiktok-3x-adapt'
active=session_config_for_profile(config,profile)
apply_frame_reuse_cadence(active,cadence,adapt=adapt)
seconds_limit=float(os.environ.get('PONG_AUDIT_SECONDS','10'))
if requested_restorer:assert active['parameters']['RestorerTypeTextSel']==requested_restorer,'Restorer override was not retained'
output_rate=Fraction(30000,1001);output_width=1920;output_height=1080
if stock:
 with av.open(str(source_path)) as probe:
  video=probe.streams.video[0];output_rate=video.average_rate;ratio=min(1.,1920./video.width,1080./video.height)
  output_width=int(video.width*ratio)//2*2;output_height=int(video.height*ratio)//2*2
 limit=int(np.ceil(float(output_rate)*seconds_limit))
faces=[f for f in os.environ.get('PONG_AUDIT_FACES','').split(',') if f] or m['initial']['selectedFaceIds']
engine=PongSwapEngine();install_acquisition_classifier(engine)
if os.environ.get('PONG_AUDIT_OCCLUSION_DEBUG')=='1':
 import pong_foreground_components as foreground
 original_protect=foreground.protect_occluded_mouth
 def capture_protect(torch,allowed,labels,state,edge):
  result=original_protect(torch,allowed,labels,state,edge)
  i=getattr(engine._vm,'_attachment_review_index',-1)
  if i in (243,244,245,246,247,248):
   p=OUT/f'{label}-mask-{i}.npz'
   if not p.exists():
    np.savez_compressed(p,labels=labels.to(torch.uint8).cpu().numpy(),before=allowed.cpu().numpy(),after=result.cpu().numpy())
    print(json.dumps({'maskFrame':i,'edge':edge,'geometry':(state or {}).get('attachmentGeometry',{}).get('index'),'snap':(state or {}).get('attachmentMouthSnap',{}).get('index'),'cleanups':(state or {}).get('attachmentOcclusionCleanups'),'flag':os.environ.get('PONG_OCCLUSION_COMPONENTS')}),flush=True)
  return result
 foreground.protect_occluded_mouth=capture_protect
report={'label':label,'config':active,'samples':[],'scope':('approved stock/benchmark clip, first %.1f seconds; silent'%seconds_limit) if stock else 'only user-marked 20.9742 second clip; silent','selectedFaceIds':faces,'sourceFile':str(source_path),'outputFps':float(output_rate),'outputWidth':output_width,'outputHeight':output_height,
 'profile':profile,'adapt':adapt,'cadence':cadence,'configSource':config_path or str(PREV/'attachmentflowprofile.json'),'harness':'perf-audit-20261101'}
report['file']=str(MEDIA/(label+'.mp4'))
report['environment']={k:v for k,v in os.environ.items() if k.startswith('PONG_')}
monitor_stop=threading.Event();monitor=None
if os.environ.get('PONG_AUDIT_TELEMETRY')=='1':
 sys.path.insert(0,'E:/Pong Benchmarks/swap-audit-20261031/telemetry-deps')
 import pynvml
 pynvml.nvmlInit();device=pynvml.nvmlDeviceGetHandleByIndex(0);report['gpuTelemetry']=[]
 def monitor_gpu():
  while not monitor_stop.is_set():
   try:
    usage=pynvml.nvmlDeviceGetUtilizationRates(device);memory=pynvml.nvmlDeviceGetMemoryInfo(device)
    report['gpuTelemetry'].append({'time':time.time(),'gpuPercent':usage.gpu,'memoryUsedMiB':memory.used/2**20,'memoryTotalMiB':memory.total/2**20,'powerWatts':pynvml.nvmlDeviceGetPowerUsage(device)/1000})
   except Exception as exc:report['gpuTelemetryError']=str(exc)
   monitor_stop.wait(.5)
 monitor=threading.Thread(target=monitor_gpu,daemon=True);monitor.start()
try:
 if os.environ.get('PONG_AUDIT_PREWARM_APPEARANCE')=='1':APPEARANCE.request_warm()
 start=time.perf_counter();engine.warm(active,allow_create_selected=True);report['warmSeconds']=time.perf_counter()-start
 candidates=[CandidateIdentity(f,engine.embedding_for_face(f,active),engine.presentation_for_face(f,active),engine.source_frame_for_face(f,active)) for f in faces]
 session=SimpleNamespace(config=active,channel='attachment-qualification',client_epoch=label,id=label,source_url=stock or 'authorized-marked-clinical-clip',candidate_face_ids=tuple(faces),stop=threading.Event(),fps=float(output_rate))
 renderer=ThreeXRenderer(engine,session,candidates,FrameEvidence)
 if 'stages' in label:
  original_restorer=engine._vm.apply_restorer
  def stage_restorer(image,*args,**kwargs):
   index=getattr(engine._vm,'_attachment_review_index',-1)
   before=image.detach().clone() if 70<=index<81 else None
   result=original_restorer(image,*args,**kwargs)
   dest=OUT/f'{label}-restorer-{index:03}.npz'
   if before is not None and not dest.exists():np.savez_compressed(dest,before=before.cpu().numpy(),after=result.cpu().numpy())
   return result
  engine._vm.apply_restorer=stage_restorer
 if 'maskdebug' in label:
  saved_visibility=engine._vm.attachment_visibility;saved_end=renderer.patch_capture.end
  debug={}
  def capture_visibility(original,edge,context=None):
   result=saved_visibility(original,edge,context)
   debug.update(original=original,allowed=result,labels=engine._vm._scratch.last_face_parser_labels)
   return result
  def capture_end():
   result=saved_end();index=getattr(engine._vm,'_attachment_review_index',-1)
   dest=OUT/f'{label}-alpha-{index:03}.npz'
   if index in (6,24,42,60,78,219,228,237,246,255) and result is not None and not dest.exists():
    np.savez_compressed(dest,patch=result[0].cpu().numpy(),**{k:v.cpu().numpy() for k,v in debug.items()})
   return result
  engine._vm.attachment_visibility=capture_visibility;renderer.patch_capture.end=capture_end
 if 'cpu' in label:
  import cProfile
  cpu=cProfile.Profile();render_unprofiled=renderer.render
  def render_profiled(frame):
   if not 30<=renderer.rendered_frames<100:return render_unprofiled(frame)
   cpu.enable()
   try:return render_unprofiled(frame)
   finally:cpu.disable()
  renderer.render=render_profiled
 if 'torchtrace' in label:
  import torch
  saved_render=renderer.render;trace=[None]
  def traced_render(frame):
   i=renderer.rendered_frames
   if i==10:
    trace[0]=torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU,torch.profiler.ProfilerActivity.CUDA],record_shapes=True)
    trace[0].__enter__()
   result=saved_render(frame)
   if i==20:
    trace[0].__exit__(None,None,None)
    (OUT/(label+'-operators.txt')).write_text(trace[0].key_averages().table(sort_by='self_cpu_time_total',row_limit=50))
    trace[0].export_chrome_trace(str(MEDIA/(label+'-trace.json')))
   return result
  renderer.render=traced_render
 if 'profile' in label:
  import pong_attachment,pong_landmark106
  measurements={}
  def profile_method(obj,name):
   original=getattr(obj,name)
   def wrapped(*args,**kw):
    started=time.perf_counter();result=original(*args,**kw)
    measurements.setdefault(name,[]).append((time.perf_counter()-started)*1000)
    return result
   setattr(obj,name,wrapped)
  for name in ('refine_geometry','retarget_features','snap_mouth_to_labels'):profile_method(pong_attachment,name)
  profile_method(pong_landmark106.Landmark106,'points')
  profile_method(engine._vm,'attachment_visibility')
  if 'deep' in label:
   from pong_face_patch import FacePatch
   from pong_three_x import OriginalFrameTracker
   profile_method(FacePatch,'render')
   profile_method(OriginalFrameTracker,'advance')
   profile_method(renderer.assignments,'match')
   for name in ('_eligible_people','_strict_pairs','_correction_regions','_enhance'):profile_method(renderer,name)
   for name in ('_detect','process_frame'):profile_method(engine,name)
 if 'debug' in label:
  import pong_attachment
  original_retarget=pong_attachment.retarget_features
  def capture_mesh(torch,patch,source_points,target_points,**kw):
   result=original_retarget(torch,patch,source_points,target_points,**kw)
   index=getattr(engine._vm,'_attachment_review_index',-1)
   dest=OUT/f'{label}-mesh-{index:03}.npz'
   if index in (6,24,42,60,78,210,219,228,237,246,255,300,390,570) and not dest.exists() and source_points is not None and target_points is not None:
    np.savez_compressed(dest,before=patch.detach().cpu().numpy(),after=result.detach().cpu().numpy(),source=source_points,target=target_points)
   return result
  pong_attachment.retarget_features=capture_mesh
 original_detect=renderer._eligible_people;observed=[]
 def capture(frame,rows):
  observed[:]=[{'points':row[1].tolist(),'area':float(row[0])} for row in rows]
  return original_detect(frame,rows)
 renderer._eligible_people=capture
 # GPU-wait accounting: time the render thread spends blocked in stream synchronize
 # (frame-boundary waits) and in the final host readback. Timing only; no behaviour change.
 wait_ms={'sync':0.0,'syncCalls':0,'readback':0.0}
 compute_stream=engine._compute_stream;original_sync=compute_stream.synchronize
 def timed_sync(*a,**k):
  t=time.perf_counter()
  try:return original_sync(*a,**k)
  finally:wait_ms['sync']+=(time.perf_counter()-t)*1000;wait_ms['syncCalls']+=1
 compute_stream.synchronize=timed_sync
 original_enhance=renderer._enhance
 def timed_enhance(tensor,points,*a,**k):
  t=time.perf_counter()
  try:return original_enhance(tensor,points,*a,**k)
  finally:wait_ms['readback']+=(time.perf_counter()-t)*1000
 renderer._enhance=timed_enhance
 previous_counters={'reused':0,'tracked':0,'corrections':0,'rechecks':0}
 # Deferred readback support: an ordered writer thread awaits each frame's GPU event,
 # hashes and encodes it, exactly like the producer's encoder writer. The render loop
 # measures submit time per frame; wall-clock FPS over the whole run is reported too.
 import queue as _queue
 writer_queue=_queue.Queue(maxsize=int(os.environ.get('PONG_DEFERRED_READBACK_DEPTH','2')));writer_error=[];writer_stats={'waitMs':[],'emitMs':[]}
 def writer_loop(encoder_target,encoder_stream):
  while True:
   item=writer_queue.get()
   if item is None:return
   pending,sample=item
   try:
    t0=time.perf_counter()
    result=pending.wait() if hasattr(pending,'wait') else pending
    t1=time.perf_counter()
    if result.shape[:2]!=(output_height,output_width):result=cv2.resize(result,(output_width,output_height),interpolation=cv2.INTER_LINEAR)
    if os.environ.get('PONG_AUDIT_PIXEL_HASH')=='1':sample['rgbSha256']=hashlib.sha256(np.ascontiguousarray(result).tobytes()).hexdigest()
    for packet in encoder_stream.encode(av.VideoFrame.from_ndarray(np.ascontiguousarray(result),format='rgb24')):encoder_target.mux(packet)
    writer_stats['waitMs'].append((t1-t0)*1000);writer_stats['emitMs'].append((time.perf_counter()-t1)*1000)
   except BaseException as exc:
    writer_error.append(exc)
   finally:
    if hasattr(pending,'release'):pending.release()
 report['renderStartedAt']=time.time()
 with av.open(str(source_path)) as source,av.open(report['file'],'w') as target:
  output=target.add_stream('libx264',rate=output_rate);output.width=output_width;output.height=output_height;output.pix_fmt='yuv420p';output.options={'crf':'12','preset':'ultrafast','threads':'2'}
  writer=threading.Thread(target=writer_loop,args=(target,output),name='perf-audit-writer',daemon=True);writer.start()
  for source_index,decoded in enumerate(source.decode(video=0)):
   if not stock and source_index%2:continue
   i=source_index if stock else source_index//2
   if i>=limit:break
   decode_started=time.perf_counter()
   frame=decoded.reformat(width=output_width,height=output_height,format='rgb24').to_ndarray();engine._vm._attachment_review_index=i
   decode_ms=(time.perf_counter()-decode_started)*1000
   wait_ms.update(sync=0.0,syncCalls=0,readback=0.0);cpu_started=time.process_time()
   started=time.perf_counter();result,count=engine._run_gpu_work(renderer.render,frame,work_label='attachment-qualification');elapsed=(time.perf_counter()-started)*1000
   if result is None:raise RuntimeError('No output frame')
   d=copy.deepcopy(getattr(session,'multi_face_decision',{}))
   counters={'reused':renderer.gpu_patch_reused,'tracked':renderer.tracked_frames,'corrections':renderer.correction_reused_frames,'rechecks':getattr(renderer.tracker,'identity_rechecked',0)}
   per_frame={'decodeMs':decode_ms,'gpuSyncWaitMs':wait_ms['sync'],'gpuSyncCalls':wait_ms['syncCalls'],'readbackMs':wait_ms['readback'],
    'processCpuMs':(time.process_time()-cpu_started)*1000,
    'reusedFaces':counters['reused']-previous_counters['reused'],'trackedFrame':counters['tracked']>previous_counters['tracked'],
    'correctionReuse':counters['corrections']>previous_counters['corrections'],'identityRechecks':counters['rechecks']-previous_counters['rechecks'],
    'freshFaces':max(0,count-(counters['reused']-previous_counters['reused'])),
    'gpenMode':d.get('gpenMode'),'qualityLevel':d.get('adaptiveQualityLevel'),'adaptiveReason':d.get('adaptiveReason')}
   previous_counters=counters
   per_frame['deferred']=bool(hasattr(result,'wait'))
   sample={'frame':i,'time':i/float(output_rate),'ms':elapsed,'rendered':count,'bindings':dict(renderer.assignments.sources),'positions':{k:v.tolist() for k,v in renderer.assignments.positions.items()},'detections':copy.deepcopy(observed),'diagnostics':d,'perFrame':per_frame}
   report['samples'].append(sample)
   if writer_error:raise writer_error[0]
   writer_queue.put((result,sample))
   if i%120==0:print(json.dumps({'label':label,'frame':i,'faces':count,'ms':round(elapsed,2)}),flush=True)
  writer_queue.put(None);writer.join(60)
  if writer_error:raise writer_error[0]
  for packet in output.encode():target.mux(packet)
 report['renderFinishedAt']=time.time()
 report['writer']={'waitMs':{'p50':float(np.median(writer_stats['waitMs'])) if writer_stats['waitMs'] else None,'p95':float(np.percentile(writer_stats['waitMs'],95)) if writer_stats['waitMs'] else None},'emitMs':{'p50':float(np.median(writer_stats['emitMs'])) if writer_stats['emitMs'] else None}}
 report['graphStatus']={'colorError':getattr(engine._vm,'color_match_graph_error',None),'colorKeys':len(getattr(engine._vm,'_color_match_graphs',{})),'colorReady':sum(v is not None for v in getattr(engine._vm,'_color_match_graphs',{}).values()),'restorers':engine._models.restorer_status()}
 times=[s['ms'] for s in report['samples']];warm=times[5:]
 report['wallFps']=(len(report['samples'])-5)/max(1e-6,(report['renderFinishedAt']-report['renderStartedAt'])-sum(times[:5])/1000.) if len(report['samples'])>5 else None
 report['freshBatch']={'calls':getattr(getattr(engine._vm,'_independent_swapper',None),'calls',0),'faces':getattr(engine._vm,'_independent_swapper_faces',0),'rejectedPackets':getattr(engine._vm,'_independent_swapper_packet_rejections',0),'error':getattr(engine._vm,'_independent_swapper_error',None),'tiledRecoveries':getattr(engine,'_tiled_recoveries',0)}
 report['freshBatch'].update(xsegCalls=getattr(getattr(engine._vm,'_fresh_xseg_batch',None),'calls',0),xsegFaces=getattr(engine._vm,'_fresh_xseg_faces',0),xsegError=getattr(engine._vm,'_fresh_xseg_batch_error',None),gpenFaces=getattr(engine._vm,'_fresh_gpen_faces',0),gpenError=getattr(engine._vm,'_fresh_gpen_batch_error',None))
 report['freshBatch'].update(fullRestorerGraphCalls=getattr(engine._vm,'_fresh_restorer_graph_calls',0),fullRestorerGraphError=getattr(engine._vm,'_fresh_restorer_graph_error',None),provenPolicySkips=getattr(renderer,'proven_policy_skips',0))
 report['fastPolicy']={str(k):{'error':getattr(v,'fast_policy_error',None),'calls':getattr(getattr(v,'fast_policy',None),'calls',0),'fallbacks':getattr(getattr(v,'fast_policy',None),'fallbacks',0)} for k,v in getattr(engine._presentation_classifier,'_graph_policies',{}).items()}
 report['summary']={'frames':len(times),'renderFps':1000*len(warm)/sum(warm),'p50Ms':float(np.median(warm)),'p95Ms':float(np.percentile(warm,95)),'noSwapFrames':[s['frame'] for s in report['samples'] if not s['rendered']],'bindings':dict(renderer.assignments.sources),'reused':renderer.gpu_patch_reused,'rejections':renderer.patch_rejections,'peakGpuAllocatedMiB':engine._torch.cuda.max_memory_allocated()/2**20}
 pf=[s['perFrame'] for s in report['samples'][5:]]
 fresh=[s for s in pf if s['reusedFaces']==0];reuse=[s for s in pf if s['reusedFaces']>0]
 def stats(rows,key):
  vals=[float(r[key]) for r in rows if isinstance(r.get(key),(int,float))]
  return {'n':len(vals),'p50':float(np.median(vals)) if vals else None,'p95':float(np.percentile(vals,95)) if vals else None,'mean':float(np.mean(vals)) if vals else None}
 frame_ms_fresh=[s['ms'] for s in report['samples'][5:] if s['perFrame']['reusedFaces']==0];frame_ms_reuse=[s['ms'] for s in report['samples'][5:] if s['perFrame']['reusedFaces']>0]
 report['summary'].update(faceEvents=int(sum(s['rendered'] for s in report['samples'])),
  freshFrames=len(fresh),reuseFrames=len(reuse),trackedFrames=sum(1 for s in pf if s['trackedFrame']),
  freshFrameMs={'p50':float(np.median(frame_ms_fresh)) if frame_ms_fresh else None,'p95':float(np.percentile(frame_ms_fresh,95)) if frame_ms_fresh else None},
  reuseFrameMs={'p50':float(np.median(frame_ms_reuse)) if frame_ms_reuse else None,'p95':float(np.percentile(frame_ms_reuse,95)) if frame_ms_reuse else None},
  gpuSyncWaitMs=stats(pf,'gpuSyncWaitMs'),readbackMs=stats(pf,'readbackMs'),processCpuMs=stats(pf,'processCpuMs'),decodeMs=stats(pf,'decodeMs'),
  gpenModes=sorted({str(s['gpenMode']) for s in pf}),qualityLevels=sorted({int(s['qualityLevel']) for s in pf if s['qualityLevel'] is not None}))
 print(json.dumps(report['summary']),flush=True)
 if 'cpu' in label:cpu.dump_stats(str(OUT/(label+'.prof')))
 if 'profile' in label:
  report['components']={k:{'count':len(v),'totalMs':sum(v),'p50Ms':float(np.median(v)),'p95Ms':float(np.percentile(v,95))} for k,v in measurements.items()}
  print(json.dumps(report['components']),flush=True)
finally:
 monitor_stop.set()
 if monitor is not None:monitor.join(2);pynvml.nvmlShutdown()
 try:(OUT/(label+'.json')).write_text(json.dumps(report,indent=2))
 finally:APPEARANCE.close();engine.unload();engine.shutdown_gpu_worker()
