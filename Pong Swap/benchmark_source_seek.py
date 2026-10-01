"""Silent synthetic HTTP baseline/standby comparison; no faces or audio."""
import functools
import hashlib
import json
import statistics
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import av
from pong_swap_source_pool import StandbySourcePool


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        # Explicit simulated HTTP response latency, not claimed as phone timing.
        time.sleep(.15)
        return super().do_GET()


def probe(container, target):
    stream=container.streams.video[0]
    container.seek(int(target/float(stream.time_base)),stream=stream,backward=True,any_frame=False)
    hashes=[]
    for frame in container.decode(stream):
        if float(frame.pts*stream.time_base) + 1/float(stream.average_rate) < target:
            continue
        hashes.append(hashlib.sha256(frame.to_ndarray(format='rgb24').tobytes()).hexdigest())
        if len(hashes)==3:break
    assert len(hashes)==3
    return hashes, [stream.codec_context.width,stream.codec_context.height],float(stream.average_rate)


results=[]
with tempfile.TemporaryDirectory(prefix='pong-seek-pool-') as temporary:
    root=Path(temporary)
    for fps in (24,30,60):
        directory=root/str(fps);directory.mkdir()
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i',f'testsrc2=size=640x360:rate={fps}',
          '-t','8','-an','-c:v','libx264','-preset','ultrafast','-g',str(fps),'-pix_fmt','yuv420p',
          '-f','hls','-hls_time','1','-hls_list_size','0','index.m3u8'],cwd=directory,check=True,capture_output=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=root))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    pool=StandbySourcePool()
    try:
        for fps in (24,30,60):
            url=f'http://127.0.0.1:{server.server_port}/{fps}/index.m3u8'
            for offset in (2.,4.,6.):
                start=time.perf_counter()
                with av.open(url,timeout=(10.,5.)) as c:
                    expected,dimensions,measured_fps=probe(c,offset)
                cold=(time.perf_counter()-start)*1000
                warm_start=time.perf_counter();assert pool.warm(url)
                while pool.status()['ready']==0 and time.perf_counter()-warm_start<10:time.sleep(.01)
                warm_ms=(time.perf_counter()-warm_start)*1000
                start=time.perf_counter();c=pool.take(url);assert c is not None
                try:actual,after_dimensions,after_fps=probe(c,offset)
                finally:c.close()
                optimized=(time.perf_counter()-start)*1000
                assert actual==expected and dimensions==after_dimensions and measured_fps==after_fps
                result=dict(fps=fps,offset=offset,coldMs=round(cold,2),standbySeekMs=round(optimized,2),
                    warmPreparationMs=round(warm_ms,2),speedup=round(cold/optimized,2),identicalDecodedFrames=True)
                results.append(result);print(json.dumps(result),flush=True)
    finally:
        pool.clear();server.shutdown();server.server_close()
report=dict(scope='synthetic HLS transport only, 150ms response delay; not Android or full face-swap latency',
    silent=True,runs=results,medianColdMs=statistics.median(r['coldMs'] for r in results),
    medianStandbyMs=statistics.median(r['standbySeekMs'] for r in results))
output=Path(__file__).resolve().parents[1]/'artifacts'/'scrub-30.17'
output.mkdir(parents=True,exist_ok=True)
(output/'synthetic-seek.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='runs'}))
