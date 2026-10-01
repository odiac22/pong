import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60196,'pong');
try{
 console.log('servedFix', (await fetch('http://127.0.0.1:8787/pong').then(r=>r.text())).includes('ownsRestoration'));
 await c.read(`(()=>{silenceAllPongAudioExcept();rememberPlayerAudioPreference(false);for(const v of document.querySelectorAll('video,audio')){v.muted=true;v.volume=0;v.pause()}return true})()`);
 await c.call('Page.reload',{ignoreCache:true});
 console.log('refreshed');
}finally{c.close()}
