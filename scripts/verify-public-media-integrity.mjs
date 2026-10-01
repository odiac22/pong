// Compare original and proxied bytes without storing or playing remote media.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const [url,app,out]=process.argv.slice(2);
const report={url,app,silent:true,createdAt:new Date().toISOString(),results:[]};
for(const [kind,target]of [['original',url],['proxy',app+'/proxy?url='+encodeURIComponent(url)]]){
 const started=performance.now();
 const response=await fetch(target,{signal:AbortSignal.timeout(30000)});
 const hash=createHash('sha256');let bytes=0;
 for await(const chunk of response.body){bytes+=chunk.byteLength;hash.update(chunk);}
 report.results.push({kind,status:response.status,declaredBytes:Number(response.headers.get('content-length')),bytes,sha256:hash.digest('hex'),elapsedMs:Math.round(performance.now()-started)});
}
report.identical=report.results[0].sha256===report.results[1].sha256&&report.results.every(r=>r.status===200&&r.bytes===r.declaredBytes);
await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!report.identical)process.exitCode=1;
