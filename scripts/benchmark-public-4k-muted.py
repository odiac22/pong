"""Headless Firefox muted decode of two public Pexels 4K sources; not Recall UI."""
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

SOURCES=[
    ('pexels-8379044','https://videos.pexels.com/video-files/8379044/8379044-uhd_3840_2160_25fps.mp4'),
    ('pexels-8774211','https://videos.pexels.com/video-files/8774211/8774211-uhd_3840_2160_25fps.mp4'),
    ('pexels-3248785','https://videos.pexels.com/video-files/3248785/3248785-uhd_3840_2160_25fps.mp4'),
]
out=Path(sys.argv[1]);out.parent.mkdir(parents=True,exist_ok=True)
options=Options();options.add_argument('-headless');options.add_argument('-private')
for key,value in {'media.volume_scale':'0.0','media.autoplay.default':0,'media.autoplay.allow-muted':True,
                  'browser.privatebrowsing.autostart':True}.items():options.set_preference(key,value)
report=json.loads(out.read_text(encoding='utf-8')) if out.exists() else {
    'scope':'Direct public 4K source decode in private headless Firefox; not userscript/Recall/Pong playback',
    'silent':True,'cases':[]}
driver=webdriver.Firefox(options=options);driver.set_script_timeout(35)
try:
    for name,url in SOURCES:
        if any(case['name']==name for case in report['cases']):continue
        try:
            driver.get('about:blank')
            playback=driver.execute_async_script('''
              const src=arguments[0],done=arguments[arguments.length-1];
              const v=document.createElement('video');v.style.cssText='width:400px;height:225px';
              v.muted=true;v.defaultMuted=true;v.volume=0;v.playsInline=true;
              document.body.appendChild(v);const t0=performance.now();let finished=false,playResolved=false;
              const finish=reason=>{if(finished)return;finished=true;clearInterval(timer);const row={reason,
                elapsedMs:Math.round(performance.now()-t0),mediaTime:v.currentTime,
                width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,
                networkState:v.networkState,paused:v.paused,playResolved,error:v.error?.code||0,
                muted:v.muted&&v.defaultMuted&&v.volume===0};
                v.pause();v.removeAttribute('src');v.load();v.remove();done(row)};
              const timer=setInterval(()=>{v.muted=true;v.volume=0;if(v.currentTime>=1.5)finish('advanced-1.5s');
                else if(performance.now()-t0>30000)finish('timeout')},100);
              v.onerror=()=>finish('media-error');v.src=src;
              v.play().then(()=>{playResolved=true}).catch(e=>finish(e.name||'play-rejected'));
            ''',url)
            report['cases'].append({'name':name,'url':url,'playback':playback,
                'passed':playback['reason']=='advanced-1.5s' and playback['muted'] and playback['width']>=3840 and playback['height']>=2160})
        except Exception as error:
            report['cases'].append({'name':name,'url':url,'error':str(error)[:400],'passed':False})
        out.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'name':name,'passed':report['cases'][-1]['passed'],
                          'playback':report['cases'][-1].get('playback')},ensure_ascii=True),flush=True)
finally:driver.quit()
