"""Read-only, silent/headless YouTube DOM check. Never sends to live Recall."""
import json
import sys
from pathlib import Path
from time import monotonic
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

options = Options()
options.add_argument('-headless'); options.add_argument('-private')
options.set_preference('media.volume_scale', '0.0')
options.set_preference('media.autoplay.default', 5)
options.set_preference('media.autoplay.allow-muted', False)
options.set_preference('media.autoplay.blocking_policy', 2)
options.page_load_strategy = 'eager'
driver = webdriver.Firefox(options=options)
driver.set_window_size(500, 1000)
driver.set_page_load_timeout(35)
out = ROOT / 'artifacts/youtube-selection-7.19.0'
out.mkdir(parents=True, exist_ok=True)
try:
    started = monotonic()
    driver.get('https://m.youtube.com/watch?v=guSAAJaSG84')
    WebDriverWait(driver, 20).until(lambda _: driver.execute_script("return !!document.querySelector('video,#movie_player,#player-container-id')"))
    driver.execute_script("""
      document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0;});
      HTMLMediaElement.prototype.play=function(){return Promise.reject(Error('Playback forbidden in test'));};
      window.GM_getValue=(key,value)=>value;window.GM_setValue=()=>{};
      window.GM_registerMenuCommand=()=>{};window.GM_notification=()=>{};
      window.GM_setClipboard=t=>window.copied=t;
      window.GM_xmlhttpRequest=()=>{throw Error('Unexpected network request during selection');};
    """)
    driver.execute_script((ROOT/'universal-video-scraper.user.js').read_text(encoding='utf-8'))
    driver.execute_async_script('const done=arguments[0];setTimeout(done,2500)')
    diagnostic = driver.execute_script("try { UniversalVideoScraper.openTargetPreview('all',1,false);return {ok:true,url:location.href}; } catch(e) {return {error:e.message,stack:e.stack};}")
    print(json.dumps(diagnostic), flush=True)
    WebDriverWait(driver, 5).until(lambda _: driver.execute_script("return !!document.querySelector('#uvs-target-preview')"))
    driver.execute_async_script('const done=arguments[0];setTimeout(done,1000)')
    report = driver.execute_script("""
      document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0;});
      const targets=UniversalVideoScraper.collectSelectableTargets('all');
      return {url:location.href,title:document.title,duration:UniversalVideoScraper.extractPageDurationSeconds(document),
        targets:targets.map(t=>({kind:t.kind,durationSeconds:t.durationSeconds,videoId:UniversalVideoScraper.youtubeVideoId(t.url),tag:t.element?.tagName,width:t.element?.getBoundingClientRect().width,height:t.element?.getBoundingClientRect().height})),
        boxes:[...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.box')].map(b=>({text:b.textContent,hidden:b.hidden,style:b.getAttribute('style'),rect:b.getBoundingClientRect().toJSON()})),
        videoRect:document.querySelector('video')?.getBoundingClientRect().toJSON(),
        controls:[...document.querySelector('#uvs-target-preview').shadowRoot.querySelectorAll('.bar button')].map(b=>b.textContent),
        media:[...document.querySelectorAll('video,audio')].map(v=>({paused:v.paused,muted:v.muted,currentTime:v.currentTime}))};
    """)
    report['elapsedSeconds'] = round(monotonic()-started, 2)
    (out/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    driver.save_screenshot(str(out/'selection.png'))
    assert report['duration']==975, report['duration']
    assert any(t['kind']=='player' and t['durationSeconds']==975 and t['width']>0 for t in report['targets']), report['targets']
    assert report['controls']==['Send','Copy log']
    assert all(m['paused'] and m['muted'] for m in report['media'])
    print(json.dumps({'passed':True,'duration':report['duration'],'targets':len(report['targets']),'relatedIds':list(dict.fromkeys(t['videoId'] for t in report['targets'] if t['kind']=='link' and t['videoId']))[:3],'report':str(out/'report.json')}))
finally:
    driver.quit()
