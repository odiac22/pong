(() => {
  const rec = window.__pongNavRec;
  if (!rec) return {error: 'not started'};
  const s = window.__pongTikTokObserverStats || {}, p = rec.pong0;
  const elapsed = performance.now() - rec.t0;
  const total = rec.long.reduce((a, b) => a + b.ms, 0);
  return {
    seconds: +(elapsed / 1000).toFixed(1), nodes: document.getElementsByTagName('*').length, videos: document.querySelectorAll('video').length,
    routes: rec.routes,
    longTasks: {count: rec.long.length, totalMs: total, worst: rec.long.slice().sort((a, b) => b.ms - a.ms).slice(0, 12)},
    pongScan: {scans: (s.scans || 0) - (p.scans || 0), fullScans: (s.fullScans || 0) - (p.fullScans || 0),
      ms: Math.round((s.totalMs || 0) - (p.totalMs || 0)), maxMs: Math.round(s.maxMs || 0)},
    error: rec.error
  };
})()
