import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
const canonical=src.slice(src.indexOf('  const canonical ='),src.indexOf('  const area ='));
const policy=src.slice(src.indexOf('  const videoPage ='),src.indexOf('  const mediaHint ='));
const one='https://www.tiktok.com/@creator/video/1234567890123456789';
const two='https://www.tiktok.com/@creator/video/1234567890123456780';
const video=id=>({closest:()=>id?{id:'xgwrapper-10-'+id}:null});
function fixture(route,links=[],card=''){
 return vm.runInNewContext(`(()=>{${canonical}${policy}return videoPage})()`,{
  URL,location:{href:route},document:{querySelectorAll:()=>links.map(href=>({href}))},itemUrl:()=>card
 });
}
test('cinema binds the displayed decoder to its own ID when address bar advances first',()=>{
 assert.equal(fixture(two,[one,two])(video('1234567890123456789')),one);
 assert.equal(fixture(one,[one,two])(video('1234567890123456780')),two);
});
test('an identified player never inherits a mismatched route or another cards React item',()=>{
 assert.equal(fixture(two,[],two)(video('1234567890123456789'),{}),'');
 assert.equal(fixture(one,[two])(video('1234567890123456789')),one);
});
test('ordinary feed data remains usable without a player wrapper',()=>{
 assert.equal(fixture(two,[],one)(video(null),{}),one);
 assert.equal(fixture(two)(video(null)),two);
});
test('the real scan uses decoder identity before adopting prepared pixels',()=>{
 assert.match(src,/const candidateCurrent = activeVideo \? videoPage\(video,active\) : ''/);
 assert.match(src,/const current = advertisement \? '' : candidateCurrent/);
 assert.ok(src.indexOf('const current = advertisement')<src.indexOf('window.__pongDomSwapObserveVideo?.(current,video)'));
});
