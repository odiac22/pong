export function summarizeVisibleFrameSeries(result) {
  const rows = Array.isArray(result?.records) ? result.records : [];
  const finite = values => values.filter(v => Number.isFinite(v) && v >= 0).sort((a,b)=>a-b);
  const times = finite(rows.map(r=>r.nativeBinaryRoundtripMs));
  const totals = finite(rows.map(r=>r.totalMs));
  const gaps = finite(result?.rafIntervalsMs ?? []);
  const percentile = (values,p) => values.length ? values[Math.ceil(values.length*p)-1] : null;
  const elapsed = Number.isFinite(result?.totalMs) && result.totalMs > 0 ? result.totalMs : null;
  const transformed = rows.filter(r=>r.transformed===true).length;
  const gapSum = gaps.reduce((sum,value)=>sum+value,0);
  return {
    samples:rows.length, transformedSamples:transformed,
    binaryRoundtripMedianMs:percentile(times,.5), binaryRoundtripP90Ms:percentile(times,.9),
    binaryRoundtripMaxMs:times.at(-1)??null,
    fullFrameMedianMs:percentile(totals,.5), fullFrameMaxMs:totals.at(-1)??null,
    firstTransformedMs:rows.some(r=>r.transformed===true)
      ? rows.slice(0,rows.findIndex(r=>r.transformed===true)+1).reduce((sum,r)=>sum+r.totalMs,0) : null,
    completedOffscreenFramesPerSecond:elapsed?rows.length*1000/elapsed:null,
    transformedOffscreenFramesPerSecond:elapsed?transformed*1000/elapsed:null,
    sourceFramesPresentedDelta:result?.sourceFramesPresentedDelta??null,
    sourceAdvancedSeconds:result?.sourceAdvancedSeconds??null,
    decodedFrames:result?.decodedFrames??null, droppedFrames:result?.droppedFrames??null,
    sampledUiRafPerSecond:gapSum>0?gaps.length*1000/gapSum:null,
    rafGapP95Ms:percentile(gaps,.95), rafGapMaxMs:gaps.at(-1)??null,
    rafIntervalsOver32Ms:gaps.filter(gap=>gap>32).length,
    // Offscreen success never qualifies visible paint, phone latency, or a 40-video run.
    visibleBenchmarkQualified:false,
  };
}
