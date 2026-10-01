from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".tools" / "selenium"))

from selenium import webdriver
from selenium.webdriver.firefox.options import Options


SITES = [
    ("suj-lia-lor", "https://m.suj.mobi/en/actor/lia_lor"),
    ("porneec-home", "https://porneec.com/"),
    ("pornhub-model", "https://www.pornhub.com/model/tiktok-sluts"),
    ("pornhub-watch", "https://www.pornhub.com/view_video.php?viewkey=6687ec7433e18"),
    ("hqporner-russian", "https://m.hqporner.com/category/russian"),
    ("hqporner-cumatozz", "https://m.hqporner.com/actress/cumatozz"),
]

SILENCE = r"""
for (const media of document.querySelectorAll('video,audio')) {
  try { media.pause(); } catch (_) {}
  media.muted = true;
  media.defaultMuted = true;
  media.volume = 0;
}
return true;
"""

INSPECT = r"""
const anchors = [...document.querySelectorAll('a[href]')];
const hrefs = [...new Set(anchors.map(a => a.href).filter(Boolean))];
const patterns = {
  viewkey: hrefs.filter(v => /view_video\.php\?[^#]*viewkey=/i.test(v)),
  videoPath: hrefs.filter(v => /\/(?:video|videos|watch|scene|post)\//i.test(new URL(v, location.href).pathname)),
  hqPorn: hrefs.filter(v => /\/hdporn\//i.test(new URL(v, location.href).pathname)),
  suj: hrefs.filter(v => /\/(?:video|videos|watch|movie|movies)\//i.test(new URL(v, location.href).pathname)),
};
const sameOrigin = hrefs.filter(value => {
  try { return new URL(value, location.href).origin === location.origin; } catch (_) { return false; }
});
return {
  title: document.title,
  href: location.href,
  htmlBytes: document.documentElement?.outerHTML?.length || 0,
  anchorCount: anchors.length,
  uniqueHrefCount: hrefs.length,
  patternCounts: Object.fromEntries(Object.entries(patterns).map(([k,v]) => [k, v.length])),
  samples: Object.fromEntries(Object.entries(patterns).map(([k,v]) => [k, v.slice(0,3)])),
  sameOriginSamples: sameOrigin.slice(0, 80).map(value => {
    const anchor = anchors.find(item => item.href === value);
    return {
      href: value,
      text: String(anchor?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      className: String(anchor?.className || '').slice(0, 120),
      parentClassName: String(anchor?.parentElement?.className || '').slice(0, 120)
    };
  }),
  media: [...document.querySelectorAll('video')].map(v => ({
    src: v.currentSrc || v.src || '', duration: Number(v.duration || 0),
    paused: v.paused, muted: v.muted, volume: v.volume
  })),
  blocked: /checking your browser|verify you are human|access denied|age verification/i.test(document.body?.innerText || '')
};
"""


def main() -> int:
    options = Options()
    options.add_argument("-headless")
    options.add_argument("-private")
    options.page_load_strategy = "eager"
    options.set_preference("media.volume_scale", "0.0")
    options.set_preference("media.autoplay.default", 5)
    options.set_preference("media.autoplay.blocking_policy", 2)
    options.set_preference("permissions.default.microphone", 2)
    options.set_preference("permissions.default.camera", 2)
    options.set_preference("dom.webnotifications.enabled", False)
    options.set_preference("security.mixed_content.block_active_content", False)
    options.set_preference("network.cors_preflight.allow_client_cert", True)
    driver = webdriver.Firefox(options=options)
    driver.set_page_load_timeout(45)
    driver.set_script_timeout(20)
    results = []
    try:
        for name, url in SITES:
            started = time.perf_counter()
            row = {"name": name, "url": url}
            try:
                driver.get(url)
                driver.execute_script(SILENCE)
                time.sleep(2)
                driver.execute_script(SILENCE)
                row.update(driver.execute_script(INSPECT))
                row["loadMs"] = round((time.perf_counter() - started) * 1000)
            except Exception as error:
                row["error"] = str(error)
            results.append(row)
            print(json.dumps(row, ensure_ascii=True), flush=True)
    finally:
        driver.quit()
    output = ROOT / "artifacts" / "universal-video-site-dom-audit.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
