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
OUT = ROOT / 'artifacts' / ('simple-capture-7.29.0-mobile' if MOBILE else 'simple-capture-7.29.0')
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
      window.store={uvs_phone_connection_v1:'true'};window.posts=[];window.reports=[];window.probes=[];window.pageFixtures={};window.fetchedPages=[];
      window.GM_getValue=(key,value)=>key in store?store[key]:value;window.GM_setValue=(key,value)=>store[key]=value;
      window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};window.GM_setClipboard=text=>window.copied=text;
      window.PONG_LOCAL_ENDPOINTS=['http://127.0.0.1:18787'];window.vpnRequests=[];
      HTMLMediaElement.prototype.play=function(){throw Error('Playback forbidden');};
      window.GM_xmlhttpRequest=options=>{
        const fixtureUrl=new URL(options.url);fixtureUrl.searchParams.delete('_pong_relay');
        const fixtureHtml=pageFixtures[options.url] || pageFixtures[fixtureUrl.href];
        const respond=(body,status=200)=>queueMicrotask(()=>options.onload({status,responseText:JSON.stringify(body)}));
        if(options.url.includes('/vpn/')) {
          vpnRequests.push({action:options.url.split('/').pop(),method:options.method});
          if(window.vpnOld)respond({},404);
          else if(window.vpnFail)respond({error:'vpn_required'},409);
          else respond({ok:true,status:{phase:'connected',verified:true,protected:true,city:'San Jose',helperVersion:'30.14',busy:false,checkedAt:Date.now(),events:[]}});
        }else if(options.url.endsWith('/media-page/youtube-resolve')) {
          if(window.hangYouTube) return {abort(){}};
          const videoId=JSON.parse(options.data).videoId;
          respond({ok:true,videoId,videoUrl:'https://media.invalid/master.m3u8',durationSeconds:975,title:'Exact title'});
        }else if(options.url.endsWith('/media-page/detection-feedback')) {
          if(window.failReport)respond({ok:false},503);
          else{reports.push(JSON.parse(options.data));respond({ok:true,saved:true});}
        }else if(options.method==='POST' && options.url.endsWith('/media-page/recall')){
          const body=JSON.parse(options.data);posts.push(body);
          if(window.failAppend && body.capturePhase==='append')respond({ok:false,error:'Simulated failure'},400);
          else if(window.holdAppend && body.capturePhase==='append')window.releaseAppend=()=>respond({ok:true,accepted:body.entries.length,videos:posts.filter(p=>p.capturePhase==='append' && p.entries?.length).length,browserRelay:body.phoneConnectionOnly?{enabled:true,phoneConnectionOnly:true,sourceIds:['fixture-source']}:null,capabilities:{independentVideoIdentity:true,phoneConnectionFiles:true,phoneTransferBeforeReady:true}});
          else respond({ok:true,accepted:window.rejectMedia?0:(body.entries?.length||0),videos:posts.filter(p=>p.capturePhase==='append' && p.entries?.length).length,browserRelay:body.phoneConnectionOnly?{enabled:true,phoneConnectionOnly:true,sourceIds:['fixture-source']}:null,capabilities:{independentVideoIdentity:true,phoneConnectionFiles:true,phoneTransferBeforeReady:true}});
        }else if(options.url.includes('/media-browser-relay/transfers')){
          window.unexpectedTransfer=true;throw Error('Full-file transfers are forbidden');
        }else if(options.method==='GET' && options.url.includes('/media-browser-relay/jobs?')){
          respond({ok:true,expired:true,job:null});
        }else if(options.method==='GET' && options.url.endsWith('/media-browser-relay/capabilities')){
          respond({ok:true,phoneConnectionFiles:true});
        }else if(options.method==='GET' && fixtureHtml){
          fetchedPages.push(options.url);queueMicrotask(()=>options.onload({status:200,responseText:fixtureHtml}));
        }else if(options.method==='GET' && options.url.startsWith('https://media.invalid/')){
          if(window.failProbe){queueMicrotask(()=>options.onload({status:403,responseHeaders:'Content-Type: text/html'+String.fromCharCode(13,10)+'Set-Cookie: PRIVATE_TOKEN',finalUrl:'https://private.invalid/SECRET',response:new ArrayBuffer(12)}));return {abort(){}};}
          probes.push(options.url);queueMicrotask(()=>options.onload({status:206,responseHeaders:'Content-Type: '+(options.url.includes('m3u8')?'application/vnd.apple.mpegurl':'video/mp4')}));
        }else throw Error('Unexpected request '+options.url);
        return {abort(){}};
      };
    ''')
    js((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    js("document.querySelector('#uvs-recall-open').click()")
    viewport = js('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio}')
    check(js("return !!document.querySelector('#uvs-target-preview')"), 'Pong directly opens red boxes')
    check(js("return !document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=phone]')"), 'Removed phone checkbox is absent')
    check(js("return [...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.bar > .row:first-child button')].map(b=>b.textContent).join('|')==='Recall 1|Send|Copy log|×'"), 'Compact destination, Send, Copy log and close controls')
    check(js("return [...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[data-vpn]')].map(b=>b.textContent).join('|')==='Connect California|Disconnect|VPN status|Paste key & connect'"), 'Separate compact VPN controls')
    click('[data-do=pair-copy]')
    check(js("return copied==='http://127.0.0.1:18787/vpn/setup'"), 'Copy pairing link copies the PC address without opening a tab')
    check(js("return new Set([...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.bar button')].map(b=>getComputedStyle(b).backgroundColor)).size===9"), 'Every panel action has its own button color')
    click('[data-vpn=connect]')
    WebDriverWait(driver,5).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.vpn-status').textContent.includes('Copy pairing link')"))
    check(js('return vpnRequests.length===0'), 'Unpaired VPN action makes no network request')
    js("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>{throw Error('Clipboard denied')}}})")
    click('[data-vpn=pair]')
    driver.switch_to.alert.send_keys('a'*64);driver.switch_to.alert.accept()
    WebDriverWait(driver,5).until(lambda _: js('return vpnRequests.length===2'))
    check(js("return JSON.parse(store.uvs_vpn_pair_v1)['http://127.0.0.1:18787']==='a'.repeat(64) && !document.querySelector('#uvs-target-preview').shadowRoot.textContent.includes('a'.repeat(64))"), 'Native pairing prompt saves key privately without putting it in page DOM')
    check(js("return vpnRequests[0].action==='connect' && vpnRequests[1].action==='verify'"), 'Pasting a key automatically connects and verifies without another tap')
    js("window.vpnRequests=[];navigator.clipboard.readText=async()=>'a'.repeat(64)")
    click('[data-vpn=pair]')
    WebDriverWait(driver,5).until(lambda _: js('return vpnRequests.length===2'))
    check(js("return vpnRequests[0].action==='connect' && vpnRequests[1].action==='verify'"), 'Clipboard paste connects directly when browser permits reading')
    js('window.vpnRequests=[]')
    click('[data-vpn=connect]')
    WebDriverWait(driver,5).until(lambda _: js('return vpnRequests.length===2'))
    check(js("return vpnRequests[0].action==='connect' && vpnRequests[1].action==='verify' && document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.vpn-status').textContent.includes('San Jose')"), 'Trusted connect verifies California and displays city')
    js("document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-vpn=disconnect]').click()")
    check(js('return vpnRequests.length===2'), 'Website-generated VPN clicks cannot toggle PC connection')
    click('[data-vpn=disconnect]');driver.switch_to.alert.dismiss()
    check(js('return vpnRequests.length===2'), 'Disconnect cancellation does not alter PC VPN')
    js('window.vpnOld=true')
    click('[data-vpn=status]')
    WebDriverWait(driver,5).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.vpn-status').textContent.includes('restart')"))
    check(True, 'Old helper shows update/restart instructions')
    js('window.vpnOld=false')
    click('[data-vpn=status]')
    WebDriverWait(driver,5).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.vpn-status').textContent.includes('San Jose')"))
    click('[data-do=channel]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=channel]').textContent==='Recall 2' && JSON.parse(store.uvs_recall_channel_v1)===2 && document.querySelector('#uvs-recall-capture').dataset.channel==='2'"), 'Destination toggles to Recall 2 and persists preference')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=close]').getAttribute('aria-label')==='Close video selection'"), 'Close control has accessible label')
    click('[data-do=close]')
    check(js("return !document.querySelector('#uvs-target-preview') && !!document.querySelector('#uvs-recall-open')"), 'Close removes panel and boxes but keeps Pong launcher')
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return document.querySelectorAll('#uvs-target-preview').length===1"), 'Reopening creates exactly one selection panel')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=channel]').textContent==='Recall 2'"), 'Reopened panel remembers Recall 2')
    check(js('return posts.length===0 && probes.length===0'), 'Selection does not fetch or play media')
    check(js("return UniversalVideoScraper.collectSelectableTargets('all').length===3"), 'Players and linked video recognized')
    click('.boxes [data-target="1"]'); click('.boxes [data-target="2"]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[aria-pressed=true]').length===2"), 'Multiple checked red boxes')
    click('.boxes [data-target="1"]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[aria-pressed=true]').length===1"), 'Tap again unchecks')
    click('[data-do=channel]'); click('[data-do=channel]')
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('[aria-pressed=true]').length===1 && posts.length===0"), 'Switching destinations preserves checkmarks without sending')
    check(js("const r=document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.bar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth"), 'Toolbar fits viewport')
    driver.save_screenshot(str(OUT/'selection.png'))
    click('[data-do=send]')
    WebDriverWait(driver, 20).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('1/1 sent')"))
    captured = js('return posts.filter(p=>p.capturePhase==="append").flatMap(p=>p.entries)')
    check(len(captured)==1 and captured[0]['logicalVideoId']=='inline-video-2', 'Only selected independent video is sent')
    check(js("return posts.length>=3 && posts.every(p=>p.channel===2)"), 'Start, append and complete all use Recall 2')
    click('[data-do=copy]')
    report = js('return JSON.parse(copied)')
    check('SECRET' not in json.dumps(report) and 'media.invalid' not in json.dumps(report), 'Copy log redacts tokens and media URLs')
    check(report['candidates'][1]['outcome']=='sent', 'Copy log records verified delivery')
    check('site' not in report and 'title' not in report and report['version']=='7.29.0' and report['channel']==2 and not report['phoneConnectionOnly'], 'New log omits site and title and records correct destination/connection')
    check('a'*64 not in json.dumps(report) and report['diagnosticsVersion']==4, 'VPN diagnostics never include private pairing key')
    check(report['candidates'][1]['attempts'][0]['requests'][0]['httpStatus']==206, 'Media HTTP status recorded')
    check(report['candidates'][1]['deliveryRequests'][0]['serverAccepted']==1, 'Server acceptance recorded')
    check(report['candidates'][1]['mediaBefore']['paused'] is True, 'Native media state recorded without playing')
    check(report['capture']['requests'][0]['phase']=='start' and report['capture']['requests'][-1]['phase']=='complete', 'Capture start and completion diagnosed')
    check(js('return reports.length===0'), 'No hidden diagnostic upload')
    js('window.holdAppend=true')
    click('[data-do=send]')
    WebDriverWait(driver, 10).until(lambda _: js('return typeof releaseAppend==="function"'))
    check(js("return posts.every(p=>p.phoneConnectionOnly===false) && store.uvs_phone_connection_v1==='true'"), 'Old enabled phone preference cannot silently force phone routing')
    check(js("const b=document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=channel]');const disabled=b.disabled;b.onclick(new Event('click'));return disabled && b.textContent==='Recall 2'"), 'Destination cannot change during an in-flight send, even through handler invocation')
    count_before_close=js("return posts.filter(p=>p.capturePhase==='append').length")
    click('[data-do=close]')
    check(js("return document.querySelector('#uvs-target-preview').hidden"), 'Close immediately hides in-flight send and overlays')
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return !document.querySelector('#uvs-target-preview').hidden && document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').disabled"), 'Pong reopens the same in-flight progress with Send disabled')
    click('[data-do=close]')
    js('window.holdAppend=false;releaseAppend()')
    WebDriverWait(driver, 10).until(lambda _: js("return !document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=send]').disabled"))
    check(js("return !window.unexpectedTransfer && posts.every(p=>p.phoneTransferBeforeReady===false)"), 'Send never requests a full-file transfer')
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return !document.querySelector('#uvs-target-preview').hidden && posts.filter(p=>p.capturePhase==='append').length") == count_before_close, 'Background send completes once without duplicate delivery')
    click('[data-do=copy]')
    check(js("return JSON.parse(copied).candidates.some(c=>c.outcome==='sent')"), 'Completed background log remains available')
    check(js('return JSON.parse(copied).phoneConnectionOnly===false'), 'Copy log records normal routing')
    check(js("return JSON.parse(copied).candidates.every(c=>!('phoneTransfer' in c))"), 'Log no longer reports removed transfer feature')
    click('[data-do=channel]'); click('[data-do=copy]')
    check(js("const r=JSON.parse(copied);return r.channel===1 && r.stage==='selection' && !r.candidates.some(c=>c.outcome==='sent') && r.candidates.some(c=>c.selected)"), 'Switching to Recall 1 never relabels old receipts and preserves selection')
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return !document.querySelector('#uvs-target-preview')"), 'Pong closes selection')
    js("""document.querySelectorAll('video,a,#space').forEach(el=>el.remove());
      document.body.insertAdjacentHTML('afterbegin', '<a id="short" href="/opaque-short"><img alt="thumb" width="160" height="70"></a>');
      pageFixtures[location.origin+'/opaque-short']='<title>Short clip</title><meta itemprop="duration" content="PT13S"><video src="https://media.invalid/short.mp4"></video>';
      document.querySelector('#uvs-recall-open').click();""")
    click('.boxes button'); click('[data-do=send]')
    WebDriverWait(driver, 15).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('.status').textContent.includes('1/1 sent')"))
    check(js("return posts.filter(p=>p.capturePhase==='append').at(-1).entries[0].durationSeconds===13"), 'Selected 13-second thumbnail video is not filtered')
    check(js("return posts.slice(-3).length===3 && posts.slice(-3).every(p=>p.channel===1)"), 'Start, append and complete all use Recall 1 after switching back')
    js("document.querySelector('#uvs-recall-open').click();document.querySelector('#uvs-recall-open').click()")
    js("""document.body.insertAdjacentHTML('afterbegin','<a id="newcard" href="https://cards.invalid/opaque"><img width="160" height="70"></a>')""")
    WebDriverWait(driver, 5).until(lambda _: js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box').length===2"))
    checks.append('Newly loaded thumbnail card gets a box')
    js("document.querySelector('#uvs-recall-open').click();window.failAppend=true;document.querySelector('#uvs-recall-open').click()")
    target = js("return UniversalVideoScraper.collectSelectableTargets('all').find(c=>c.element.id==='short').previewId")
    click(f'.boxes [data-target="{target}"]'); click('[data-do=send]')
    WebDriverWait(driver, 15).until(lambda _: js("const s=document.querySelector('#uvs-target-preview').shadowRoot;return !s.querySelector('[data-do=send]').disabled && s.querySelector('.boxes').textContent.includes('Delivery failed')"))
    click('[data-do=copy]')
    check(js("return JSON.parse(copied).candidates.find(c=>c.selected).outcome==='delivery_failed'"), 'Failed handoff never claims Sent')
    check(js("const r=JSON.parse(copied).candidates.find(c=>c.selected);return r.failure==='server_rejected' && r.verificationFailure==='none' && r.deliveryRequests.length===2 && r.deliveryRequests.every(t=>t.httpStatus===400)"), 'Delivery retries and verification failure are separate')
    js("window.failAppend=false;document.querySelector('#uvs-recall-open').click()")
    js("window.rejectMedia=true;document.querySelector('#uvs-recall-open').click()")
    click(f'.boxes [data-target="{target}"]'); click('[data-do=send]')
    WebDriverWait(driver, 15).until(lambda _: js("const s=document.querySelector('#uvs-target-preview').shadowRoot;return !s.querySelector('[data-do=send]').disabled && s.querySelector('.boxes').textContent.includes('Delivery failed')"))
    click('[data-do=copy]')
    check(js("return JSON.parse(copied).candidates.find(c=>c.selected).outcome==='delivery_failed'"), 'HTTP 200 with accepted=0 is not falsely reported as Sent')
    js("window.rejectMedia=false;document.querySelector('#uvs-recall-open').click()")
    js("window.failProbe=true;window.failAppend=true;document.querySelector('#uvs-recall-open').click()")
    click(f'.boxes [data-target="{target}"]'); click('[data-do=send]')
    WebDriverWait(driver, 15).until(lambda _: js("const s=document.querySelector('#uvs-target-preview').shadowRoot;return !s.querySelector('[data-do=send]').disabled && s.querySelector('.boxes').textContent.includes('Delivery failed')"))
    click('[data-do=copy]')
    failed_report=js('return JSON.parse(copied)')
    failed=next(c for c in failed_report['candidates'] if c['selected'])
    check(failed['verificationFailure']=='media_unverified' and failed['deliveryFailure']=='server_rejected' and failed['failure']!='none', 'Original combined media/delivery failure reports both causes')
    probes=[r for a in failed['attempts'] for r in a['requests'] if r['phase']=='media_probe']
    check(all(r['httpStatus']==403 and r['contentType']=='text/html' and r['redirected'] and r['responseBytes']==12 for r in probes), 'Probe status, MIME, redirect boolean and byte count recorded')
    check('PRIVATE_TOKEN' not in json.dumps(failed_report) and 'private.invalid' not in json.dumps(failed_report) and 'SECRET' not in json.dumps(failed_report), 'Headers and redirect URLs never leak into copied diagnostics')
    (OUT/'failure-example.json').write_text(json.dumps(failed_report,indent=2),encoding='utf-8')
    js("window.failProbe=false;window.failAppend=false;document.querySelector('#uvs-recall-open').click()")
    redacted=js("return UniversalVideoScraper.requestDiagnosticOutput({phase:'SECRET',failure:'https://PRIVATE',contentType:'SECRET',helperVersion:'SECRET',httpStatus:'SECRET',contentRange:{start:'SECRET',end:22,total:33},responseText:'SECRET',headers:'SECRET'})")
    check('SECRET' not in json.dumps(redacted) and 'PRIVATE' not in json.dumps(redacted), 'Request-log allowlist rejects arbitrary strings and response bodies')
    # Protected-site gate uses only mocked helper requests, never visits a site.
    js("""window.vpnFail=true;window.gatePosts=posts.length;window.gateVpnStart=vpnRequests.length;window.gateDone=false;
      UniversalVideoScraper.sendCaptureToRecall('all',1,false,{userInitiated:true,targets:[{url:'https://www.pornhub.com/view_video.php?viewkey=fixture'}]})
      .catch(e=>window.gateError=e.code).finally(()=>window.gateDone=true);""")
    WebDriverWait(driver,5).until(lambda _: js('return gateDone'))
    check(js("return gateError==='vpn_required' && posts.length===gatePosts && vpnRequests[gateVpnStart].action==='verify'"), 'Unverified route blocks Recall before start; public API cannot authorize VPN launch')
    js('window.vpnFail=false')
    # Parser must choose exact video ID, never a recommendation's duration.
    info = js("""const u=UniversalVideoScraper;
      const doc=new DOMParser().parseFromString('<script>var ytInitialPlayerResponse = '+JSON.stringify({videoDetails:{videoId:'guSAAJaSG84',lengthSeconds:'975',title:'Quoted } title'},playabilityStatus:{status:'OK'}})+';<\/script>','text/html');
      doc.__uvsUrl='https://m.youtube.com/watch?v=guSAAJaSG84';
      window.youtubeFixture=doc;
      return {duration:u.extractPageDurationSeconds(doc),match:u.youtubePlayerData(doc,doc.__uvsUrl)?.videoDetails.videoId,mismatch:u.youtubePlayerData(doc,'https://www.youtube.com/watch?v=abcdefghijk'),bad:u.youtubeVideoId('https://youtube.com.evil.invalid/watch?v=guSAAJaSG84')};""")
    check(info=={'duration':975,'match':'guSAAJaSG84','mismatch':None,'bad':''}, 'Exact-ID YouTube player parsing: 16:15; rejects mismatched ID/host')
    result = driver.execute_async_script("""const done=arguments[0];UniversalVideoScraper.youtubeMediaEntries(youtubeFixture,youtubeFixture.__uvsUrl).then(r=>done(r[0]),e=>done({error:e.message}));""")
    check(result['durationSeconds']==975 and result['videoUrl'].endswith('master.m3u8'), 'YouTube SABR fallback resolves a combined HLS master')
    # Shorten only the outer 35-second target deadline to exercise stuck work.
    js("""window.hangYouTube=true;window.nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===35000?80:ms,...args);
      pageFixtures['https://www.youtube.com/watch?v=guSAAJaSG84']=youtubeFixture.documentElement.outerHTML;
      window.timeoutDone=false;window.timeoutStatuses=[];
      UniversalVideoScraper.sendCaptureToRecall('all',1,false,{targets:[{url:'https://www.youtube.com/watch?v=guSAAJaSG84',durationSeconds:975}],onStatus:(t,s)=>timeoutStatuses.push(s),onResult:(t,r)=>window.timeoutResult=r}).catch(()=>{}).finally(()=>window.timeoutDone=true);""")
    WebDriverWait(driver, 45).until(lambda _: js('return timeoutDone'))
    check(js("return timeoutStatuses.includes('Timed out') && timeoutResult.failure==='timeout' && !timeoutResult.delivered"), 'Stuck YouTube resolver exits Checking with explicit timeout and no delivery')
    js("window.setTimeout=window.nativeTimeout")
    # Recreate the page and userscript with only GM storage carried over:
    # verifies this is persistence, not merely an old launcher's dataset.
    js("document.querySelector('#uvs-recall-open').click()")
    click('[data-do=channel]')
    click('[data-do=close]')
    from selenium.webdriver.common.action_chains import ActionChains
    launcher=driver.find_element('id','uvs-recall-open')
    ActionChains(driver).move_to_element(launcher).click_and_hold().move_by_offset(75,-65).release().perform()
    check(js("return !!store.uvs_launcher_position_v1 && !document.querySelector('#uvs-target-preview')"), 'Dragging launcher persists position without opening panel')
    moved=js("const r=document.querySelector('#uvs-recall-capture').getBoundingClientRect();return {x:r.left,y:r.top}")
    stored=js('return store')
    driver.get(f'http://127.0.0.1:{server.server_port}/news/reloaded-fixture')
    js("""window.store=arguments[0];window.GM_getValue=(key,value)=>key in store?store[key]:value;
      window.GM_setValue=(key,value)=>store[key]=value;window.GM_registerMenuCommand=()=>{};
      window.GM_notification=()=>{};window.GM_setClipboard=()=>{};
      window.GM_xmlhttpRequest=()=>{throw Error('Unexpected network during preference reload test');};
      HTMLMediaElement.prototype.play=function(){throw Error('Playback forbidden');};""", stored)
    js((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    check(js("const r=document.querySelector('#uvs-recall-capture').getBoundingClientRect();return Math.abs(r.left-arguments[0].x)<2 && Math.abs(r.top-arguments[0].y)<2",moved) if not MOBILE else js("return parseFloat(document.querySelector('#uvs-recall-capture').style.top)>0 && document.querySelector('#uvs-recall-capture').getBoundingClientRect().right<=innerWidth"), 'Fresh page restores saved launcher position within viewport')
    js("document.querySelector('#uvs-recall-open').click()")
    check(js("return document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=channel]').textContent==='Recall 2'"), 'Fresh page/userscript restores Recall 2 from persisted storage')
    check(js("return !document.querySelector('#uvs-target-preview').shadowRoot.querySelector('[data-do=phone]')"), 'Fresh page keeps removed checkbox absent')
    (OUT/'report.json').write_text(json.dumps({'version':'7.29.0','viewport':viewport,'checks':checks,'feedbackExample':report}, indent=2), encoding='utf-8')
    print(json.dumps({'passed':len(checks),'report':str(OUT/'report.json')}))
finally:
    driver.quit(); server.shutdown(); server.server_close()
