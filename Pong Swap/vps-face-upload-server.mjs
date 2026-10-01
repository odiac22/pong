import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const host = '127.0.0.1';
const port = 8801;
const uploadDir = '/opt/pong-face-upload/uploads';
const maximumBytes = 25 * 1024 * 1024;
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pong Swap approved faces</title><style>
body{font:16px system-ui;background:#070b0f;color:#eef2ff;padding:28px;max-width:620px;margin:auto}section{border:1px solid #283343;padding:24px;border-radius:16px;background:#0d141c;box-shadow:0 24px 70px #0008}input,button{display:block;width:100%;box-sizing:border-box;margin-top:18px;padding:14px;font-size:16px;border-radius:10px}input{border:1px solid #334155;background:#111827;color:#e5e7eb}button{background:#7e22ce;color:#fff;border:0;font-weight:800}button:disabled{opacity:.45}progress{width:100%;margin-top:18px}#s{white-space:pre-wrap;margin-top:16px;color:#94a3b8}</style></head><body><section><h1>Pong Swap approved faces</h1><p>Select all approved JPG, PNG, or WebP images, then press Upload. They remain private and staged for review before appearing in Pong.</p><input id="f" type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"><button id="b">Upload images</button><progress id="p" value="0" max="100"></progress><div id="s"></div></section><script>
b.onclick=async()=>{const files=[...f.files];if(!files.length){s.textContent='Select the images first.';return}b.disabled=true;s.textContent='';let done=0;try{for(const file of files){s.textContent+='Uploading '+file.name+'…\\n';const r=await fetch('upload?name='+encodeURIComponent(file.name),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file,cache:'no-store'});const result=await r.json().catch(()=>({}));if(!r.ok)throw new Error(result.error||'Upload failed');done++;p.value=done/files.length*100;s.textContent+=file.name+' uploaded.\\n'}s.textContent+='Finished. Return to the chat and say done.'}catch(error){s.textContent+='Error: '+(error?.message||error)}finally{b.disabled=false}}</script></body></html>`;

function safeName(raw) {
  const name = path.basename(String(raw || '')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 140);
  return /\.(jpg|jpeg|png|webp)$/i.test(name) ? name : '';
}

function validMagic(type, header) {
  if (type === 'image/jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (type === 'image/png') return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (type === 'image/webp') return header.length >= 12 && header.subarray(0,4).toString() === 'RIFF' && header.subarray(8,12).toString() === 'WEBP';
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(html),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(html);
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/upload') {
    const name = safeName(url.searchParams.get('name'));
    const type = String(req.headers['content-type'] || '').toLowerCase().split(';')[0];
    if (!name || !['image/jpeg','image/png','image/webp'].includes(type)) {
      res.writeHead(415, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Only JPG, PNG, or WebP images are accepted'})); return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(uploadDir, `${stamp}-${crypto.randomBytes(5).toString('hex')}-${name}`);
    const temporary = `${target}.part`;
    let bytes = 0;
    let header = Buffer.alloc(0);
    let failed = false;
    const out = fs.createWriteStream(temporary, { flags:'wx', mode:0o600 });
    req.on('data', chunk => {
      bytes += chunk.length;
      if (header.length < 16) header = Buffer.concat([header, chunk]).subarray(0, 16);
      if (bytes > maximumBytes && !failed) { failed = true; out.destroy(); req.destroy(); fs.rm(temporary, {force:true}, () => {}); }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (!validMagic(type, header)) {
        fs.rm(temporary, {force:true}, () => {});
        res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'The file contents are not a valid image'})); return;
      }
      fs.renameSync(temporary, target);
      res.writeHead(201, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:true,name,size:bytes}));
    });
    out.on('error', () => { fs.rm(temporary, {force:true}, () => {}); if (!res.headersSent) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Upload failed'})); } });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(port, host, () => console.log('Pong face upload listening privately'));
