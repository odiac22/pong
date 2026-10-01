import json
import itertools
import os
import queue
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("PONG_FIREFOX_SCRAPER_PORT", "18801"))
HEADLESS = os.environ.get("PONG_FIREFOX_HEADLESS", "1") != "0"
IDLE_SECONDS = 15 * 60
BATCH_LIMIT = max(1, min(20, int(os.environ.get("PONG_FIREFOX_BATCH_LIMIT", "20"))))
MIN_BATCH_GAP_SECONDS = max(0.1, float(os.environ.get("PONG_FIREFOX_BATCH_GAP_SECONDS", "1.0")))
ALLOWED_HOSTS = {"coomerfans.com", "www.coomerfans.com"}
VERIFY_RE = re.compile(r"checking your browser|verifying you are human|verify you are human", re.I)
requests_queue = queue.PriorityQueue()
request_sequence = itertools.count()
browser_lock = threading.Lock()
browser = None
last_used = 0.0
next_batch_at = 0.0


class FetchTask:
    def __init__(self, url):
        self.url = url
        self.event = threading.Event()
        self.status = 502
        self.html = ""
        self.error = "Firefox fetch failed"


def enqueue_task(task, priority=0):
    safe_priority = max(-1000, min(1000, int(priority or 0)))
    requests_queue.put((-safe_priority, next(request_sequence), task))


def allowed_url(raw):
    try:
        value = urlparse(raw)
        return value.scheme == "https" and value.hostname in ALLOWED_HOSTS
    except Exception:
        return False


def stop_browser():
    global browser
    with browser_lock:
        current = browser
        browser = None
    if current is not None:
        try:
            current.quit()
        except Exception:
            pass


def ensure_browser():
    global browser, last_used
    with browser_lock:
        if browser is not None:
            return browser
        # Import Selenium only in the single process that owns the listening
        # socket. Failed duplicate launches then exit before loading WebDriver.
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
        options = Options()
        if HEADLESS:
            options.add_argument("-headless")
        options.add_argument("-private")
        options.set_preference("browser.privatebrowsing.autostart", True)
        options.set_preference("media.volume_scale", "0.0")
        options.set_preference("media.autoplay.default", 5)
        options.set_preference("media.autoplay.blocking_policy", 2)
        options.set_preference("permissions.default.microphone", 2)
        options.set_preference("permissions.default.camera", 2)
        driver = webdriver.Firefox(options=options)
        if not HEADLESS:
            try:
                driver.set_window_position(-32000, -32000)
                driver.minimize_window()
            except Exception:
                pass
        driver.set_page_load_timeout(30)
        driver.set_script_timeout(35)
        driver.get("https://coomerfans.com/")
        deadline = time.time() + 20
        while VERIFY_RE.search(f"{driver.title} {driver.page_source[:8000]}") and time.time() < deadline:
            time.sleep(0.5)
        if VERIFY_RE.search(f"{driver.title} {driver.page_source[:8000]}"):
            driver.quit()
            raise RuntimeError("Firefox remained on the verification page")
        browser = driver
        last_used = time.time()
        return browser


FETCH_SCRIPT = r"""
const urls = arguments[0];
const done = arguments[arguments.length - 1];
Promise.all(urls.map(async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      credentials: 'include', cache: 'no-store', signal: controller.signal
    });
    return {url, status: response.status, html: await response.text()};
  } catch (error) {
    return {url, status: 0, html: '', error: String(error && error.message || error)};
  } finally {
    clearTimeout(timer);
  }
})).then(done, error => done(urls.map(url => ({
  url, status: 0, html: '', error: String(error && error.message || error)
}))));
"""


