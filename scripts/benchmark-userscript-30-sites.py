"""Silent, private 30-domain red-box userscript audit against an isolated Pong server.

Uses the production userscript inside the repository's Firefox GM compatibility
extension. This does not test the Tampermonkey manager itself. No screenshots.
"""
import argparse
import base64
import importlib.util
import json
import hashlib
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.actions.action_builder import ActionBuilder

EXTRA = [
    ('dailymotion','https://www.dailymotion.com/us'),
    ('twitch','https://www.twitch.tv/directory'),
    ('tiktok','https://www.tiktok.com/explore'),
    ('instagram','https://www.instagram.com/explore/'),
    ('facebook','https://www.facebook.com/watch/'),
    ('reddit','https://www.reddit.com/r/videos/'),
    ('x','https://x.com/explore'),
    ('rumble','https://rumble.com/'),
    ('odysee','https://odysee.com/'),
    ('bitchute','https://www.bitchute.com/'),
    ('peertube','https://framatube.org/videos/overview'),
    ('videvo','https://www.videvo.net/stock-video-footage/people/'),
    ('motionarray','https://motionarray.com/browse/stock-video/'),
    ('adobe-stock','https://stock.adobe.com/video'),
    ('shutterstock','https://www.shutterstock.com/video/search/people'),
]

def get_json(url):
    with urllib.request.urlopen(url, timeout=8) as response:
        return json.load(response)


