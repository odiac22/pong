"""Actual Firefox metadata + production Send, local generated silent fixtures only.

GM transport uses real local HTTP; receipt is an isolated test receiver, NOT live Pong.
No player playback, remote pages, browser windows or audio.
"""
import json
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

OUT = ROOT / 'artifacts' / 'quality-selection-7.21.0'
MEDIA = OUT / 'assets' / 'one'
MEDIA.mkdir(parents=True, exist_ok=True)
for name, size in [('a', '640x360'), ('b', '1280x720'), ('c', '1920x1080')]:
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    f'color=c=navy:s={size}:r=24', '-t', '2', '-an', '-c:v', 'libx264',
                    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    str(MEDIA / f'{name}.mp4')], check=True, capture_output=True)

posts = []
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/watch/one':
            base = f'http://127.0.0.1:{self.server.server_port}'
            html = f'''<title>Inert quality fixture</title>
              <script type="application/ld+json">{{"@type":"VideoObject","url":"{base}/watch/one",
              "contentUrl":"{base}/assets/one/a.mp4","duration":"PT2S","name":"Local fixture"}}</script>
              <video muted preload="metadata" width="320" height="180" src="{base}/assets/one/b.mp4"></video>
              <script type="application/json">{{"sources":[{{"src":"{base}/assets/one/a.mp4","label":"2160p"}},
              {{"src":"{base}/assets/one/b.mp4","label":"720p"}},{{"src":"{base}/assets/one/c.mp4","label":"360p"}}]}}</script>'''
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
            self.wfile.write(html.encode()); return
        super().do_GET()
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        posts.append(payload)
        body = json.dumps({'ok': True, 'accepted': len(payload.get('entries', [])),
                           'videos': sum(len(p.get('entries', [])) for p in posts),
                           'capabilities': {'independentVideoIdentity': True}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(OUT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options(); options.add_argument('-headless'); options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0'); options.set_preference('media.autoplay.default', 5)
driver = webdriver.Firefox(options=options)
driver.set_window_size(850, 900)
checks = []
def js(code, *args): return driver.execute_script(code, *args)
def check(condition, label):
    assert condition, label
    checks.append(label)
try:
    driver.get(f'http://127.0.0.1:{server.server_port}/watch/one')
    WebDriverWait(driver, 10).until(lambda _: js('return document.querySelector("video").videoHeight===720'))
    js('''
      window.store={};window.playCalls=0;
      HTMLMediaElement.prototype.play=function(){playCalls++;throw Error('Playback forbidden');};
      window.GM_getValue=(k,v)=>k in store?store[k]:v;window.GM_setValue=(k,v)=>store[k]=v;
      window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};window.GM_setClipboard=s=>window.copied=s;
      window.PONG_LOCAL_ENDPOINTS=[location.origin];
      window.GM_xmlhttpRequest=o=>{
        const x=new XMLHttpRequest();x.open(o.method,o.url);x.timeout=o.timeout||0;
        if(o.responseType)x.responseType=o.responseType;
        for(const [k,v]of Object.entries(o.headers||{}))if(k.toLowerCase()!=='referer')x.setRequestHeader(k,v);
        const response=()=>({status:x.status,responseHeaders:x.getAllResponseHeaders(),finalUrl:x.responseURL,
          response:x.response,responseText:x.responseType==='arraybuffer'?'':x.responseText});
        x.onload=()=>o.onload?.(response());x.onerror=()=>o.onerror?.({});x.ontimeout=()=>o.ontimeout?.();
        x.onabort=()=>o.onabort?.();x.send(o.data||null);return{abort:()=>x.abort()};
      };
    ''')
    js((ROOT / 'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    extracted = js('return UniversalVideoScraper.primaryMediaEntriesFromDoc(document,location.href)')
    check(len(extracted) == 3, 'Structured VideoObject retains three same-asset renditions')
    live = next(e for e in extracted if e['videoUrl'].endswith('/b.mp4'))
    check(live['width'] == 1280 and live['height'] == 720 and live['qualityEvidence'] == 'live_decoder', 'Early metadata path preserves actual browser 720p')
    js("document.querySelector('#uvs-recall-open').click()")
    shadow = driver.find_element('id', 'uvs-target-preview').shadow_root
    shadow.find_element('css selector', '.boxes button').click()
    start = time.perf_counter()
    shadow.find_element('css selector', '[data-do=send]').click()
    WebDriverWait(driver, 15).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('1/1 sent')"))
    elapsed = round((time.perf_counter() - start) * 1000)
    appended = [e for p in posts if p.get('capturePhase') == 'append' for e in p.get('entries', [])]
    check(len(appended) == 1 and appended[0]['videoUrl'].endswith('/c.mp4'), 'Real metadata selects 1080p despite default 360p and misleading 2160p label')
    check(appended[0]['height'] == 1080, 'Selected dimensions survive production Send payload')
    shadow.find_element('css selector', '[data-do=copy]').click()
    report = js('return JSON.parse(copied)')
    selected = next(c for c in report['candidates'] if c['selected'])
    quality = selected['attempts'][0]['qualitySelection']
    check(quality['selected']['height'] == 1080 and quality['selected']['evidence'] == 'metadata_decoder', 'Copied log shows measured selected quality')
    check(quality['browser']['height'] == 720 and quality['unresolvedQualityCount'] == 0, 'Copied log compares browser quality without unknown variants')
    quality_requests = [r for r in selected['attempts'][0]['requests'] if r['phase'] == 'quality_probe']
    check(len(quality_requests) == 2 and all(r['state'] == 'complete' for r in quality_requests), 'Only two alternate renditions require new decoder metadata')
    check('127.0.0.1' not in json.dumps(report) and '/assets/' not in json.dumps(report), 'Diagnostic report excludes page and source addresses')
    check(js('return playCalls===0 && document.querySelector("video").paused && document.querySelector("video").currentTime===0'), 'No playback and no audio')
    # An unrelated ad/recommendation outside the authoritative asset directory
    # must not get promoted just because it advertises a larger resolution.
    identity = js('''const d=new DOMParser().parseFromString(document.documentElement.outerHTML,'text/html');
      const a=d.createElement('script');a.type='application/json';a.textContent=JSON.stringify({sources:[{src:location.origin+'/assets/other/huge.mp4',label:'4320p'}]});d.body.appendChild(a);
      return UniversalVideoScraper.primaryMediaEntriesFromDoc(d,location.href).map(e=>e.videoUrl);''')
    check(not any('other' in url for url in identity), 'Higher-resolution unrelated asset excluded by identity guard')
    (OUT / 'report.json').write_text(json.dumps({'version': '7.21.0', 'fixtureSendMs': elapsed,
        'scope': 'real Firefox metadata, generated local silent media, isolated receiver; not live Pong or remote-site validation',
        'checks': checks, 'diagnostics': report}, indent=2), encoding='utf-8')
    print(json.dumps({'passed': len(checks), 'fixtureSendMs': elapsed, 'report': str(OUT / 'report.json')}))
finally:
    driver.quit(); server.shutdown(); server.server_close()
