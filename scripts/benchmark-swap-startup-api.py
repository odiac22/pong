"""Silent existing-service startup diagnostic, NOT Android display latency.

Uses attributed public stock inputs; never touches either live Recall queue.
Counts only transformed first-frame responses, not metadata or an original frame.
"""
import argparse
import hashlib
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE='http://127.0.0.1:8792'


def request(route, method='GET', body=None, timeout=20):
    req=urllib.request.Request(BASE+route, data=None if body is None else json.dumps(body).encode(),
        method=method, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as response:
        return json.load(response)


def digest(config):
    return hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',required=True);ap.add_argument('--limit',type=int,default=30)
    ap.add_argument('--face',default='Approved 3');args=ap.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(Path(r'E:\Pong Benchmarks\v3029-overnight\corpus\manifest.json').read_text())
    config=request('/settings')['config']
    if config['runtime'].get('swapAudioEnabled') is not False: raise RuntimeError('Silent service required')
    face=next(f for f in request('/faces')['faces'] if f['name']==args.face)
    report={'scope':'PC renderer transformed-preview response, real public sources; NOT browser/Android playback, buffering, or phone presentation',
            'silent':True,'createdAt':time.time(),'config':config,'configHash':digest(config),'faceId':face['id'],
            'serviceVersion':request('/health').get('serviceVersion'),'cases':[]}
    owned=None
    def save(): (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    try:
        for clip in manifest['clips'][:args.limit]:
            foreign=[s for s in request('/sessions')['sessions'] if not s.get('complete') and not s.get('playbackPaused')]
            if foreign:
                report['blocked']='Another active renderer owns the GPU; no unrelated session stopped';break
            source=clip.get('sourceVariant',{}).get('link')
            if not source: continue
            row={'clip':clip['ordinal'],'pageUrl':clip['pageUrl'],'sourceFps':clip['fps'],
                 'width':clip['width'],'height':clip['height'],'cachedSourceState':'not-controlled',
                 'passed':False,'previewTransformed':False}
            report['cases'].append(row)
            started=time.perf_counter()
            try:
                payload=request('/sessions','POST',{'channel':'test','sourceUrl':source,'faceId':face['id'],
                    'faceIds':[face['id']],'navigationClass':'foreground','prefetch':False,'prebufferSeconds':.5})
                owned=payload['session']['id'];row['registrationMs']=(time.perf_counter()-started)*1000
                deadline=started+18
                while time.perf_counter()<deadline:
                    session=request('/sessions/'+owned)['session'];row['session']=session
                    if session.get('firstTransformedFrameAt') and session.get('createdAt'):
                        row['rendererFirstTransformedMs']=(session['firstTransformedFrameAt']-session['createdAt'])*1000
                    if session.get('error'): raise RuntimeError(session['errorCode'] or session['error'])
                    if session.get('firstTransformedFrameAt'):
                        url=BASE+'/sessions/'+owned+'/first-frame?waitMs=100'
                        try:
                            with urllib.request.urlopen(url,timeout=3) as response:
                                data=response.read()
                                if response.headers.get('X-Pong-Swap-Transformed')=='1' and len(data)>12:
                                    row['previewTransformed']=True
                                    row['transformedPreviewResponseMs']=(time.perf_counter()-started)*1000
                                    row['passed']=row['transformedPreviewResponseMs']<1500
                                    break
                        except urllib.error.HTTPError as exc:
                            if exc.code!=425:raise
                    if session.get('complete'):break
                    time.sleep(.025)
                if not row['previewTransformed']:
                    row['failure']=('opening-frame-has-no-swap; later-frame-transformed' if session.get('firstTransformedFrameAt')
                                    else 'no-compatible-face-in-rendered-prefix')
            except Exception as exc:row['failure']=type(exc).__name__+': '+str(exc)[:180]
            finally:
                row['elapsedMs']=(time.perf_counter()-started)*1000
                if owned:
                    request('/sessions/'+owned,'DELETE');owned=None
                save()
                print(json.dumps({k:row.get(k) for k in ['clip','registrationMs','transformedPreviewResponseMs','passed','failure']}),flush=True)
        report['configUnchanged']=digest(request('/settings')['config'])==report['configHash']
        report['passedCases']=sum(r['passed'] for r in report['cases'])
    finally:
        if owned:request('/sessions/'+owned,'DELETE')
        save()


if __name__=='__main__':main()