def receipt_matches_submission(state, payload, expected_url):
    capture = state.get('mediaCapture') or {}
    if not payload.get('id') or capture.get('id') != payload['id']:
        return False
    if capture.get('sourceUrl') != expected_url or payload.get('sourceUrl') != expected_url:
        return False
    recall = state.get('recall') or {}
    return not capture.get('deliveredVideos') or recall.get('id') == payload['id']

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--base',default='http://127.0.0.1:17929')
    ap.add_argument('--out',required=True)
    ap.add_argument('--limit',type=int,default=30)
    ap.add_argument('--site',action='append')
    ap.add_argument('--url-override')
    ap.add_argument('--preclick-selector',help='Touch a site player opener before opening the userscript preview')
    ap.add_argument('--manifest-json')
    ap.add_argument('--diagnose-target', action='store_true',
                    help='Inspect the current player after preview opens; never select or send')
    args=ap.parse_args()
    endpoint=urlsplit(args.base)
    if endpoint.scheme!='http' or endpoint.hostname!='127.0.0.1' or endpoint.port!=17929 or endpoint.path not in ('','/') or endpoint.query or endpoint.fragment:
        raise ValueError('This harness may write only to the existing isolated helper on127.0.0.1:17929')
    args.base=args.base.rstrip('/')
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(Path('E:/Pong Benchmarks/v3006-public-recall/manifest.json').read_text(encoding='utf-8'))
    cases=[];seen=set()
    for item in manifest:
        if item['site'] not in seen:
            cases.append({'site':item['site'],'url':item['url'],'kind':'watch'})
            seen.add(item['site'])
    cases.extend({'site':site,'url':url,'kind':'listing'} for site,url in EXTRA)
    assert len(cases)==30 and len({c['site'] for c in cases})==30
    if args.manifest_json:cases=[{'kind':'watch', **item} for item in json.loads(Path(args.manifest_json).read_text(encoding='utf-8'))]
    spec=importlib.util.spec_from_file_location('qualification',ROOT/'scripts/qualify-universal-video-recall.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    original=helper._extension_archive(out)
    with zipfile.ZipFile(original) as z: contents={n:z.read(n) for n in z.namelist()}
    code=contents['content.js'].decode()
    code=code[:code.index('// ==UserScript==')]+'''\nconst originalBenchmarkGmRequest=GM_xmlhttpRequest;
    GM_xmlhttpRequest=function(options){
      if(options.method==='POST'&&options.url.endsWith('/media-page/desktop-capture')){
        try{const p=JSON.parse(options.data);document.documentElement.dataset.pongBenchmarkPayload=JSON.stringify({
          id:p.id,targets:p.targets,channel:p.channel,sourceUrl:p.sourceUrl});}catch{}
      }
      return originalBenchmarkGmRequest(options);
    };\n'''+(ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8')
    code += '''\ndocument.addEventListener('pong:benchmark-targets',()=>{
      const a=window.UniversalVideoScraper;
      document.documentElement.dataset.pongBenchmarkTargets=JSON.stringify({
        targets:(a?.collectSelectableTargets('all')||[]).map(c=>({id:String(c.previewId),url:c.url,kind:c.kind,
          directMedia:!!c.directMedia,linkEvidence:c.linkEvidence||'',logicalVideoId:c.logicalVideoId||'',
          surface:c.element?{tag:c.element.tagName,connected:c.element.isConnected,
            rect:c.element.getBoundingClientRect().toJSON(),ancestors:(()=>{const rows=[];
              for(let e=c.element;e&&rows.length<8;e=e.parentElement){const s=getComputedStyle(e);
                rows.push({tag:e.tagName,display:s.display,visibility:s.visibility,opacity:s.opacity});}return rows;})()}:null})),
        main:a?.primaryMediaEntriesFromDoc(document,location.href)||[]});
    });\n'''
    code += '''\ndocument.addEventListener('pong:benchmark-main-target',()=>{
      const targets=window.UniversalVideoScraper?.collectSelectableTargets('main')||[];
      document.documentElement.dataset.pongBenchmarkMainTarget=JSON.stringify(
        targets.map(t=>({kind:t.kind,url:t.url,element:t.element?{
          tag:t.element.tagName,className:String(t.element.className||'').slice(0,100),
          connected:t.element.isConnected,rect:t.element.getBoundingClientRect().toJSON()}:null})));
    });\n'''
    contents['content.js']=code.replace('http://127.0.0.1:8787',args.base).encode()
    extension=out/'isolated-userscript.xpi'
    with zipfile.ZipFile(extension,'w',zipfile.ZIP_DEFLATED) as z:
        for name,data in contents.items():z.writestr(name,data)
    options=Options();options.add_argument('-headless');options.add_argument('-private')
    options.page_load_strategy='eager'
    options.set_preference('extensions.allowPrivateBrowsingByDefault',True)
    for key,value in {'media.volume_scale':'0.0','media.autoplay.default':0,'media.autoplay.allow-muted':True,
                      'permissions.default.microphone':2,'permissions.default.camera':2,
                      'browser.privatebrowsing.autostart':True}.items():options.set_preference(key,value)
    report={'scope':'Actual public pages + production userscript in Firefox GM compatibility shim + isolated PC Recall; not Tampermonkey manager or live queue',
            'headless':True,'private':True,'silent':True,'server':args.base,
            'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'userscriptSha256':hashlib.sha256((ROOT/'universal-video-scraper.user.js').read_bytes()).hexdigest(),
            'version':next(l for l in (ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8').splitlines() if '@version' in l).split()[-1],
            'cases':[]}
    driver=webdriver.Firefox(options=options)
    driver.set_page_load_timeout(14);driver.set_script_timeout(12);driver.set_window_size(1100,900)
    try:
        driver.execute('INSTALL_ADDON',{'addon':base64.b64encode(extension.read_bytes()).decode(),'temporary':True,'allowPrivateBrowsing':True})
        filtered=[c for c in cases if not args.site or c['site'] in args.site]
        if args.url_override:
            if len(filtered)!=1:raise ValueError('--url-override requires exactly one --site')
            filtered[0]={**filtered[0],'url':args.url_override}
        for case in filtered[:args.limit]:
            started=time.monotonic();row=dict(case)
            try:
                try:driver.get(case['url'])
                except Exception as e:row['navigationWarning']=type(e).__name__
                time.sleep(1.5)
                if args.preclick_selector:
                    opener=driver.find_element('css selector',args.preclick_selector)
                    opener.location_once_scrolled_into_view
                    action=ActionBuilder(driver,mouse=PointerInput('touch','site-player-opener'))
                    action.pointer_action.move_to(opener)
                    action.pointer_action.pointer_down()
                    action.pointer_action.pause(.08)
                    action.pointer_action.pointer_up()
                    action.perform()
                    row['sitePlayerOpenedByTouch']=True
                    time.sleep(.7)
                page=driver.execute_script('''
                    for(const v of document.querySelectorAll('video,audio')){v.pause();v.muted=true;v.defaultMuted=true;v.volume=0}
                    const t=(document.body?.innerText||'').slice(0,5000);
                    return {url:location.href,title:document.title,bodyLength:t.length,
                      challenge:/checking your browser|verify you are human|access denied|captcha/i.test(t),
                      login:/log in to continue|sign in to continue/i.test(t),
                      videoCount:document.querySelectorAll('video').length,
                      userscript:!!document.querySelector('#uvs-recall-open')};
                ''')
                row['page']=page
                row['playerDomProbe']=driver.execute_script('''
                  return [...document.querySelectorAll('video,iframe,embed,object,mux-player,video-js,.video-js,media-player')]
                    .slice(0,12).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),p=e.parentElement;
                      return {tag:e.tagName,src:e.getAttribute('src')||e.getAttribute('data')||'',
                        currentSrc:e.currentSrc||'',sourceCount:e.querySelectorAll?.('source[src]')?.length||0,
                        rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,visibility:s.visibility,
                        parentTag:p?.tagName||'',parentClass:String(p?.className||'').slice(0,120)};});
                ''')
                if page['challenge'] or 'just a moment' in page['title'].lower():
                    row['status']='site-access-challenge';continue
                if not page['userscript']:
                    row['status']='userscript-not-injected';continue
                driver.find_element('id','uvs-recall-open').click()
                for _ in range(8):
                    if driver.execute_script("return !!document.querySelector('#uvs-target-preview')?.shadowRoot"):break
                    time.sleep(.25)
                else:
                    row['status']='preview-open-failed';continue
                if args.diagnose_target:
                    row['targetSnapshots']=[]
                    for delay in (0, .6, 1.5, 3.0):
                        if delay: time.sleep(delay)
                        row['targetSnapshots'].append(driver.execute_script('''
                          const describe=e=>{
                            if(!e)return null;
                            const r=e.getBoundingClientRect(),ancestors=[];
                            for(let n=e;n&&ancestors.length<12;n=n.parentElement){
                              const s=getComputedStyle(n),b=n.getBoundingClientRect();
                              ancestors.push({tag:n.tagName,className:String(n.className||'').slice(0,100),
                                display:s.display,visibility:s.visibility,opacity:s.opacity,
                                width:b.width,height:b.height,clientRects:n.getClientRects().length});
                            }
                            return {tag:e.tagName,className:String(e.className||'').slice(0,100),
                              connected:e.isConnected,width:r.width,height:r.height,top:r.top,
                              clientRects:e.getClientRects().length,ancestors};
                          };
                          const host=document.querySelector('wa-video-player.wa-video-details__video-player');
                          const native=host?.querySelector('video')||null;
                          const videoJs=host?.querySelector('.video-js')||null;
                          document.dispatchEvent(new Event('pong:benchmark-main-target'));
                          const targets=JSON.parse(document.documentElement.dataset.pongBenchmarkMainTarget||'[]');
                          const shadow=document.querySelector('#uvs-target-preview')?.shadowRoot;
                          return {timeMs:performance.now(),videoCount:document.querySelectorAll('video').length,
                            customPlayerCount:document.querySelectorAll('mux-player,video-js,.video-js,media-player').length,
                            host:describe(host),native:describe(native),videoJs:describe(videoJs),
                            mainTargets:targets,boxes:[...(shadow?.querySelectorAll('.box')||[])].map(b=>({hidden:b.hidden,
                              text:b.textContent,rect:b.getBoundingClientRect().toJSON()}))};
                        '''))
                    shadow=driver.find_element('id','uvs-target-preview').shadow_root
                    main_box=shadow.find_element('css selector','.box[data-target="1"]')
                    row['diagnosticSelection']={'beforePressed':main_box.get_attribute('aria-pressed')}
                    hit=driver.execute_script('''
                      const el=arguments[0],r=el.getBoundingClientRect(),root=el.getRootNode();
                      const l=Math.max(0,r.left),t=Math.max(0,r.top),b=Math.min(innerHeight,r.bottom),right=Math.min(innerWidth,r.right);
                      if(el.hidden||right-l<2||b-t<2)return null;
                      for(const fx of [.5,.15,.85])for(const fy of [.5,.15,.85]){
                        const x=Math.min(innerWidth-1,Math.max(0,Math.floor(l+(right-l)*fx)));
                        const y=Math.min(innerHeight-1,Math.max(0,Math.floor(t+(b-t)*fy)));
                        const target=root.elementFromPoint(x,y);
                        if(target===el||el.contains(target))return {x,y};
                      }
                      return null;
                    ''',main_box)
                    row['diagnosticSelection']['hitPoint']=hit
                    if hit:
                        touch=ActionBuilder(driver,mouse=PointerInput('touch','diagnostic-finger'))
                        touch.pointer_action.move_to_location(hit['x'],hit['y'])
                        touch.pointer_action.pointer_down();touch.pointer_action.pointer_up();touch.perform()
                        row['diagnosticSelection']['afterPressed']=main_box.get_attribute('aria-pressed')
                        row['diagnosticSelection']['summary']=driver.execute_script("return document.querySelector('#uvs-target-preview')?.shadowRoot?.querySelector('.summary')?.textContent||''")
                    row['status']='diagnosed-no-send'
                    continue
                selection=driver.execute_script('''
                  const s=document.querySelector('#uvs-target-preview')?.shadowRoot;
                  if(!s)return {boxes:[]};
                  return {boxes:[...s.querySelectorAll('.box')].map(b=>({id:b.dataset.target,hidden:b.hidden,
                    label:b.textContent,pressed:b.getAttribute('aria-pressed'),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height})),
                    summary:s.querySelector('.summary')?.textContent};
                ''')
                row['selection']=selection
                boxes=[b for b in selection['boxes'] if not b['hidden'] and b['width']>30 and b['height']>20]
                for scroll in range(1,7):
                    if boxes:break
                    driver.execute_script('window.scrollTo(0,Math.min(document.documentElement.scrollHeight,innerHeight*arguments[0]*.8))',scroll)
                    time.sleep(.35)
                    selection=driver.execute_script('''
                      const s=document.querySelector('#uvs-target-preview')?.shadowRoot;
                      return {boxes:[...s.querySelectorAll('.box')].map(b=>({id:b.dataset.target,hidden:b.hidden,
                        label:b.textContent,pressed:b.getAttribute('aria-pressed'),width:b.getBoundingClientRect().width,
                        height:b.getBoundingClientRect().height})),summary:s.querySelector('.summary')?.textContent};
                    ''')
                    boxes=[b for b in selection['boxes'] if not b['hidden'] and b['width']>30 and b['height']>20]
                    row['scrollSteps']=scroll
                row['selection']=selection
                if not boxes:
                    row['dom']=driver.execute_script('''
                      const describe=e=>{const r=e.getBoundingClientRect(),p=e.parentElement;
                        return {tag:e.tagName,id:e.id,class:String(e.className||'').slice(0,120),
                          parentTag:p?.tagName,parentClass:String(p?.className||'').slice(0,120),
                          w:r.width,h:r.height,top:r.top,display:getComputedStyle(e).display,
                          visibility:getComputedStyle(e).visibility,src:e.currentSrc||e.getAttribute('src')||'',
                          poster:e.getAttribute('poster')||''}};
                      return {videos:[...document.querySelectorAll('video')].slice(0,12).map(describe),
                        images:[...document.querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect();return r.width>200&&r.height>100&&r.top<innerHeight&&r.bottom>0}).slice(0,8).map(describe)};
                    ''')
                    row['status']='no-visible-video-box';continue
                inspected=driver.execute_script('''
                  document.dispatchEvent(new Event('pong:benchmark-targets'));
                  return JSON.parse(document.documentElement.dataset.pongBenchmarkTargets||'{}');
                ''')
                candidates=inspected.get('targets') or []
                row['mainEntries']=inspected.get('main') or []
                row['candidates']=candidates
                by_id={c['id']:c for c in candidates}
                def valid_video_target(candidate):
                    url=candidate.get('url','')
                    if candidate.get('kind')=='player' or candidate.get('directMedia'):return True
                    if url==page['url'] and case['kind']=='watch':return True
                    from urllib.parse import urlsplit
                    target=urlsplit(url);path=target.path.lower()
                    page_host=urlsplit(page['url']).hostname or ''
                    target_host=target.hostname or ''
                    if target_host!=page_host:return False
                    if '/download/' in path or '/timedtext:' in path:return False
                    return (any(piece in path for piece in ('/video/','/videos/','/watch/','/talks/','/clip/','/clips/','/free-stock-video/','/free-video/'))
                            or path.startswith('/details/') or path.startswith('/wiki/file:'))
                boxes=[b for b in boxes if valid_video_target(by_id.get(b['id'],{}))]
                if not boxes:
                    row['dom']=driver.execute_script('''
                      const describe=e=>{const r=e.getBoundingClientRect(),p=e.parentElement;
                        return {tag:e.tagName,id:e.id,class:String(e.className||'').slice(0,120),
                          parentTag:p?.tagName,parentClass:String(p?.className||'').slice(0,120),
                          w:r.width,h:r.height,top:r.top,display:getComputedStyle(e).display,
                          visibility:getComputedStyle(e).visibility,src:e.currentSrc||e.getAttribute('src')||'',
                          poster:e.getAttribute('poster')||''}};
                      return {videos:[...document.querySelectorAll('video')].slice(0,12).map(describe),
                        images:[...document.querySelectorAll('img')].filter(e=>{const r=e.getBoundingClientRect();return r.width>200&&r.height>100&&r.top<innerHeight&&r.bottom>0}).slice(0,8).map(describe)};
                    ''')
                    row['status']='no-credible-video-box';continue
                boxes.sort(key=lambda b:(
                    by_id.get(b['id'],{}).get('kind')=='player',
                    by_id.get(b['id'],{}).get('url')==page['url'],
                    '/download/' not in by_id.get(b['id'],{}).get('url',''),
                    '/video/' in by_id.get(b['id'],{}).get('url',''),
                    b['width']*b['height']),reverse=True)
                chosen=boxes[0]
                row['chosen']=by_id.get(chosen['id'],{})
                if case['kind']=='watch' and row['chosen'].get('kind')=='link' and row['chosen'].get('url')!=page['url']:
                    row['status']='requested-main-video-not-selectable'
                    continue
                # Real Selenium click produces pointer/click events at the red box.
                shadow=driver.find_element('id','uvs-target-preview').shadow_root
                box_element=shadow.find_element('css selector',f'.box[data-target="{chosen["id"]}"]')
                point=driver.execute_script('''
                  const el=arguments[0],r=el.getBoundingClientRect(),root=el.getRootNode();
                  const l=Math.max(0,r.left),t=Math.max(0,r.top),b=Math.min(innerHeight,r.bottom),right=Math.min(innerWidth,r.right);
                  if(right-l<2||b-t<2)return null;
                  for(const fx of [.5,.15,.85])for(const fy of [.5,.15,.85]){
                    const x=Math.min(innerWidth-1,Math.max(0,Math.floor(l+(right-l)*fx)));
                    const y=Math.min(innerHeight-1,Math.max(0,Math.floor(t+(b-t)*fy)));
                    const hit=root.elementFromPoint(x,y);
                    if(hit===el||el.contains(hit))return {x,y};
                  }
                  return null;
                ''',box_element)
                if not point:
                    row['status']='red-box-not-touchable-in-viewport'
                    continue
                touch=ActionBuilder(driver,mouse=PointerInput('touch','finger'))
                touch.pointer_action.move_to_location(point['x'],point['y'])
                touch.pointer_action.pointer_down();touch.pointer_action.pointer_up();touch.perform()
                row['selectionInput']='WebDriver touch pointer'
                row['selected']=driver.execute_script('''
                  const s=document.querySelector('#uvs-target-preview').shadowRoot;
                  return {pressed:[...s.querySelectorAll('.box[aria-pressed="true"]')].map(b=>b.dataset.target),
                    summary:s.querySelector('.summary')?.textContent};
                ''')
                if row['selected']['pressed']!=[chosen['id']]:
                    row['status']='selection-failed';continue
                driver.execute_script("delete document.documentElement.dataset.pongBenchmarkPayload")
                sent_at=time.monotonic()
                shadow.find_element('css selector','[data-do="send"]').click()
                accepted=False;last={}
                for _ in range(75):
                    time.sleep(.4)
                    ui=driver.execute_script('''const s=document.querySelector('#uvs-target-preview')?.shadowRoot;
                      return {status:s?.querySelector('.status')?.textContent||'',summary:s?.querySelector('.summary')?.textContent||''};''')
                    last=ui
                    if 'PC accepted' in ui['status']:accepted=True
                    state=get_json(args.base+'/simpcity/recall?channel=1&consume=0')
                    capture=state.get('mediaCapture') or {}
                    submitted=driver.execute_script("return JSON.parse(document.documentElement.dataset.pongBenchmarkPayload||'{}')")
                    # Production sets sourceUrl to the first selected target,
                    # which may differ from the originating listing page.
                    if receipt_matches_submission(state,submitted,row['chosen'].get('url')):
                        accepted=True
                        row.setdefault('receiptObservedMs',round((time.monotonic()-sent_at)*1000))
                        row['receipt']={'id':capture.get('id'),'state':capture.get('state'),'deliveredVideos':capture.get('deliveredVideos'),
                                        'totalPages':capture.get('totalPages'),'sourceUrl':capture.get('sourceUrl'),
                                        'submittedIdMatches':True}
                        if capture.get('state') in ('complete','empty','failed'):
                            row['terminalReceiptMs']=round((time.monotonic()-sent_at)*1000)
                            try:
                                row['desktopJob']=get_json(args.base+'/media-page/desktop-capture?id='+submitted['id']).get('job')
                            except Exception as exc:
                                row['desktopJobDiagnosticError']=type(exc).__name__
                            bundles=(state.get('recall') or {}).get('genericBundles') or []
                            row['recallVideoCount']=sum(len(b.get('videos') or []) for b in bundles)
                            row['videos']=[v for b in bundles for v in (b.get('videos') or [])]
                            break
                    if 'PC could not accept' in ui['status'] or 'Pong PC address' in ui['status']:break
                row['ui']=last;row['accepted']=accepted
                row['submittedPayload']=driver.execute_script("return JSON.parse(document.documentElement.dataset.pongBenchmarkPayload||'{}')")
                row['status']='receipt-video' if row.get('receipt',{}).get('deliveredVideos',0)>0 and row.get('recallVideoCount',0)>0 else (
                    'accepted-pending-unverified' if accepted and row.get('receipt',{}).get('state') in ('running','starting') else
                    'accepted-no-video' if accepted else 'send-failed')
                if row['status']=='receipt-video':
                    source=(row.get('videos') or [{}])[0].get('videoUrl')
                    if source:
                        driver.set_script_timeout(34)
                        row['playback']=driver.execute_async_script('''
                          const src=arguments[0],done=arguments[arguments.length-1];
                          const v=document.createElement('video');v.muted=true;v.defaultMuted=true;v.volume=0;
                          v.playsInline=true;v.preload='auto';v.style.cssText='position:fixed;width:320px;height:180px;top:0;left:0;pointer-events:none';
                          document.body.appendChild(v);let finished=false,frames=0,frameCallback=0;const t0=performance.now();
                          const painted=()=>{frames++;frameCallback=v.requestVideoFrameCallback(painted)};
                          if(typeof v.requestVideoFrameCallback==='function')frameCallback=v.requestVideoFrameCallback(painted);
                          const finish=reason=>{if(finished)return;finished=true;clearInterval(timer);const data={reason,
                            elapsedMs:Math.round(performance.now()-t0),mediaTime:v.currentTime,width:v.videoWidth,height:v.videoHeight,
                            presentedFrames:frames,
                            readyState:v.readyState,paused:v.paused,error:v.error?.code||0,muted:v.muted&&v.volume===0};
                            if(frameCallback)v.cancelVideoFrameCallback(frameCallback);
                            v.pause();v.removeAttribute('src');v.load();v.remove();done(data)};
                          const timer=setInterval(()=>{v.muted=true;v.volume=0;if(v.currentTime>=1.5&&frames>=2&&v.videoWidth>0&&v.videoHeight>0)finish('advanced-1.5s');
                            else if(performance.now()-t0>30000)finish('timeout')},100);
                          v.onerror=()=>finish('media-error');v.src=src;v.play().catch(e=>finish(e.name||'play-rejected'));
                        ''',source)
                        row['playbackPass']=(row['playback']['reason']=='advanced-1.5s' and row['playback']['muted']
                            and row['playback']['presentedFrames']>=2 and row['playback']['width']>0 and row['playback']['height']>0)
                        row['minimum1080pPass']=row['playbackPass'] and min(row['playback']['width'],row['playback']['height'])>=1080
            except Exception as e:
                row['status']='harness-error';row['error']=str(e)[:500]
            finally:
                row['elapsedMs']=round((time.monotonic()-started)*1000)
                report['cases'].append(row)
                (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
                print(json.dumps({'site':row['site'],'status':row['status'],'ms':row['elapsedMs'],'boxes':len(row.get('selection',{}).get('boxes',[])),
                                  'receipt':row.get('receipt',{}).get('deliveredVideos'),'error':row.get('error')},ensure_ascii=True),flush=True)
    finally:driver.quit()

if __name__=='__main__':main()
