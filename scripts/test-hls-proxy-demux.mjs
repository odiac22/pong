// Silent synthetic transport regression: no external sites or face generation.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { genericHlsProxyPath, isGenericHlsProxyPath } from '../hls-proxy-path.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'pong-hls-demux-'));
for (const format of ['mpegts', 'fmp4']) {
  const dir = path.join(root, format);
  await mkdir(dir);
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=30', '-t', '4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
    '-hls_segment_type', format, path.join(dir, 'index.m3u8')], {cwd:dir, windowsHide:true, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
}
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (!isGenericHlsProxyPath(u.pathname)) {res.writeHead(404).end();return;}
    const target = new URL(u.searchParams.get('url'));
    if (target.hostname !== 'fixture.invalid' || !/^\/(mpegts|fmp4)\/[a-zA-Z0-9_.-]+$/.test(target.pathname)) {
      res.writeHead(403).end();return;
    }
    let data = await readFile(path.join(root, target.pathname));
    if (target.pathname.endsWith('.m3u8')) {
      const rewrite = value => {
        const absolute = new URL(value, target).href;
        return u.searchParams.get('legacy') === '1'
          ? `/generic-media/hls?url=${encodeURIComponent(absolute)}&legacy=1`
          : genericHlsProxyPath(absolute);
      };
      data = Buffer.from(data.toString().split('\n').map(line => !line || line.startsWith('#')
        ? line.replace(/\bURI="([^"]+)"/g, (_, value) => `URI="${rewrite(value)}"`)
        : rewrite(line)).join('\n'));
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    }
    res.setHeader('Content-Length', data.length);
    res.end(data);
  } catch (_) {res.writeHead(500).end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const code = `import av,sys,json,time
u=sys.argv[1]; t=time.monotonic()
try:
 with av.open(u,timeout=(5.,5.)) as c:
  s=c.streams.video[0]
  frames=[]
  for f in c.decode(s):
   frames.append(f.pts)
   if len(frames)==12:break
  c.seek(int(2/float(s.time_base)),stream=s,backward=True)
  sought=next(c.decode(s))
  print(json.dumps({'ok':True,'width':s.codec_context.width,'height':s.codec_context.height,'frames':len(frames),'seekDecoded':sought is not None,'audioTracks':len(c.streams.audio),'elapsedMs':round((time.monotonic()-t)*1000)}))
except Exception as e:print(json.dumps({'ok':False,'error':type(e).__name__}))`;
const results = [];
try {
  for (const format of ['mpegts', 'fmp4']) for (const legacy of [true, false]) {
    const url = `http://127.0.0.1:${server.address().port}/generic-media/hls?url=${encodeURIComponent(`https://fixture.invalid/${format}/index.m3u8`)}&legacy=${legacy?1:0}`;
    const result = await new Promise((resolve,reject) => {
      const p=spawn('Pong Swap/runtime/venv/Scripts/python.exe',['-c',code,url],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let out=''; const timer=setTimeout(()=>{p.kill();reject(Error('probe timeout'));},20000);
      p.stdout.on('data',d=>out+=d);p.stderr.on('data',()=>{});
      p.on('error',reject);p.on('exit',()=>{clearTimeout(timer);try{resolve(JSON.parse(out));}catch(e){reject(e);}});
    });
    results.push({format,legacy,...result});
    assert.equal(result.ok, !legacy, JSON.stringify(results.at(-1)));
    if (!legacy) {assert.equal(result.frames,12);assert.equal(result.seekDecoded,true);assert.equal(result.audioTracks,0);}
  }
} finally {server.close();server.closeAllConnections();}
await mkdir('artifacts/swap-input-30.16',{recursive:true});
await writeFile('artifacts/swap-input-30.16/synthetic-demux.json',JSON.stringify(results,null,2));
console.log(JSON.stringify({fixtures:root,results},null,2));
