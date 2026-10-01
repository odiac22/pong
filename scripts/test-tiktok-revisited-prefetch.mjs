import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('index.html','utf8');
const start=code.indexOf('    const candidates = forwardWrappers');
const expr=code.slice(start,code.indexOf('    const desiredKeys',start));
const candidates=(isTikTokDeck,forwardWrappers)=>vm.runInNewContext(`(()=>{${expr};return candidates;})()`,{isTikTokDeck,forwardWrappers,withinDeckBudget:2});
test('revisited TikTok destinations keep immediate-next priority after refresh and Back',()=>{
 const viewed={isConnected:true,dataset:{viewed:'true'}},fresh={isConnected:true,dataset:{}};
 assert.deepEqual([...candidates(true,[viewed,fresh])],[viewed,fresh]);
});
test('ordinary Pong history exclusion and the two-item cap are unchanged',()=>{
 const viewed={isConnected:true,dataset:{viewed:'true'}},fresh={isConnected:true,dataset:{}},extra={isConnected:true,dataset:{}};
 assert.deepEqual([...candidates(false,[viewed,fresh])],[fresh]);
 assert.deepEqual([...candidates(true,[viewed,fresh,extra])],[viewed,fresh]);
 assert.equal(candidates(true,[{isConnected:false,dataset:{}}]).length,0);
});
