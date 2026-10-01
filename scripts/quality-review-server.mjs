import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {createHash} from 'node:crypto';

const assets=new Map([['','quality-review/index.html'],['style.css','quality-review/style.css'],['app.js','quality-review/app.js'],['restoration','quality-review/restoration.html']]);
export function comparisonKey(m,c,row){return createHash('sha256').update(JSON.stringify([m.faceId,c.baselineId||m.baselineId||'legacy',c.id,row.clip,row.before?.sha256||m.clips.find(x=>x.id===row.clip)?.sha256,row.sha256])).digest('hex').slice(0,24)}
function publicRow(m,c,{file,before,comparison,...row}){return {...row,ready:!!file,comparison:comparison?{sha256:comparison.sha256,crop:comparison.crop,integrity:comparison.integrity,ready:!!comparison.file}:undefined,before:before?{sha256:before.sha256,metrics:before.metrics,integrity:before.integrity,ready:!!before.file}:undefined,comparisonKey:comparisonKey(m,c,{...row,before})}}
export function validScore(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=10&&Math.abs(value*100-Math.round(value*100))<1e-7}
export function createReviewServer({root,host,port,token}){
 if(!/^[a-f0-9]{48}$/.test(token))throw Error('Invalid token');
 const prefix='/review/'+token+'/',manifestFile=join(root,'gallery.json'),ratingsFile=join(root,'ratings.json');
 let saveQueue=Promise.resolve();
 const loadRatings=async()=>{try{return JSON.parse(await readFile(ratingsFile,'utf8'))}catch(e){if(e.code==='ENOENT')return {schema:1,ratings:{}};throw e}};
 const server=createServer(async(req,res)=>{
  const expectedHost=`${host}:${server.address()?.port||port}`,origin=`http://${expectedHost}`;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy',"default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const reply=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:typeof value==='string'?value:JSON.stringify(value))};
  try{
   if(req.headers.host!==expectedHost)return reply(403,{error:'Host not allowed'});
   const url=new URL(req.url,origin);if(!url.pathname.startsWith(prefix))return reply(404,{error:'Not found'});
   const part=decodeURIComponent(url.pathname.slice(prefix.length));
   if(!['GET','HEAD','POST'].includes(req.method))return reply(405,{error:'Method not allowed'});
   if(req.method==='POST'){
    if(part!=='ratings')return reply(405,{error:'Read-only route'});
    // Only the owner-written, exact public origin is accepted. Never trust
    // forwarded headers or reflect a caller-supplied origin into this list.
    const allowedOrigins=new Set([origin]);
    try{const publicConfig=JSON.parse(await readFile(join(root,'public-origin.json'),'utf8'));const publicUrl=new URL(publicConfig.origin);if(publicUrl.protocol==='https:'&&publicUrl.origin===publicConfig.origin&&!publicUrl.username&&!publicUrl.password)allowedOrigins.add(publicUrl.origin)}catch(e){if(e.code!=='ENOENT')throw e}
    if(!allowedOrigins.has(req.headers.origin)||req.headers['content-type']?.split(';')[0]!=='application/json')return reply(403,{error:'Same-origin JSON required'});
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)return reply(413,{error:'Request too large'});chunks.push(chunk)}
    let body;try{body=JSON.parse(Buffer.concat(chunks))}catch{return reply(400,{error:'Invalid JSON'})}
    const m=JSON.parse(await readFile(manifestFile,'utf8')),c=m.candidates.find(x=>x.id===body.experimentId),row=c?.clips.find(x=>x.clip===body.clip);
    if(!row?.file||!m.clips.some(x=>x.id===body.clip&&x.baseline))return reply(400,{error:'Both comparison videos must exist first'});
    const key=comparisonKey(m,c,row);if(body.comparisonKey!==key)return reply(409,{error:'Comparison changed. Refresh before scoring.'});
    if(!validScore(body.before)||!validScore(body.after)||typeof body.comment!=='string'||body.comment.length>2000)return reply(400,{error:'Scores must be 0.00–10.00 in 0.01 steps; comment max 2000 characters'});
    const entry={comparisonKey:key,experimentId:c.id,clip:row.clip,faceId:m.faceId,baselineId:c.baselineId||m.baselineId,before:body.before,after:body.after,comment:body.comment,updatedAt:new Date().toISOString(),decision:'user-scored; no automatic promotion'};
    const save=saveQueue.then(async()=>{const all=await loadRatings();all.ratings[key]=entry;const temporary=ratingsFile+'.tmp';await writeFile(temporary,JSON.stringify(all,null,2));await rename(temporary,ratingsFile)});
    saveQueue=save.catch(()=>{});await save;return reply(200,{ok:true,rating:entry});
   }
   if(assets.has(part)){const file=new URL(assets.get(part),import.meta.url),type=(part===''||part==='restoration')?'text/html; charset=utf-8':part==='app.js'?'text/javascript; charset=utf-8':'text/css; charset=utf-8';return reply(200,await readFile(file,'utf8'),type)}
   if(part==='ratings')return reply(200,await loadRatings());
   const m=JSON.parse(await readFile(manifestFile,'utf8'));
   if(part==='manifest')return reply(200,{faceId:m.faceId,faceName:m.faceName,baselineId:m.baselineId,baselineFaceName:m.baselineFaceName,note:m.note,inventory:m.inventory,tests:m.tests||[],faces:m.faces.map(({file,...x})=>x),clips:m.clips.map(({source,baseline,...x})=>({...x,ready:!!baseline})),candidates:m.candidates.map(c=>({...c,clips:c.clips.map(x=>publicRow(m,c,x))}))});
   if(!part.startsWith('media/'))return reply(404,{error:'Not found'});
   const id=part.slice(6),allowed=new Map();for(const f of m.faces)allowed.set('face-'+f.id,f.file);for(const c of m.clips){allowed.set('source-'+c.id,c.source);if(c.baseline)allowed.set('baseline-'+c.id,c.baseline)}for(const c of m.candidates)for(const row of c.clips){if(row.file)allowed.set(c.id+'-'+row.clip,row.file);if(row.before?.file)allowed.set(c.id+'-before-'+row.clip,row.before.file);if(row.comparison?.file)allowed.set(c.id+'-comparison-'+row.clip,row.comparison.file)}
   allowed.set('approved28-restoration-tan',new URL('../artifacts/approved-28-tan-dark-restoration/Approved-28-90-60-30.mp4',import.meta.url));
   const file=allowed.get(id);if(!file)return reply(404,{error:'Unknown media'});
   const size=(await stat(file)).size;let start=0,end=size-1,status=200;
   if(req.headers.range){const r=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!r||(!r[1]&&!r[2])){res.setHeader('Content-Range',`bytes */${size}`);return reply(416,{error:'Invalid range'})}if(!r[1]){if(Number(r[2])===0)return reply(416,{error:'Invalid range'});start=Math.max(0,size-Number(r[2]))}else{start=Number(r[1]);if(r[2])end=Math.min(end,Number(r[2]))}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.setHeader('Content-Range',`bytes */${size}`);return reply(416,{error:'Range outside media'})}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`)}
   const ext=extname(file instanceof URL?file.pathname:file).toLowerCase(),type={'.mp4':'video/mp4','.webm':'video/webm','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[ext]||'application/octet-stream';
   res.setHeader('Content-Type',type);res.setHeader('Content-Length',end-start+1);res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','private, max-age=60');if(url.searchParams.has('download'))res.setHeader('Content-Disposition',`attachment; filename="${id.replace(/[^a-z0-9-]/gi,'_')}${ext}"`);res.writeHead(status);if(req.method==='HEAD')return res.end();const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }catch(error){if(!res.headersSent)reply(500,{error:'Review request failed'});else res.destroy();console.error(error.message)}
 });return server;
}
