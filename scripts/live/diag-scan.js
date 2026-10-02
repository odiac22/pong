(async () => {
  const s = window.__pongTikTokObserverStats || {};
  const before = {...s};
  await new Promise(r => setTimeout(r, 8000));
  const after = {...(window.__pongTikTokObserverStats || {})};
  const d = k => (after[k] || 0) - (before[k] || 0);
  return {
    lifetime: {scans: after.scans, totalMs: Math.round(after.totalMs || 0), maxMs: Math.round(after.maxMs || 0)},
    last8s: {scans: d('scans'), fullScans: d('fullScans'), msSpent: Math.round(d('totalMs')),
             avgMs: d('scans') ? +(d('totalMs') / d('scans')).toFixed(1) : null,
             shareOfMainThread: (d('totalMs') / 8000 * 100).toFixed(1) + '%'}
  };
})()
