"""Real Tampermonkey -> live PC job. Closes sending Firefox on acceptance.

Uses an inert local link card; the source site is accessed only by the PC helper.
Requires an explicit page URL and idle Recall 2. Silent, private, headless.
"""
import argparse
import base64
import html
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--stock-batch',action='store_true');parser.add_argument('--channel',type=int,choices=[1,2],default=2);parser.add_argument('--out',default='artifacts/desktop-handoff-7.32.0');args=parser.parse_args()
assert bool(args.url) != args.stock_batch, 'Choose --url or --stock-batch'
targets = [args.url] if args.url else [
    'https://media.w3.org/2010/05/bunny/movie.mp4',
    'https://media.w3.org/2010/05/sintel/trailer.mp4',
    'https://media.w3.org/2010/05/bunny/trailer.mp4',
    'https://media.w3.org/2010/05/video/movie_300.mp4',
    'https://media.w3.org/2010/05/video/movie_300.webm',
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm',
    *['https://download.samplelib.com/mp4/sample-'+str(n)+'s.mp4' for n in [5,10,15,20,30]],
]
OUT=ROOT/args.out;OUT.mkdir(parents=True,exist_ok=True)
def get_json(url):
    with urllib.request.urlopen(url,timeout=5) as r:return json.load(r)
def recall():return get_json(f'http://127.0.0.1:8787/simpcity/recall?channel={args.channel}&consume=0')
before=recall()
assert not before.get('pending') and not (before.get('recall') or {}).get('live'),'Recall 2 is busy'
report={'version':'7.32.0','helper':'30.20','headless':True,'private':True,'silent':True,'manager':'Tampermonkey 5.5.0 signed','phoneMediaRelay':False,'selectedCount':len(targets)}
class Fixture(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_GET(self):
        self.send_response(200)
        script=self.path.endswith('.user.js')
        self.send_header('Content-Type','application/javascript' if script else 'text/html');self.end_headers()
        self.wfile.write((ROOT/'universal-video-scraper.user.js').read_bytes() if script else ('<title>Desktop handoff fixture</title><style>a{display:block;width:320px;height:180px;background:#555}img{width:100%;height:100%}</style>'+''.join('<a href="'+html.escape(url,quote=True)+'"><img alt="Selected test video"></a>' for url in targets)).encode())
server=ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
options=Options();options.add_argument('-headless');options.add_argument('-private');options.page_load_strategy='eager'
for k,v in {'media.volume_scale':'0.0','media.autoplay.default':5,'media.autoplay.allow-muted':False,'browser.privatebrowsing.autostart':True}.items():options.set_preference(k,v)
driver=webdriver.Firefox(options=options);driver.set_window_size(500,950);driver.set_page_load_timeout(20)
def progress(stage): print(json.dumps({'stage':stage}),flush=True)
try:
    progress('installing_manager')
    addon=Path('E:/Pong Benchmarks/v3006-public-recall/tampermonkey-5.5.0.xpi')
    driver.execute('INSTALL_ADDON',{'addon':base64.b64encode(addon.read_bytes()).decode(),'temporary':True,'allowPrivateBrowsing':True})
    time.sleep(1)
    progress('installing_userscript')
    try:driver.get(f'http://127.0.0.1:{server.server_port}/universal-video-scraper.user.js')
    except Exception:pass
    def installer(_):
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            if driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url:
                for b in driver.find_elements('css selector','button,input'):
                    if (b.text or b.get_dom_attribute('value') or '').strip()=='Install':return b
        return False
    WebDriverWait(driver,20).until(installer).click()
    progress('opening_inert_fixture')
    driver.switch_to.window(driver.window_handles[0]);driver.get(f'http://127.0.0.1:{server.server_port}/fixture')
    WebDriverWait(driver,15).until(lambda _:driver.find_elements('id','uvs-recall-open'))
    driver.find_element('id','uvs-recall-open').click()
    def control(selector):return driver.find_element('id','uvs-target-preview').shadow_root.find_element('css selector',selector)
    if not args.stock_batch:
        control('details summary').click();control('[data-vpn=pair]').click()
        progress('pairing_test_browser')
        WebDriverWait(driver,10).until(EC.alert_is_present())
        driver.switch_to.alert.send_keys((ROOT/'.pong-local-ai/vpn-control-key').read_text().strip());driver.switch_to.alert.accept()
        WebDriverWait(driver,25).until(lambda _: not control('[data-vpn=pair]').get_property('disabled'))
        vpn=control('.vpn-status').text
        assert 'San Jose' in vpn or 'San Francisco' in vpn or 'Los Angeles' in vpn,'PC VPN not confirmed California'
        report['vpnVerified']=True
    progress('sending_links')
    if args.channel==2:control('[data-do=channel]').click()
    assert control('[data-do=channel]').text==f'Recall {args.channel}'
    driver.execute_script("for(const box of document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box'))box.click()")
    report['selectedSummary']=control('.summary').text
    assert report['selectedSummary'].startswith(str(len(targets))+' selected')
    began=time.monotonic();control('[data-do=send]').click()
    WebDriverWait(driver,25,poll_frequency=0.05).until(lambda _: 'PC accepted' in control('.status').text or 'ready in Recall' in control('.status').text)
    report['acceptedMs']=round((time.monotonic()-began)*1000)
    state=recall();job_id=state['mediaCapture']['id']
    report['stateAtBrowserClose']=state['mediaCapture']['state']
    report['readyBeforeClose']=state['mediaCapture']['deliveredVideos']
    report['acceptedTargets']=state['mediaCapture']['totalPages']
    report['summaryAtClose']=control('.summary').text
    driver.quit();driver=None
    report['sendingBrowserClosed']=True
    progress('browser_closed_pc_work_continues')
    deadline=time.monotonic()+300
    while time.monotonic()<deadline:
        job=get_json('http://127.0.0.1:8787/media-page/desktop-capture?id='+job_id)['job']
        if job['state']!='running':break
        time.sleep(1)
    report['job']=job;report['readyMs']=round((time.monotonic()-began)*1000)
    state=recall();videos=[v for b in state.get('recall',{}).get('genericBundles',[]) for v in b.get('videos',[])]
    report['receiptCount']=len(videos)
    report['matchingPage']=len(videos)==len(targets) and {v.get('pageUrl') for v in videos}==set(targets)
    report['hasPhoneDependency']=any(v.get('browserRelayUrl') or v.get('phoneConnectionOnly') for v in videos)
    report['passed']=job['state']=='complete' and report['matchingPage'] and not report['hasPhoneDependency']
    if args.stock_batch:
        report['passed']=report['passed'] and report['acceptedTargets']==12 and report['readyBeforeClose']<12 and report['acceptedMs']<3000
    assert report['passed'],'Desktop job did not finish independently'
finally:
    if driver:driver.quit()
    server.shutdown();server.server_close()
    (OUT/'receipt.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))
