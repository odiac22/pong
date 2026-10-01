"""Silent local browser regression: panel dragging, persistence, event isolation."""
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'")
        self.end_headers()
        self.wfile.write(b'''<style>body{margin:0}#under{position:fixed;inset:0;background:#ddd}video{position:relative;width:320px;height:180px;pointer-events:none}</style><a id="under" href="#clicked">Underlying website</a><video preload="none" src="https://media.invalid/fixture.mp4"></video>''')

server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options()
options.add_argument('-headless')
options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0')
options.set_preference('media.autoplay.default', 5)
driver = webdriver.Firefox(options=options)
driver.set_window_size(850, 950)
js = driver.execute_script
checks = []

def check(value, label):
    assert value, label
    checks.append(label)

def panel(selector):
    return driver.find_element('id', 'uvs-target-preview').shadow_root.find_element('css selector', selector)

def bounds():
    return js("return arguments[0].getBoundingClientRect().toJSON()", panel('.bar'))

try:
    driver.get(f'http://127.0.0.1:{server.server_port}/fixture')
    js('''window.store={};window.pageEvents=0;
      window.GM_getValue=(k,v)=>k in store?store[k]:v;
      window.GM_setValue=(k,v)=>store[k]=v;
      window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};
      window.GM_setClipboard=()=>{};
      window.GM_xmlhttpRequest=o=>({abort(){}});
      HTMLMediaElement.prototype.play=function(){throw Error('Playback forbidden')};
    ''')
    js((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    js("document.querySelector('#uvs-recall-open').click()")
    js("for(const t of ['click','pointerdown','pointerup','mousedown','mouseup']) document.addEventListener(t,()=>pageEvents++)")
    before = bounds()
    ActionChains(driver).move_to_element(panel('.drag-handle')).click_and_hold().move_by_offset(90, -180).release().perform()
    after = bounds()
    check(after['y'] < before['y'] - 100, 'Mouse drag moves opened panel')
    check(js('return pageEvents') == 0, 'Drag does not reach website bubble handlers')
    check(js("return !!store.uvs_target_preview_position_v1"), 'Drag persists panel position')
    # Click a non-control region directly over the full-window website link.
    ActionChains(driver).move_to_element(panel('.summary')).click().perform()
    check(js('return location.hash') == '', 'Panel surface blocks underlying link')
    check(js('return pageEvents') == 0, 'Panel click does not reach website bubble handlers')
    channel = panel('[data-do=channel]')
    old_text = channel.text
    channel.click()
    check(channel.text != old_text, 'Panel controls remain interactive')
    handle = panel('.drag-handle')
    handle.send_keys(Keys.ARROW_UP)
    moved = bounds()
    check(moved['y'] < after['y'], 'Keyboard movement works')
    handle.send_keys(Keys.ESCAPE)
    check(js("return !document.querySelector('#uvs-target-preview')"), 'Escape dismisses focused panel')
    js("document.querySelector('#uvs-recall-open').click()")
    check(abs(bounds()['y'] - moved['y']) < 2, 'Reopening restores position')
    driver.set_window_size(500, 650)
    WebDriverWait(driver, 5).until(lambda _: js('return arguments[0].getBoundingClientRect().right<=innerWidth && arguments[0].getBoundingClientRect().bottom<=innerHeight', panel('.bar')))
    r = bounds()
    check(js('return arguments[0].right<=innerWidth && arguments[0].bottom<=innerHeight', r), 'Resize keeps panel inside viewport')
    # Exercise touch pointer path without playing media or interacting with a site.
    before = bounds()
    js('''const h=arguments[0],r=h.getBoundingClientRect();
      h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,pointerType:'touch',pointerId:7,button:0,clientX:r.x+10,clientY:r.y+10}));
      window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'touch',pointerId:7,clientX:r.x+10,clientY:r.y-50,cancelable:true}));
      window.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',pointerId:7}));''', panel('.drag-handle'))
    check(bounds()['y'] < before['y'], 'Touch pointer movement path works')
    print('\n'.join('PASS: '+label for label in checks))
finally:
    driver.quit()
    server.shutdown()
