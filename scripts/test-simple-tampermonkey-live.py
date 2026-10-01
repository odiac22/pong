"""Signed Tampermonkey, private/headless Firefox; selection only, no Recall writes."""
import base64
import json
import sys
import threading
import time
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
out=ROOT/'artifacts/simple-tampermonkey-7.19.0';out.mkdir(parents=True,exist_ok=True)
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
    driver.get('https://m.youtube.com/watch?v=guSAAJaSG84')
    WebDriverWait(driver,20).until(lambda _: driver.find_elements('id','uvs-recall-open'))
    driver.execute_script("document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0;})")
    driver.execute_async_script('const done=arguments[0];setTimeout(done,2500)')
    driver.find_element('id','uvs-recall-open').click()
    WebDriverWait(driver,8).until(lambda _: driver.execute_script("return !!document.querySelector('#uvs-target-preview')"))
    driver.execute_async_script('const done=arguments[0];setTimeout(done,500)')
    report=driver.execute_script("""
      const s=document.querySelector('#uvs-target-preview').shadowRoot;
      return {controls:[...s.querySelectorAll('.bar button')].map(b=>b.textContent),boxes:[...s.querySelectorAll('.box')].map(b=>({text:b.textContent,hidden:b.hidden,rect:b.getBoundingClientRect().toJSON()})),player:document.querySelector('#movie_player').getBoundingClientRect().toJSON(),media:[...document.querySelectorAll('video')].map(v=>({paused:v.paused,currentTime:v.currentTime}))};
    """)
    assert report['controls']==['Send','Copy log']
    main=next(b for b in report['boxes'] if '16:15' in b['text'])
    assert not main['hidden'] and abs(main['rect']['top']-report['player']['top'])<2
    assert all(v['paused'] and v['currentTime']==0 for v in report['media'])
    # A real UI click must check the box without starting the underlying video.
    driver.find_element('id','uvs-target-preview').shadow_root.find_element('css selector','.box:not([hidden])').click()
    assert driver.execute_script("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[aria-pressed=true]').length") == 1
    report['selected']=1;report['manager']='Tampermonkey 5.5.0 signed';report['passed']=True
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    driver.save_screenshot(str(out/'selection.png'))
    print(json.dumps({'passed':True,'manager':report['manager'],'targets':len(report['boxes']),'report':str(out/'report.json')}))
finally:
    driver.quit();server.shutdown();server.server_close()
