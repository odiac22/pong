import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60195,'tiktok');
try{console.log(await c.read(readFileSync('android-app/app/src/main/assets/tiktok-phone-fit.js','utf8')))}finally{c.close()}
