import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = code => Object.assign(new Error(code), {code});
const ERRORS = new Set(['file_too_large','cache_full','disk_space_low','invalid_range','source_changed','not_video','browser_unavailable','transfer_interrupted']);

// Owns only phone-UUID.{json,media,part} in its dedicated temporary directory.
// No URL, page title, cookie, or credential is persisted.
export class PhoneTransferStore {
  constructor({directory, maxBytes=8*1024**3, maxFileBytes=4*1024**3, minFreeBytes=2*1024**3, ttlMs=24*3600_000, chunkBytes=512*1024, concurrency=2}) {
    this.directory=path.resolve(directory); this.maxBytes=maxBytes; this.maxFileBytes=maxFileBytes;
    this.minFreeBytes=minFreeBytes; this.ttlMs=ttlMs; this.chunkBytes=chunkBytes; this.concurrency=concurrency;
    this.records=new Map(); this.running=0; this.queue=[];
  }
  file(id,ext) {
    if(!ID.test(id))throw fail('invalid_id');
    return path.join(this.directory,`phone-${id}.${ext}`);
  }
  async init() {
    await fs.mkdir(this.directory,{recursive:true});
    for(const name of await fs.readdir(this.directory)) {
      const match=name.match(/^phone-([a-f0-9-]{36})\.(json|part)$/i);
      if(!match||!ID.test(match[1]))continue;
      const [ ,id,ext]=match;
      if(ext==='part'){await fs.unlink(this.file(id,'part')).catch(()=>{});continue;}
      try {
        const r=JSON.parse(await fs.readFile(this.file(id,'json'),'utf8'));
        const stat=await fs.lstat(this.file(id,'media'));
        if(r.id!==id||r.state!=='ready'||!stat.isFile()||stat.size!==r.totalBytes||!Number.isSafeInteger(r.totalBytes)||r.totalBytes<=0||!['video/mp4','video/webm'].includes(r.contentType)||!Number.isFinite(r.expiresAt))continue;
        this.records.set(id,{id,state:'ready',bytes:r.totalBytes,totalBytes:r.totalBytes,contentType:r.contentType,expiresAt:r.expiresAt});
      } catch {}
    }
    // A crash between the rename and manifest commit must not leave an
    // unaccounted full video occupying disk forever.
    for(const name of await fs.readdir(this.directory)) {
      const match=name.match(/^phone-([a-f0-9-]{36})\.(media|json)$/i);
      if(match&&ID.test(match[1])&&!this.records.has(match[1]))await fs.unlink(this.file(match[1],match[2])).catch(()=>{});
    }
    await this.prune();
    return this;
  }
  async prune() {
    for(const [id,r] of this.records) {
      if(r.state==='downloading'||r.state==='queued'||r.readers>0||r.expiresAt>Date.now())continue;
      this.records.delete(id);
      for(const ext of ['media','json','part'])await fs.unlink(this.file(id,ext)).catch(()=>{});
    }
  }
  status(id) {
    const r=this.records.get(id);
    if(!r||r.expiresAt<=Date.now())return null;
    return {id,state:r.state,bytes:r.bytes,totalBytes:r.totalBytes,percent:r.totalBytes?Math.floor(r.bytes/r.totalBytes*100):0,error:r.error||null,expiresAt:r.expiresAt};
  }
  start(id,readRange) {
    this.file(id,'media');
    const old=this.status(id);
    if(old&&['ready','queued','downloading'].includes(old.state))return old;
    const r={id,state:'queued',bytes:0,totalBytes:0,expiresAt:Date.now()+this.ttlMs};
    this.records.set(id,r);this.queue.push({r,readRange});this.pump();return this.status(id);
  }
  pump() {
    while(this.running<this.concurrency&&this.queue.length){
      const {r,readRange}=this.queue.shift();this.running++;
      this.download(r,readRange).catch(()=>{}).finally(()=>{this.running--;this.pump();});
    }
  }
  async download(r,readRange) {
    r.state='downloading'; let file; let validator=''; let source=''; const startedAt=Date.now();
    try {
      await this.prune();
      file=await fs.open(this.file(r.id,'part'),'w');
      while(!r.totalBytes||r.bytes<r.totalBytes) {
        if(Date.now()-startedAt>60*60_000)throw fail('transfer_interrupted');
        const start=r.bytes, end=Math.min(start+this.chunkBytes-1,r.totalBytes?r.totalBytes-1:Infinity);
        let response;
        for(let attempt=0;attempt<2;attempt++) {
          try {response=await readRange(`bytes=${start}-${end}`,validator);break;}
          catch {if(attempt===1)throw fail('browser_unavailable');}
        }
        const body=response?.body;
        const match=String(response?.contentRange||'').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        if(response?.status!==206||!match||!Buffer.isBuffer(body)||!body.length)throw fail('invalid_range');
        const lo=Number(match[1]),hi=Number(match[2]),total=Number(match[3]);
        if(!Number.isSafeInteger(total)||total<=0||lo!==start||hi<lo||hi>end||hi>=total||body.length!==hi-lo+1)throw fail('invalid_range');
        if(r.totalBytes&&r.totalBytes!==total)throw fail('source_changed');
        const nextValidator=response.etag&&!String(response.etag).startsWith('W/')?response.etag:response.lastModified||'';
        if(validator&&nextValidator!==validator)throw fail('source_changed');
        if(source&&response.sourceUrl!==source)throw fail('source_changed');
        if(!r.totalBytes) {
          if(total>this.maxFileBytes)throw fail('file_too_large');
          const reserved=[...this.records.values()].reduce((sum,x)=>sum+(x.totalBytes||0),0);
          if(reserved+total>this.maxBytes)throw fail('cache_full');
          // Reserve synchronously before checking free disk so simultaneous
          // transfers cannot both admit the same remaining cache capacity.
          r.totalBytes=total;
          const stat=await fs.statfs(this.directory);
          const outstanding=[...this.records.values()].filter(x=>x.state==='downloading').reduce((n,x)=>n+Math.max(0,x.totalBytes-x.bytes),0);
          if(Number(stat.bavail)*Number(stat.bsize)-outstanding<this.minFreeBytes)throw fail('disk_space_low');
          const mp4=body.length>=12&&body.toString('ascii',4,8)==='ftyp';
          const webm=body.length>=4&&body.readUInt32BE(0)===0x1a45dfa3;
          if(!mp4&&!webm)throw fail('not_video');
          r.contentType=mp4?'video/mp4':'video/webm';
          validator=nextValidator;source=response.sourceUrl||'';
        }
        let written=0;
        while(written<body.length){const result=await file.write(body,written,body.length-written,r.bytes+written);if(!result.bytesWritten)throw fail('transfer_interrupted');written+=result.bytesWritten;}
        r.bytes+=body.length;
      }
      await file.sync();await file.close();file=null;
      await fs.rename(this.file(r.id,'part'),this.file(r.id,'media'));
      r.expiresAt=Date.now()+this.ttlMs;
      await fs.writeFile(this.file(r.id,'json'),JSON.stringify({id:r.id,state:'ready',totalBytes:r.totalBytes,contentType:r.contentType,expiresAt:r.expiresAt}));
      r.state='ready';
    } catch(error) {
      if(file)await file.close().catch(()=>{});
      for(const ext of ['part','media','json'])await fs.unlink(this.file(r.id,ext)).catch(()=>{});
      r.state='error';r.error=ERRORS.has(error.code)?error.code:'transfer_interrupted';r.bytes=0;r.totalBytes=0;
    }
  }
  async serve(id,req,res) {
    const r=this.records.get(id);
    if(!r||r.state!=='ready'||r.expiresAt<=Date.now())return false;
    let start=0,end=r.totalBytes-1,status=200;
    if(req.headers.range) {
      const match=String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${r.totalBytes}`});res.end();return true;}
      start=match[1]?Number(match[1]):Math.max(0,r.totalBytes-Number(match[2]));
      end=match[1]&&match[2]?Math.min(Number(match[2]),end):end;status=206;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=r.totalBytes){res.writeHead(416,{'Content-Range':`bytes */${r.totalBytes}`});res.end();return true;}
    }
    res.writeHead(status,{'Content-Type':r.contentType,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Pong-Phone-Transfer':'complete',...(status===206?{'Content-Range':`bytes ${start}-${end}/${r.totalBytes}`}:{})});
    if(req.method==='HEAD'){res.end();return true;}
    r.readers=(r.readers||0)+1;
    try{await pipeline(createReadStream(this.file(id,'media'),{start,end}),res);}catch(error){if(!res.destroyed)res.destroy(error);}finally{r.readers--;}
    return true;
  }
}
