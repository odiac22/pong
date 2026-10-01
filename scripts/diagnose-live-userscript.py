"""Silent, private, headless real Tampermonkey diagnostic. No screenshots or titles.

Default is selection-only. --send authorizes an exact main-player send to Recall 2
only while that channel is idle. No source playback, challenge handling, or VPN changes.
"""
import argparse
import base64
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--send', action='store_true')
parser.add_argument('--duration', type=int, default=432)
parser.add_argument('--mobile', action='store_true')
args = parser.parse_args()
OUT = ROOT / 'artifacts' / 'live-userscript-7.26.0'
OUT.mkdir(parents=True, exist_ok=True)
report = {'version': '7.26.0', 'headless': True, 'private': True,
          'audioDisabled': True, 'manager': 'Tampermonkey 5.5.0 signed',
          'receipt': False, 'playbackVerified': False}

class ScriptServer(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript')
        self.end_headers()
        self.wfile.write((ROOT / 'universal-video-scraper.user.js').read_bytes())

def recall():
    with urllib.request.urlopen('http://127.0.0.1:8787/simpcity/recall?channel=2&consume=0', timeout=4) as response:
        return json.load(response)

server = ThreadingHTTPServer(('127.0.0.1', 0), ScriptServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options()
options.add_argument('-headless')
options.add_argument('-private')
options.page_load_strategy = 'eager'
if args.mobile:
    options.set_preference('general.useragent.override', 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0')
for key, value in {'media.volume_scale': '0.0', 'media.autoplay.default': 5,
                   'media.autoplay.allow-muted': False, 'media.autoplay.blocking_policy': 2,
                   'browser.privatebrowsing.autostart': True}.items():
    options.set_preference(key, value)
driver = None
try:
    driver = webdriver.Firefox(options=options)
    driver.set_window_size(700, 900)
    driver.set_page_load_timeout(20)
    addon = Path('E:/Pong Benchmarks/v3006-public-recall/tampermonkey-5.5.0.xpi')
    driver.execute('INSTALL_ADDON', {'addon': base64.b64encode(addon.read_bytes()).decode(),
                                   'temporary': True, 'allowPrivateBrowsing': True})
    time.sleep(1)
    try: driver.get(f'http://127.0.0.1:{server.server_port}/universal-video-scraper.user.js')
    except Exception: pass
    def installer(_):
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            if driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url:
                for button in driver.find_elements('css selector', 'button,input'):
                    if (button.text or button.get_dom_attribute('value') or '').strip() == 'Install':
                        return button
        return False
    WebDriverWait(driver, 15).until(installer).click()
    driver.switch_to.window(driver.window_handles[0])
    driver.get('https://api.nordvpn.com/v1/helpers/ips/insights')
    browser_vpn = json.loads(driver.find_element('tag name', 'body').text)
    report['browserVpn'] = {key: browser_vpn.get(key) for key in ('country','city','protected')}
    if browser_vpn.get('protected') is not True or browser_vpn.get('city') not in ('San Jose','San Francisco','Los Angeles'):
        report['blocked'] = 'browser_california_vpn_not_verified'
        raise RuntimeError('Browser California VPN not verified')
    start = time.monotonic()
    try: driver.get(args.url)
    except Exception: report['navigationTimeout'] = True
    time.sleep(2)
    report['page'] = driver.execute_script("""
        const text=document.body?.innerText||'';
        document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0});
        const structured=[];
        for(const script of document.querySelectorAll('script[type="application/ld+json"]')){try{const o=JSON.parse(script.textContent);const walk=x=>{if(!x||typeof x!=='object')return;if(x['@type']==='VideoObject')structured.push({duration:x.duration,contentUrl:!!x.contentUrl,embedUrl:!!x.embedUrl});Object.values(x).forEach(v=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)});};walk(o);}catch{}}
        return {requestedPage:location.href===arguments[0],canonicalMatches:document.querySelector('link[rel="canonical"]')?.href===arguments[0],
          structured,playerContainers:[...document.querySelectorAll('#player,#playerContainer,#videoPlayer,.video-wrapper')].map(e=>({id:e.id,videoCount:e.querySelectorAll('video').length,visible:!!e.getClientRects().length})),
          notices:['video not found','video has been removed','video is unavailable','video is private','video has been disabled','video is no longer available','currently unavailable'].filter(s=>text.toLowerCase().includes(s)),
          challenge:/verify (?:you are|you're) human|complete the security check|checking your browser|access denied|unusual traffic/i.test(text),
          pongButton:!!document.querySelector('#uvs-recall-open'),
          accessNotice:/age verification|verify your age|not available in your (?:region|country)|video (?:has been removed|is unavailable)/i.test(text),
          declaredDurations:[...document.querySelectorAll('[itemprop="duration"]')].map(e=>e.content||e.getAttribute('datetime')).filter(Boolean),
          videos:[...document.querySelectorAll('video')].map(v=>({duration:Number.isFinite(v.duration)?v.duration:null,
            width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,error:v.error?.code||0,
            paused:v.paused,muted:v.muted})),iframes:document.querySelectorAll('iframe').length};
    """, args.url)
    report['navigationMs'] = round((time.monotonic() - start) * 1000)
    if report['page']['challenge']:
        report['blocked'] = 'site_access_challenge'
    elif not report['page']['pongButton']:
        report['blocked'] = 'userscript_not_injected'
    else:
        driver.find_element('id', 'uvs-recall-open').click()
        WebDriverWait(driver, 8).until(lambda _: driver.execute_script("return !!document.querySelector('#uvs-target-preview')"))
        report['selection'] = driver.execute_script("""
          const s=document.querySelector('#uvs-target-preview').shadowRoot;
          return {boxes:[...s.querySelectorAll('.box')].map(b=>({id:b.dataset.target,label:b.textContent,hidden:b.hidden})),
            controls:[...s.querySelectorAll('.bar button')].map(b=>b.getAttribute('data-do'))};
        """)
        if args.send:
            before = recall()
            if before.get('pending') or (before.get('recall') or {}).get('live') or (before.get('mediaCapture') or {}).get('state') == 'running':
                report['blocked'] = 'recall_busy_not_modified'
            elif not report['page']['videos']:
                report['blocked'] = 'no_native_main_player'
            else:
                # Ads can be larger than the intended player. Match the user's
                # known main-video duration, never the largest rectangle alone.
                matched = driver.execute_script("""
                  const s=document.querySelector('#uvs-target-preview').shadowRoot;
                  const clock=Math.floor(arguments[0]/60)+':'+String(arguments[0]%60).padStart(2,'0');
                  const b=[...s.querySelectorAll('.box')].find(b=>b.textContent.startsWith('Video · '+clock));
                  if(!b)return false;
                  if(s.querySelector('[data-do=channel]').textContent!=='Recall 2')s.querySelector('[data-do=channel]').click();
                  if(s.querySelector('[data-do=phone]').checked)s.querySelector('[data-do=phone]').click();
                  if(b.getAttribute('aria-pressed')!=='true')b.click();
                  return s.querySelectorAll('.box[aria-pressed=true]').length===1;
                """, args.duration)
                if not matched:
                    report['blocked'] = 'main_player_box_not_matched'
                else:
                    page_handle = driver.current_window_handle
                    sent_at = time.monotonic()
                    driver.find_element('id', 'uvs-target-preview').shadow_root.find_element('css selector', '[data-do=send]').click()
                    while time.monotonic() - sent_at < 55:
                        # Restrict extension permission to local helper and this test's CDN.
                        for handle in driver.window_handles:
                            if handle == page_handle: continue
                            driver.switch_to.window(handle)
                            if not (driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url): continue
                            body = driver.find_element('tag name', 'body').text
                            if 'DESTINATION URL' not in body: continue
                            host = urlsplit(body.split('DESTINATION URL',1)[1].strip().splitlines()[0]).hostname or ''
                            if host in ('127.0.0.1','localhost','192.168.1.124') or host.endswith('.phncdn.com') or host == urlsplit(args.url).hostname:
                                for button in driver.find_elements('css selector','button,input'):
                                    if (button.get_dom_attribute('value') or button.text).strip() == 'Temporarily allow':
                                        button.click(); break
                        driver.switch_to.window(page_handle)
                        if driver.execute_script("return !document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').disabled"):
                            break
                        time.sleep(.2)
                    state = recall()
                    capture = state.get('mediaCapture') or {}
                    report['receipt'] = capture.get('id') != (before.get('mediaCapture') or {}).get('id') and capture.get('sourceUrl') == args.url and capture.get('deliveredVideos', 0) > 0
                    report['sendMs'] = round((time.monotonic()-sent_at)*1000)
                    report['deliveredCount'] = capture.get('deliveredVideos', 0)
                    report['captureState'] = capture.get('state')
                    report['diagnostics'] = driver.execute_script("""
                      const ds=JSON.parse(document.documentElement.dataset.uvsCaptureDiagnostics||'[]');
                      return ds.map(d=>({verified:d.verified,delivered:d.delivered,failure:d.failure,verificationFailure:d.verificationFailure,
                        attempts:(d.attempts||[]).map(a=>({fetched:a.fetched,verified:a.verified,extracted:a.extracted,failure:a.failure,
                          requests:(a.requests||[]).map(r=>({phase:r.phase,state:r.state,httpStatus:r.httpStatus,failure:r.failure,elapsedMs:r.elapsedMs}))}))}));
                    """)
except Exception as error:
    report['errorType'] = type(error).__name__
finally:
    if driver: driver.quit()
    server.shutdown(); server.server_close()
    report_text=json.dumps(report, indent=2)
    (OUT/'report.json').write_text(report_text, encoding='utf-8')
    (OUT/('run-'+str(time.time_ns())+'.json')).write_text(report_text, encoding='utf-8')
    summary={**report}
    if 'selection' in summary: summary['selection']={**summary['selection'],'boxes':summary['selection']['boxes'][:6],'totalBoxes':len(summary['selection']['boxes'])}
    print(json.dumps(summary), flush=True)
