import {readFile,writeFile} from 'node:fs/promises';
import {primaryVideoEvidence} from '../video-source-policy.mjs';
const file=new URL('../universal-video-scraper.user.js',import.meta.url);
let source=await readFile(file,'utf8');
const begin='  // BEGIN SHARED PRIMARY VIDEO POLICY',end='  // END SHARED PRIMARY VIDEO POLICY';
const block=begin+'\n'+primaryVideoEvidence.toString()+'\n'+end;
if(source.includes(begin))source=source.slice(0,source.indexOf(begin))+block+source.slice(source.indexOf(end)+end.length);
else source=source.replace('  /* HELPERS */',block+'\n\n  /* HELPERS */');
await writeFile(file,source);
