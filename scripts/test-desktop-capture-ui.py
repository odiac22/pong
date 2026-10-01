"""Silent private/headless Firefox: real userscript, inert links, mocked PC jobs."""
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
from selenium.webdriver.support import expected_conditions as EC
OUT = ROOT / 'artifacts/desktop-capture-7.32.0'
OUT.mkdir(parents=True, exist_ok=True)
class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
        self.wfile.write(b'''<title>Inert selection test</title><style>body{background:#ccd;margin:20px}a{display:block;width:280px;height:160px;background:#778;margin-bottom:15px}img{width:100%;height:100%}</style><a href="https://example.org/watch/one"><img alt="Video one"></a><a href="https://example.org/watch/two"><img alt="Video two"></a>''')
server = ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
options=Options();options.add_argument('-headless');options.add_argument('-private')
options.set_preference('media.volume_scale','0.0');options.set_preference('media.autoplay.default',5)
driver=webdriver.Firefox(options=options);driver.set_window_size(500,950)
checks=[]
def js(code,*args):return driver.execute_script(code,*args)
def click(selector):driver.find_element('id','uvs-target-preview').shadow_root.find_element('css selector',selector).click()
def check(value,label):
    assert value,label
    checks.append(label)
try:
    driver.get(f'http://127.0.0.1:{server.server_port}/')
    js('''window.store={uvs_phone_connection_v1:'true'};window.calls=[];window.posts=[];window.job=null;window.ready=false;window.fail=false;window.old=false;window.loseReply=false;
    window.GM_getValue=(k,v)=>k in store?store[k]:v;window.GM_setValue=(k,v)=>store[k]=v;
    window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};window.GM_setClipboard=t=>window.copied=t;
    window.PONG_LOCAL_ENDPOINTS=['http://127.0.0.1:18787'];
    HTMLMediaElement.prototype.play=function(){throw Error('No playback allowed')};
    window.GM_xmlhttpRequest=o=>{
      calls.push({url:o.url,method:o.method});
      const respond=(body,status=200)=>queueMicrotask(()=>o.onload({status,responseText:JSON.stringify(body)}));
      const u=new URL(o.url);
      if(u.origin!=='http://127.0.0.1:18787'||u.pathname!=='/media-page/desktop-capture')throw Error('Phone attempted non-PC request');
      if(old){respond({},404);return {abort(){}};}
      if(o.method==='POST'){
        const b=JSON.parse(o.data);posts.push(b);job={id:b.id,state:'running',targets:b.targets.map((_,index)=>({index,state:'queued'}))};
        if(loseReply){loseReply=false;queueMicrotask(()=>o.onerror());return {abort(){}};}
        respond({ok:true,desktopOwned:true,job},202);
      }else if(u.searchParams.has('id')){
        if(ready||fail){job.state=fail?'failed':'complete';job.targets.forEach(t=>Object.assign(t,{state:fail?'failed':'ready',error:fail?'source_unavailable':undefined,durationSeconds:60,resolutionMs:140,verificationMs:50}));}
        respond({ok:true,desktopOwned:true,job});
      }else respond({ok:true,desktopOwned:true,version:'30.15',maxTargets:80});
      return {abort(){}};
    };''')
    js((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box').length===2"),'Both thumbnail links selectable')
    check(js("return !document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=phone]')"),'No phone option despite old preference')
    js("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>new Promise(()=>{})}})")
    click('details summary');click('[data-vpn=pair]')
    WebDriverWait(driver,4).until(EC.alert_is_present());driver.switch_to.alert.dismiss()
    check(True,'Hanging clipboard permission falls back to cancellable paste prompt')
    click('details summary')
    click('.box[data-target="1"]');click('.box[data-target="2"]');click('[data-do=send]')
    WebDriverWait(driver,5).until(lambda _:js('return posts.length===1'))
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('can close Firefox')"),'Acceptance explicitly permits closing Firefox')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('Recall 1') && document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('does not mean ready')"),'Acceptance distinguishes destination and media readiness')
    check(js("return calls[0].method==='POST' && !calls.some(c=>c.method==='GET'&&!c.url.includes('?id='))"),'Batch POST occurs without a serial capability preflight')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.summary').textContent==='2 selected · 0 ready in Pong' && document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').textContent==='Sent to PC'"),'Selected/ready counters and sent button change at receipt')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box[data-ready=true]').length===0"),'Queued links are not falsely green')
    check(js("return posts[0].targets.length===2 && posts[0].targets.every(t=>Object.keys(t).every(k=>['url','logicalVideoId','durationSeconds'].includes(k))) && !('entries' in posts[0]) && !('browserRelayClientId' in posts[0]) && !('phoneConnectionOnly' in posts[0])"),'Submission contains links and identity hints, never phone media or relay')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=channel]').disabled"),'Destination fixed during job')
    click('[data-do=close]')
    js("document.querySelector('#uvs-recall-open').click();window.ready=true")
    WebDriverWait(driver,8).until(lambda _:js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box[data-ready=true]').length===2"))
    check(True,'Green boxes only after PC readiness; closing panel preserves job')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.summary').textContent==='2 selected · 2 ready in Pong'"),'Ready counter increments only after confirmed PC delivery')
    click('[data-do=copy]');report=json.loads(js('return copied'))
    check(report['deliveryMode']=='desktop_owned' and all(c['desktop']['phoneRelayUsed'] is False for c in report['candidates']),'Log describes desktop-owned route')
    check(report['capture']['acceptedMs'] is not None and report['capture']['destinationChannel']==1,'Log records handoff latency separately from preparation and destination')
    check('example.org' not in json.dumps(report) and '/watch/' not in json.dumps(report),'Copy log has no site or selected URLs')
    check(all(r['phase'].startswith('desktop_') for r in report['capture']['requests']),'Diagnostics distinguish submit/status/capability requests')
    check(js("return calls.every(c=>c.url.startsWith('http://127.0.0.1:18787/media-page/desktop-capture'))"),'Zero phone-side source fetches, probes, or relay polls')
    driver.save_screenshot(str(OUT/'panel.png'))
    click('[data-do=channel]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box[data-ready=true]').length===0"),'Switching destination clears previous green receipts')
    js('window.old=true');click('[data-do=send]')
    WebDriverWait(driver,5).until(lambda _:js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('Restart')"))
    check(js('return posts.length===1'),'Old helper fails before Recall mutation, no phone fallback')
    js('window.old=false;window.ready=false;window.fail=true;window.loseReply=true');click('[data-do=send]')
    WebDriverWait(driver,8).until(lambda _:js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('could not prepare')"))
    check(js('return posts.length===3 && posts[1].id===posts[2].id && posts[2].channel===2'),'Lost POST response retries idempotently on same PC/channel')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box[data-ready=true]').length===0"),'Failed desktop job never turns green')
    click('[data-do=copy]');failure=json.loads(js('return copied'))
    check(all(c['failure']=='source_unavailable' for c in failure['candidates']),'Desktop error code survives safe diagnostics')
    (OUT/'report.json').write_text(json.dumps({'version':'7.32.0','checks':checks,'feedback':report},indent=2),encoding='utf-8')
    print(json.dumps({'passed':len(checks),'report':str(OUT/'report.json')}))
finally:
    driver.quit();server.shutdown();server.server_close()
