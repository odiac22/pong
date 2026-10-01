// Read-only inventory of project-owned evidence. Never reads file contents.
import {readdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
const repo=path.resolve(import.meta.dirname,'..');
const roots=[path.join(repo,'artifacts'),path.join(repo,'Pong Swap','benchmarks'),path.join(repo,'Pong Swap','reports'),path.join(repo,'Pong Swap','original_models'),path.join(repo,'docs'),'E:/Pong Benchmarks'];
const results=[];
const skip=new Set(['node_modules','.git','__pycache__','runtime','vendor']);
async function walk(dir,root,depth=0){
 let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
 for(const e of entries){
  const p=path.join(dir,e.name);
  if(e.isSymbolicLink())continue;
  if(e.isDirectory()){
   if(depth===0)results.push({kind:'directory',root,path:p});
   if(!skip.has(e.name)&&!/^silent-chrome|^chrome-profile|^firefox-profile/i.test(e.name))await walk(p,root,depth+1);
  }else if(/\.(md|json|html|csv|jsonl)$/i.test(e.name)&&!/token|credential|secret|cookie|signing|private|profile|preferences|sessionstorage|localstorage/i.test(e.name)){
   const s=await stat(p);results.push({kind:'evidence-file',root,path:p,bytes:s.size,modified:s.mtime.toISOString()});
  }
 }
}
for(const root of roots)await walk(root,root);
await writeFile(path.join(repo,'docs','PONG_HANDOFF_EVIDENCE_INDEX.json'),JSON.stringify({generatedAt:new Date().toISOString(),scope:'Paths and sizes only; file presence is not benchmark qualification. Private browser profiles excluded. No media, model weights, or credential contents copied.',roots,entries:results},null,2));
console.log(JSON.stringify({entries:results.length,roots:roots.length}));
