// Read-only differential trial for Pong's overlay hitboxes. Run separately
// with panels closed and manually opened; this script never changes the UI.
import { connectWebView } from './lib/tiktok-audit-cdp.mjs';

const port = Number(process.env.PONG_CDP_PORT || 9225);
const samples = Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] || 4);
const label = String(process.argv.find(arg => arg.startsWith('--label='))?.slice('--label='.length) || 'unspecified')
  .replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CDP port');
if (!Number.isInteger(samples) || samples < 1 || samples > 12) throw Error('Samples must be 1–12');

const expression = `(() => {
  const selector = 'button,a[href],input,textarea,select,[role="button"],[role="slider"],.video-progress-container,.audio-toggle-button,.control-button,.pong-face-swap-picker,.pong-face-swap-menu,#pong-face-swap-picker,#pong-face-swap-settings-panel,#pong-collection-panel,.auth-helper-panel';
  const nodes = Array.from(document.querySelectorAll(selector));
  const inView = r => !!r.width && !!r.height && r.bottom > 0 && r.right > 0 &&
    r.top < innerHeight && r.left < innerWidth;
  const normalized = r => ({x:r.left/innerWidth,y:r.top/innerHeight,
    w:r.width/innerWidth,h:r.height/innerHeight});
  const oldRect = (node, visibility) => {
    const visited=[];
    for(let parent=node;parent;parent=parent.parentElement){
      if(visibility.has(parent)){
        if(!visibility.get(parent)){visited.forEach(p=>visibility.set(p,false));return null;}
        break;
      }
      visited.push(parent);
      const c=getComputedStyle(parent);
      if(parent.hidden||c.display==='none'||c.visibility==='hidden'||Number(c.opacity)===0){
        visited.forEach(p=>visibility.set(p,false));return null;
      }
    }
    visited.forEach(p=>visibility.set(p,true));
    const r=node.getBoundingClientRect();
    return inView(r)?normalized(r):null;
  };
  const oldSnapshot = () => {
    const visibility=new WeakMap(),hits=[];
    nodes.forEach((node,index)=>{const rect=oldRect(node,visibility);if(rect)hits.push({index,rect});});
    return hits.slice(0,256);
  };
  const variants = {
    legacy:{checkOpacity:true,checkVisibilityCSS:true},
    current:{opacityProperty:true,visibilityProperty:true},
    combined:{checkOpacity:true,checkVisibilityCSS:true,opacityProperty:true,visibilityProperty:true}
  };
  const nativeSnapshot = options => {
    const hits=[];
    nodes.forEach((node,index)=>{
      if(typeof node.checkVisibility!=='function'||!node.checkVisibility(options))return;
      const r=node.getBoundingClientRect();
      if(inView(r))hits.push({index,rect:normalized(r)});
    });
    return hits.slice(0,256);
  };
  const compare = (oldHits,newHits) => {
    const oldByIndex=new Map(oldHits.map(hit=>[hit.index,hit.rect]));
    const newByIndex=new Map(newHits.map(hit=>[hit.index,hit.rect]));
    const mismatches=[];
    for(const index of new Set([...oldByIndex.keys(),...newByIndex.keys()])){
      if(JSON.stringify(oldByIndex.get(index))!==JSON.stringify(newByIndex.get(index)))
        mismatches.push({index,oldPresent:oldByIndex.has(index),newPresent:newByIndex.has(index)});
    }
    return {exact:mismatches.length===0,mismatchCount:mismatches.length,
      mismatchSample:mismatches.slice(0,12)};
  };
  const oldHits=oldSnapshot();
  const results={};
  for(const [name,options] of Object.entries(variants)){
    const nativeHits=nativeSnapshot(options);
    results[name]={oldVisible:oldHits.length,nativeVisible:nativeHits.length,
      ...compare(oldHits,nativeHits)};
  }
  // An offscreen wrapper can still contain a fixed-position visible control.
  // Counting these makes a wrapper-level skip demonstrably unsafe when nonzero.
  const wrapperRects=new Map();
  let visibleFixedEscapeCount=0,visibleOffscreenWrapperCount=0;
  for(const hit of oldHits){
    const node=nodes[hit.index],wrapper=node.closest('.video-wrapper');
    if(!wrapper)continue;
    if(!wrapperRects.has(wrapper))wrapperRects.set(wrapper,wrapper.getBoundingClientRect());
    if(!inView(wrapperRects.get(wrapper))){
      visibleOffscreenWrapperCount++;
      if(getComputedStyle(node).position==='fixed')visibleFixedEscapeCount++;
    }
  }
  const timings={oldMs:0,combinedMs:0};
  for(let i=0;i<${samples};i++){
    let began=performance.now();
    if(i%2===0){oldSnapshot();timings.oldMs+=performance.now()-began;
      began=performance.now();nativeSnapshot(variants.combined);timings.combinedMs+=performance.now()-began;}
    else{nativeSnapshot(variants.combined);timings.combinedMs+=performance.now()-began;
      began=performance.now();oldSnapshot();timings.oldMs+=performance.now()-began;}
  }
  return {label:${JSON.stringify(label)},scope:'read-only-current-dom',overlayActive:
    document.documentElement.classList.contains('pong-tiktok-original-overlay'),
    supported:nodes.every(node=>typeof node.checkVisibility==='function'),
    candidates:nodes.length,oldVisible:oldHits.length,oldLimitReached:oldHits.length===256,
    variants:results,visibleOffscreenWrapperCount,visibleFixedEscapeCount,
    timingSamples:${samples},meanOldMs:timings.oldMs/${samples},
    meanCombinedMs:timings.combinedMs/${samples}};
})()`;

const pong = await connectWebView(port, 'pong');
try {
  const result = await pong.read(expression);
  console.log(JSON.stringify(result, null, 2));
  if (!result?.supported || !result?.variants?.combined?.exact) process.exitCode = 2;
} finally {
  pong.close();
}