def browser_worker():
    global last_used, next_batch_at
    while True:
        try:
            first_item = requests_queue.get(timeout=5)
        except queue.Empty:
            if browser is not None and time.time() - last_used >= IDLE_SECONDS:
                stop_browser()
            continue
        batch_items = [first_item]
        batch = [first_item[2]]
        time.sleep(0.025)
        # Match the proven userscript's twenty-wide batch, but pace sustained
        # batches one second apart. The former unpaced succession produced a
        # 429 only after four fast artists; the inter-batch floor prevents that
        # burst accumulation without serializing the twenty post fetches.
        while len(batch) < BATCH_LIMIT:
            try:
                item = requests_queue.get_nowait()
                batch_items.append(item)
                batch.append(item[2])
            except queue.Empty:
                break
        try:
            driver = ensure_browser()
            remaining_gap = next_batch_at - time.monotonic()
            if remaining_gap > 0:
                time.sleep(remaining_gap)
            rows = driver.execute_async_script(FETCH_SCRIPT, [task.url for task in batch])
            saw_rate_limit = any(
                isinstance(row, dict) and int(row.get("status") or 0) == 429
                for row in rows
            )
            next_batch_at = time.monotonic() + (5.0 if saw_rate_limit else MIN_BATCH_GAP_SECONDS)
            by_url = {str(row.get("url", "")): row for row in rows if isinstance(row, dict)}
            for task in batch:
                row = by_url.get(task.url, {})
                task.status = int(row.get("status") or 502)
                task.html = str(row.get("html") or "")
                task.error = str(row.get("error") or "")
                if VERIFY_RE.search(task.html[:12000]):
                    task.status = 503
                    task.error = "Firefox received a verification page"
            last_used = time.time()
        except Exception as error:
            stop_browser()
            for task in batch:
                task.status = 502
                task.error = str(error)
        finally:
            for task in batch:
                task.event.set()
            for _item in batch_items:
                requests_queue.task_done()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def send_bytes(self, status, body, content_type="text/plain; charset=utf-8"):
        data = body if isinstance(body, bytes) else str(body).encode("utf-8", "replace")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        request_url = urlparse(self.path)
        if request_url.path == "/health":
            self.send_bytes(200, json.dumps({
                "ok": True,
                "browserRunning": browser is not None,
                "queued": requests_queue.qsize(),
                "idleShutdownSeconds": IDLE_SECONDS,
            }), "application/json; charset=utf-8")
            return
        if request_url.path != "/fetch":
            self.send_bytes(404, "not found")
            return
        raw_url = (parse_qs(request_url.query).get("url") or [""])[0]
        if not allowed_url(raw_url):
            self.send_bytes(400, "invalid target")
            return
        task = FetchTask(raw_url)
        enqueue_task(task, (parse_qs(request_url.query).get("priority") or [0])[0])
        if not task.event.wait(45):
            self.send_bytes(504, "Firefox fetch timed out")
            return
        if task.status < 200 or task.status >= 300:
            self.send_bytes(task.status if 400 <= task.status <= 599 else 502, task.error or "upstream failure")
            return
        self.send_bytes(200, task.html, "text/html; charset=utf-8")

    def do_POST(self):
        request_url = urlparse(self.path)
        if request_url.path != "/fetch-batch":
            self.send_bytes(404, "not found")
            return
        try:
            length = min(64 * 1024, max(0, int(self.headers.get("Content-Length", "0"))))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            urls = list(dict.fromkeys(str(value) for value in payload.get("urls", [])))[:20]
            priority = int(payload.get("priority") or 0)
        except Exception:
            self.send_bytes(400, json.dumps({"ok": False, "error": "invalid JSON"}), "application/json; charset=utf-8")
            return
        if not urls or any(not allowed_url(value) for value in urls):
            self.send_bytes(400, json.dumps({"ok": False, "error": "invalid target"}), "application/json; charset=utf-8")
            return
        tasks = [FetchTask(value) for value in urls]
        for task in tasks:
            enqueue_task(task, priority)
        deadline = time.time() + 45
        for task in tasks:
            task.event.wait(max(0.0, deadline - time.time()))
        rows = [{
            "url": task.url,
            "status": task.status if task.event.is_set() else 504,
            "html": task.html if task.event.is_set() else "",
            "error": task.error if task.event.is_set() else "Firefox fetch timed out",
        } for task in tasks]
        self.send_bytes(200, json.dumps({"ok": True, "rows": rows}), "application/json; charset=utf-8")


if __name__ == "__main__":
    # The Node supervisor can receive several simultaneous recovery requests.
    # Bind before starting the worker/browser so losing processes exit cleanly
    # instead of lingering as duplicate hidden Firefox services.
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=browser_worker, name="firefox-scraper", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop_browser()
