// Offline numeric FrameTimeline report. No ADB, trace capture, pixels or URLs.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const FIELDS=['token','present_ns','app_jank','sf_jank','app_late','sf_late',
  'buffer_stuffing','app_dropped','sf_dropped'];
const FLAGS=FIELDS.slice(2);
const NS_PER_SECOND=1000000000n;
const ms=ns=>Number(ns)/1e6;
const round=value=>Math.round(value*1000)/1000;

export function parseFrameTimelineCsv(csv){
  const lines=csv.trim().split(/\r?\n/).filter(Boolean);
  // trace_processor quotes column names and emits [NULL] for missing joins.
  // This remains a deliberately narrow numeric format, not permissive CSV.
  const cell=value=>/^"[^"\r\n]*"$/.test(value)?value.slice(1,-1):value;
  if(lines.shift()?.replace(/^\uFEFF/,'').split(',').map(cell).join(',')!==FIELDS.join(','))
    throw Error('Unexpected FrameTimeline CSV columns; run the paired SQL query');
  const tokens=new Set();
  return lines.map((line,index)=>{
    const cells=line.split(',').map(cell);
    if(cells.length!==FIELDS.length)throw Error(`Invalid numeric CSV row ${index+2}`);
    const [rawToken,presentCell,...rawFlags]=cells;
    const rawPresent=presentCell==='[NULL]'?'':presentCell;
    if(!/^\d+$/.test(rawToken)||tokens.has(rawToken))throw Error(`Invalid or duplicate display token at row ${index+2}`);
    tokens.add(rawToken);
    if(rawPresent!==''&&!/^\d+$/.test(rawPresent))throw Error(`Invalid present timestamp at row ${index+2}`);
    const flags=Object.fromEntries(FLAGS.map((name,i)=>{
      if(!/^[01]$/.test(rawFlags[i]))throw Error(`Invalid ${name} at row ${index+2}`);
      return [name,Number(rawFlags[i])];
    }));
    return {token:rawToken,presentNs:rawPresent===''?null:BigInt(rawPresent),...flags};
  });
}

export function parseTraceWindows(spec){
  if(spec?.clock!=='perfetto-trace-ns'||!Array.isArray(spec.windows))
    throw Error('Windows require clock=perfetto-trace-ns and a windows array');
  let previousEnd=null;
  return spec.windows.map((window,index)=>{
    const {startNs,endNs}=window;
    if(!/^\d+$/.test(String(startNs))||!/^\d+$/.test(String(endNs)))
      throw Error(`Invalid Perfetto nanosecond window ${index+1}`);
    const start=BigInt(startNs),end=BigInt(endNs);
    if(end<=start||end-start>600n*NS_PER_SECOND||(previousEnd!==null&&start<previousEnd))
      throw Error(`Windows must be positive, ordered and non-overlapping at ${index+1}`);
    previousEnd=end;
    return {index:index+1,start,end};
  });
}

function percentile(values,fraction){
  if(!values.length)return null;
  const ordered=[...values].sort((a,b)=>a-b);
  return round(ordered[Math.ceil(fraction*ordered.length)-1]);
}

function lowestFullSecondUpdates(times,start,end){
  if(end-start<NS_PER_SECOND)return null;
  // Evaluate only complete rolling seconds, including the final full second.
  // A partial last bucket is not a one-second FPS sample. Counts can decrease
  // only just after an update exits the half-open window.
  const lastStart=end-NS_PER_SECOND;
  const starts=[start,...times.map(t=>t+1n).filter(t=>t>start&&t<=lastStart),lastStart];
  let left=0,right=0,lowest=Infinity;
  for(const from of starts){
    while(left<times.length&&times[left]<from)left++;
    right=Math.max(right,left);
    while(right<times.length&&times[right]<from+NS_PER_SECOND)right++;
    lowest=Math.min(lowest,right-left);
  }
  return lowest;
}

