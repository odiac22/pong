// Sample the renderer's GPU worker label every 50 ms; report time per label
// and the longest single jobs. node gpu-labels.mjs <seconds> [port]
const seconds = Number(process.argv[2] || 15), port = Number(process.argv[3] || 8792);
const totals = {}, longest = {}, t0 = Date.now();
let current = null;
while (Date.now() - t0 < seconds * 1000) {
  const at = Date.now();
  try {
    const w = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).gpuWorker;
    const label = w.inflight ? w.activeLabel : '(idle)';
    totals[label] = (totals[label] || 0) + 50;
    if (w.inflight) {
      const key = `${label}@${w.activeSince}`;
      const ms = Math.round((Date.now() / 1000 - w.activeSince) * 1000);
      if (!current || current.key !== key) current = {key, label};
      longest[label] = Math.max(longest[label] || 0, ms);
    }
  } catch {}
  await new Promise(r => setTimeout(r, Math.max(0, 50 - (Date.now() - at))));
}
const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
for (const [label, ms] of rows) console.log(`${String(ms).padStart(7)} ms  longest ${String(longest[label] ?? '').padStart(5)} ms  ${label}`);
