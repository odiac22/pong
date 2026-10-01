"""Silent headless Firefox UI test on local inert fixtures; no media playback."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

MOBILE = '--mobile' in sys.argv
OUT = ROOT / 'artifacts' / ('target-selection-7.18.1-mobile' if MOBILE else 'target-selection-7.18.1')
OUT.mkdir(parents=True, exist_ok=True)

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'")
        self.end_headers()
        self.wfile.write(b'''<title>Selection fixture</title><style>body{margin:30px;background:#ddd}video{display:block;width:320px;height:180px;background:#444;margin-bottom:20px}a{display:block;width:200px;height:70px}#space{height:900px}</style>
          <video preload="none" data-duration="45" src="https://media.invalid/one.mp4?token=SECRET" title="One"></video>
          <video preload="none" data-duration="65" src="https://media.invalid/two.mp4?token=SECRET" title="Two"></video>
          <a href="/watch/third?token=SECRET">Video card</a><div id="space"></div>''')

server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options()
options.add_argument('-headless'); options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0')
options.set_preference('media.autoplay.default', 5)
driver = webdriver.Firefox(options=options)
driver.set_window_size(500, 1000) if MOBILE else driver.set_window_size(850, 900)
checks = []

def js(code, *args): return driver.execute_script(code, *args)
def click(selector): driver.find_element('id', 'uvs-target-preview').shadow_root.find_element('css selector', selector).click()
def check(condition, label):
    assert condition, label
    checks.append(label)

try:
    driver.get(f'http://127.0.0.1:{server.server_port}/news/fixture')
    if MOBILE:
        # A nested browsing context gives an exact CSS viewport despite
        # Firefox's minimum desktop window width. This is not Android emulation.
        js("document.body.innerHTML='';document.body.style.margin='0';const f=document.createElement('iframe');f.id='phone-fixture';f.style.cssText='width:390px;height:844px;border:0';f.src=location.href;document.body.appendChild(f)")
        driver.switch_to.frame(driver.find_element('id', 'phone-fixture'))
        WebDriverWait(driver, 5).until(lambda _: js('return document.querySelectorAll("video").length===2'))
    js('''
      window.store={};window.posts=[];window.reports=[];window.probes=[];window.pageFixtures={};window.fetchedPages=[];
      window.GM_getValue=(key,value)=>key in store?store[key]:value;window.GM_setValue=(key,value)=>store[key]=value;
      window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};
      window.PONG_LOCAL_ENDPOINTS=['http://capture.invalid'];
      HTMLMediaElement.prototype.play=function(){throw Error('Playback forbidden');};
      window.GM_xmlhttpRequest=options=>{
        const respond=(body,status=200)=>queueMicrotask(()=>options.onload({status,responseText:JSON.stringify(body)}));
        if(options.url.endsWith('/media-page/detection-feedback')) {
          if(window.failReport)respond({ok:false},503);
          else{reports.push(JSON.parse(options.data));respond({ok:true,saved:true});}
        }else if(options.method==='POST' && options.url.endsWith('/media-page/recall')){
          const body=JSON.parse(options.data);posts.push(body);
          if(window.failAppend && body.capturePhase==='append')respond({ok:false,error:'Simulated failure'},400);
          else respond({ok:true,videos:posts.filter(p=>p.capturePhase==='append' && p.entries?.length).length,capabilities:{independentVideoIdentity:true}});
        }else if(options.method==='GET' && pageFixtures[options.url]){
          fetchedPages.push(options.url);queueMicrotask(()=>options.onload({status:200,responseText:pageFixtures[options.url]}));
        }else if(options.method==='GET' && options.url.startsWith('https://media.invalid/')){
          probes.push(options.url);queueMicrotask(()=>options.onload({status:206,responseHeaders:'Content-Type: video/mp4'}));
        }else throw Error('Unexpected request '+options.url);
        return {abort(){}};
      };
    ''')
    js((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    js("document.querySelector('#uvs-recall-open').click();document.querySelector('[data-action=all]').click()")
    viewport = js('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio}')
    if MOBILE:
        check(viewport['width'] <= 430, 'Actual CSS viewport is phone width')
        check(js("const r=document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.bar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth"), 'Selection toolbar fits the phone viewport')
    check(js("return !!document.querySelector('#uvs-target-preview')"), 'All button opens preview')
    check(js('return posts.length===0 && probes.length===0'), 'Preview does not capture or probe')
    check(js("return UniversalVideoScraper.collectSelectableTargets('all').length===3"), 'Native players and linked card recognized together')
    click('.boxes [data-target="1"]'); click('.boxes [data-target="2"]')
    check(js("return [...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.boxes button')].filter(b=>b.getAttribute('aria-pressed')==='true').length===2"), 'Multiple boxes independently check')
    click('.boxes [data-target="1"]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.boxes [data-target="+'"1"'+"]').getAttribute('aria-pressed')==='false'"), 'Second tap unchecks a target')
    if MOBILE:
        driver.switch_to.default_content()
        driver.find_element('id', 'phone-fixture').screenshot(str(OUT/'selection.png'))
        driver.switch_to.frame(driver.find_element('id', 'phone-fixture'))
    else:
        driver.save_screenshot(str(OUT/'selection.png'))
    js('window.scrollTo(0,150)')
    WebDriverWait(driver, 5).until(lambda _: js("const s=document.querySelector('#uvs-target-preview').shadowRoot;return Math.abs(parseFloat(s.querySelector('.boxes [data-target="+'"2"'+"]').style.top)-document.querySelectorAll('video')[1].getBoundingClientRect().top)<2"))
    checks.append('Boxes follow page scrolling')
    click('[data-do="send"]')
    WebDriverWait(driver, 20).until(lambda _: js('return reports.length>0'))
    captured = js('return posts.filter(p=>p.capturePhase==="append").flatMap(p=>p.entries)')
    check(len(captured)==1 and captured[0]['logicalVideoId']=='inline-video-2', 'Only selected second video delivered with its own identity')
    report = js('return reports[0]')
    check('SECRET' not in json.dumps(report) and 'media.invalid' not in json.dumps(report), 'Report excludes tokens and media URLs')
    check(report['candidates'][1]['outcome']=='sent' and report['candidates'][0]['outcome']=='not_checked', 'Report distinguishes selected delivery from unselected targets')
    check(js('return location.pathname==="/news/fixture"'), 'Selection never navigates the page')
    click('[data-do="close"]')
    check(js("return !document.querySelector('#uvs-target-preview')"), 'Close removes overlay')
    js("UniversalVideoScraper.openTargetPreview('main',1,true)")
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.boxes button').length===1"), 'Main mode exposes one target')
    js('window.failReport=true')
    click('[data-do="report"]')
    WebDriverWait(driver, 10).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('Retry report')"))
    check(js('return Object.values(store).some(v=>{try{return JSON.parse(v)?.schema===1}catch{return false}})'), 'Failed report remains in local storage')
    js('window.failReport=false')
    click('[data-do="retry"]')
    WebDriverWait(driver, 5).until(lambda _: js('return reports.length===2'))
    checks.append('Retry uploads the pending report')
    click('[data-do="close"]')
    js("window.failAppend=true;UniversalVideoScraper.openTargetPreview('all',1,true)")
    click('.list [data-target="1"]'); click('[data-do="send"]')
    WebDriverWait(driver, 20).until(lambda _: js('return reports.length===3'))
    check(js("return reports[2].candidates[0].outcome==='delivery_failed'"), 'A failed append never claims delivery')
    click('[data-do="close"]')
    js("window.failAppend=false;UniversalVideoScraper.openTargetPreview('all',1,true)")
    click('.list [data-target="1"]')
    js('document.querySelector("video").remove()')
    click('[data-do="send"]')
    WebDriverWait(driver, 10).until(lambda _: js('return reports.length===4'))
    check(js("return reports[3].candidates[0].failure==='extraction_error'"), 'Detached selected player cannot silently capture a different player')
    click('[data-do="close"]')
    js("document.querySelectorAll('video,a').forEach(el=>el.remove());UniversalVideoScraper.openTargetPreview('all',1,true)")
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').disabled"), 'No-target state cannot send')
    click('[data-do="close"]')
    js('''document.body.insertAdjacentHTML('afterbegin','<div class="player"><iframe src="https://embed.invalid/embed/one"></iframe><iframe src="https://embed.invalid/embed/two"></iframe></div>');UniversalVideoScraper.openTargetPreview('all',1,true)''')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.boxes button').length===2"), 'Independent embedded players have separate selectable boxes')
    click('[data-do="close"]')
    js('''
      document.querySelectorAll('.player,#space').forEach(el=>el.remove());
      document.body.insertAdjacentHTML('afterbegin', `<section id="link-fixture">
        <a id="opaque" href="/asset-f9"><img alt="Thumbnail" width="160" height="70"></a>
        <a href="/asset-f9">Duplicate title</a>
        <a id="crosshost" href="https://stockcards.invalid/opaque-42?signature=SECRET"><img alt="Thumbnail" width="160" height="70"></a>
        <a id="preview-card" href="/preview-destination"><video preload="none" data-duration="5" src="https://media.invalid/preview.mp4"></video></a>
        <a id="unknown-link" href="/mystery">Continue</a>
        <nav><a href="/settings"><img alt="Settings"></a></nav>
        <a href="/photo.jpg"><img alt="Image only"></a>
        <a href="javascript:void(0)"><img alt="No destination"></a>
      </section>`);
      pageFixtures['https://stockcards.invalid/opaque-42?signature=SECRET']='<title>Actual destination video</title><meta itemprop="duration" content="PT45S"><video src="https://media.invalid/destination.mp4"></video>';
      window.scrollTo(0,0);UniversalVideoScraper.openTargetPreview('all',1,true);
    ''')
    candidates = js("return UniversalVideoScraper.collectSelectableTargets('all').map(c=>({url:c.url,kind:c.kind,element:c.element?.id,evidence:c.linkEvidence}))")
    check(len(candidates)==3 and all(c['kind']=='link' for c in candidates), 'Opaque thumbnail links and cross-host cards detected without duplicate inline previews')
    check({c['element'] for c in candidates}=={'opaque','crosshost','preview-card'}, 'Navigation images, image files, JavaScript links and duplicate titles excluded')
    cross = next(i+1 for i,c in enumerate(candidates) if c['element']=='crosshost')
    click(f'.list [data-target="{cross}"]')
    click('[data-do="links"]')
    check(js("return UniversalVideoScraper.collectSelectableTargets('all',true).some(c=>c.element?.id==='unknown-link')"), 'Show all links exposes an otherwise unrecognized plain link')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.list [aria-pressed=true]').length===1"), 'Expanding link candidates preserves selection')
    click('[data-do="links"]')
    click('[data-do="send"]')
    WebDriverWait(driver, 15).until(lambda _: js('return reports.length===5'))
    check(js("return fetchedPages.includes('https://stockcards.invalid/opaque-42?signature=SECRET')"), 'Selected card resolves its exact destination including required query parameters')
    check(js("return posts.filter(p=>p.capturePhase==='append').at(-1).entries[0]?.videoUrl==='https://media.invalid/destination.mp4'"), 'Destination video sent instead of card thumbnail or autoplay preview')
    check(js("return reports[4].candidates.filter(c=>c.selected).length===1 && reports[4].candidates.find(c=>c.selected).linkEvidence==='thumbnail'"), 'Report records selected link and recognition evidence')
    click('[data-do="close"]')
    js("document.querySelector('#preview-card video').remove();UniversalVideoScraper.openTargetPreview('main',1,true)")
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.list button').textContent.includes('Video link')"), 'Main can highlight a destination link when no player is present')
    # Same receiver used by live Pong, with a synthetic report only.
    (OUT/'report.json').write_text(json.dumps({'version':'7.18.1','viewport':viewport,'checks':checks,'feedbackExample':report}, indent=2), encoding='utf-8')
    print(json.dumps({'passed':len(checks),'report':str(OUT/'report.json'),'screenshot':str(OUT/'selection.png')}))
finally:
    driver.quit(); server.shutdown(); server.server_close()