function windowMetrics(window,frames){
  const own=frames.filter(frame=>frame.presentNs>=window.start&&frame.presentNs<window.end);
  const times=own.map(frame=>frame.presentNs).sort((a,b)=>a<b?-1:a>b?1:0);
  const gaps=[];
  let previous=window.start;
  for(const time of times){gaps.push(ms(time-previous));previous=time;}
  gaps.push(ms(window.end-previous));
  const intervals=times.slice(1).map((time,i)=>ms(time-times[i]));
  const seconds=Number(window.end-window.start)/Number(NS_PER_SECOND);
  return {index:window.index,durationMs:round(ms(window.end-window.start)),
    appAssociatedDisplayUpdates:own.length,appUpdateRateHz:round(own.length/seconds),
    lowestOneSecondAppUpdates:lowestFullSecondUpdates(times,window.start,window.end),
    oneSecondMethod:'minimum complete rolling half-open one-second window',
    maxSilentGapMs:round(Math.max(...gaps)),p90InterUpdateMs:percentile(intervals,.9),
    appJankEvents:own.reduce((n,f)=>n+f.app_jank,0),
    surfaceFlingerJankEvents:own.reduce((n,f)=>n+f.sf_jank,0),
    appLateEvents:own.reduce((n,f)=>n+f.app_late,0),
    surfaceFlingerLateEvents:own.reduce((n,f)=>n+f.sf_late,0),
    bufferStuffingEvents:own.reduce((n,f)=>n+f.buffer_stuffing,0)};
}

export function summarizeFrameTimeline(csv,windowSpec=null,{expectedWindows=40}={}){
  if(!Number.isSafeInteger(expectedWindows)||expectedWindows<1)throw Error('Invalid expected window count');
  const rows=parseFrameTimelineCsv(csv);
  const presented=rows.filter(row=>row.presentNs!==null&&!row.app_dropped&&!row.sf_dropped)
    .sort((a,b)=>a.presentNs<b.presentNs?-1:a.presentNs>b.presentNs?1:0);
  const windows=windowSpec===null?null:parseTraceWindows(windowSpec);
  const windowRows=windows?.map(window=>windowMetrics(window,presented))||[];
  const measuredMs=windowRows.reduce((n,row)=>n+row.durationMs,0);
  const measuredFrames=windowRows.reduce((n,row)=>n+row.appAssociatedDisplayUpdates,0);
  const status=!rows.length?'unsupported-no-app-frames':
    !presented.length?'unsupported-no-matched-display-frames':
    !windows?'discovery-only-no-trace-clock-windows':
    windows.length!==expectedWindows?'incomplete-window-set':'app-associated-only';
  return {status,scope:'Pong 2 app-associated SurfaceFlinger display updates',
    physicalDisplayFpsFloorProven:false,videoContentFramesProven:false,
    limitation:'FrameTimeline can omit SurfaceView video and does not prove distinct video pixels or every physical refresh.',
    matchedDisplayTokens:presented.length,appTokensWithoutDisplayMatch:rows.filter(r=>r.presentNs===null).length,
    droppedAppTokens:rows.filter(r=>r.app_dropped||r.sf_dropped).length,
    expectedWindows,observedWindows:windows?.length??0,
    aggregateWindowUpdateRateHz:measuredMs?round(measuredFrames/(measuredMs/1000)):null,
    windows:windowRows};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
  const csvPath=value('--csv'),windowsPath=value('--windows');
  if(!csvPath||args.some(arg=>arg.startsWith('--')&&!['--csv','--windows','--expected-windows'].includes(arg))){
    throw Error('Usage: node scripts/summarize-tiktok-frame-timeline.mjs --csv numeric-frames.csv [--windows trace-clock-windows.json] [--expected-windows 40]');
  }
  const expected=value('--expected-windows')===null?40:Number(value('--expected-windows'));
  const report=summarizeFrameTimeline(readFileSync(csvPath,'utf8'),
    windowsPath?JSON.parse(readFileSync(windowsPath,'utf8')):null,{expectedWindows:expected});
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
}
