"""Silent public-site userscript audit. Never opens adult fixtures or touches live Recall.

Firefox uses the production userscript in the existing GM compatibility extension;
this is explicitly not a claim that the installed Tampermonkey manager was tested.
"""
import argparse
import base64
import importlib.util
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

SITES = [
    ('pexels', 'https://www.pexels.com/search/videos/people/'),
    ('pixabay', 'https://pixabay.com/videos/search/people/'),
    ('mixkit', 'https://mixkit.co/free-stock-video/portrait/'),
    ('coverr', 'https://coverr.co/stock-video-footage/people'),
    ('videezy', 'https://www.videezy.com/free-video/people'),
    ('vecteezy', 'https://www.vecteezy.com/free-videos/people'),
    ('mazwai', 'https://mazwai.com/'),
    ('dareful', 'https://dareful.com/'),
    ('youtube', 'https://www.youtube.com/results?search_query=pexels+people+stock+footage'),
    ('archive', 'https://archive.org/details/prelinger?tab=collection'),
    ('wikimedia', 'https://commons.wikimedia.org/wiki/Category:Videos_of_people'),
    ('nasa', 'https://plus.nasa.gov/'),
    ('esa', 'https://www.esa.int/ESA_Multimedia/Videos'),
    ('ted', 'https://www.ted.com/talks'),
    ('vimeo', 'https://vimeo.com/creativecommons/by'),
]

