// Isolated state/cache, unchanged engine quality, production source snapshot.
import {readFile, writeFile, mkdir, copyFile, readdir, cp, symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out=process.argv[2];
if(!out || !path.resolve(out).startsWith('E:\\Pong Benchmarks\\')) throw Error('Explicit benchmark output on E: required');
const server=path.join(out,'server'); await mkdir(server,{recursive:true});
const hash=s=>createHash('sha256').update(s).digest('hex');
const settings=await fetch('http://127.0.0.1:8792/settings').then(r=>r.json());
const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
const files={};
for(const entry of await readdir(root,{withFileTypes:true})) {
  if(entry.isFile() && /\.(mjs|js|html|css|json)$/.test(entry.name)) {
    await copyFile(path.join(root,entry.name),path.join(server,entry.name));
    if(['index.html','local-ai-server.mjs','universal-video-scraper.user.js'].includes(entry.name))
      files[entry.name]=hash(await readFile(path.join(root,entry.name)));
  }
}
for(const dir of ['ui','scripts']) await cp(path.join(root,dir),path.join(server,dir),{recursive:true});
for(const dir of ['node_modules','.tools','Pong Swap']) {
  try {await symlink(path.join(root,dir),path.join(server,dir),'junction');}
  catch(e) {if(e.code!=='EEXIST') throw e;}
}
const source=await readFile(path.join(root,'universal-video-scraper.user.js'),'utf8');
const needle=": ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];";
if(source.split(needle).length!==2) throw Error('Unexpected userscript endpoint configuration');
await writeFile(path.join(server,'universal-video-scraper.user.js'),source.replace(needle,": ['http://127.0.0.1:17929'];"));
const manifest=JSON.parse(await readFile('E:/Pong Benchmarks/v3006-public-recall/manifest.json','utf8'));
// Public stock/video documentation sites only. Three different watch pages/site.
const selectedSites=['pexels','pixabay','mixkit','coverr','videezy','vecteezy','youtube','archive','wikimedia','nasa','esa','ted','vimeo'];
const cases=manifest.filter(x=>selectedSites.includes(x.site) && x.ordinal<=3);
await writeFile(path.join(out,'sites.json'),JSON.stringify(cases,null,2));
await writeFile(path.join(out,'baseline.json'),JSON.stringify({recordedAt:new Date().toISOString(),settings,health,
  qualityHash:hash(JSON.stringify(settings.config)),files,scope:'Real signed-manager Firefox touch + isolated Recall + Android Pong emulator',
  thresholds:{startupMs:1500,swapMs:1500,continuousPlaybackSeconds:10},
  warning:'Measurements must distinguish cold/warm cache and first decoded frame from first transformed frame.'},null,2));
console.log(JSON.stringify({server,out,cases:cases.length,sites:new Set(cases.map(x=>x.site)).size,qualityHash:hash(JSON.stringify(settings.config)),
  restorer:settings.config.parameters.RestorerTypeTextSel,strength:settings.config.parameters.RestorerSlider}));
