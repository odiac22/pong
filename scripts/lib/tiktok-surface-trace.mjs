// Bounded Android metadata trace, shared by opt-in emulator diagnostics.
// This reports compositor updates, never claims unique face-swapped pixels.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {summarizeFrameTimeline} from '../summarize-tiktok-frame-timeline.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const device=(...args)=>execFileSync(adb,['-s','emulator-5582',...args],{encoding:'utf8',timeout:15000,windowsHide:true}).trim();
export async function startSurfaceTrace(output){
  const remote='/data/misc/perfetto-traces/pong-surface-'+Date.now()+'.pftrace';
  const pid=execFileSync(adb,['-s','emulator-5582','shell','perfetto','--background-wait','--txt','-c','-','-o',remote],{
    input:readFileSync('scripts/tiktok-frame-timeline-diagnostic.pbtxt'),encoding:'utf8',timeout:35000,windowsHide:true}).trim();
  if(!/^\d+$/.test(pid))throw Error('No owned trace PID');
  const clock=()=>{
    const value=device('shell','cat','/proc/uptime').split(' ')[0];
    if(!/^\d+\.\d{2}$/.test(value))throw Error('Unexpected Android boot clock');
    return String(BigInt(value.replace('.',''))*10000000n);
  };
  const windows=[];let start=null,closed=false;
  return {
    begin(){if(start!==null)throw Error('Trace window already open');start=clock();},
    end(){if(start===null)throw Error('No trace window');windows.push({startNs:start,endNs:clock()});start=null;},
    async close(expectedWindows){
      if(closed)throw Error('Trace already closed');closed=true;
      const identity=device('shell','cat','/proc/'+pid+'/cmdline');
      if(!identity.includes('perfetto')||!identity.includes(remote))throw Error('Trace process identity changed; not stopped');
      device('shell','kill','-TERM',pid);
      await new Promise(r=>setTimeout(r,500));
      const local=output.replace(/\.json$/,'.pftrace');device('pull',remote,local);
      const processor='E:/Pong Benchmarks/tiktok-webview-2026-09-29/frame-timeline-smoke/trace_processor_shell.exe';
      const csv=execFileSync(processor,['query','-f','scripts/tiktok-frame-timeline.sql',local],{encoding:'utf8',timeout:20000,windowsHide:true});
      writeFileSync(output.replace(/\.json$/,'-frames.csv'),csv);
      const layers=execFileSync(processor,['query',local,'SELECT a.layer_name,COUNT(*) AS updates FROM actual_frame_timeline_slice a JOIN process p USING(upid) WHERE p.name = \'com.odiac22.pong2\' GROUP BY a.layer_name'],{encoding:'utf8',timeout:20000,windowsHide:true});
      return {...summarizeFrameTimeline(csv,{clock:'perfetto-trace-ns',windows},{expectedWindows}),
        layers,clockUncertaintyMs:10,windowsSpec:{clock:'perfetto-trace-ns',windows},
        note:'App-associated updates, not proof of unique transformed frames or every physical refresh.'};
    }
  };
}
