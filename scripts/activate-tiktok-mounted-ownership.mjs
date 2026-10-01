// Publish only the fixed mounted-activation function to the test receiver.
// The HTTP server reads the same index.html for subsequent ordinary loads.
import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const html=readFileSync('index.html','utf8');
const begin=html.indexOf('window.PongTikTokLiveSwapCurrent =');
const end=html.indexOf('\nfunction pongTikTokWrapperUrl(',begin);
if(begin<0||end<=begin)throw Error('Mounted activation boundaries changed');
const code=html.slice(begin,end);
if(!code.includes('activationStillOwned')||!code.includes('BEGIN_TIKTOK_MOUNTED_ACTIVATION'))
  throw Error('Expected ownership fix is missing');
const page=await connectWebView(60195,'pong');
try{
  const before=await page.read('({enabled:pongFaceSwapState.enabled,selection:pongFaceSwapFaceIds(),sequence:pongFaceSwapState.activationSequence})');
  if(before.enabled)throw Error('Pause owned swap sessions before this scoped activation');
  await page.read(code);
  const after=await page.read('({enabled:pongFaceSwapState.enabled,selection:pongFaceSwapFaceIds(),sequence:pongFaceSwapState.activationSequence,fixed:window.PongTikTokLiveSwapCurrent.toString().includes("activationStillOwned")})');
  if(!after.fixed||JSON.stringify(before.selection)!==JSON.stringify(after.selection)||
      before.enabled!==after.enabled||before.sequence!==after.sequence)
    throw Error('Activation state did not remain unchanged');
  console.log(JSON.stringify({activated:true,selectedFacesUnchanged:true,swapStateUnchanged:true}));
}finally{page.close()}
