"""Actual signed Tampermonkey manager, isolated silent/private/headless Firefox."""
import base64
import importlib.util
import json
import sys
import time
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By

base='http://127.0.0.1:17896'
out=Path('E:/Pong Benchmarks/v3006-public-recall/tampermonkey-manager')
out.mkdir(parents=True,exist_ok=True)
options=Options();options.add_argument('-headless');options.add_argument('-private')
options.page_load_strategy='eager'
for key,value in {'media.volume_scale':'0.0','media.autoplay.default':5,'permissions.default.microphone':2,'permissions.default.camera':2,'browser.privatebrowsing.autostart':True}.items():options.set_preference(key,value)
driver=webdriver.Firefox(options=options);driver.set_page_load_timeout(25)
report={'manager':'Tampermonkey 5.5.0 (Mozilla signed XPI)','private':True,'headless':True,'silent':True,'sites':[]}
# Only grant individual public fixture media hosts in this temporary profile.
approved_hosts=set()
qualified=json.loads(Path('E:/Pong Benchmarks/v3006-public-recall/userscript-qualified/discovery.json').read_text(encoding='utf-8'))
for fixture in qualified['sites']:
    for bundle in (fixture.get('recall') or {}).get('genericBundles',[]):
        for video in bundle.get('videos',[]):
            approved_hosts.add(urlsplit(video.get('videoUrl','')).hostname)
def approve_fixture_prompt(page_handle,row):
    for handle in driver.window_handles:
        if handle==page_handle:continue
        driver.switch_to.window(handle)
        if not driver.current_url.startswith('moz-extension:') or '/ask.html' not in driver.current_url:continue
        bodies=driver.find_elements(By.TAG_NAME,'body')
        if not bodies:continue
        body=bodies[0].text
        if 'DESTINATION URL' not in body:continue
        destination=body.split('DESTINATION URL',1)[1].strip().splitlines()[0].strip()
        controls=driver.find_elements(By.CSS_SELECTOR,'input,button')
        row.setdefault('permissions',[]).append({'destination':destination,'allowed':urlsplit(destination).hostname in approved_hosts})
        if urlsplit(destination).hostname in approved_hosts:
            temporary=[e for e in controls if (e.get_dom_attribute('value') or e.text).strip()=='Temporarily allow']
            if temporary:temporary[0].click()
    driver.switch_to.window(page_handle)
try:
    addon=Path('E:/Pong Benchmarks/v3006-public-recall/tampermonkey-5.5.0.xpi')
    driver.execute('INSTALL_ADDON',{'addon':base64.b64encode(addon.read_bytes()).decode(),'temporary':True,'allowPrivateBrowsing':True})
    time.sleep(2)
    driver.set_page_load_timeout(6)
    try:driver.get(base+'/universal-video-scraper.user.js')
    except Exception as error:report['installerNavigationWarning']=str(error)[:200]
    time.sleep(3)
    tabs=[];installer_handle=None
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        entry={'url':driver.current_url}
        if driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url:installer_handle=handle
        try:
            entry['body']=driver.find_element(By.TAG_NAME,'body').text[:2200]
            entry['buttons']=[{'tag':e.tag_name,'text':e.text[:80],'value':e.get_dom_attribute('value'),'id':e.get_dom_attribute('id')} for e in driver.find_elements(By.CSS_SELECTOR,'button,input,a')]
        except Exception as error:entry['error']=str(error)[:500]
        tabs.append(entry)
    report['installer']=tabs
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    if not installer_handle:raise RuntimeError('No actual Tampermonkey installer opened')
    driver.switch_to.window(installer_handle)
    install=[e for e in driver.find_elements(By.CSS_SELECTOR,'button,input') if e.text.strip()=='Install' or e.get_dom_attribute('value')=='Install']
    if not install:
        print(json.dumps(tabs),flush=True)
        raise RuntimeError('Install control was not found')
    install[0].click();time.sleep(2)
    driver.switch_to.window(driver.window_handles[0]);driver.set_page_load_timeout(25)
    report['installed']=True
    cases=json.loads(Path('E:/Pong Benchmarks/v3006-public-recall/fastlane-manifest.json').read_text(encoding='utf-8'))
    for case in cases:
        row={**case};report['sites'].append(row)
        try:
            try:driver.get(case['url'])
            except Exception as error:row['navigationWarning']=str(error)[:100]
            deadline=time.perf_counter()+8
            while not driver.find_elements(By.ID,'uvs-recall-open') and time.perf_counter()<deadline:time.sleep(.2)
            row['pageTitle']=driver.title
            page_handle=driver.current_window_handle
            clicked=time.perf_counter()
            driver.execute_script("document.dispatchEvent(new CustomEvent('pong:universal-video-recall',{detail:{mode:'main',channel:1,ignoreUnder30:false}}))")
            while time.perf_counter()-clicked<18:
                if len(driver.window_handles)>1:approve_fixture_prompt(page_handle,row)
                with urllib.request.urlopen(base+'/simpcity/recall?channel=1&consume=0',timeout=5) as response:state=json.load(response)
                capture=state.get('mediaCapture') or {}
                if capture.get('sourceUrl')==driver.current_url:
                    if capture.get('deliveredVideos') and 'firstDeliveredMs' not in row:row['firstDeliveredMs']=round((time.perf_counter()-clicked)*1000)
                    row['capture']=capture;row['recall']=state.get('recall')
                    if capture.get('state') in ('complete','empty'):break
                time.sleep(.1)
            row['captureMs']=round((time.perf_counter()-clicked)*1000)
            row['status']=driver.find_element(By.ID,'uvs-recall-status').text
        except Exception as error:row['error']=str(error)[:500]
        (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'site':row['site'],'ms':row.get('captureMs'),'videos':row.get('capture',{}).get('deliveredVideos'),'error':row.get('error')}),flush=True)
        if not row.get('capture'):
            report['blockedTabs']=[]
            for handle in driver.window_handles:
                driver.switch_to.window(handle)
                diagnostic={'url':driver.current_url}
                try:diagnostic['body']=driver.find_element(By.TAG_NAME,'body').text[:2500]
                except Exception as error:diagnostic['error']=str(error)[:120]
                report['blockedTabs'].append(diagnostic)
            print(json.dumps(report['blockedTabs']),flush=True)
            break
finally:
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    driver.quit()
