import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
const extraction=code.slice(code.indexOf('  const reactVideo ='),code.indexOf('  const itemUrl ='));
const resolve=vm.runInNewContext(`(()=>{const canonical=x=>x;${extraction};return reactVideo;})()`);
const item=(id='1234567890123456789',author='fixture')=>({id,author:{uniqueId:author}});

function virtualCard(post=item()){
 const component={memoizedProps:{id:post.id,index:2},memoizedState:{memoizedState:{current:{hasValue:true,value:post}}}};
 const element={__reactFiber$test:{return:component},getAttribute:key=>key==='data-e2e'?'recommend-list-item-container':key==='data-scroll-index'?'2':null};
 return {element,component};
}
test('virtualized next cards expose only their own matching selected post',()=>{
 const f=virtualCard();assert.equal(resolve(f.element),'/@fixture/video/1234567890123456789');
 f.component.memoizedState.memoizedState.current.value=item('1234567890123456790');
 assert.equal(resolve(f.element),'');
 f.component.memoizedProps.id='1234567890123456790';
 assert.equal(resolve(f.element),'/@fixture/video/1234567890123456790');
});

test('cached virtual slot avoids repeated enumeration and follows replaced Fibers',()=>{
 const f=virtualCard();let enumerations=0;
 const element=new Proxy(f.element,{ownKeys(target){enumerations++;return Reflect.ownKeys(target)}});
 assert.equal(resolve(element),'/@fixture/video/1234567890123456789');
 const initial=enumerations;
 for(let i=0;i<20;i++)assert.equal(resolve(element),'/@fixture/video/1234567890123456789');
 assert.equal(enumerations,initial);
 const next=virtualCard(item('1234567890123456790','replacement'));
 f.element.__reactFiber$test=next.element.__reactFiber$test;
 assert.equal(resolve(element),'/@replacement/video/1234567890123456790');
 assert.equal(enumerations,initial);
 let getterCalls=0;
 Object.defineProperty(next.component.memoizedState.memoizedState.current,'value',{
  get(){getterCalls++;throw Error('must not execute a page getter');}
 });
 assert.equal(resolve(element),'');assert.equal(getterCalls,0);
});
test('virtualized fallback rejects a stale slot, photos, unrelated stores and getters',()=>{
 for(const post of [{...item(),imagePost:{}},{...item(),imagePostInfo:{}}])assert.equal(resolve(virtualCard(post).element),'');
 const f=virtualCard();f.component.memoizedProps.index=3;assert.equal(resolve(f.element),'');
 f.component.memoizedProps.index=2;
 let called=false;Object.defineProperty(f.component.memoizedState.memoizedState.current,'value',{get(){called=true;return item()}});
 assert.equal(resolve(f.element),'');assert.equal(called,false);
 f.element.getAttribute=()=>null;assert.equal(resolve(f.element),'');
});
test('virtualized fallback is bounded even with cyclic parents and hooks',()=>{
 const f=virtualCard();f.component.memoizedState.memoizedState={};f.component.memoizedState.next=f.component.memoizedState;
 f.component.return=f.component;
 assert.equal(resolve(f.element),'');
});

test('missing anchors on video routes preserve distinct current and next card identities',()=>{
 const canonicalCode=code.slice(code.indexOf('  const canonical ='),code.indexOf('  const area ='));
 const itemCode=code.slice(code.indexOf('  const itemUrl ='),code.indexOf('  const scan ='));
 const urlFor=vm.runInNewContext(`(()=>{${canonicalCode}${extraction}${itemCode}return itemUrl;})()`,
   {URL,location:{href:'https://www.tiktok.com/@fixture/video/1234567890123456789'}});
 const card=id=>({closest:()=>null,querySelector:()=>null,__reactProps$test:{item:item(id)}});
 assert.equal(urlFor(card('1234567890123456789')),'https://www.tiktok.com/@fixture/video/1234567890123456789');
 assert.equal(urlFor(card('1234567890123456790')),'https://www.tiktok.com/@fixture/video/1234567890123456790');
 assert.equal(urlFor({closest:()=>null,querySelector:()=>null}),'');
});

test('metadata traversal never invokes accessors or object string conversions',()=>{
 let calls=0;
 const unsafe={id:{toString(){calls++;throw Error('conversion');}}};
 Object.defineProperty(unsafe,'author',{enumerable:true,get(){calls++;throw Error('getter');}});
 Object.defineProperty(unsafe,'cookie',{enumerable:true,get(){calls++;throw Error('cookie');}});
 assert.equal(resolve({__reactProps$test:{unsafe,valid:item()}}),'/@fixture/video/1234567890123456789');
 assert.equal(calls,0);
});
test('current props win over outgoing alternate fibers and stay fresh after recycling',()=>{
 const element={__reactFiber$test:{memoizedProps:item('1234567890123456780','previous')},__reactProps$test:{data:item()}};
 assert.equal(resolve(element),'/@fixture/video/1234567890123456789');
 element.__reactProps$test={data:item('1234567890123456790','next')};
 assert.equal(resolve(element),'/@next/video/1234567890123456790');
});
test('unrelated ID and author never become a fabricated video',()=>{
 assert.equal(resolve({__reactProps$test:{one:{id:item().id},two:{author:item().author}}}), '');
});

