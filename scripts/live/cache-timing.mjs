// Poll the helper's video cache for N seconds and report, per new TikTok
// record, ms from first sighting to first bytes / playable / ready.
// No URLs are printed. node cache-timing.mjs <seconds>
const seconds = Number(process.argv[2] || 20);
const seen = new Map(), t0 = Date.now();
let constrained = 0, samples = 0;
while (Date.now() - t0 < seconds * 1000) {
  const at = Date.now();
  try {
    const s = await (await fetch('http://127.0.0.1:8787/video-cache/status')).json();
    samples++; if (s.cache?.buffer_scheduler?.constrained) constrained++;
    for (const r of s.records) {
      if (!r.tiktokSourceTransport && !/tiktok/i.test(String(r.id))) continue;
      let e = seen.get(r.id);
      if (!e) { e = {first: at, preexisting: at - t0 < 300 && r.ready, transport: r.tiktokSourceTransport}; seen.set(r.id, e); }
      if (!e.bytes && r.bytes > 0) e.bytes = at;
      if (!e.playable && r.playable) e.playable = at;
      if (!e.ready && r.ready) e.ready = at;
      e.status = r.status; e.priority = r.priority;
    }
  } catch {}
  await new Promise(r => setTimeout(r, Math.max(0, 150 - (Date.now() - at))));
}
const d = (e, k) => e[k] ? e[k] - e.first : '';
for (const [id, e] of seen) if (!e.preexisting)
  console.log(`${String(id).slice(-10)} transport=${e.transport} bytes=${d(e, 'bytes')} playable=${d(e, 'playable')} ready=${d(e, 'ready')} status=${e.status} prio=${e.priority}`);
console.log(`constrained in ${constrained}/${samples} samples`);
