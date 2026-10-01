// Local-only, silent format/transport audit. No external pages or media.
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {join,basename,extname} from 'node:path';
import vm from 'node:vm';
import {extractGenericVideoUrlsFromHtml} from '../media-page-resolver.mjs';

const root=process.argv[2]||'E:/Pong Benchmarks/v3006-player-compatibility';
await mkdir(root,{recursive:true});
const dir=await mkdtemp(join(root,'synthetic-'));
const run=(args)=>new Promise(resolve=>{
 const started=performance.now();let stdout='',stderr='';
 const child=spawn('ffmpeg',['-hide_banner','-nostdin','-loglevel','error',...args],{windowsHide:true,cwd:dir});
 const deadline=setTimeout(()=>child.kill(),60000);
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 child.on('error',e=>{clearTimeout(deadline);resolve({code:-1,stderr:String(e),ms:performance.now()-started});});
 child.on('close',code=>{clearTimeout(deadline);resolve({code,stdout,stderr,ms:Math.round(performance.now()-started)});});
});
async function generate(args){const r=await run(['-y',...args]);if(r.code!==0)throw Error(r.stderr);}
await generate(['-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=10','-an','-c:v','libx264','-preset','ultrafast','-crf','18','-g','30','-movflags','+faststart',join(dir,'source.mp4')]);
for(const file of ['source.mov','source.mkv'])await generate(['-i',join(dir,'source.mp4'),'-map','0:v:0','-an','-c:v','copy',join(dir,file)]);
await generate(['-i',join(dir,'source.mp4'),'-an','-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8',join(dir,'source.webm')]);
await generate(['-i',join(dir,'source.mp4'),'-an','-c:v','copy','-hls_time','2','-hls_list_size','0',join(dir,'ts.m3u8')]);
await generate(['-i',join(dir,'source.mp4'),'-an','-c:v','copy','-hls_time','2','-hls_list_size','0','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4',join(dir,'fragmented.m3u8')]);
await generate(['-i',join(dir,'source.mp4'),'-an','-c:v','copy','-f','dash','-seg_duration','2',join(dir,'source.mpd')]);
const requests=[];
const types={'.mp4':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.m3u8':'application/vnd.apple.mpegurl','.mpd':'application/dash+xml','.ts':'video/mp2t','.m4s':'video/iso.segment'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');requests.push({path:url.pathname,range:req.headers.range||null});
  if(url.pathname==='/redirect.mp4'){res.writeHead(302,{Location:'/source.mp4?signature=fixture'});res.end();return;}
  if(url.pathname==='/expired.mp4'){res.writeHead(403,{'Content-Type':'text/html'});res.end('Expired local test token');return;}
  if(url.pathname==='/login.mp4'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>Local login fixture</html>');return;}
  if(url.pathname==='/empty.mp4'){res.writeHead(204);res.end();return;}
  if(url.pathname==='/corrupt.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});res.end('Not actually encoded media');return;}
  if(url.pathname==='/missing.ts'){res.writeHead(404);res.end();return;}
  if(url.pathname==='/broken.m3u8'){res.writeHead(200,{'Content-Type':types['.m3u8']});res.end('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nmissing.ts\n#EXT-X-ENDLIST\n');return;}
  const file=url.pathname==='/no-range.mp4'?'source.mp4':basename(url.pathname);
  const bytes=await readFile(join(dir,file));
  const headers={'Content-Type':types[extname(file)]||'application/octet-stream','Accept-Ranges':'bytes'};
  const range=url.pathname!=='/no-range.mp4'&&/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  let start=0,end=bytes.length-1;
  if(range){
   start=range[1]?Number(range[1]):Math.max(0,bytes.length-Number(range[2]));
   end=range[1]&&range[2]?Math.min(end,Number(range[2])):end;
   if(start>end||start>=bytes.length){res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`});res.end();return;}
   headers['Content-Range']=`bytes ${start}-${end}/${bytes.length}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(range?206:200,headers);
  res.end(req.method==='HEAD'?undefined:bytes.subarray(start,end+1));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const source=await readFile(new URL('../universal-video-scraper.user.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  function probeCapturedMediaUrl('),source.indexOf('  function probeCapturedDuration('));
// Adapter tests the production probe logic with real loopback HTTP. This is
// not a claim of testing Tampermonkey permissions or browser codec support.
const context=vm.createContext({setTimeout,clearTimeout,location:{href:base},VIDEO_EXT_RE:/\.(mp4|m4v|mov|webm|mkv|m3u8|ogv)(\?|#|$)/i,
 responseHeaderValue:(headers,key)=>headers.split('\r\n').find(s=>s.toLowerCase().startsWith(key.toLowerCase()+':'))?.split(':').slice(1).join(':').trim()||'',
 GM_xmlhttpRequest:options=>{
  const controller=new AbortController();
  fetch(options.url,{headers:options.headers,signal:controller.signal}).then(async response=>{
   const data={status:response.status,readyState:2,responseHeaders:[...response.headers].map(([k,v])=>`${k}: ${v}`).join('\r\n')};
   options.onreadystatechange?.(data);
   if(controller.signal.aborted)return;
   data.response=await response.arrayBuffer();options.onload?.(data);
  }).catch(e=>e.name==='AbortError'?options.onabort?.():options.onerror?.(e));
  return {abort:()=>controller.abort()};
 }});
vm.runInContext(fn,context);
const cases=[
 ['Progressive H.264 MP4','source.mp4',true],['QuickTime H.264','source.mov',true],['Matroska H.264','source.mkv',true],['WebM VP9','source.webm',true],
 ['HLS MPEG-TS','ts.m3u8',true],['HLS fragmented MP4','fragmented.m3u8',true],['DASH fragmented MP4','source.mpd',true],
 ['HTTP redirect','redirect.mp4',true],['Server ignores Range','no-range.mp4',true],
 ['Expired link','expired.mp4',false],['HTML instead of video','login.mp4',false],['Empty 204','empty.mp4',false],
 ['Invalid bytes with video MIME','corrupt.mp4',false],['HLS missing segment','broken.m3u8',false]
];
const report={createdAt:new Date().toISOString(),scope:'Synthetic test bars only; no external pages accessed; no audio tracks/devices; no UI; no face-swap or live Pong browser playback tested.',version:'30.06 / 7.15.0',fixtureDirectory:dir,cases:[]};
try{
 for(const [name,file,valid] of cases){
  const url=base+'/'+file;const started=performance.now();
  const probeAccepted=await context.probeCapturedMediaUrl(url,base);
  const probeMs=Math.round(performance.now()-started);
  const extracted=extractGenericVideoUrlsFromHtml(`<video><source src="${url}"></video>`,base).includes(url);
  const decode=await run(['-i',url,'-map','0:v:0','-an','-progress','pipe:1','-f','null','-']);
  const frames=Number([...String(decode.stdout||'').matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]||0);
  const row={name,valid,extracted,probeAccepted,probeMs,decoderMs:decode.ms,frames,decodePassed:decode.code===0&&frames===300,error:decode.stderr?.trim()||null};
  report.cases.push(row);console.log(JSON.stringify(row));
 }
 report.observations={validFixtures:cases.filter(c=>c[2]).length,fullDecodes:report.cases.filter(c=>c.valid&&c.decodePassed).length,
  unsupportedDiscovery:report.cases.filter(c=>c.valid&&!c.extracted).map(c=>c.name),probeFalsePositives:report.cases.filter(c=>!c.valid&&c.probeAccepted).map(c=>c.name)};
 report.httpRequests=requests;
 await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));
 const lines=['# Synthetic player/transport audit','',report.scope,'',
 '| Case | Extracted | Probe accepted | Complete 300-frame decode | Probe ms | Decode ms |','|---|---:|---:|---:|---:|---:|',
 ...report.cases.map(c=>`| ${c.name} | ${c.extracted} | ${c.probeAccepted} | ${c.decodePassed} | ${c.probeMs} | ${c.decoderMs} |`),'',
 '## Findings','',
 `- ${report.observations.fullDecodes}/${report.observations.validFixtures} valid fixtures decoded all 300 frames (10 seconds at 30 FPS).`,
 `- Missing automatic discovery support: ${report.observations.unsupportedDiscovery.join(', ')||'none'}.`,
 `- Header/reachability probes falsely accept: ${report.observations.probeFalsePositives.join(', ')||'none'}. Actual decoding rejects these broken fixtures.`,
 '- A successful probe does not establish playable video. This audit calls the userscript probe directly; later server checks are not included.',
 '- Decoder speed is offline throughput, not first-playable latency or proof of browser/Android/swap playback.',
 '- No VPN, user queues, live settings, production code, or version were changed. None of the requested external sites is certified by this test.','', '[Detailed evidence](report.json)',''];
 await writeFile(join(dir,'REPORT.md'),lines.join('\n'));
 console.log(JSON.stringify({report:join(dir,'REPORT.md'),observations:report.observations}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
