"""Inert, synthetic DOM fixtures: no remote pages, media playback, or live Recall."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

OUT = Path('E:/Pong Benchmarks/v3018-player-recognition')
OUT.mkdir(parents=True, exist_ok=True)
MEDIA = 'https://media.invalid/fixture.mp4'
BASE = 'https://fixture.invalid/watch/example'
CASES = [
    ('Native HTML5', f'<video preload="none" src="{MEDIA}"></video>'),
    ('Video.js-style HTML5 markup', f'<video class="video-js" preload="none"><source src="{MEDIA}" type="video/mp4"></video>'),
    ('Plyr-style HTML5 markup', f'<video id="player" preload="none"><source src="{MEDIA}" type="video/mp4"></video>'),
    ('JW Player-style literal config', f'<script>jwplayer("player").setup({{sources:[{{file:"{MEDIA}"}}]}})</script>'),
    ('Playerjs labelled renditions', '<script>new Playerjs({file:"[360p]https://media.invalid/low.mp4,[1080p]https://media.invalid/high.mp4"})</script>'),
    ('KVS-style literal config', f'<script>var flashvars={{video_url:"{MEDIA}",video_alt_url:"https://media.invalid/fixture_1080p.mp4"}}</script>'),
    ('JSON-LD VideoObject', '<script type="application/ld+json">'+json.dumps({'@type':'VideoObject','name':'Synthetic example','contentUrl':MEDIA,'duration':'PT45S'})+'</script>'),
    ('HLS literal source', '<video preload="none"><source src="https://media.invalid/master.m3u8" type="application/vnd.apple.mpegurl"></video>'),
    ('DASH literal source', '<video preload="none"><source src="https://media.invalid/manifest.mpd" type="application/dash+xml"></video>'),
    ('Extensionless MP4 endpoint', '<video preload="none"><source src="https://media.invalid/content?id=123" type="video/mp4"></video>'),
    ('Blob-only player', '<video src="blob:https://fixture.invalid/fixture"></video>'),
    ('Iframe wrapper', '<div class="player"><iframe src="https://embed.invalid/embed/fixture"></iframe></div>'),
    ('Two independent videos', f'<video src="{MEDIA}"></video><video src="https://media.invalid/second.mp4"></video>'),
    ('Direct video on an ordinary article URL', f'<video src="{MEDIA}"></video>'),
    ('JW rendition labels outrank live low source', '<video src="https://media.invalid/low.mp4"></video><script>jwplayer("x").setup({sources:[{file:"https://media.invalid/high.mp4",label:"1080p"},{file:"https://media.invalid/low.mp4",label:"360p"}]})</script>'),
    ('Advertising file is not a main source', '<script>jwplayer("x").setup({advertising:{file:"https://media.invalid/ad.mp4"},image:"https://media.invalid/poster.jpg"})</script>'),
    ('Player code is never executed', '<script>jwplayer("x").setup({sources:[{file:stealSecrets()}]})</script>'),
    ('Signed extensionless source is preserved', '<video><source src="https://media.invalid/get?token=a%2Fb&amp;expires=999" type="video/mp4"></video>'),
    ('Video.js extensionless sources array', '<script>videojs("v").src({sources:[{src:"https://media.invalid/stream?id=videojs",type:"video/mp4",label:"720p"}]})</script>'),
    ('MediaDefinitions highest rendition', '<script>window.player={mediaDefinitions:[{videoUrl:"https://media.invalid/low.mp4",quality:"360p"},{videoUrl:"https://media.invalid/high.mp4",quality:"1080p"}]}</script>'),
    ('Files array signed extensionless MP4', '<script>window.cfg={files:[{url:"https://media.invalid/download?id=abc&sig=123",type:"video/mp4",height:1080}]}</script>'),
    ('Qualities array HLS over progressive fallback', '<script>window.cfg={qualities:[{url:"https://media.invalid/fallback.mp4",quality:"480p"},{url:"https://media.invalid/master.m3u8",quality:"1080p"}]}</script>'),
]
options = Options()
options.add_argument('-headless')
options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0')
options.set_preference('media.autoplay.default', 5)
options.set_preference('permissions.default.image', 2)
driver = webdriver.Firefox(options=options)
report = {'scope':'Synthetic inert DOM recognition only. Player libraries are not loaded. No external sites, real media, live Pong handoff, or playback tested.',
          'version':'7.18.0','silent':True,'headless':True,'cases':[]}
try:
    driver.get('about:blank')
    driver.execute_script('window.GM_getValue=(_key,value)=>value;window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>{};window.GM_xmlhttpRequest=()=>{throw Error("Network disabled in recognition audit")};')
    driver.execute_script((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    for name, markup in CASES:
        page = 'https://fixture.invalid/news/studio-feature' if name.endswith('article URL') else BASE
        result = driver.execute_script('''
          const markup=arguments[0], page=arguments[1];
          const doc=new DOMParser().parseFromString('<html><head><base href="'+page+'"><meta itemprop="duration" content="PT45S"></head><body>'+markup+'</body></html>','text/html');
          doc.__uvsRawHtml=markup;doc.__uvsUrl=page;
          const api=window.UniversalVideoScraper;
          return {entries:api.primaryMediaEntriesFromDoc(doc,page),targets:api.collectLogicalWatchPageTargets(doc,page,80),groups:api.independentVideoGroupsFromDoc(doc,page)};
        ''', markup, page)
        report['cases'].append({'name':name,**result})
    expected=[1,1,1,1,2,2,1,1,1,1,0,0,2,1,2,0,0,1,1,2,1,2]
    for row,count in zip(report['cases'],expected):
        assert len(row['entries'])==count, row['name']
    assert len(report['cases'][12]['targets'])==2
    assert len(report['cases'][13]['targets'])==1
    assert report['cases'][14]['entries'][0]['videoUrl']=='https://media.invalid/high.mp4'
    assert report['cases'][17]['entries'][0]['videoUrl']=='https://media.invalid/get?token=a%2Fb&expires=999'
    assert report['cases'][18]['entries'][0]['videoUrl']=='https://media.invalid/stream?id=videojs'
    assert report['cases'][19]['entries'][0]['videoUrl']=='https://media.invalid/high.mp4'
    assert report['cases'][20]['entries'][0]['videoUrl']=='https://media.invalid/download?id=abc&sig=123'
    assert report['cases'][21]['entries'][0]['videoUrl']=='https://media.invalid/master.m3u8'
    class FixtureHandler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type','text/html')
            self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(b'<title>Two synthetic sources</title><video preload="none" data-duration="45" src="https://media.invalid/one.mp4" title="One"></video><video preload="none" data-duration="45" src="https://media.invalid/two.mp4" title="Two"></video>')
    fixture_server=ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)
    threading.Thread(target=fixture_server.serve_forever,daemon=True).start()
    try:
        driver.get(f'http://127.0.0.1:{fixture_server.server_port}/news/example')
        driver.execute_script('''
          window.GM_getValue=(_key,value)=>value;window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>{};
          window.PONG_LOCAL_ENDPOINTS=['http://capture.invalid'];window.fixturePosts=[];window.fixtureVideos=new Map();
          HTMLMediaElement.prototype.play=function(){throw Error('Playback forbidden in this audit');};
          window.GM_xmlhttpRequest=options=>{
            if(options.method==='POST' && options.url==='http://capture.invalid/media-page/recall'){
              const body=JSON.parse(options.data);fixturePosts.push(body);
              for(const entry of body.entries||[])fixtureVideos.set(entry.logicalVideoId||entry.pageUrl,entry);
              queueMicrotask(()=>options.onload({status:200,responseText:JSON.stringify({ok:true,videos:fixtureVideos.size,capabilities:{independentVideoIdentity:true}})}));
            } else if(options.method==='GET' && options.url.startsWith('https://media.invalid/')) {
              queueMicrotask(()=>options.onload({status:206,responseHeaders:'Content-Type: video/mp4'}));
            } else throw Error('Unexpected network request: '+options.method+' '+options.url);
            return {abort(){}};
          };
        ''')
        driver.execute_script((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
        driver.set_script_timeout(15)
        handoff=driver.execute_async_script('''
          const done=arguments[arguments.length-1];
          window.UniversalVideoScraper.sendCaptureToRecall('all',1,true).then(result=>done({result,posts:fixturePosts,entries:[...fixtureVideos.values()]})).catch(error=>done({error:String(error)}));
        ''')
        assert 'error' not in handoff,handoff
        assert len(handoff['entries'])==2,handoff
        assert [entry['title'] for entry in handoff['entries']]==['One','Two'],handoff
        assert [entry['logicalVideoId'] for entry in handoff['entries']]==['inline-video-1','inline-video-2'],handoff
        report['simulatedHandoff']=handoff
    finally:
        fixture_server.shutdown();fixture_server.server_close()
    lines = ['# Userscript player-recognition audit','',report['scope'],'',
             '| Synthetic pattern | Direct media candidates | All-mode page targets |',
             '|---|---:|---:|']
    lines += [f"| {row['name']} | {len(row['entries'])} | {len(row['targets'])} |" for row in report['cases']]
    lines += ['', 'The full userscript All capture completed against a simulated GM request adapter: start, two independently titled/identified append entries, then complete. No HTTP media requests or live Pong handoff occurred. Browser media loading was blocked by CSP and play() was disabled.', '', 'These counts measure extraction only. Multiple renditions are not necessarily distinct videos. Iframe-only pages require a separate fetch; this inert test does not perform it. A blob URL needs its original manifest or media requests. No claim is made about the player technology used by any unvisited website. DASH detection does not establish Pong/browser playback support.', '', '[Detailed evidence](report.json)', '']
    (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    (OUT/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps({'report':str(OUT/'REPORT.md'),'cases':[{'name':c['name'],'media':len(c['entries']),'allTargets':len(c['targets'])} for c in report['cases']]}),flush=True)
finally:
    driver.quit()