DISCOVER = r"""
const api=window.UniversalVideoScraper;
document.dispatchEvent(new Event('pong:benchmark-inspect'));
const bridge=JSON.parse(document.documentElement.dataset.pongBenchmarkInspect||'{}');
const anchors=[...document.querySelectorAll('a[href]')].map(a=>({url:a.href,title:(a.getAttribute('title')||a.innerText||a.querySelector('img')?.alt||'').trim().replace(/\s+/g,' ').slice(0,240)}));
const unique=[...new Map(anchors.map(a=>[a.url,a])).values()];
return {url:location.href,title:document.title,body:document.body?.innerText.slice(0,1200),
 scriptReady:!!api||!!bridge.ready, panel:!!document.getElementById('uvs-recall-capture'), targets:bridge.targets||api?.collectLogicalWatchPageTargets(document,location.href,80)||[],
 links:unique.filter(a=>{try{return new URL(a.url).hostname.replace(/^www\./,'')===location.hostname.replace(/^www\./,'')}catch{return false}}),
 videos:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc||v.src,duration:v.duration,width:v.videoWidth,height:v.videoHeight})),
 main:bridge.main||api?.primaryMediaEntriesFromDoc(document,location.href)||[],
 duration:bridge.duration||api?.extractPageDurationSeconds(document)||0};
"""

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--site', action='append')
    parser.add_argument('--manifest')
    parser.add_argument('--userscript')
    parser.add_argument('--mode', choices=['main','all'], default='main')
    parser.add_argument('--base',default='http://127.0.0.1:17887')
    args=parser.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    spec=importlib.util.spec_from_file_location('qualification',ROOT/'scripts/qualify-universal-video-recall.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    # Reuse the existing GM bridge, but direct it ONLY to the isolated benchmark server.
    original=helper._extension_archive(out)
    with zipfile.ZipFile(original) as z:
        contents={n:z.read(n) for n in z.namelist()}
    contents['content.js']=contents['content.js'].replace(b"http://127.0.0.1:8787",args.base.encode())
    if args.userscript:
        text=contents['content.js'].decode()
        text=text[:text.index('// ==UserScript==')]+Path(args.userscript).read_text(encoding='utf-8')
        contents['content.js']=text.replace('http://127.0.0.1:8787',args.base).encode()
    contents['content.js']+=b"\ndocument.addEventListener('pong:benchmark-inspect',()=>{const a=window.UniversalVideoScraper;document.documentElement.dataset.pongBenchmarkInspect=JSON.stringify({ready:!!a,targets:a?.collectLogicalWatchPageTargets(document,location.href,80)||[],main:a?.primaryMediaEntriesFromDoc(document,location.href)||[],duration:a?.extractPageDurationSeconds(document)||0});});"
    extension=out/'isolated-userscript.xpi'
    with zipfile.ZipFile(extension,'w',zipfile.ZIP_DEFLATED) as z:
        for n,data in contents.items():z.writestr(n,data)
    options=Options();options.add_argument('-headless');options.add_argument('-private')
    options.page_load_strategy='eager'
    options.set_preference('extensions.allowPrivateBrowsingByDefault',True)
    for key,value in {'media.volume_scale':'0.0','media.autoplay.default':5,'permissions.default.microphone':2,'permissions.default.camera':2,'dom.webnotifications.enabled':False,'browser.privatebrowsing.autostart':True}.items():options.set_preference(key,value)
    driver=webdriver.Firefox(options=options)
    driver.set_page_load_timeout(25);driver.set_script_timeout(20)
    report={'silent':True,'headless':True,'private':True,'manager':'Firefox GM compatibility harness, not Tampermonkey manager','sites':[]}
    try:
        driver.execute('INSTALL_ADDON',{'addon':base64.b64encode(extension.read_bytes()).decode('ascii'),'temporary':True,'allowPrivateBrowsing':True})
        cases=json.loads(Path(args.manifest).read_text(encoding='utf-8')) if args.manifest else [{'site':n,'url':u} for n,u in SITES]
        for case in cases:
            name,url=case['site'],case['url']
            if args.site and name not in args.site:continue
            start=time.perf_counter();row={**case,'requestedUrl':url}
            try:
                try:driver.get(url)
                except Exception as e:row['navigationWarning']=str(e)[:250]
                time.sleep(1)
                row.update(driver.execute_script(DISCOVER))
                ready_deadline=time.perf_counter()+5
                while not row.get('scriptReady') and time.perf_counter()<ready_deadline:
                    time.sleep(.2)
                    row.update(driver.execute_script(DISCOVER))
                (out/(name+'-'+str(case.get('ordinal','listing'))+'.html')).write_text(driver.page_source,encoding='utf-8')
                if args.manifest:
                    if not row.get('scriptReady'):raise RuntimeError('Userscript did not run')
                    clicked=time.perf_counter()
                    row['mode']=args.mode
                    driver.execute_script("document.dispatchEvent(new CustomEvent('pong:universal-video-recall',{detail:{mode:arguments[0],channel:1,ignoreUnder30:false}}))",args.mode)
                    first=None
                    while time.perf_counter()-clicked<40:
                        with urllib.request.urlopen(args.base+'/simpcity/recall?channel=1&consume=0',timeout=5) as response:state=json.load(response)
                        capture=state.get('mediaCapture') or {}
                        if capture.get('sourceUrl')==driver.current_url:
                            count=capture.get('deliveredVideos',0)
                            if count and first is None:first=round((time.perf_counter()-clicked)*1000)
                            row['capture']=capture;row['recall']=state.get('recall')
                            if capture.get('state') in ('complete','empty'):break
                        time.sleep(.15)
                    row['captureMs']=round((time.perf_counter()-clicked)*1000);row['firstDeliveredMs']=first
                    row['diagnostics']=driver.execute_script("return {panel:document.querySelector('#uvs-recall-status')?.textContent,attempts:document.documentElement.dataset.uvsCaptureDiagnostics}")
            except Exception as e:row['error']=str(e)[:500]
            row['elapsedMs']=round((time.perf_counter()-start)*1000)
            report['sites'].append(row)
            (out/'discovery.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            print(json.dumps({'site':name,'ms':row['elapsedMs'],'targets':len(row.get('targets',[])),'links':len(row.get('links',[])),'script':row.get('scriptReady'),'title':row.get('title'),'error':row.get('error')}),flush=True)
    finally:driver.quit()

if __name__=='__main__':main()
