// Read only, redact query strings and any iframe credentials.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'tiktok');
try{
 const x=await p.call('Page.getFrameTree');
 const walk=f=>({origin:f.frame.securityOrigin,path:(()=>{try{return new URL(f.frame.url).pathname}catch{return ''}})(),children:(f.childFrames||[]).map(walk)});
 console.log(JSON.stringify(walk(x.frameTree)));
 console.log(JSON.stringify(await p.read(`({ids:[...document.querySelectorAll('[id]')].map(e=>e.id).filter(s=>/captcha|verify|arkose/i.test(s)),iframes:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,id:f.id,path:(()=>{try{return new URL(f.src).pathname}catch{return ''}})()}))})`)));
}finally{p.close()}
