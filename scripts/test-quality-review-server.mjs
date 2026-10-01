import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReviewServer,comparisonKey,validScore} from './quality-review-server.mjs';
test('exact hundredths and bounds',()=>{for(const x of [0,0.01,1,1.01,8.37,9.99,10])assert.ok(validScore(x));for(const x of [-.01,10.01,NaN,Infinity,1.001,'8.20',null])assert.equal(validScore(x),false)});
test('a matched rerun does not silently reuse old comparison scores',()=>{
 const m={faceId:'approved-8',baselineId:'original',clips:[{id:1,sha256:'old'}]};
 const c={id:'candidate-a',baselineId:'matched-r3'},row={clip:1,sha256:'after',before:{sha256:'fresh'}};
 const key=comparisonKey(m,c,row);
 assert.notEqual(key,comparisonKey(m,c,{...row,before:{sha256:'changed'}}));
 assert.notEqual(key,comparisonKey(m,{...c,baselineId:'different-run'},row));
 assert.equal(key,comparisonKey({...m,baselineId:'unrelated-latest'},c,row));
});
test('private media and durable scores',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pong-review-test-')),token='a'.repeat(48),file=join(root,'fixture.mp4');await writeFile(file,Buffer.from('0123456789'));
 const composite=join(root,'combined.webm');await writeFile(composite,Buffer.from('abcdefghij'));
 const m={faceId:'approved-8',baselineId:'baseline-r1',faces:[],clips:[{id:1,baseline:file,source:file,sha256:'before'}],candidates:[{id:'candidate-a',name:'A',clips:[{clip:1,file,sha256:'after',comparison:{file:composite,sha256:'combined',crop:[0,0,2,2],integrity:{pixelExact:true}}}]}]};await writeFile(join(root,'gallery.json'),JSON.stringify(m));
 const server=createReviewServer({root,host:'127.0.0.1',port:0,token});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,url=origin+'/review/'+token+'/';
 const post=body=>fetch(url+'ratings',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
 try{
  const restoration=await fetch(url+'restoration');assert.equal(restoration.status,200);assert.match(restoration.headers.get('content-type'),/text\/html/);assert.match(await restoration.text(),/approved28-restoration-tan/);
  assert.equal((await fetch(origin+'/restoration')).status,404);
  const manifest=await fetch(url+'manifest').then(r=>r.json());assert.equal(manifest.clips[0].baseline,undefined);assert.equal(manifest.candidates[0].clips[0].file,undefined);assert.equal(manifest.candidates[0].clips[0].ready,true);
  assert.equal(manifest.candidates[0].clips[0].comparison.file,undefined);assert.equal(manifest.candidates[0].clips[0].comparison.ready,true);
  const combined=await fetch(url+'media/candidate-a-comparison-1',{headers:{Range:'bytes=1-3'}});assert.equal(combined.status,206);assert.equal(combined.headers.get('Content-Type'),'video/webm');assert.equal(await combined.text(),'bcd');
  const ranged=await fetch(url+'media/baseline-1',{headers:{Range:'bytes=2-5'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'2345');assert.equal(ranged.headers.get('Content-Range'),'bytes 2-5/10');
  assert.equal((await fetch(url+'media/baseline-1',{headers:{Range:'bytes=50-'}})).status,416);
  assert.equal((await fetch(url+'media/not-listed')).status,404);assert.equal((await fetch(origin+'/')).status,404);
  const body={experimentId:'candidate-a',clip:1,comparisonKey:comparisonKey(m,m.candidates[0],m.candidates[0].clips[0]),before:8.37,after:9.99,comment:'Keep these exact scores'};
  assert.equal((await post(body)).status,200);const stored=JSON.parse(await readFile(join(root,'ratings.json'),'utf8'));assert.equal(stored.ratings[body.comparisonKey].before,8.37);assert.equal(stored.ratings[body.comparisonKey].after,9.99);
  assert.equal((await post({...body,before:0,after:10})).status,200);assert.equal((await post(body)).status,200);
  assert.equal((await post({...body,after:9.999})).status,400);assert.equal((await post({...body,comparisonKey:'stale'})).status,409);
  assert.equal((await fetch(url+'ratings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(url+'ratings').then(r=>r.json())).ratings[body.comparisonKey].comment,body.comment);
  await writeFile(join(root,'public-origin.json'),JSON.stringify({origin:'https://review-fixture.trycloudflare.com'}));
  assert.equal((await fetch(url+'ratings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://review-fixture.trycloudflare.com'},body:JSON.stringify(body)})).status,200);
  assert.equal((await fetch(url+'ratings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://review-fixture.trycloudflare.com.evil.invalid'},body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(url+'ratings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid','X-Forwarded-Host':'review-fixture.trycloudflare.com'},body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(url)).headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true})}
});
