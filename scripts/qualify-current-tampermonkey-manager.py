"""Signed Tampermonkey qualification in silent private Firefox, isolated Recall.

Only public benign video pages are visited. The script under test is the
production userscript snapshot with its endpoint changed to port 17930 only.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools/selenium'))
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.by import By

arguments = argparse.ArgumentParser()
arguments.add_argument('--out', default=r'E:\Pong Benchmarks\v3031-tampermonkey-current-touch')
arguments.add_argument('--base', default='http://127.0.0.1:17931')
arguments.add_argument('--manifest')
arguments.add_argument('--live-current', action='store_true',
                       help='Test the unchanged live userscript; refuses a nonempty or active Recall 1')
args = arguments.parse_args()
OUT = Path(args.out)
REPORT = OUT / 'signed-manager'
BASE = args.base.rstrip('/')
if args.live_current and BASE != 'http://127.0.0.1:8787':
    raise RuntimeError('Live-current qualification is limited to the existing local helper')
XPI = Path(r'E:\Pong Benchmarks\v3006-public-recall\tampermonkey-5.5.0.xpi')
SNAP = OUT / 'server' / 'universal-video-scraper.user.js'
PROD = ROOT / 'universal-video-scraper.user.js'
SITES = [
    ('Pixabay', 'https://pixabay.com/videos/people-commerce-shop-busy-mall-6387/'),
]
if args.manifest:
    SITES = [(item['site'], item['url']) for item in json.loads(Path(args.manifest).read_text(encoding='utf-8'))]
TOUCH_CASE = True


def touch_tap(driver, element):
    actions = ActionBuilder(driver, mouse=PointerInput('touch', 'qualification-finger'))
    actions.pointer_action.move_to(element)
    actions.pointer_action.pointer_down()
    actions.pointer_action.pause(.08)
    actions.pointer_action.pointer_up()
    actions.perform()


def safe_host(url):
    return (urlsplit(url).hostname or '').lower()


def logical_page_url(url):
    """Match the page URL sent by the userscript after the server strips its fragment."""
    parts = urlsplit(url)
    if parts.scheme.lower() != 'https' or not parts.hostname:
        return ''
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or '/', parts.query, ''))


def capture_started_at(capture):
    value = capture.get('startedAt')
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return stamp.replace(tzinfo=timezone.utc).timestamp() if stamp.tzinfo is None else stamp.timestamp()
    except ValueError:
        return None


def matching_receipt(state, prior_capture, sent_at, expected_page_url):
    """Return only a new capture for this exact page and matching Recall payload."""
    capture = state.get('mediaCapture') or {}
    recall_payload = state.get('recall') or {}
    capture_id = capture.get('id')
    if not capture_id or capture_id == (prior_capture or {}).get('id'):
        return None
    if recall_payload.get('id') != capture_id:
        return None
    expected = logical_page_url(expected_page_url)
    if not expected or logical_page_url(capture.get('sourceUrl', '')) != expected:
        return None
    started = capture_started_at(capture)
    prior_started = capture_started_at(prior_capture or {})
    if capture.get('startedAt') and started is None:
        return None
    if started is not None and (started < sent_at - 1 or
                                (prior_started is not None and started <= prior_started)):
        return None
    return capture, recall_payload


def recall():
    with urllib.request.urlopen(BASE + '/simpcity/recall?channel=1&consume=0', timeout=5) as response:
        return json.load(response)


def snapshot_proof():
    original = PROD.read_text(encoding='utf-8')
    if args.live_current:
        with urllib.request.urlopen(BASE + '/universal-video-scraper.user.js', timeout=5) as response:
            served = response.read().decode('utf-8').replace('\r\n', '\n')
        if served != original:
            raise RuntimeError('Live served userscript differs from current source')
        return {'productionSha256': hashlib.sha256(original.encode()).hexdigest(),
                'servedMatchesProduction': True, 'onlyEndpointSubstitution': False}
    isolated = SNAP.read_text(encoding='utf-8')
    needle = ": ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];"
    replacement = ": ['" + BASE + "'];"
    if original.count(needle) != 1 or isolated != original.replace(needle, replacement):
        raise RuntimeError('Isolated userscript differs from production beyond endpoint substitution')
    return {'productionSha256': hashlib.sha256(original.encode()).hexdigest(),
            'isolatedSha256': hashlib.sha256(isolated.encode()).hexdigest(),
            'onlyEndpointSubstitution': True}


def require_empty_live_recall(state):
    if args.live_current and (state.get('recall') or state.get('pending') or
                             (state.get('mediaCapture') or {}).get('state') == 'running'):
        raise RuntimeError('Live Recall 1 is not empty/idle; no test capture was submitted')


def inspect_permission_prompts(driver, main_handle, row):
    for handle in driver.window_handles:
        if handle == main_handle:
            continue
        driver.switch_to.window(handle)
        if not (driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url):
            continue
        body = driver.find_element(By.TAG_NAME, 'body').text
        if 'DESTINATION URL' not in body:
            continue
        destination = body.split('DESTINATION URL', 1)[1].strip().splitlines()[0].strip()
        host = safe_host(destination)
        allowed = host in {'127.0.0.1', 'localhost', 'www.w3schools.com', 'www.nps.gov', 'www.pexels.com',
                           'www.w3.org', 'media.w3.org', 'plus.nasa.gov'} or host in {safe_host(url) for _, url in SITES}
        row.setdefault('permissions', []).append({'host': host, 'allowed': allowed})
        if allowed:
            controls = driver.find_elements(By.CSS_SELECTOR, 'input,button')
            temporary = [e for e in controls if (e.get_dom_attribute('value') or e.text).strip() == 'Temporarily allow']
            if temporary:
                temporary[0].click()
    driver.switch_to.window(main_handle)


def shadow_state(driver):
    return driver.execute_script("""
      const h=document.getElementById('uvs-target-preview');
      const s=h?.shadowRoot;
      return {open:!!h, boxes:s?.querySelectorAll('.box[data-target]').length||0,
        selected:s?.querySelectorAll('.box[data-target][aria-pressed="true"]').length||0,
        sendEnabled:!!s?.querySelector('[data-do="send"]:not([disabled])'),
        status:s?.querySelector('.status')?.textContent||''};
    """)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.mkdir(parents=True, exist_ok=True)
    report = {'manager': 'signed Tampermonkey 5.5.0 XPI', 'private': True,
              'headless': True, 'audioForcedOffBeforeOpen': True,
              'endpoint': BASE, 'snapshotProof': snapshot_proof(), 'sites': []}
    require_empty_live_recall(recall())
    report['liveCurrent'] = args.live_current
    # Health check also proves the isolated listener is present before browser use.
    with urllib.request.urlopen(BASE + '/health', timeout=5) as response:
        report['isolatedHealthStatus'] = response.status
    options = webdriver.FirefoxOptions()
    options.add_argument('-headless')
    options.add_argument('-private')
    options.page_load_strategy = 'eager'
    for key, value in {
        'media.volume_scale': '0.0', 'media.autoplay.default': 5,
        'media.autoplay.blocking_policy': 2,
        'permissions.default.microphone': 2, 'permissions.default.camera': 2,
        'browser.privatebrowsing.autostart': True,
        'dom.w3c_touch_events.enabled': 1,
    }.items():
        options.set_preference(key, value)
    driver = webdriver.Firefox(options=options)
    driver.set_page_load_timeout(20)
    try:
        result = driver.execute('INSTALL_ADDON', {'addon': base64.b64encode(XPI.read_bytes()).decode(),
                                                  'temporary': True, 'allowPrivateBrowsing': True})
        report['addonInstallResult'] = bool(result)
        time.sleep(2)
        driver.set_page_load_timeout(6)
        try:
            driver.get(BASE + '/universal-video-scraper.user.js')
        except Exception as exc:
            report['installerNavigationWarning'] = type(exc).__name__
        time.sleep(3)
        installer = None
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            if driver.current_url.startswith('moz-extension:') and '/ask.html' in driver.current_url:
                installer = handle
                break
        if not installer:
            report['installerFound'] = False
            return
        report['installerFound'] = True
        controls = driver.find_elements(By.CSS_SELECTOR, 'button,input')
        install = [e for e in controls if e.text.strip() == 'Install' or e.get_dom_attribute('value') == 'Install']
        if not install:
            report['installControlFound'] = False
            return
        report['installControlFound'] = True
        install[0].click()
        time.sleep(2)
        main_handle = driver.window_handles[0]
        driver.switch_to.window(main_handle)
        driver.set_page_load_timeout(20)
        for label, url in SITES:
            row = {'site': label, 'host': safe_host(url), 'pageUrl': url, 'startedAt': time.time()}
            navigation_started = time.monotonic()
            report['sites'].append(row)
            try:
                try:
                    driver.get(url)
                except Exception as exc:
                    row['navigationWarning'] = type(exc).__name__
                if label.lower() == 'pixabay':
                    time.sleep(3)
                    row['playerReadiness'] = driver.execute_script("""
                      return {videoCount:document.querySelectorAll('video').length,
                        videos:[...document.querySelectorAll('video')].slice(0,3).map(v=>({
                          readyState:v.readyState,networkState:v.networkState,
                          currentSrcHost:(()=>{try{return new URL(v.currentSrc).hostname}catch{return ''}})(),
                          srcHost:(()=>{try{return new URL(v.getAttribute('src')||'').hostname}catch{return ''}})()
                        }))};
                    """)
                if label.lower() in {'nasa+', 'nasa'}:
                    openers = driver.find_elements(By.CSS_SELECTOR,
                        'a.poster-wrapper-link[data-open-modal][aria-controls="fullscreen-player"]')
                    row['mainPosterOpenerFound'] = bool(openers)
                    if not openers:
                        continue
                    touch_tap(driver, openers[0])
                    row['mainPosterOpenMethod'] = 'WebDriver touch pointer'
                    modal_deadline = time.monotonic() + 12
                    while time.monotonic() < modal_deadline:
                        visible = driver.execute_script("""
                          const modal=document.querySelector('.usa-modal.video-modal');
                          const player=modal?.querySelector('.video-js');
                          const shown=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);
                            return r.width>100&&r.height>100&&s.visibility==='visible'&&s.display!=='none';};
                          return shown(modal)&&shown(player);
                        """)
                        if visible:
                            break
                        time.sleep(.2)
                    row['modalPlayerVisible'] = bool(visible)
                    if not visible:
                        continue
                    row['mainModalMedia'] = driver.execute_script("""
                      const player=document.querySelector('.usa-modal.video-modal .video-js');
                      const video=player?.querySelector('video');
                      const players=Object.values(window.videojs?.getPlayers?.()||{});
                      return {currentSrc:video?.currentSrc||'',src:video?.getAttribute('src')||'',
                        sourceUrls:[...(player?.querySelectorAll('source')||[])].map(s=>s.src).filter(Boolean),
                        videoJsSources:players.flatMap(p=>[p.currentSource?.()?.src||'']).filter(Boolean),
                        manifestRequests:performance.getEntriesByType('resource').map(e=>e.name)
                          .filter(u=>/\.m3u8(?:[?#]|$)/i.test(u)).slice(-8)};
                    """)
                row['landedHost'] = safe_host(driver.current_url)
                deadline = time.monotonic() + 12
                while not driver.find_elements(By.ID, 'uvs-recall-open') and time.monotonic() < deadline:
                    time.sleep(.2)
                launcher = driver.find_elements(By.ID, 'uvs-recall-open')
                row['launcherFound'] = bool(launcher)
                row['navigationToLauncherMs'] = round((time.monotonic() - navigation_started) * 1000)
                if not launcher:
                    continue
                root = driver.find_element(By.ID, 'uvs-recall-capture')
                before = root.rect
                ActionChains(driver).click_and_hold(launcher[0]).move_by_offset(45, -35).release().perform()
                after = root.rect
                row['launcherDragMoved'] = abs(after['x'] - before['x']) > 10 or abs(after['y'] - before['y']) > 10
                time.sleep(.6)
                launcher[0].click()
                deadline = time.monotonic() + 8
                while not shadow_state(driver)['open'] and time.monotonic() < deadline:
                    time.sleep(.2)
                row['preview'] = shadow_state(driver)
                if not row['preview']['boxes']:
                    continue
                if label in {'Pixabay', 'Pexels'}:
                    time.sleep(1)
                    if not shadow_state(driver)['open']:
                        row['previewDisappeared'] = True
                        again = driver.find_elements(By.ID, 'uvs-recall-open')
                        if again:
                            again[0].click()
                            time.sleep(.5)
                        row['previewAfterReopen'] = shadow_state(driver)
                if TOUCH_CASE:
                    driver.execute_script("""
                      const b=document.getElementById('uvs-target-preview')?.shadowRoot?.querySelector('.box[data-target="1"]');
                      if(b && !b.hidden){const r=b.getBoundingClientRect();window.scrollBy(0,r.top+r.height/2-innerHeight/2);}
                    """)
                    time.sleep(.5)
                if not shadow_state(driver)['open']:
                    row['previewMissingAfterScroll'] = True
                    again = driver.find_elements(By.ID, 'uvs-recall-open')
                    if again:
                        again[0].click()
                        time.sleep(.5)
                    row['previewAfterScrollReopen'] = shadow_state(driver)
                for attempt in range(4):
                    visible_count = driver.execute_script("return [...document.getElementById('uvs-target-preview').shadowRoot.querySelectorAll('.box[data-target]')].filter(b=>!b.hidden).length")
                    if visible_count:
                        break
                    driver.execute_script('window.scrollBy(0, Math.round(window.innerHeight * .8))')
                    time.sleep(.5)
                row['visibleBoxes'] = visible_count
                row['boxHitTests'] = driver.execute_script("""
                  const s=document.getElementById('uvs-target-preview').shadowRoot;
                  return [...s.querySelectorAll('.box[data-target]')].map(b=>{
                    const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                    const stack=s.elementsFromPoint(x,y).slice(0,5);
                    return {id:b.dataset.target,hidden:b.hidden,rect:{x:r.x,y:r.y,w:r.width,h:r.height},
                      top:stack.map(e=>({tag:e.tagName,cls:e.className||'',target:e.dataset?.target||''})),
                      selfHit:stack[0]===b || stack[0]?.closest?.('.box[data-target]')===b};
                  });
                """)
                box = driver.execute_script("""
                  const s=document.getElementById('uvs-target-preview').shadowRoot;
                  return [...s.querySelectorAll('.box[data-target]')].find(b=>{
                    if(b.hidden)return false; const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                    const top=s.elementFromPoint(x,y); return top===b || top?.closest?.('.box[data-target]')===b;
                  }) || [...s.querySelectorAll('.box[data-target]')].find(b=>!b.hidden);
                """)
                if not box:
                    row['noVisibleBox'] = True
                    continue
                row['chosenBoxId'] = box.get_dom_attribute('data-target')
                driver.execute_script("""
                  window.__uvsTapEvents=[];
                  for(const b of document.getElementById('uvs-target-preview').shadowRoot.querySelectorAll('.box[data-target]')){
                    for(const type of ['pointerdown','pointerup','touchstart','touchend','click'])
                      b.addEventListener(type,e=>window.__uvsTapEvents.push({type,isTrusted:e.isTrusted,pointerType:e.pointerType||'',target:b.dataset.target}),true);
                  }
                """)
                if TOUCH_CASE:
                    try:
                        touch_tap(driver, box)
                        row['selectionMethod'] = 'WebDriver touch pointer'
                    except Exception as exc:
                        row['touchSelectionError'] = type(exc).__name__ + ': ' + str(exc)[:120]
                    row['tapEvents'] = driver.execute_script('return window.__uvsTapEvents || []')
                    row['afterSelection'] = shadow_state(driver)
                    if not row['afterSelection']['sendEnabled']:
                        continue
                    send = driver.execute_script("return document.getElementById('uvs-target-preview').shadowRoot.querySelector('[data-do=send]')")
                    prior_state = recall()
                    require_empty_live_recall(prior_state)
                    prior_capture = (prior_state.get('mediaCapture') or {}).copy()
                    expected_page_url = driver.current_url
                    sent_at = time.time()
                    send_started = time.monotonic()
                    try:
                        touch_tap(driver, send)
                        row['sendMethod'] = 'WebDriver touch pointer'
                    except Exception as exc:
                        row['touchSendError'] = type(exc).__name__ + ': ' + str(exc)[:120]
                    deadline = time.monotonic() + 45
                    while time.monotonic() < deadline:
                        inspect_permission_prompts(driver, main_handle, row)
                        state = recall()
                        match = matching_receipt(state, prior_capture, sent_at, expected_page_url)
                        if match:
                            capture, recall_payload = match
                            row['receipt'] = {'state': capture.get('state'),
                                              'deliveredVideos': capture.get('deliveredVideos'),
                                              'sourcePageMatches': True,
                                              'newCaptureId': capture['id'],
                                              'recallIdMatches': True,
                                              'startedAt': capture.get('startedAt')}
                            if row.get('acceptedMs') is None:
                                row['acceptedMs'] = round((time.monotonic() - send_started) * 1000)
                            bundles = recall_payload.get('genericBundles') or []
                            row['videos'] = [v for bundle in bundles for v in (bundle.get('videos') or [])]
                            row['recallPayload'] = state
                            if row['videos'] and row.get('readyMs') is None:
                                row['readyMs'] = round((time.monotonic() - send_started) * 1000)
                                row['readyBasis'] = 'new capture has Recall video metadata'
                            if capture.get('state') in {'complete', 'empty'}:
                                break
                        time.sleep(.25)
                    row['afterSend'] = shadow_state(driver)
                    continue
                try:
                    ActionChains(driver).click(box).perform()
                    row['selectionMethod'] = 'WebDriver pointer'
                except Exception as exc:
                    row['pointerSelectionWarning'] = type(exc).__name__
                if not shadow_state(driver)['selected']:
                    driver.execute_script('arguments[0].click()', box)
                    row['selectionMethod'] = 'DOM click fallback'
                row['afterSelection'] = shadow_state(driver)
                if not row['afterSelection']['sendEnabled']:
                    continue
                send = driver.execute_script("return document.getElementById('uvs-target-preview').shadowRoot.querySelector('[data-do=send]')")
                prior_capture = (recall().get('mediaCapture') or {}).copy()
                expected_page_url = driver.current_url
                sent_at = time.time()
                send_started = time.monotonic()
                try:
                    ActionChains(driver).click(send).perform()
                    row['sendMethod'] = 'WebDriver pointer'
                except Exception as exc:
                    row['pointerSendWarning'] = type(exc).__name__
                    driver.execute_script('arguments[0].click()', send)
                    row['sendMethod'] = 'DOM click fallback'
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    inspect_permission_prompts(driver, main_handle, row)
                    state = recall()
                    match = matching_receipt(state, prior_capture, sent_at, expected_page_url)
                    if match:
                        capture, recall_payload = match
                        row['receipt'] = {
                            'state': capture.get('state'),
                            'deliveredVideos': capture.get('deliveredVideos'),
                            'sourcePageMatches': True,
                            'newCaptureId': capture['id'],
                            'recallIdMatches': True,
                            'startedAt': capture.get('startedAt'),
                        }
                        if row.get('acceptedMs') is None:
                            row['acceptedMs'] = round((time.monotonic() - send_started) * 1000)
                        bundles = recall_payload.get('genericBundles') or []
                        row['videos'] = [v for bundle in bundles for v in (bundle.get('videos') or [])]
                        if row['videos'] and row.get('readyMs') is None:
                            row['readyMs'] = round((time.monotonic() - send_started) * 1000)
                            row['readyBasis'] = 'new capture has Recall video metadata'
                        if capture.get('state') in {'complete', 'empty'}:
                            break
                    time.sleep(.25)
                row['afterSend'] = shadow_state(driver)
            except Exception as exc:
                row['error'] = type(exc).__name__ + ': ' + str(exc)[:180]
            finally:
                row['elapsedMs'] = round((time.monotonic() - navigation_started) * 1000)
                (REPORT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
                print(json.dumps({'site': label, 'launcher': row.get('launcherFound'),
                                  'boxes': row.get('preview', {}).get('boxes'),
                                  'selected': row.get('afterSelection', {}).get('selected'),
                                  'receipt': row.get('receipt'), 'error': row.get('error')}), flush=True)
    finally:
        (REPORT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        driver.quit()


if __name__ == '__main__':
    main()
