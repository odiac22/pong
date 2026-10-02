(() => {
  // Record main-thread freezes, route changes and Pong's own script time during navigation.
  const rec = window.__pongNavRec = {t0: performance.now(), long: [], routes: [], pong0: {...(window.__pongTikTokObserverStats || {})}};
  const route = () => location.pathname.replace(/\/video\/\d+/, '/video/#').replace(/@[^/]+/, '@user');
  let last = route();
  rec.routes.push({t: 0, route: last});
  rec.timer = setInterval(() => { const r = route(); if (r !== last) { last = r; rec.routes.push({t: Math.round(performance.now() - rec.t0), route: r}); } }, 100);
  try {
    rec.obs = new PerformanceObserver(list => { for (const e of list.getEntries()) rec.long.push({t: Math.round(e.startTime - rec.t0), ms: Math.round(e.duration)}); });
    rec.obs.observe({type: 'longtask', buffered: false});
  } catch (e) { rec.error = String(e); }
  // Count DOM nodes and observers Pong keeps alive.
  return {started: true, nodes: document.getElementsByTagName('*').length, route: last};
})()
