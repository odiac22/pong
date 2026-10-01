"""Signed Tampermonkey, private/headless Firefox; real Send to authorized live Recall 2, no playback."""
import base64
import json
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/javascript'); self.end_headers()
        self.wfile.write((ROOT/'universal-video-scraper.user.js').read_bytes())
server = ThreadingHTTPServer(('127.0.0.1',0), Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
options=Options();options.add_argument('-headless');options.add_argument('-private')
options.page_load_strategy='eager'
for key,value in {'media.volume_scale':'0.0','media.autoplay.default':5,'media.autoplay.allow-muted':False,'media.autoplay.blocking_policy':2,'browser.privatebrowsing.autostart':True}.items(): options.set_preference(key,value)
driver=webdriver.Firefox(options=options);driver.set_window_size(500,1000);driver.set_page_load_timeout(20)
video_id=sys.argv[1] if len(sys.argv)>1 else 'ZtL60wk4gys'
expected_duration=975 if video_id=='guSAAJaSG84' else 2661
out=ROOT/('artifacts/live-send-'+video_id);out.mkdir(parents=True,exist_ok=True)
try:
    addon=Path('E:/Pong Benchmarks/v3006-public-recall/tampermonkey-5.5.0.xpi')
    driver.execute('INSTALL_ADDON',{'addon':base64.b64encode(addon.read_bytes()).decode(),'temporary':True,'allowPrivateBrowsing':True})
    time.sleep(1.5)
    try: driver.get(f'http://127.0.0.1:{server.server_port}/universal-video-scraper.user.js')
    except Exception: pass
    def installer(_):
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            if driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url:
                buttons=[e for e in driver.find_elements('css selector','button,input') if (e.text or e.get_dom_attribute('value') or '').strip()=='Install']
                if buttons: return buttons[0]
        return False
    WebDriverWait(driver,15).until(installer).click()
    driver.switch_to.window(driver.window_handles[0])
    driver.get('https://m.youtube.com/watch?v='+video_id)
    WebDriverWait(driver,20).until(lambda _: driver.find_elements('id','uvs-recall-open'))
    driver.execute_script("document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0;})")
    driver.execute_async_script('const done=arguments[0];setTimeout(done,2500)')
    driver.execute_script("document.querySelector('#uvs-recall-capture').dataset.channel='2'")
    driver.find_element('id','uvs-recall-open').click()
    WebDriverWait(driver,8).until(lambda _: driver.execute_script("return !!document.querySelector('#uvs-target-preview')"))
    driver.execute_async_script('const done=arguments[0];setTimeout(done,500)')
    report=driver.execute_script("""
      const s=document.querySelector('#uvs-target-preview').shadowRoot;
      return {controls:[...s.querySelectorAll('.bar button')].map(b=>b.textContent),boxes:[...s.querySelectorAll('.box')].map(b=>({text:b.textContent,hidden:b.hidden,rect:b.getBoundingClientRect().toJSON()})),player:document.querySelector('#movie_player').getBoundingClientRect().toJSON(),media:[...document.querySelectorAll('video')].map(v=>({paused:v.paused,currentTime:v.currentTime}))};
    """)
    assert report['controls']==['Send','Copy log']
    expected_clock=f'{expected_duration//60}:{expected_duration%60:02d}'
    main=next(b for b in report['boxes'] if expected_clock in b['text'])
    assert not main['hidden'] and abs(main['rect']['top']-report['player']['top'])<2
    assert all(v['paused'] and v['currentTime']==0 for v in report['media'])
    # A real UI click must check the box without starting the underlying video.
    driver.find_element('id','uvs-target-preview').shadow_root.find_element('css selector','.box:not([hidden])').click()
    assert driver.execute_script("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[aria-pressed=true]').length") == 1
    report={'manager':'Tampermonkey 5.5.0 signed','channel':2,'expectedDuration':expected_duration,'selected':1,'permissions':[]}
    page_handle=driver.current_window_handle
    sent_at=time.monotonic()
    driver.find_element('id','uvs-target-preview').shadow_root.find_element('css selector','[data-do=send]').click()
    receipt=None
    while time.monotonic()-sent_at<75:
        # Only authorize the actual local Pong endpoints and media CDN in this
        # temporary private profile. Do not log permission-page text or tokens.
        for handle in driver.window_handles:
            if handle==page_handle: continue
            driver.switch_to.window(handle)
            if not (driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url): continue
            body=driver.find_element('tag name','body').text
            if 'DESTINATION URL' not in body: continue
            destination=body.split('DESTINATION URL',1)[1].strip().splitlines()[0].strip()
            host=urlsplit(destination).hostname or ''
            allowed=host in ('192.168.1.124','127.0.0.1','localhost') or host=='googlevideo.com' or host.endswith('.googlevideo.com')
            if allowed:
                buttons=[e for e in driver.find_elements('css selector','button,input') if (e.get_dom_attribute('value') or e.text).strip() in ('Temporarily allow','Always allow')]
                if buttons: buttons[0].click(); report['permissions'].append({'allowed':True,'kind':'local' if host in ('192.168.1.124','127.0.0.1','localhost') else 'media'})
        driver.switch_to.window(page_handle)
        try:
            with urllib.request.urlopen('http://127.0.0.1:8787/simpcity/recall?channel=2&consume=0',timeout=3) as response: state=json.load(response)
            capture=state.get('mediaCapture') or {}
            matches=parse_qs(urlsplit(capture.get('sourceUrl','')).query).get('v',[''])[0]==video_id
            if matches:
                report['capture']={k:capture.get(k) for k in ('id','state','totalPages','completedPages','deliveredVideos')}
                payload=state.get('recall') or {}
                videos=[v for bundle in payload.get('genericBundles',[]) for v in bundle.get('videos',[])]
                report['receiptCount']=len(videos)
                report['durationReceived']=[v.get('durationSeconds') or v.get('duration') for v in videos]
                report['receivedVideoFields']=list(videos[0].keys()) if videos else []
                report['status']=driver.execute_script("return document.querySelector('#uvs-target-preview')?.shadowRoot.querySelector('.status')?.textContent")
                if capture.get('state')=='complete' and capture.get('deliveredVideos',0)>0 and videos:
                    receipt=state;break
                if capture.get('state')=='empty' and not driver.execute_script("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').disabled"):break
        except Exception as e: report['pollErrorType']=type(e).__name__
        time.sleep(.15)
    report['elapsedMs']=round((time.monotonic()-sent_at)*1000)
    report['passed']=receipt is not None
    report['diagnostics']=driver.execute_script("try{return JSON.parse(document.documentElement.dataset.uvsCaptureDiagnostics||'[]')}catch{return []}")
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    driver.save_screenshot(str(out/'result.png'))
    print(json.dumps({k:v for k,v in report.items() if k!='diagnostics'}),flush=True)
    assert receipt is not None, 'Live Pong did not confirm receipt'

finally:
    driver.quit();server.shutdown();server.server_close()
