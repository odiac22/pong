"""Check the real Pong Recall player on an isolated server, headless and silent.

This does not submit or consume Recall; it presses the app's Recall 1 button
against the already-present isolated queue. Do not point it at a live server.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:17929')
ap.add_argument('--out', required=True)
ap.add_argument('--seconds', type=int, default=40)
ap.add_argument('--progressive-hls', action='store_true')
args = ap.parse_args()
if args.base.rstrip('/') != 'http://127.0.0.1:17929':
    raise ValueError('Only the isolated port 17929 is allowed')
options = Options()
options.add_argument('-headless')
options.add_argument('-private')
options.page_load_strategy = 'eager'
for key, value in {
    'media.volume_scale': '0.0', 'media.autoplay.default': 0,
    'media.autoplay.allow-muted': True,
    'browser.privatebrowsing.autostart': True,
    'permissions.default.microphone': 2, 'permissions.default.camera': 2,
}.items():
    options.set_preference(key, value)
driver = webdriver.Firefox(options=options)
driver.set_page_load_timeout(25)
report = {'base': args.base, 'scope': 'isolated real Pong controller, fresh private headless Firefox, audio disabled', 'samples': []}
try:
    driver.get(args.base + '/pong')
    driver.execute_script('''
      localStorage.setItem('pong_random40_local_endpoint_v1', location.origin);
      window.pongIsolatedDiagnostics=[];
      const record=(kind,detail)=>window.pongIsolatedDiagnostics.push({atMs:Math.round(performance.now()),kind,detail});
      const originalFetch=window.fetch;
      window.fetch=async function(...args){
        const url=String(args[0]?.url||args[0]||'');
        try{const response=await originalFetch(...args);
          if(url.includes('/generic-media/hls'))record('fetch',{url:url.slice(0,400),status:response.status});
          return response;
        }catch(e){if(url.includes('/generic-media/hls'))record('fetch-error',{url:url.slice(0,400),error:e.name});throw e}
      };
      const originalOpen=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(method,url,...args){
        this.__pongIsolatedUrl=String(url||'');return originalOpen.call(this,method,url,...args)
      };
      const originalSend=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send=function(...args){
        if(this.__pongIsolatedUrl?.includes('/generic-media/hls'))this.addEventListener('loadend',()=>record('xhr',{
          url:this.__pongIsolatedUrl.slice(0,400),status:this.status,responseBytes:this.response?.byteLength||0
        }),{once:true});
        return originalSend.apply(this,args)
      };
      const silence = () => document.querySelectorAll('video,audio').forEach(v => {
        v.muted=true;v.defaultMuted=true;v.volume=0;
      });
      silence();new MutationObserver(silence).observe(document.documentElement,{subtree:true,childList:true});
    ''')
    if args.progressive_hls:
        driver.execute_script('''
          if(!window.Hls?.isSupported?.())throw Error('hls.js unavailable');
          const Original=window.Hls;
          window.Hls=class ProgressiveHls extends Original {
            constructor(config){super({...config,progressive:true})}
          };
        ''')
        report['hlsVariant'] = 'experimental progressive=true injected before Recall; not production code'
    # Pong's canvas can cover the menu in a desktop-size headless viewport;
    # invoke the actual Recall button handler without altering app code.
    driver.execute_script("document.getElementById('simpcity-recall-1').click()")
    started = time.monotonic()
    while time.monotonic() - started < args.seconds:
        sample = driver.execute_script('''
          const v=document.querySelector('#video-container video');
          if(v){v.muted=true;v.defaultMuted=true;v.volume=0}
          if(v?.__pongHls&&!v.__pongIsolatedObserved){
            v.__pongIsolatedObserved=true;
            const h=v.__pongHls;
            for(const event of ['ERROR','MANIFEST_PARSED','LEVEL_LOADED','FRAG_LOADED','FRAG_BUFFERED','BUFFER_APPENDED']){
              const name=window.Hls?.Events?.[event];if(!name)continue;
              h.on(name,(_,data)=>window.pongIsolatedDiagnostics.push({atMs:Math.round(performance.now()),kind:event,
                detail:{fatal:!!data?.fatal,type:String(data?.type||''),details:String(data?.details||''),
                  level:String(data?.level??''),fragLevel:String(data?.frag?.level??''),
                  fragSn:String(data?.frag?.sn??''),code:String(data?.response?.code??'')}}));
            }
          }
          if(v&&!v.dataset.pongIsolatedPlayRequested){
            v.dataset.pongIsolatedPlayRequested='true';v.muted=true;v.volume=0;
            v.play().catch(e=>{v.dataset.pongIsolatedPlayError=e.name});
          }
          if(v?.paused&&v.__pongHls&&performance.now()-Number(v.dataset.pongIsolatedLastRetry||0)>5000){
            v.dataset.pongIsolatedLastRetry=String(performance.now());
            v.play().catch(e=>{v.dataset.pongIsolatedPlayError=e.name});
          }
          return {atMs:Math.round(performance.now()),recallVideos:document.documentElement.dataset.pongRecallVideos||'',
            text:(document.querySelector('#video-container')?.innerText||'').slice(0,300),
            src:v?.currentSrc||v?.src||'',time:v?.currentTime||0,width:v?.videoWidth||0,
            height:v?.videoHeight||0,readyState:v?.readyState||0,error:v?.error?.code||0,
            paused:v?.paused,muted:v?!!v.muted&&v.volume===0:null,
            playError:v?.dataset.pongIsolatedPlayError||'',
            videoCount:document.querySelectorAll('#video-container video').length,
            hlsLevel:v?.__pongHls?.loadLevel,hlsLevels:v?.__pongHls?.levels?.map(l=>`${l.width}x${l.height}`)||[]};
        ''')
        report['samples'].append(sample)
        if sample['time'] >= 1.5 and sample['muted']:
            report['passed'] = True
            break
        time.sleep(.5)
    report.setdefault('passed', False)
    report['elapsedMs'] = round((time.monotonic() - started)*1000)
    report['diagnostics'] = driver.execute_script('return window.pongIsolatedDiagnostics||[]')[-250:]
finally:
    driver.quit()
    path=Path(args.out);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(report, indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','diagnostics')} | {
        'finalSample':report['samples'][-1] if report['samples'] else None,
        'diagnostics':report.get('diagnostics',[])[-15:]}),flush=True)
