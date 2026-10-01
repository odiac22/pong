"""Silent, sanitized actual-Pong HLS check on a dedicated isolated Recall 1."""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:17929')
parser.add_argument('--out', required=True)
parser.add_argument('--seconds', type=int, default=45)
parser.add_argument('--progressive-hls', action='store_true')
args = parser.parse_args()
if args.base.rstrip('/') != 'http://127.0.0.1:17929':
    raise ValueError('Only the dedicated isolated port 17929 is allowed')

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
report = {'scope': 'actual isolated Pong Recall 1 HLS player, headless private silent Firefox; signed URLs excluded',
          'samples': []}
try:
    driver.get(args.base + '/pong')
    driver.execute_script('''
      localStorage.setItem('pong_random40_local_endpoint_v1', location.origin);
      window.pongHlsAudit=[];window.pongHlsEvents=[];
      const originalFetch=window.fetch;
      window.fetch=async function(...args){
        const raw=String(args[0]?.url||args[0]||'');
        const started=performance.now();
        const response=await originalFetch(...args);
        if(raw.includes('/generic-media/hls'))window.pongHlsAudit.push({
          suffix:new URL(raw,location.href).pathname.split('.').pop().slice(0,12),
          status:response.status,elapsedMs:Math.round(performance.now()-started),
          contentLength:Number(response.headers.get('content-length')||0),
          ranged:response.headers.get('x-pong-hls-range')==='bounded',
          contentType:String(response.headers.get('content-type')||'').split(';')[0]});
        return response;
      };
      const originalOpen=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(method,url,...args){
        const value=String(url||'');
        this.__pongHlsAudit=value.includes('/generic-media/hls') ?
          {started:performance.now(), suffix:new URL(value,location.href).pathname.split('.').pop().slice(0,12)} : null;
        return originalOpen.call(this,method,url,...args)
      };
      const originalSend=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send=function(...args){
        if(this.__pongHlsAudit)this.addEventListener('loadend',()=>{
          const item=this.__pongHlsAudit;
          window.pongHlsAudit.push({suffix:item.suffix,status:this.status,
            elapsedMs:Math.round(performance.now()-item.started),
            responseBytes:this.response?.byteLength||0,
            contentLength:Number(this.getResponseHeader('content-length')||0),
            ranged:this.getResponseHeader('x-pong-hls-range')==='bounded',
            contentType:String(this.getResponseHeader('content-type')||'').split(';')[0]});
        },{once:true});
        return originalSend.apply(this,args)
      };
      const silence=()=>document.querySelectorAll('video,audio').forEach(v=>{
        v.muted=true;v.defaultMuted=true;v.volume=0;
      });
      silence();new MutationObserver(silence).observe(document.documentElement,{subtree:true,childList:true});
    ''')
    if args.progressive_hls:
        driver.execute_script('''
          if(!window.Hls?.isSupported?.())throw Error('hls.js progressive experiment unavailable');
          const Original=window.Hls;
          window.Hls=class ProgressiveHls extends Original {
            constructor(config){super({...config,progressive:true})}
          };
        ''')
        report['hlsVariant'] = 'experimental progressive=true; only constructor config differs'
    driver.execute_script("document.getElementById('simpcity-recall-1').click()")
    started = time.monotonic()
    while time.monotonic() - started < args.seconds:
        sample = driver.execute_script('''
          const v=document.querySelector('#video-container video');
          if(v){v.muted=true;v.defaultMuted=true;v.volume=0}
          if(v?.__pongHls&&!v.dataset.pongAuditObserved){
            v.dataset.pongAuditObserved='true';
            const h=v.__pongHls;
            for(const event of ['ERROR','MANIFEST_PARSED','LEVEL_LOADED','FRAG_LOADED','FRAG_BUFFERED','BUFFER_APPENDED']){
              const name=window.Hls?.Events?.[event];if(!name)continue;
              h.on(name,(_,data)=>window.pongHlsEvents.push({atMs:Math.round(performance.now()),kind:event,
                fatal:!!data?.fatal,type:String(data?.type||''),details:String(data?.details||''),
                code:Number(data?.response?.code||0)}));
            }
          }
          if(v?.paused&&performance.now()-Number(v.dataset.pongAuditLastRetry||0)>5000){
            v.dataset.pongAuditLastRetry=String(performance.now());
            v.play().catch(e=>{v.dataset.pongAuditPlayError=e.name});
          }
          return {atMs:Math.round(performance.now()),time:v?.currentTime||0,
            width:v?.videoWidth||0,height:v?.videoHeight||0,
            readyState:v?.readyState||0,error:v?.error?.code||0,
            paused:v?.paused,playError:v?.dataset.pongAuditPlayError||'',
            muted:v?!!v.muted&&v.volume===0:null,
            hlsLevel:v?.__pongHls?.loadLevel,
            hlsProgressive:v?.__pongHls?.config?.progressive||false,
            hlsLoader:v?.__pongHls?.config?.loader?.name||'',
            hlsLevels:v?.__pongHls?.levels?.map(l=>`${l.width}x${l.height}`)||[]};
        ''')
        report['samples'].append(sample)
        if sample['time'] >= 3 and sample['muted']:
            break
        time.sleep(.25)
    report['elapsedMs'] = round((time.monotonic() - started) * 1000)
    report['requests'] = driver.execute_script('return window.pongHlsAudit||[]')
    report['events'] = driver.execute_script('return window.pongHlsEvents||[]')
    report['passed'] = bool(report['samples'] and report['samples'][-1]['time'] >= 3
                            and report['samples'][-1]['muted']
                            and report['samples'][-1]['width'] == 3840
                            and report['samples'][-1]['height'] == 2160)
finally:
    driver.quit()
    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report.get('passed', False), 'elapsedMs': report.get('elapsedMs'),
                      'finalSample': report['samples'][-1] if report['samples'] else None,
                      'requests': report.get('requests', [])[-20:],
                      'events': report.get('events', [])[-20:]}), flush=True)
