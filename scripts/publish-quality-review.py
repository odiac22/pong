"""Validate every output frame and publish immutable, silent review files."""
import argparse
import hashlib
import json
from pathlib import Path
import os
import av

ROOT=Path('E:/Pong Benchmarks/user-quality-review-2026-09-30')
TESTS=['GPEN1024 TensorRT tuning','GPEN1024 selective FP16','GPU decoding','GPU-resident frame pipeline','CPU/GPU overlap','Next-video preparation and cancellation','Cold versus warm starts','First-frame delivery','Temporal reuse and tracking','GPEN512 / adaptive restoration','GFPGAN and GPEN256','Alternative swappers and trained renderers','Prefetch batching','Face-only streaming']
EXCLUDED={11,12}
def verify(path,expected):
 with av.open(str(path)) as c:
  if c.streams.audio: raise ValueError('Review files must have no audio')
  stream=c.streams.video[0];pts=[]
  for f in c.decode(video=0):
   if f.width!=expected['width'] or f.height!=expected['height']:raise ValueError('Unexpected dimensions')
   pts.append(float(f.time))
  if len(pts)!=expected['frames'] or any(b<=a for a,b in zip(pts,pts[1:])):raise ValueError('Frame count or PTS mismatch')
  return {'frames':len(pts),'width':stream.width,'height':stream.height,'fps':float(stream.average_rate),'firstPts':pts[0],'lastPts':pts[-1],'audio':False}
def main():
 p=argparse.ArgumentParser();p.add_argument('report',type=Path);p.add_argument('--baseline',action='store_true');p.add_argument('--before-report',type=Path);p.add_argument('--id',required=True);p.add_argument('--name',required=True);p.add_argument('--test',type=int,choices=range(1,15));p.add_argument('--phase',choices=['initial','refined','validation'],default='initial');p.add_argument('--description',default='');args=p.parse_args()
 if args.test in EXCLUDED:raise ValueError('Tests 11 and 12 were excluded by the user')
 r=json.loads(args.report.read_text(encoding='utf-8'))
 if not r.get('completed') or not r.get('savedPresetUnchanged') or r.get('faceId')!='approved-8-f7bf754ac81f' or len(r['clips'])!=5:raise ValueError('A completed Approved 8 five-clip report is required')
 m=json.loads((ROOT/'gallery.json').read_text(encoding='utf-8'));entries=[]
 before=None
 if args.before_report:
  before=json.loads(args.before_report.read_text(encoding='utf-8'))
  if args.baseline or not before.get('completed') or not before.get('savedPresetUnchanged') or before.get('faceId')!=r['faceId'] or before.get('restorer')!='GPEN1024' or len(before['clips'])!=5:raise ValueError('Fresh matched GPEN1024 baseline is required')
  if before.get('diagnosticsEnabled',False)!=r.get('diagnosticsEnabled',False):raise ValueError('Do not compare profiled and unprofiled timing')
  if before.get('faceSourceHashes')!=r.get('faceSourceHashes'):raise ValueError('Approved face bytes differ')
 for row in r['clips']:
  path=Path(row['file']).resolve(strict=True)
  if not path.is_relative_to(ROOT):raise ValueError('Output outside review root')
  if hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Output changed since benchmark')
  verified=verify(path,row['final']);metrics={k:row[k] for k in ['firstEncodedByteMs','renderWorkFps','endToEndProducerFps','wallSeconds']}
  metrics.update({'frames':row['final']['frames'],'transformedFrames':row['final']['transformedFrames'],'reusedFrames':row['final']['temporalReuseFrames']})
  entries.append({'clip':row['clip'],'file':str(path),'sha256':row['sha256'],'sourceSha256':row['sourceSha256'],'metrics':metrics,'integrity':verified})
  if before:
   b=next(b for b in before['clips'] if b['clip']==row['clip']);bp=Path(b['file']).resolve(strict=True)
   if not bp.is_relative_to(ROOT) or b['sourceSha256']!=row['sourceSha256'] or digest_file(bp)!=b['sha256']:raise ValueError('Before file or source mismatch')
   integrity=verify(bp,b['final'])
   if any(integrity[k]!=verified[k] for k in ['frames','width','height','fps']):raise ValueError('Before/after cadence or dimensions differ')
   entries[-1]['before']={'file':str(bp),'sha256':b['sha256'],'metrics':{k:b[k] for k in ['firstEncodedByteMs','renderWorkFps','endToEndProducerFps','wallSeconds']},'integrity':integrity}
 if args.baseline:
  if m.get('baselineId') and m['baselineId']!=args.id and m['candidates']:raise ValueError('Existing comparisons must not be silently rebound to another baseline')
  m['legacyBaseline']={k:m.get(k) for k in ['faceId','baselineFaceName','clips']} if not m.get('baselineId') else m.get('legacyBaseline')
  m.update(faceId=r['faceId'],faceName='Approved 8',baselineFaceName='Approved 8 · GPEN1024',baselineId=args.id,pendingFaceChoice=False)
  for row in entries:
   c=next(c for c in m['clips'] if c['id']==row['clip']);c.update(baseline=row['file'],sha256=row['sha256'],sourceSha256=row['sourceSha256'],metrics=row['metrics'],integrity=row['integrity'])
 else:
  if not m.get('baselineId'):raise ValueError('Publish matched baseline first')
  if any(c['id']==args.id for c in m['candidates']):raise ValueError('Immutable candidate id already exists')
  for row in entries:
   c=next(c for c in m['clips'] if c['id']==row['clip'])
   if c['sourceSha256']!=row['sourceSha256']:raise ValueError('Source mismatch')
  m['candidates'].append({'id':args.id,'name':args.name,'description':args.description,'test':args.test,'phase':args.phase,'baselineId':args.before_report.parent.name if before else m['baselineId'],'restorer':r['restorer'],'clips':entries})
 m['note']='Approved 8 throughout. GPEN1024 is the main baseline. Score before and after separately; your ratings are saved on this PC. Nothing is automatically promoted.'
 for f in m['faces']:f['selected']=f['id']==r['faceId']
 if not m.get('tests'):m['tests']=[{'number':i+1,'name':name,'status':'Pending','summary':''} for i,name in enumerate(TESTS)]
 if args.test:
  t=next(t for t in m['tests'] if t['number']==args.test);t['status']={'initial':'Initial comparison available · refinement and matched reruns pending','refined':'Refined comparison available · independent validation pending','validation':'Matched validation available · awaiting your quality decision'}[args.phase];t['summary']=args.description
  t.setdefault('runs',[]).append({'id':args.id,'phase':args.phase,'before':args.before_report.parent.name if before else m['baselineId']})
 for t in m['tests']:
  if t['number'] in EXCLUDED:t.update(status='Excluded by your request',summary='Not being tested or implemented.')
 temporary=ROOT/'gallery.json.next';temporary.write_text(json.dumps(m,indent=2),encoding='utf-8');os.replace(temporary,ROOT/'gallery.json')
 print(json.dumps({'published':args.id,'clips':len(entries),'baseline':args.baseline,'silent':True,'verifiedAllFrames':True}))
def digest_file(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
if __name__=='__main__':main()
