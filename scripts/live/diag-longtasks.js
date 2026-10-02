(async () => {
  // Long main-thread tasks (>50 ms) over 6 s, and how long Pong's own feed
  // scan takes per call, measured by wrapping it temporarily.
  const tasks = [];
  const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) tasks.push(Math.round(e.duration)); });
  try { observer.observe({type: 'longtask', buffered: false}); } catch (_) {}
  const scan = window.__pongTikTokScan;
  const scanTimes = [];
  if (typeof scan === 'function') {
    window.__pongTikTokScan = function () { const t = performance.now(); try { return scan.apply(this, arguments); } finally { scanTimes.push(performance.now() - t); } };
  }
  const v = [...document.querySelectorAll('video')].find(x => !x.paused);
  const q0 = v?.getVideoPlaybackQuality?.();
  await new Promise(r => setTimeout(r, 6000));
  const q1 = v?.getVideoPlaybackQuality?.();
  observer.disconnect();
  if (typeof scan === 'function') window.__pongTikTokScan = scan;
  const sum = a => Math.round(a.reduce((x, y) => x + y, 0));
  scanTimes.sort((a, b) => a - b);
  return {
    longTasks: tasks.length, longTaskMs: sum(tasks), worstTaskMs: Math.max(0, ...tasks),
    pongScanCalls: scanTimes.length, pongScanTotalMs: sum(scanTimes),
    pongScanP50Ms: scanTimes.length ? +scanTimes[Math.floor(scanTimes.length / 2)].toFixed(1) : null,
    pongScanMaxMs: scanTimes.length ? +scanTimes[scanTimes.length - 1].toFixed(1) : null,
    videoFramesIn6s: q1 && q0 ? q1.totalVideoFrames - q0.totalVideoFrames : null,
    droppedIn6s: q1 && q0 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
    domNodes: document.getElementsByTagName('*').length
  };
})()
