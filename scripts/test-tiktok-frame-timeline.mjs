import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFrameTimelineCsv,parseTraceWindows,summarizeFrameTimeline}
  from './summarize-tiktok-frame-timeline.mjs';

const header='token,present_ns,app_jank,sf_jank,app_late,sf_late,buffer_stuffing,app_dropped,sf_dropped';
const csv=(...rows)=>`${header}\n${rows.join('\n')}\n`;
const clock=(...windows)=>({clock:'perfetto-trace-ns',windows:windows.map(([startNs,endNs])=>({startNs,endNs}))});

test('accepts official trace processor quoted columns and NULL timestamps without inventing frames',()=>{
  const quoted=header.split(',').map(name=>`"${name}"`).join(',');
  const rows=parseFrameTimelineCsv(`${quoted}\n1,100,0,0,0,0,0,0,0\n2,[NULL],0,0,0,0,0,0,0\n`);
  assert.equal(rows[0].presentNs,100n);
  assert.equal(rows[1].presentNs,null);
  assert.throws(()=>parseFrameTimelineCsv(`${quoted}\n3,unknown,0,0,0,0,0,0,0\n`),/timestamp/);
  assert.throws(()=>parseFrameTimelineCsv(`${quoted}\n3,200,[NULL],0,0,0,0,0,0\n`),/app_jank/);
});

test('strict numeric metadata rejects duplicate tokens and malformed frame columns',()=>{
  assert.throws(()=>parseFrameTimelineCsv(csv('1,100,0,0,0,0,0,0,0','1,200,0,0,0,0,0,0,0')),/duplicate/);
  assert.throws(()=>parseFrameTimelineCsv(csv('1,100,0,0,0,0,0,0')),/numeric CSV row/);
  assert.throws(()=>parseFrameTimelineCsv(csv('1,100,0,0,0,0,0,0,2')),/Invalid sf_dropped/);
  assert.throws(()=>parseFrameTimelineCsv('url,pixels\n'),/Unexpected/);
});

test('windows require exact trace nanosecond clock, positive non-overlapping bounds',()=>{
  assert.throws(()=>parseTraceWindows({clock:'host-wall-ms',windows:[]}),/perfetto-trace-ns/);
  assert.throws(()=>parseTraceWindows(clock([20,10])),/positive/);
  assert.throws(()=>parseTraceWindows(clock([10,20],[19,30])),/non-overlapping/);
  assert.deepEqual(parseTraceWindows(clock(['10000000000000000','10000000001000000']))
    .map(w=>w.index),[1]);
});

test('matches only presented display tokens, not dropped or unmatched app submissions',()=>{
  const input=csv(
    '1,1000000000,0,0,0,0,0,0,0',
    '2,1500000000,1,0,1,0,0,0,0',
    '3,,0,0,0,0,0,0,0',
    '4,1750000000,0,0,0,0,0,1,0',
    '5,2000000000,0,1,0,1,1,0,0');
  const report=summarizeFrameTimeline(input,clock([1000000000,3000000000]),{expectedWindows:1});
  assert.equal(report.status,'app-associated-only');
  assert.equal(report.physicalDisplayFpsFloorProven,false);
  assert.equal(report.matchedDisplayTokens,3);
  assert.equal(report.appTokensWithoutDisplayMatch,1);
  assert.equal(report.droppedAppTokens,1);
  assert.equal(report.windows[0].appAssociatedDisplayUpdates,3);
  assert.equal(report.windows[0].appUpdateRateHz,1.5);
  assert.equal(report.windows[0].appJankEvents,1);
  assert.equal(report.windows[0].surfaceFlingerJankEvents,1);
  assert.equal(report.windows[0].bufferStuffingEvents,1);
  assert.equal(report.windows[0].maxSilentGapMs,1000);
});

test('explicitly reports missing data or clip windows as unsupported/incomplete',()=>{
  assert.equal(summarizeFrameTimeline(csv()).status,'unsupported-no-app-frames');
  assert.equal(summarizeFrameTimeline(csv('1,,0,0,0,0,0,0,0')).status,
    'unsupported-no-matched-display-frames');
  assert.equal(summarizeFrameTimeline(csv('1,100,0,0,0,0,0,0,0')).status,
    'discovery-only-no-trace-clock-windows');
  assert.equal(summarizeFrameTimeline(csv('1,100,0,0,0,0,0,0,0'),clock([0,200])).status,
    'incomplete-window-set');
});

test('partial tail is not misreported as a full-second deficit, but trailing freezes still count',()=>{
  const steady=Array.from({length:225},(_,i)=>`${i+1},${BigInt(i)*10000000n},0,0,0,0,0,0,0`);
  const report=summarizeFrameTimeline(csv(...steady),clock([0,2250000000]),{expectedWindows:1});
  assert.equal(report.windows[0].lowestOneSecondAppUpdates,100);
  const frozen=summarizeFrameTimeline(csv(...steady.slice(0,100)),clock([0,2250000000]),{expectedWindows:1});
  assert.equal(frozen.windows[0].lowestOneSecondAppUpdates,0);
  const short=summarizeFrameTimeline(csv(...steady.slice(0,25)),clock([0,250000000]),{expectedWindows:1});
  assert.equal(short.windows[0].lowestOneSecondAppUpdates,null);
});

test('rolling windows catch a cross-bucket gap instead of hiding it in aligned buckets',()=>{
  const input=csv(...[0,100000000,1800000000,1900000000].map((t,i)=>`${i+1},${t},0,0,0,0,0,0,0`));
  const report=summarizeFrameTimeline(input,clock([0,2000000000]),{expectedWindows:1});
  assert.equal(report.windows[0].lowestOneSecondAppUpdates,0);
});
