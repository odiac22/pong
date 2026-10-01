from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".tools" / "selenium"))

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait


CASES = (
    {
        "name": "pexels-main-5935550",
        "url": "https://www.pexels.com/video/girl-friends-posing-for-selfies-5935550/",
        "mode": "main",
        "expected": 1,
        "duration": 13,
        "minimumDurationSeconds": 1,
    },
    {
        "name": "suj-main-9933",
        "url": "https://m.suj.mobi/en/scene/guy_thought_his_girlfriend_brought_a_victim_for_a_threesome_video_9933",
        "mode": "main",
        "expected": 1,
        "duration": 2213,
    },
    {"name": "suj-lia-lor", "url": "https://m.suj.mobi/en/actor/lia_lor", "mode": "all", "expected": 8},
    {"name": "porneec-home", "url": "https://porneec.com/", "mode": "all", "expected": 30},
    {"name": "pornhub-model", "url": "https://www.pornhub.com/model/tiktok-sluts", "mode": "all", "expected": 21},
    {"name": "pornhub-watch-all", "url": "https://www.pornhub.com/view_video.php?viewkey=6687ec7433e18", "mode": "all", "expected": 20},
    {"name": "pornhub-watch-main", "url": "https://www.pornhub.com/view_video.php?viewkey=6687ec7433e18", "mode": "main", "expected": 1, "duration": 853},
    {"name": "hqporner-russian", "url": "https://m.hqporner.com/category/russian", "mode": "all", "expected": 46},
    {"name": "hqporner-cumatozz", "url": "https://m.hqporner.com/actress/cumatozz", "mode": "all", "expected": 8},
)

SILENCE = r"""
window.pongUserWantsAudio = false;
for (const media of document.querySelectorAll('video,audio')) {
  try { media.pause(); } catch (_) {}
  media.muted = true;
  media.defaultMuted = true;
  media.volume = 0;
}
return true;
"""

PLAY_ONE = r"""
const index = Number(arguments[0]);
const seconds = Number(arguments[1]);
const done = arguments[arguments.length - 1];
window.pongUserWantsAudio = false;
const snapshot = typeof window.PongRecallPlaybackSnapshot === 'function'
  ? window.PongRecallPlaybackSnapshot()
  : {urls:[],metadata:[]};
const main = String((snapshot.urls || [])[index] || '');
const metadata = (snapshot.metadata || [])[index] || {};
let mediaHost = '';
let pageKey = '';
try { mediaHost = new URL(metadata.canonicalMediaUrl || main, location.href).hostname; } catch (_) {}
try { pageKey = new URL(metadata.postUrl || '', location.href).pathname.split('/').filter(Boolean).at(-1) || ''; } catch (_) {}
const candidates = [...new Set([
  main,
  ...(Array.isArray(metadata.videoSources) ? metadata.videoSources.map(item => item?.playbackUrl) : [])
].map(value => String(value || '')).filter(Boolean))];
const attemptSource = source => new Promise(resolve => {
  const video = document.createElement('video');
  video.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:.001;pointer-events:none';
  document.body.appendChild(video);
  video.muted = true; video.defaultMuted = true; video.volume = 0;
  video.playsInline = true; video.preload = 'auto';
  const started = performance.now();
  let firstPlaying = 0;
  let firstMedia = null;
  let lastMedia = null;
  let lastProgressAt = performance.now();
  let maximumGapMs = 0;
  let waits = 0;
  let settled = false;
  const cleanup = result => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    video.remove();
    resolve(result);
  };
  video.addEventListener('playing', () => { if (!firstPlaying) firstPlaying = performance.now(); });
  video.addEventListener('waiting', () => { waits++; });
  video.addEventListener('stalled', () => { waits++; });
  video.addEventListener('error', () => cleanup({ok:false, reason:`media-${video.error?.code || 'error'}`}));
  video.src = new URL(source, location.href).href;
  try { video.load(); } catch (_) {}
  Promise.resolve(video.play()).catch(error => cleanup({ok:false, reason:String(error?.name || error)}));
  const timer = setInterval(() => {
    video.muted = true; video.defaultMuted = true; video.volume = 0;
    const now = performance.now();
    const current = Number(video.currentTime || 0);
    if (firstMedia === null && current > 0) firstMedia = current;
    if (lastMedia === null || current > lastMedia + .01) {
      maximumGapMs = Math.max(maximumGapMs, now - lastProgressAt);
      lastProgressAt = now;
      lastMedia = current;
    }
    const advance = firstMedia === null ? 0 : Math.max(0, current - firstMedia);
    if (advance >= seconds) {
      cleanup({
        ok:true,
        startupMs:Math.round((firstPlaying || now) - started),
        wallMs:Math.round(now - started),
        mediaAdvance:Number(advance.toFixed(3)),
        waits,
        maximumGapMs:Math.round(maximumGapMs),
        duration:Number.isFinite(video.duration) ? Number(video.duration) : 0,
        videoWidth:Number(video.videoWidth || 0),
        videoHeight:Number(video.videoHeight || 0),
        currentSrc:String(video.currentSrc || video.src || source),
        muted:video.muted && video.defaultMuted && Number(video.volume) === 0
      });
      return;
    }
    const startupExpired = firstMedia === null && now - started > 15000;
    const playbackStalled = firstMedia !== null && now - lastProgressAt > 4500;
    if (startupExpired || playbackStalled || now - started > Math.max(45000, seconds * 2500)) {
      cleanup({
        ok:false,
        reason: startupExpired ? 'startup-timeout' : playbackStalled ? 'stalled' : 'timeout',
        mediaAdvance:Number(advance.toFixed(3)), waits,
        readyState:video.readyState, networkState:video.networkState,
        duration:Number.isFinite(video.duration) ? Number(video.duration) : 0
      });
    }
  }, 200);
});
(async () => {
  const failures = [];
  for (let sourceIndex = 0; sourceIndex < candidates.length; sourceIndex++) {
    const result = await attemptSource(candidates[sourceIndex]);
    if (result.ok) return done({...result, index, sourceIndex, mediaHost, pageKey});
    failures.push(result.reason || 'failed');
  }
  done({ok:false,index,reason:failures.join(',') || 'no-source',mediaHost,pageKey});
})().catch(error => done({ok:false,index,reason:String(error?.message || error)}));
"""


