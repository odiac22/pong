// Local operational snapshot for a controlled restart. Never prints source URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const allowActive=process.argv.includes('--allow-active');
const channels=[];
for(const channel of [1,2,3]){
 const response=await fetch(`http://127.0.0.1:8787/simpcity/recall?channel=${channel}`,{signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('Recall snapshot failed');
 const item=await response.json();
 const active=Boolean(item.pending || item.recall?.live || item.mediaCapture?.state==='running' || ['queued','running','starting'].includes(item.background?.state));
 if(active&&!allowActive)throw Error('Recall work is active; do not restart');
 channels.push({channel,recall:item.recall||null,mediaCapture:item.mediaCapture||null,pending:active?(item.pending||null):null,wasActive:active});
}
const file=path.join(root,'.pong-local-ai',`recall-restart-${Date.now()}.json`);
await fs.writeFile(file,JSON.stringify({schema:1,channels}),{flag:'wx'});
console.log(JSON.stringify({file,channels:channels.map(c=>({channel:c.channel,hasRecall:!!c.recall,wasActive:c.wasActive}))}));
