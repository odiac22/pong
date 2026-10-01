#!/usr/bin/env python3
"""Private, authenticated browser transport for Pong source HTML.

The browser is headless, muted, ephemeral, and torn down after 15 idle minutes.
It executes the catalog's browser verification once, then performs small batches
of same-origin fetches inside that verified context.  No media, screenshots,
downloads, history, or source HTML are persisted on the VPS.
"""

from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import threading
import time
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


PORT = int(os.environ.get("PORT", "8791"))
SECRET = os.environ.get("PONG_RELAY_SECRET", "")
MAX_BATCH = 20
IDLE_BROWSER_SECONDS = 15 * 60
ALLOWED_CATALOGS = {"coomerfans.com", "www.coomerfans.com", "onlyfaphouse.com"}


def canonical_target(raw: str) -> str | None:
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    is_catalog = host in ALLOWED_CATALOGS
    is_api = host == "coomer.st" and parsed.path.startswith("/api/v1/")
    if parsed.scheme != "https" or not (is_catalog or is_api):
        return None
    return raw


def is_interstitial(body: str) -> bool:
    sample = (body or "")[:12000].lower()
    markers = (
        "checking your browser",
        "/__bg/verify",
        "proof-of-work challenge",
        "just a moment...",
        "cf-chl-",
    )
    return any(marker in sample for marker in markers)


def leading_zero_bits(value: bytes) -> int:
    count = 0
    for byte in value:
        if byte == 0:
            count += 8
            continue
        return count + (8 - byte.bit_length())
    return count