test('Following author-less posts retain their exact owned video identity',()=>{
 const id='7690300394475441439';
 const card={__reactProps$test:{item:{id,author:'',video:{id}}}};
 assert.equal(resolve(card),'/@_/video/'+id);
 card.__reactProps$test.item.author='resolved';
 assert.equal(resolve(card),'/@resolved/video/'+id);
 card.__reactProps$test.item.author='';card.__reactProps$test.item.video.id='1234567890123456789';
 assert.equal(resolve(card),'');
 for(const data of [{id},{id,author:''},{id,author:'bad/name',video:{id}},
   {id,author:'',video:{id},imagePost:{}},{id,author:'',video:{id},isAd:true}])
  assert.equal(resolve({__reactProps$test:{item:data}}),'');
});

test('photo post metadata is not fabricated into a video source',()=>{
 for(const key of ['imagePost','imagePostInfo']){
   const card={__reactProps$test:{item:{...item(),[key]:{images:[{}]}}}};
   assert.equal(resolve(card),'');
 }
});

test('recognized photo paths are cached without hiding a recycled video',()=>{
 let keys=0;
 const photo={...item(),imagePost:{images:[{}]}};
 const data=new Proxy({item:photo},{ownKeys(x){keys++;return Reflect.ownKeys(x)}});
 const card={__reactProps$test:data};
 assert.equal(resolve(card),'');const initial=keys;
 for(let i=0;i<20;i++)assert.equal(resolve(card),'');
 assert.equal(keys,initial);
 data.item=item('1234567890123456790','incoming');
 assert.equal(resolve(card),'/@incoming/video/1234567890123456790');
 const f=virtualCard(photo);let rootKeys=0;
 const virtual=new Proxy(f.element,{ownKeys(x){rootKeys++;return Reflect.ownKeys(x)}});
 assert.equal(resolve(virtual),'');const first=rootKeys;
 for(let i=0;i<20;i++)assert.equal(resolve(virtual),'');
 assert.equal(rootKeys,first);
 f.component.memoizedState.memoizedState.current.value=item();
 assert.equal(resolve(virtual),'/@fixture/video/1234567890123456789');
});

test('cached descriptor path reads current data instead of remembering an ID',()=>{
 const card={__reactProps$test:{children:{item:item()}}};
 assert.equal(resolve(card),'/@fixture/video/1234567890123456789');
 card.__reactProps$test.children.item=item('1234567890123456790','changed');
 assert.equal(resolve(card),'/@changed/video/1234567890123456790');
 delete card.__reactProps$test.children.item;
 card.__reactProps$test.relocated=item('1234567890123456791','moved');
 assert.equal(resolve(card),'/@moved/video/1234567890123456791');
});

test('stable current props avoid re-enumerating a wide tree',()=>{
 let keys=0;const data=new Proxy({children:{item:item()}},{ownKeys(x){keys++;return Reflect.ownKeys(x)}});
 const card={__reactProps$test:data};resolve(card);const first=keys;
 for(let i=0;i<20;i++)assert.equal(resolve(card),'/@fixture/video/1234567890123456789');
 assert.equal(keys,first);
});

test('a replaced cached path accessor is not invoked',()=>{
 let calls=0;const root={item:item()},card={__reactProps$test:root};resolve(card);
 Object.defineProperty(root,'item',{get(){calls++;throw Error('accessor')},enumerable:true});
 assert.equal(resolve(card),'');assert.equal(calls,0);
});
test('a wide Fiber cannot starve the nested current and next items in real card props',()=>{
 const fiber={};for(let a=0;a<60;a++){fiber['a'+a]={};for(let b=0;b<60;b++)fiber['a'+a]['b'+b]={};}
 const card=(id,author)=>({__reactFiber$test:fiber,__reactProps$test:{children:{props:{children:[null,{props:{item:{id,author}}}]}}}});
 assert.equal(resolve(card('1234567890123456789','current')),'/@current/video/1234567890123456789');
 assert.equal(resolve(card('1234567890123456790','next')),'/@next/video/1234567890123456790');
});
test('wide cyclic data has a bounded traversal and DOM parent references are ignored',()=>{
 let inspections=0;
 const leaf=()=>new Proxy({}, {ownKeys(){inspections++;return []}});
 const root={};for(let a=0;a<60;a++){root['a'+a]={};for(let b=0;b<60;b++)root['a'+a]['b'+b]=leaf();}
 root.self=root;
 assert.equal(resolve({__reactProps$test:root}), '');
 assert.ok(inspections<=180);
 assert.equal(resolve({__reactFiber$test:{stateNode:item(),ownerDocument:item(),return:item()}}),'');
});
test('playing events cancel pending scans instead of multiplying timer chains',()=>{
 const timers=new Map(),listeners=new Map();let id=0,mutate;
 const document={hidden:false,documentElement:{},querySelector:()=>null,querySelectorAll:()=>[],
   addEventListener:(name,fn)=>listeners.set(name,fn)};
 const context={window:{},document,URL,location:{href:'https://www.tiktok.com/foryou'},
   innerWidth:400,innerHeight:800,performance:{now:()=>1000},
   setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key),setInterval(){},addEventListener(){},
   MutationObserver:class{constructor(fn){mutate=fn}observe(){}}};
 vm.runInNewContext(code,context);
 assert.equal(timers.size,1);
 const playing={target:{tagName:'VIDEO',classList:{contains:()=>false}}};
 for(let i=0;i<20;i++){mutate();listeners.get('playing')(playing);assert.equal(timers.size,0);}
 for(let i=0;i<20;i++)mutate();
 assert.equal(timers.size,1);
});
