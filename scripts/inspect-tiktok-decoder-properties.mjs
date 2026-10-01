import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'tiktok');const properties=new Map();
const stop=page.onEvent(m=>{
 if(m.method==='Media.playerPropertiesChanged'){
  const current=properties.get(m.params.playerId)||{};
  for(const p of m.params.properties)if(/codec|decoder|size|resolution|dimension|hardware|pipeline/i.test(p.name))current[p.name]=p.value;
  properties.set(m.params.playerId,current);
 }
});
try{await page.call('Media.enable');await new Promise(r=>setTimeout(r,1500));console.log(JSON.stringify([...properties.values()]));}
finally{await page.call('Media.disable').catch(()=>{});stop();page.close()}
