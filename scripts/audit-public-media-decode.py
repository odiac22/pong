"""Silent packet/decode verification; never opens an audio output device."""
import argparse
import json
import time
import av
from urllib.parse import quote

parser=argparse.ArgumentParser()
parser.add_argument('url')
parser.add_argument('--proxy')
args=parser.parse_args()
urls=[args.url]
if args.proxy:urls.append(args.proxy+'/proxy?url='+quote(args.url,safe=''))
for url in urls:
    started=time.perf_counter();frames=0;container=None
    result={'source':url,'silent':True}
    try:
        container=av.open(url,timeout=(10,10))
        for frame in container.decode(video=0):
            frames+=1
            result['lastFrameSeconds']=float(frame.time or 0)
        result['status']='decoded-to-eof'
    except Exception as error:result['error']=str(error)
    finally:
        if container:container.close()
    result.update(frames=frames,seconds=round(time.perf_counter()-started,3))
    print(json.dumps(result),flush=True)
