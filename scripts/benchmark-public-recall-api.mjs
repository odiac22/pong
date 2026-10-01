// Real public-page Recall route, on the isolated benchmark server only.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const [manifestFile,out,base='http://127.0.0.1:17887']=process.argv.slice(2);
await mkdir(out,{recursive:true});
const cases=JSON.parse(await readFile(manifestFile,'utf8'));
const report={kind:'public-page Recall API, not paced playback',headless:true,silent:true,concurrency:3,timeoutMs:45000,startedAt:new Date().toISOString(),cases:[]};
let next=0,saveChain=Promise.resolve();
await Promise.all(Array.from({length:3},async()=>{while(next<cases.length){const c=cases[next++];
 const started=performance.now(),row={...c};
 try{
  const r=await fetch(base+'/media-page/recall',{method:'POST',headers:{'Content-Type':'application/json','X-Pong-SimpCity-Controller':'1'},body:JSON.stringify({sourceUrl:c.url,pageUrls:[c.url],mode:'main',channel:2,ignoreUnder30:false,title:c.listingTitle}),signal:AbortSignal.timeout(report.timeoutMs)});
  row.status=r.status;row.result=await r.json();
 }catch(e){row.error=String(e);}
 row.elapsedMs=performance.now()-started;report.cases.push(row);
 const snapshot=JSON.stringify(report,null,2);saveChain=saveChain.then(()=>writeFile(out+'/report.json',snapshot));await saveChain;
 console.log(JSON.stringify({site:c.site,ordinal:c.ordinal,ms:Math.round(row.elapsedMs),status:row.status,videos:row.result?.videos,error:row.error||row.result?.error}));
}}));
report.completed=true;await writeFile(out+'/report.json',JSON.stringify(report,null,2));
