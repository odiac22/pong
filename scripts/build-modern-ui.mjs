// Mechanically embed the maintained UI assets: Android and /pong need no new routes.
import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('../index.html',import.meta.url);
let html=await readFile(file,'utf8');
for(const [kind,path] of [['style','../ui/pong-modern.css'],['script','../ui/pong-modern.js']]) {
  const content=await readFile(new URL(path,import.meta.url),'utf8');
  const pattern=new RegExp(`<${kind} id="pong-modern-${kind}">[\\s\\S]*?<\\/${kind}>`);
  if(!pattern.test(html))throw Error('Missing embed marker: '+kind);
  html=html.replace(pattern,()=>`<${kind} id="pong-modern-${kind}">\n${content}</${kind}>`);
}
await writeFile(file,html);