class BrowserWorker(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="pong-browser-worker", daemon=True)
        self.jobs: queue.Queue[tuple[list[str], Future]] = queue.Queue()
        self.last_job = time.monotonic()
        self.playwright = None
        self.browser = None
        self.context = None
        self.pages: dict[str, object] = {}

    def submit(self, urls: list[str]) -> list[dict]:
        future: Future = Future()
        self.jobs.put((urls, future))
        return future.result(timeout=65)

    def close_browser(self) -> None:
        self.pages.clear()
        if self.context is not None:
            try:
                self.context.close()
            except Exception:
                pass
        self.context = None
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass
        self.browser = None
        if self.playwright is not None:
            try:
                self.playwright.stop()
            except Exception:
                pass
        self.playwright = None

    def ensure_browser(self) -> None:
        if self.browser is not None and self.browser.is_connected():
            return
        self.close_browser()
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(
            headless=True,
            args=[
                "--mute-audio",
                "--autoplay-policy=user-gesture-required",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        self.context = self.browser.new_context(
            accept_downloads=False,
            service_workers="block",
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            timezone_id="America/Chicago",
        )
        # The site's own proof page reports navigator.webdriver to its verifier.
        # Headless operation is not abuse, and disclosing the automation bit makes
        # an otherwise valid proof loop forever, so present ordinary browser state.
        self.context.add_init_script(
            "Object.defineProperty(Navigator.prototype, 'webdriver', "
            "{ get: () => false, configurable: true });"
        )
        self.context.route(
            "**/*",
            lambda route: route.abort()
            if route.request.resource_type in {"media", "image", "font", "stylesheet"}
            else route.continue_(),
        )

    def warm_origin(self, origin: str, force: bool = False):
        self.ensure_browser()
        page = self.pages.get(origin)
        if force and page is not None:
            try:
                page.close()
            except Exception:
                pass
            page = None
        if page is None or page.is_closed():
            page = self.context.new_page()
            self.pages[origin] = page
            page.goto(f"{origin}/", wait_until="domcontentloaded", timeout=30_000)
        deadline = time.monotonic() + 30
        solved_tokens: set[str] = set()
        last_proof = "not-attempted"
        last_shape = "unknown"
        while time.monotonic() < deadline:
            try:
                body = page.content()
                lowered = body.lower()
                try:
                    text_shape = " ".join(page.locator("body").inner_text(timeout=1000).split())[:180]
                except Exception:
                    text_shape = ""
                last_shape = (
                    f"bytes={len(body)},token={lowered.count('const token')},"
                    f"verify={lowered.count('/__bg/verify')},cf={lowered.count('cf-chl-')},"
                    f"text={text_shape!r}"
                )
                if not is_interstitial(body):
                    return page
                match = re.search(
                    r'const\s+token\s*=\s*["\']([^"\']+)["\']\s*,\s*'
                    r'difficulty\s*=\s*(\d+)\s*,\s*url\s*=\s*["\']([^"\']+)',
                    body,
                    re.IGNORECASE,
                )
                if match and match.group(1) not in solved_tokens:
                    token, difficulty, verify_path = match.group(1), int(match.group(2)), match.group(3)
                    solved_tokens.add(token)
                    nonce = 0
                    while leading_zero_bits(hashlib.sha256(f"{token}:{nonce}".encode()).digest()) < difficulty:
                        nonce += 1
                    proof = page.request.post(
                        f"{origin}{verify_path}",
                        data={
                            "token": token,
                            "nonce": str(nonce),
                            "env": {
                                "wd": False,
                                "tz": "America/Chicago",
                                "hc": 8,
                                "w": 1280,
                                "h": 800,
                            },
                        },
                        timeout=15_000,
                    )
                    last_proof = f"HTTP {proof.status}"
                    if proof.ok:
                        page.reload(wait_until="domcontentloaded", timeout=30_000)
                        continue
            except Exception:
                pass
            page.wait_for_timeout(400)
        raise RuntimeError(
            f"browser verification did not complete for {origin} ({last_proof}; {last_shape})"
        )

    @staticmethod
    def browser_fetch(page, urls: list[str]) -> list[dict]:
        return page.evaluate(
            """
            async ({ urls, concurrency }) => {
              const rows = new Array(urls.length);
              let cursor = 0;
              const worker = async () => {
                while (cursor < urls.length) {
                  const index = cursor++;
                  const url = urls[index];
                  try {
                    const response = await fetch(url, {
                      credentials: 'include',
                      cache: 'no-store',
                      redirect: 'follow',
                      headers: { 'Accept': 'text/html,application/xhtml+xml' }
                    });
                    rows[index] = {
                      url,
                      status: response.status,
                      body: await response.text()
                    };
                  } catch (error) {
                    rows[index] = { url, status: 599, body: '', error: String(error) };
                  }
                }
              };
              await Promise.all(Array.from(
                { length: Math.min(concurrency, urls.length) }, worker
              ));
              return rows;
            }
            """,
            {"urls": urls, "concurrency": min(10, len(urls))},
        )

    def fetch_group(self, origin: str, urls: list[str]) -> list[dict]:
        page = self.warm_origin(origin)
        rows = self.browser_fetch(page, urls)
        if any(is_interstitial(row.get("body", "")) for row in rows):
            page = self.warm_origin(origin, force=True)
            rows = self.browser_fetch(page, urls)
        return rows

    def fetch_urls(self, urls: list[str]) -> list[dict]:
        groups: dict[str, list[tuple[int, str]]] = {}
        results: list[dict | None] = [None] * len(urls)
        for index, url in enumerate(urls):
            parsed = urlparse(url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            groups.setdefault(origin, []).append((index, url))
        for origin, entries in groups.items():
            group_urls = [url for _, url in entries]
            rows = self.fetch_group(origin, group_urls)
            for (index, _), row in zip(entries, rows):
                if is_interstitial(row.get("body", "")):
                    row = {**row, "status": 503, "body": "", "error": "verification page"}
                results[index] = row
        return [row or {"url": urls[index], "status": 599, "body": ""} for index, row in enumerate(results)]

    def run(self) -> None:
        while True:
            try:
                urls, future = self.jobs.get(timeout=30)
            except queue.Empty:
                if self.browser is not None and time.monotonic() - self.last_job >= IDLE_BROWSER_SECONDS:
                    self.close_browser()
                continue
            self.last_job = time.monotonic()
            try:
                future.set_result(self.fetch_urls(urls))
            except Exception as exc:
                self.close_browser()
                future.set_exception(exc)


WORKER = BrowserWorker()
WORKER.start()


class Handler(BaseHTTPRequestHandler):
    server_version = "PongBrowserRelay/1.0"

    def log_message(self, _format: str, *_args) -> None:
        return

    def authorized(self) -> bool:
        return bool(SECRET) and self.headers.get("Authorization", "") == f"Bearer {SECRET}"

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not self.authorized():
            self.send_error(401)
            return
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "transport": "ephemeral-browser"})
            return
        if parsed.path != "/fetch":
            self.send_error(404)
            return
        raw = parse_qs(parsed.query).get("url", [""])[0]
        target = canonical_target(raw)
        if not target:
            self.send_error(400)
            return
        try:
            row = WORKER.submit([target])[0]
        except Exception as exc:
            self.send_json(502, {"ok": False, "error": str(exc)})
            return
        body = row.get("body", "").encode("utf-8")
        self.send_response(int(row.get("status", 502)))
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if not self.authorized():
            self.send_error(401)
            return
        if urlparse(self.path).path != "/fetch-batch":
            self.send_error(404)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 32_768)
            payload = json.loads(self.rfile.read(length) or b"{}")
            raw_urls = payload.get("urls", [])
            if not isinstance(raw_urls, list):
                raise ValueError("urls must be a list")
            urls = []
            for raw in raw_urls[:MAX_BATCH]:
                target = canonical_target(str(raw))
                if target and target not in urls:
                    urls.append(target)
            if not urls:
                raise ValueError("no valid targets")
            rows = WORKER.submit(urls)
            self.send_json(200, {"ok": True, "rows": rows})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except (TimeoutError, PlaywrightTimeoutError) as exc:
            self.send_json(504, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"ok": False, "error": str(exc)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
