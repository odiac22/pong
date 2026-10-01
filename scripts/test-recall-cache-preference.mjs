import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function body(name) {
  const start=html.indexOf(`function ${name}(`);
  return html.slice(start,html.indexOf('\nfunction ',start+1));
}
for(const name of ['random40PlaybackUrl','random40ForegroundPlaybackUrl']) {
  test(`${name}: populated Recall cache wins; cold Recall keeps supplied route`,()=>{
    let record=null, direct='https://media.example/direct.mp4';
    const c=vm.createContext({pongCanonicalRawMediaUrl:x=>x,
      random40ServerVideoCacheRecordFor:()=>record,pongGenericRecallCaptureActive:()=>true,
      pongGenericRecallDirectPlaybackUrl:()=>direct});
    vm.runInContext(body(name),c);
    assert.equal(c[name]('/proxy?test'),'https://media.example/direct.mp4');
    for(const flag of ['ready','growingReady']) {
      record={[flag]:true,playbackUrl:'http://pc.example/video-cache/media/test'};
      assert.equal(c[name]('/proxy?test'),record.playbackUrl);
    }
    record={ready:false,growingReady:false};direct='';
    assert.equal(c[name]('/proxy?test'),'/proxy?test');
  });
}
test('Recall does not newly declare an incomplete cache playback-ready',()=>{
  const start=html.indexOf('      const encodedBytesPerSecond = Math.max(0, Number(playbackMetadata.bytesPerSecond || 0));');
  const end=html.indexOf('      random40ServerVideoCacheTracked.set',start);
  const script=html.slice(start,end)+'\ngrowingReady';
  function ready(bytes,status='downloading',duration=100) {
    return vm.runInNewContext(script,{bytes,record:{playable:true,ready:false,status,totalBytes:100*1024**2},
      playbackMetadata:{duration},pongGenericRecallCaptureActive:()=>true,pongLocal22TurboPlaybackActive:()=>false});
  }
  assert.equal(ready(0),false);
  assert.equal(ready(5*1024**2),false);
  assert.equal(ready(7*1024**2),false);
  assert.equal(ready(7*1024**2,'queued'),false);
  assert.equal(ready(7*1024**2,'error'),false);
  assert.equal(ready(7*1024**2,'downloading',0),false);
});
