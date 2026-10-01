import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../universal-video-scraper.user.js',import.meta.url),'utf8');
const start=source.indexOf('  function collectLogicalWatchPageTargets(');
const end=source.indexOf('\n  function collectLogicalWatchPageUrls(',start);
assert.ok(start>0&&end>start);

test('site-wide navigation /details route is not a video target',()=>{
  const page='https://archive.org/details/BigBuckBunny_124';
  const anchors=[
    {href:'https://archive.org/details/texts',getAttribute:()=>null,closest:s=>s.includes('nav')?{}:null},
    {href:'https://archive.org/details/another-movie',getAttribute:()=>null,closest:()=>null}
  ];
  const doc={querySelectorAll:selector=>selector==='a[href]'?anchors:[],documentElement:{dataset:{}}};
  const context=vm.createContext({document:doc,location:{href:page},URL,
    canonicalWatchPageUrl:u=>String(u),isLogicalVideoPageUrl:u=>/\/details\//.test(String(u)),
    logicalPageDurationHint:()=>0,independentVideoGroupsFromDoc:()=>[],
    primaryMediaEntriesFromDoc:()=>[],embeddedPlayerPageUrls:()=>[],extractPageDurationSeconds:()=>0});
  vm.runInContext(source.slice(start,end),context);
  const result=context.collectLogicalWatchPageTargets(doc,page);
  assert.equal(result.some(target=>target.url==='https://archive.org/details/texts'),false);
  assert.equal(result.some(target=>target.url==='https://archive.org/details/another-movie'),true);
});
