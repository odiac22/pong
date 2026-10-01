// Snapshot production routes into a separate working directory. Never use live Recall state.
import {readFile,writeFile,mkdir,copyFile,readdir,cp,symlink,access} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const out=path.resolve(process.argv[2]);
await mkdir(out,{recursive:true});
for(const name of await readdir(root))if(/\.(mjs|js|html|webmanifest|svg)$/.test(name))await copyFile(path.join(root,name),path.join(out,name));
await cp(path.join(root,'ui'),path.join(out,'ui'),{recursive:true});
await mkdir(path.join(out,'.pong-local-ai'),{recursive:true});
for(const [target,link] of [[path.join(root,'node_modules'),path.join(out,'node_modules')],[path.join(root,'.pong-local-ai/lora-venv'),path.join(out,'.pong-local-ai/lora-venv')]]){
 try{await access(link);}catch{await symlink(target,link,'junction');}
}
let code=await readFile(path.join(out,'local-ai-server.mjs'),'utf8');
// Harness-only isolation: disable unrelated network warmups / model ownership.
for(const name of ['warmGatewayConnections','cleanupStaleSimpCityProfiles','sleepAiWorkersIfIdle']){
 const marker=`async function ${name}(`,start=code.indexOf(marker),brace=code.indexOf('{',start);
 if(start<0)throw Error('Missing isolation hook '+name);
 code=code.slice(0,brace+1)+'\n return; // isolated public-video benchmark\n'+code.slice(brace+1);
}
code=code.replace('  reportPreferenceReady().catch(() => {});','  // Other model services are outside this benchmark.');
code=code.replace('  ensurePongSwapService({ warm: true })','  Promise.resolve({gpu:{name:"existing quality baseline; no startup mutation"}})');
await writeFile(path.join(out,'local-ai-server.mjs'),code);
await writeFile(path.join(out,'snapshot-info.json'),JSON.stringify({root,out,createdAt:new Date().toISOString(),harnessOnlyChanges:['disable unrelated background warmup','disable cleanup of production browser profiles','disable AI worker lifecycle','skip swap startup warming'],publicVideoRoutesUnchanged:true},null,2));
console.log(out);