def _extension_archive(target: Path) -> Path:
    userscript = (ROOT / "universal-video-scraper.user.js").read_text(encoding="utf-8")
    manifest = {
        "manifest_version": 2,
        "name": "Pong Recall Qualification Harness",
        "version": "7.14.0",
        "browser_specific_settings": {"gecko": {"id": "pong-recall-qualification@local"}},
        "incognito": "spanning",
        "permissions": ["<all_urls>", "webRequest"],
        "background": {"scripts": ["background.js"], "persistent": True},
        "content_scripts": [{"matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle"}],
    }
    background = r"""
browser.runtime.onMessage.addListener(async message => {
  if (message?.kind !== 'pong-gm-xhr') return null;
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(120000, Number(message.timeout || 30000)));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(message.headers || {});
  const referer = headers.get('referer') || '';
  headers.delete('referer');
  const options = {
    method: String(message.method || 'GET').toUpperCase(),
    headers,
    redirect: 'follow',
    credentials: 'include',
    cache: 'no-store',
    signal: controller.signal
  };
  if (!['GET','HEAD'].includes(options.method) && message.data !== undefined) options.body = message.data;
  if (referer) options.referrer = referer;
  try {
    const response = await fetch(message.url, options);
    const responseHeaders = [...response.headers].map(([key,value]) => `${key}: ${value}`).join('\r\n');
    if (message.responseType === 'arraybuffer') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {status:response.status, responseHeaders, finalUrl:response.url, bytes:[...bytes]};
    }
    return {status:response.status, responseHeaders, finalUrl:response.url, responseText:await response.text()};
  } finally {
    clearTimeout(timeout);
  }
});
"""
    prelude = r"""
const unsafeWindow = window;
globalThis.PONG_LOCAL_ENDPOINTS = ['http://127.0.0.1:8787'];
const __pongValues = new Map();
function GM_getValue(key, fallback) { return __pongValues.has(key) ? __pongValues.get(key) : fallback; }
function GM_setValue(key, value) { __pongValues.set(key, value); }
function GM_setClipboard() {}
function GM_registerMenuCommand() {}
function GM_notification() {}
function GM_addStyle(css) { const style=document.createElement('style'); style.textContent=css; document.documentElement.appendChild(style); return style; }
function GM_xmlhttpRequest(options) {
  let aborted = false;
  let controller = null;
  let timedOut = false;
  let completed = false;
  let fallbackStarted = false;
  let bridgeTimer = 0;
  const request = { abort() { aborted=true; controller?.abort(); options.onabort?.(); } };
  const payload = {
    kind:'pong-gm-xhr', method:options.method || 'GET', url:options.url,
    headers:options.headers || {}, data:options.data, responseType:options.responseType || '',
    timeout:Number(options.timeout || 30000)
  };
  const deliver = result => {
    if (aborted || completed) return;
    completed = true;
    clearTimeout(bridgeTimer);
    const response = result?.bytes
      ? new Uint8Array(result.bytes).buffer
      : result?.response
        ? result.response
      : undefined;
    options.onload?.({
      status:Number(result?.status || 0), responseHeaders:String(result?.responseHeaders || ''),
      finalUrl:String(result?.finalUrl || options.url), responseText:String(result?.responseText || ''), response
    });
  };
  const directFetch = async () => {
    if (completed || fallbackStarted) return;
    fallbackStarted = true;
    controller = new AbortController();
    const timeout = setTimeout(() => { timedOut=true; controller.abort(); }, Math.max(1000, payload.timeout));
    try {
      const headers = new Headers(payload.headers);
      const referer = headers.get('referer') || '';
      headers.delete('referer');
      const init = {
        method:String(payload.method || 'GET').toUpperCase(), headers, redirect:'follow',
        credentials:'include', cache:'no-store', signal:controller.signal
      };
      if (!['GET','HEAD'].includes(init.method) && payload.data !== undefined) init.body=payload.data;
      if (referer) init.referrer=referer;
      const response = await fetch(payload.url, init);
      const responseHeaders = [...response.headers].map(([key,value]) => `${key}: ${value}`).join('\r\n');
      if (payload.responseType === 'arraybuffer') {
        deliver({status:response.status,responseHeaders,finalUrl:response.url,response:await response.arrayBuffer()});
      } else {
        deliver({status:response.status,responseHeaders,finalUrl:response.url,responseText:await response.text()});
      }
    } catch (error) {
      if (!aborted) (timedOut ? options.ontimeout : options.onerror)?.({error:String(error)});
    } finally {
      clearTimeout(timeout);
    }
  };
  // Firefox private content-script bridges can remain pending forever instead
  // of rejecting when the temporary background page is asleep. Fall back to
  // the same privileged content-script fetch after a short bounded grace.
  bridgeTimer = setTimeout(directFetch, 750);
  browser.runtime.sendMessage(payload).then(result => {
    if (result) deliver(result);
    else directFetch();
  }).catch(directFetch);
  return request;
}
"""
    archive = target / "pong-recall-qualification.xpi"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        output.writestr("manifest.json", json.dumps(manifest))
        output.writestr("background.js", background)
        output.writestr("content.js", prelude + "\n" + userscript)
    return archive


