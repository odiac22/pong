(() => {
  // Time Pong's handlers that TikTok navigation triggers (Pong page side).
  const names = ['PongTikTokLiveFeed', 'PongTikTokLiveSwapCurrent'];
  const t = window.__pongFeedTiming ||= {calls: {}, wrapped: {}};
  for (const name of names) {
    const fn = window[name];
    if (typeof fn !== 'function' || t.wrapped[name] === fn) continue;
    const wrapped = function (...args) {
      const started = performance.now();
      try { return fn.apply(this, args); } finally {
        const ms = performance.now() - started, c = t.calls[name] ||= {n: 0, totalMs: 0, maxMs: 0, slow: []};
        c.n++; c.totalMs += ms; c.maxMs = Math.max(c.maxMs, ms);
        if (ms > 30) c.slow.push({at: Math.round(started), ms: Math.round(ms)});
      }
    };
    window[name] = wrapped; t.wrapped[name] = wrapped;
  }
  return Object.fromEntries(Object.entries(t.calls).map(([k, c]) => [k, {n: c.n, totalMs: Math.round(c.totalMs), maxMs: Math.round(c.maxMs), slow: c.slow.slice(-8)}]));
})()
