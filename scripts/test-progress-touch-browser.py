"""Exercise the production progress listeners on inert DOM in silent headless Firefox."""
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

html = (ROOT/'index.html').read_text(encoding='utf-8')
start = html.index('    let pendingProgressSeek = null;')
block = html[start:html.index("    const tapArea = document.createElement('div');", start)]
options = Options(); options.add_argument('-headless'); options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0'); options.set_preference('media.autoplay.default', 5)
driver = webdriver.Firefox(options=options)
driver.set_window_size(500, 800)
try:
    driver.get('about:blank')
    report = driver.execute_script('''
      document.body.innerHTML='<div id="bar" style="position:absolute;left:0;width:400px;height:8px"><div id="fill"></div><div id="handle"></div></div>';
      const progressBar=document.querySelector('#bar'), progressFill=document.querySelector('#fill'), scrubberHandle=document.querySelector('#handle');
      const calls={seeks:[],suspend:0,resume:0}; const video={currentTime:7}; const wrapper={};
      document.progressTestCalls=calls;
      const window={};
      const pongFaceSwapFullDuration=()=>100, isPongFaceSwapManagedMedia=()=>true;
      const suspendPongFaceSwapForScrub=()=>calls.suspend++,resumePongFaceSwapAfterScrub=()=>calls.resume++;
      const seekPongVideoTo=(_w,_v,time)=>calls.seeks.push(time);
      eval(arguments[0]);
      const fire=(type,x)=>{const e=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperty(e,'touches',{value:[{clientX:x,clientY:20}]});
        Object.defineProperty(e,'changedTouches',{value:[{clientX:x,clientY:20}]});
        progressBar.dispatchEvent(e);};
      const tap=x=>{fire('touchstart',x);fire('touchend',x);};
      const checks=[];const check=(v,name)=>{if(!v)throw Error(name);checks.push(name);};
      tap(200);check(calls.seeks.length===0 && calls.suspend===0,'Single touch does not seek or pause');
      progressBar.dispatchEvent(new MouseEvent('mousedown',{clientX:200,bubbles:true,cancelable:true}));
      progressBar.dispatchEvent(new MouseEvent('click',{clientX:200,bubbles:true,cancelable:true}));
      check(calls.seeks.length===0,'Synthetic mouse events cannot bypass protection');
      tap(208);check(calls.seeks.length===1 && calls.seeks[0]===52,'Double touch commits exact target once');
      tap(210);check(calls.seeks.length===1,'Third touch cannot reuse consumed double tap');
      tap(216);check(calls.seeks.length===2 && calls.seeks[1]===54,'Fourth touch completes a new pair');
      tap(350);check(calls.seeks.length===2,'Immediate far-away third tap after double tap does not seek');
      progressBar.dispatchEvent(new MouseEvent('click',{clientX:300,bubbles:true,cancelable:true}));
      check(calls.seeks.length===2,'Trailing compatibility click never jumps');
      fire('touchstart',80);fire('touchmove',120);fire('touchmove',300);fire('touchend',300);
      check(calls.seeks.length===2 && calls.suspend===2,'Single-contact bar slide does not seek or suspend');
      check(video.currentTime===7,'Managed fragment currentTime never changed directly');
      fire('touchstart',100);fire('touchmove',160);fire('touchcancel',160);
      check(calls.seeks.length===2 && calls.resume===0,'Cancelled bar slide never changes playback ownership');
      check(!document.body.classList.contains('scrubbing-active'),'No stuck scrolling lock');
      return {version:'30.12',checks,calls,scope:'Inert real DOM events; no media created or played; not a physical touch test'};
    ''', block)
    # Actual headless-browser mouse actions, not just synthetic DOM events.
    # Wait out touch compatibility suppression without playing any media.
    driver.execute_async_script('const done=arguments[0];setTimeout(done,750)')
    bar=driver.find_element('id','bar')
    before=driver.execute_script('return document.progressTestCalls.seeks.length')
    ActionChains(driver).move_to_element(bar).click().pause(.05).click().pause(.05).click().perform()
    assert driver.execute_script('return document.progressTestCalls.seeks.length') == before+1, 'Third real mouse click reused consumed pair'
    report['checks'].append('Actual browser double click followed by third click seeks once')
    driver.execute_async_script('const done=arguments[0];setTimeout(done,400)')
    ActionChains(driver).click().perform()
    assert driver.execute_script('return document.progressTestCalls.seeks.length') == before+1, 'Expired single real mouse click sought'
    report['checks'].append('Later single real mouse click still does not seek')
    report['calls']=driver.execute_script('return document.progressTestCalls')
    out = ROOT/'artifacts'/'pong-30.12'
    out.mkdir(parents=True, exist_ok=True)
    (out/'touch-browser.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'passed':len(report['checks']),'report':str(out/'touch-browser.json')}))
finally:
    driver.quit()