def _json_get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _hard_mute(driver: webdriver.Firefox) -> None:
    try:
        driver.execute_script(SILENCE)
    except Exception:
        pass


def _capture(driver: webdriver.Firefox, case: dict, channel: int) -> tuple[dict, dict]:
    before = _json_get(f"http://127.0.0.1:8787/simpcity/recall?channel={channel}&consume=0")
    previous_id = str((before.get("mediaCapture") or {}).get("id") or "")
    started = time.perf_counter()
    print(json.dumps({"event": "navigate", "name": case["name"]}), flush=True)
    driver.get(case["url"])
    _hard_mute(driver)
    WebDriverWait(driver, 45).until(lambda item: item.find_elements(By.ID, "uvs-recall-capture"))
    _hard_mute(driver)
    current_url = driver.current_url
    dom_counts = driver.execute_script(
        "return {anchors:document.querySelectorAll('a[href]').length,"
        "hq:document.querySelectorAll('a[href*=\"/hdporn/\"]').length,"
        "scene:document.querySelectorAll('a[href*=\"/scene/\"]').length,"
        "porneec:document.querySelectorAll('article.thumb-block a[href]').length,"
        "api:typeof window.UniversalVideoScraper};"
    )
    print(json.dumps({"event": "userscript-ready", "name": case["name"], "finalUrl": current_url, "dom": dom_counts}), flush=True)
    redirected = current_url.rstrip("/") != case["url"].rstrip("/")
    if "pornhub.com" in case["url"] and not (
        ("model/tiktok-sluts" in current_url and "model/tiktok-sluts" in case["url"])
        or ("view_video.php" in current_url and "view_video.php" in case["url"])
    ):
        return ({
            "name": case["name"], "requestedUrl": case["url"], "finalUrl": current_url,
            "mode": case["mode"], "expected": case["expected"], "redirected": redirected,
            "blocked": True, "blockReason": "clean Firefox profile redirected away from requested Pornhub page"
        }, {})
    root = driver.find_element(By.ID, "uvs-recall-capture")
    while root.get_attribute("data-channel") != str(channel):
        driver.execute_script("arguments[0].click()", driver.find_element(By.ID, "uvs-recall-channel"))
    allow_short = float(case.get("minimumDurationSeconds", 30)) < 30
    driver.execute_script(
        "const input=document.querySelector('#uvs-recall-min30 input');"
        "if(input && input.checked===arguments[0]) input.click();",
        allow_short,
    )
    recall_clicked_at = time.perf_counter()
    driver.execute_script(
        "const root=document.getElementById('uvs-recall-capture');"
        "root.dataset.harnessMode=arguments[0];root.dataset.harnessChannel=arguments[1];"
        "document.dispatchEvent(new CustomEvent('pong:universal-video-recall',{detail:{"
        "mode:arguments[0],channel:arguments[1],ignoreUnder30:arguments[2]}}));",
        case["mode"], str(channel), not allow_short,
    )
    time.sleep(1)
    panel_state = driver.execute_script(
        "const root=document.getElementById('uvs-recall-capture');"
        "return {busy:root?.dataset?.busy||'',status:document.getElementById('uvs-recall-status')?.textContent||''};"
    )
    trigger_probe = _json_get(
        f"http://127.0.0.1:8787/simpcity/recall?channel={channel}&consume=0"
    )
    trigger_id = str((trigger_probe.get("mediaCapture") or {}).get("id") or "")
    if trigger_id == previous_id and panel_state.get("busy") != "true":
        # Firefox occasionally loses a cross-compartment custom Event after an
        # ad-heavy page rewrites document handlers. Dispatch directly on the
        # userscript-owned button without bubbling into site/ad listeners.
        driver.execute_script(
            "const button=document.querySelector('#uvs-recall-capture [data-action=\"'+arguments[0]+'\"]');"
            "if(!button) throw new Error('Recall action button is missing');"
            "button.dispatchEvent(new MouseEvent('click',{bubbles:false,cancelable:true,view:window}));",
            case["mode"],
        )
        time.sleep(1)
        panel_state = driver.execute_script(
            "const root=document.getElementById('uvs-recall-capture');"
            "return {busy:root?.dataset?.busy||'',status:document.getElementById('uvs-recall-status')?.textContent||''};"
        )
    print(json.dumps({"event": "capture-panel", "name": case["name"], **panel_state}), flush=True)
    print(json.dumps({"event": "capture-clicked", "name": case["name"], "mode": case["mode"]}), flush=True)
    capture = None
    recall = None
    delivery_milestones: list[dict] = []
    last_delivered = -1
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        snapshot = _json_get(f"http://127.0.0.1:8787/simpcity/recall?channel={channel}&consume=0")
        candidate = snapshot.get("mediaCapture") or {}
        if candidate.get("id") and candidate.get("id") != previous_id:
            capture = candidate
            recall = snapshot.get("recall") or {}
            delivered = int(candidate.get("deliveredVideos") or 0)
            if delivered != last_delivered:
                last_delivered = delivered
                delivery_milestones.append({
                    "videos": delivered,
                    "elapsedMs": round((time.perf_counter() - recall_clicked_at) * 1000),
                    "state": str(candidate.get("state") or ""),
                })
            print(json.dumps({
                "event": "capture-progress", "name": case["name"],
                "state": candidate.get("state"), "checked": candidate.get("completedPages"),
                "total": candidate.get("totalPages"), "videos": delivered
            }), flush=True)
            if candidate.get("state") in {"complete", "empty"}:
                break
        time.sleep(0.5)
    if not capture:
        raise TimeoutError(f"{case['name']}: capture did not start")
    bundle = ((recall or {}).get("genericBundles") or [{}])[0]
    videos = bundle.get("videos") or []
    durations = [max(0.0, float(item.get("durationSeconds") or 0)) for item in videos]
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    recall_complete_ms = round((time.perf_counter() - recall_clicked_at) * 1000)
    first_milestone = next((item for item in delivery_milestones if item["videos"] >= 1), None)
    fifth_milestone = next((item for item in delivery_milestones if item["videos"] >= 5), None)
    minimum = 1 if case["expected"] == 1 else math.ceil(case["expected"] * 0.90)
    maximum = 1 if case["expected"] == 1 else math.floor(case["expected"] * 1.10)
    minimum_duration = float(case.get("minimumDurationSeconds", 30))
    row = {
        "name": case["name"], "requestedUrl": case["url"], "finalUrl": current_url,
        "mode": case["mode"], "expected": case["expected"], "minimum": minimum,
        "maximum": maximum, "targetPages": int(capture.get("totalPages") or 0),
        "checkedPages": int(capture.get("completedPages") or 0), "capturedVideos": len(videos),
        "captureMs": elapsed_ms,
        "recallToFirstVideoMs": first_milestone["elapsedMs"] if first_milestone else None,
        "recallToFiveVideosMs": fifth_milestone["elapsedMs"] if fifth_milestone else None,
        "recallToCompleteMs": recall_complete_ms,
        "deliveryMilestones": delivery_milestones,
        "redirected": redirected, "blocked": False,
        "countPass": minimum <= len(videos) <= maximum,
        "minimumDurationSeconds": minimum_duration,
        "allDurationsMeetMinimum": bool(videos) and all(value >= minimum_duration for value in durations),
        "allDurationsAtLeast30": bool(videos) and all(value >= 30 for value in durations),
        "reportedDurations": durations,
    }
    raw_diagnostics = driver.execute_script("return document.documentElement.dataset.uvsCaptureDiagnostics || '[]'")
    try:
        row["captureDiagnostics"] = json.loads(raw_diagnostics)
    except Exception:
        row["captureDiagnostics"] = raw_diagnostics
    if case.get("duration"):
        row["expectedDuration"] = case["duration"]
        row["durationPass"] = bool(durations) and abs(durations[0] - case["duration"]) <= 20
    return row, {"capture": capture, "recall": recall}


