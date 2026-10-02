(async () => {
  // What the Pong page keeps running while TikTok is in front: animations,
  // rAF loops and timers, sampled over 3 s.
  const anims = document.getAnimations().filter(a => a.playState === 'running');
  const byTarget = {};
  for (const a of anims) {
    const t = a.effect?.target, key = t ? (t.id ? '#' + t.id : t.tagName.toLowerCase() + '.' + String(t.className).split(' ')[0]) : '?';
    byTarget[key + ' ' + (a.animationName || a.constructor.name)] = (byTarget[key + ' ' + (a.animationName || a.constructor.name)] || 0) + 1;
  }
  const raf = window.requestAnimationFrame, st = window.setTimeout, si = window.setInterval;
  let rafCalls = 0, timeouts = 0; const rafSites = {}, timeoutSites = {};
  const site = () => (new Error().stack.split('\n')[3] || '').trim().replace(/https?:\/\/[^)]+\//, '').slice(0, 90);
  window.requestAnimationFrame = function (cb) { rafCalls++; const s = site(); rafSites[s] = (rafSites[s] || 0) + 1; return raf.call(this, cb); };
  window.setTimeout = function (cb, ms, ...rest) { timeouts++; const s = site(); timeoutSites[s] = (timeoutSites[s] || 0) + 1; return st.call(this, cb, ms, ...rest); };
  await new Promise(r => st(r, 3000));
  window.requestAnimationFrame = raf; window.setTimeout = st;
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {runningAnimations: anims.length, animations: top(byTarget), rafPerSec: +(rafCalls / 3).toFixed(1), rafSites: top(rafSites),
    timeoutsPerSec: +(timeouts / 3).toFixed(1), timeoutSites: top(timeoutSites), nodes: document.getElementsByTagName('*').length};
})()