def _playback(driver: webdriver.Firefox, channel: int, count: int, seconds: float) -> list[dict]:
    source_handle = driver.current_window_handle
    driver.switch_to.new_window("tab")
    pong_handle = driver.current_window_handle
    try:
        driver.get(f"http://127.0.0.1:8787/pong?pongInstance=1&pongNative=1&qualifyRecall={int(time.time() * 1000)}")
        _hard_mute(driver)
        WebDriverWait(driver, 45).until(
            lambda item: item.execute_script("return typeof startSimpCityRecall === 'function' && document.readyState !== 'loading'")
        )
        driver.set_script_timeout(700)
        recall_result = driver.execute_async_script(
            "const done=arguments[arguments.length-1];window.pongUserWantsAudio=false;"
            f"Promise.resolve(startSimpCityRecall({channel})).then(()=>done(true),e=>done(String(e)));"
        )
        loaded = int(driver.execute_script(
            "return typeof window.PongRecallPlaybackSnapshot === 'function' "
            "? window.PongRecallPlaybackSnapshot().urls.length : 0"
        ) or 0)
        print(json.dumps({"event": "pong-recall", "result": recall_result, "loaded": loaded}), flush=True)
        results = []
        for index in range(min(count, loaded)):
            attempts = []
            result = {}
            for attempt in range(1, 4):
                _hard_mute(driver)
                result = driver.execute_async_script(PLAY_ONE, index, seconds)
                attempts.append({
                    "attempt": attempt,
                    "ok": bool(result.get("ok")),
                    "reason": str(result.get("reason") or ""),
                    "startupMs": int(result.get("startupMs") or 0),
                    "mediaAdvance": float(result.get("mediaAdvance") or 0),
                })
                if result.get("ok") and result.get("muted") is True and float(result.get("mediaAdvance") or 0) >= seconds:
                    break
                time.sleep(1)
            safe = {
                "index": index,
                "ok": bool(result.get("ok")),
                "startupMs": int(result.get("startupMs") or 0),
                "wallMs": int(result.get("wallMs") or 0),
                "mediaAdvance": float(result.get("mediaAdvance") or 0),
                "waits": int(result.get("waits") or 0),
                "maximumGapMs": int(result.get("maximumGapMs") or 0),
                "duration": float(result.get("duration") or 0),
                "videoWidth": int(result.get("videoWidth") or 0),
                "videoHeight": int(result.get("videoHeight") or 0),
                "currentSrc": str(result.get("currentSrc") or ""),
                "muted": result.get("muted") is True,
                "sourceIndex": int(result.get("sourceIndex") or 0),
                "reason": str(result.get("reason") or ""),
                "mediaHost": str(result.get("mediaHost") or ""),
                "pageKey": str(result.get("pageKey") or ""),
                "attempts": attempts,
            }
            results.append(safe)
            print(json.dumps({"event": "playback", **safe}), flush=True)
            # Give Firefox and the gateway a moment to close the prior Range
            # stream before reusing the same decoder for the next logical card.
            time.sleep(0.5)
        return results
    finally:
        driver.close()
        driver.switch_to.window(source_handle)
        assert pong_handle != source_handle


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--channel", type=int, default=1, choices=(1, 2))
    parser.add_argument("--play-seconds", type=float, default=10.0)
    parser.add_argument(
        "--play-count", type=int, default=0,
        help="Limit playback qualification per site; zero checks every captured video.",
    )
    parser.add_argument("--skip-playback", action="store_true")
    parser.add_argument(
        "--output", type=Path,
        help="Write the report here instead of replacing the default qualification report.",
    )
    parser.add_argument(
        "--hold-seconds", type=float, default=0.0,
        help="Keep the muted private source browser alive so Android can exercise authenticated relay fallbacks."
    )
    args = parser.parse_args()
    selected = [case for case in CASES if not args.case or case["name"] in set(args.case)]
    if not selected:
        raise SystemExit("No matching qualification cases")

    options = Options()
    options.add_argument("-headless")
    options.add_argument("-private")
    options.page_load_strategy = "eager"
    options.set_preference("general.useragent.override", "Mozilla/5.0 (Android 14; Mobile; rv:156.0) Gecko/156.0 Firefox/156.0")
    options.set_preference("media.volume_scale", "0.0")
    options.set_preference("media.autoplay.default", 0)
    options.set_preference("media.autoplay.blocking_policy", 0)
    options.set_preference("permissions.default.microphone", 2)
    options.set_preference("permissions.default.camera", 2)
    options.set_preference("dom.webnotifications.enabled", False)
    options.set_preference("security.mixed_content.block_active_content", False)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.page", 0)

    report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cases": []}
    with tempfile.TemporaryDirectory(prefix="pong-recall-qualification-") as temp:
        extension = _extension_archive(Path(temp))
        driver = webdriver.Firefox(options=options)
        driver.set_window_size(412, 915)
        driver.set_page_load_timeout(60)
        driver.set_script_timeout(60)
        try:
            driver.install_addon(str(extension), temporary=True)
            for case in selected:
                try:
                    row, _ = _capture(driver, case, args.channel)
                    if not row.get("blocked") and not args.skip_playback and row.get("capturedVideos"):
                        playback_count = int(row["capturedVideos"])
                        if args.play_count > 0:
                            playback_count = min(playback_count, args.play_count)
                        playback = _playback(
                            driver, args.channel, playback_count, args.play_seconds
                        )
                        row["playback"] = playback
                        row["playbackRequested"] = playback_count
                        row["playbackPass"] = len(playback) == playback_count and all(
                            item["ok"] and item["muted"] and item["mediaAdvance"] >= args.play_seconds
                            for item in playback
                        )
                    report["cases"].append(row)
                    print(json.dumps({"event": "case", **row}), flush=True)
                    if args.hold_seconds > 0:
                        hold_until = time.monotonic() + args.hold_seconds
                        print(json.dumps({
                            "event": "source-browser-held",
                            "name": case["name"],
                            "seconds": args.hold_seconds
                        }), flush=True)
                        while time.monotonic() < hold_until:
                            _hard_mute(driver)
                            time.sleep(min(1.0, max(0.0, hold_until - time.monotonic())))
                except Exception as error:
                    row = {"name": case["name"], "requestedUrl": case["url"], "mode": case["mode"], "error": str(error)}
                    report["cases"].append(row)
                    print(json.dumps({"event": "case-error", **row}), flush=True)
        finally:
            driver.quit()
    report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    output = args.output.resolve() if args.output else ROOT / "artifacts" / "universal-video-recall-qualification.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    failed = [row for row in report["cases"] if row.get("error") or row.get("blocked") or not row.get("countPass") or not row.get("allDurationsMeetMinimum") or (not args.skip_playback and not row.get("playbackPass")) or row.get("durationPass") is False]
    print(json.dumps({"report": str(output), "passed": len(report["cases"]) - len(failed), "failed": len(failed)}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
