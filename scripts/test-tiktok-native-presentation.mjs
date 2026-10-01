import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-native-presentation.js','utf8');
function fixture(){
 const style=()=>{const map=new Map([['background',['black','important']]]);return {
  getPropertyValue:k=>map.get(k)?.[0]||'',getPropertyPriority:k=>map.get(k)?.[1]||'',
  setProperty:(k,v,p='')=>map.set(k,[v,p]),removeProperty:k=>map.delete(k)};};
 const ancestor={style:style(),parentElement:null},v={style:style(),parentElement:ancestor,isConnected:true,currentTime:2,paused:false,playbackRate:1,
  getBoundingClientRect:()=>({left:0,top:0,right:400,bottom:700,width:400,height:700})};
 const retired=[];const w={__pongTikTokObservedVideo:{video:v,pageUrl:'page'},PongTikTokSwap:{nativeDepart:s=>retired.push(s)}};
 vm.runInNewContext(code,{window:w,Map,performance:{now:()=>100},innerWidth:400,innerHeight:800,getComputedStyle:()=>({objectFit:'contain'})});
 return {w,v,ancestor,retired};
}
test('native trial only exposes an exact currently observed video',()=>{
 const {w,v}=fixture();assert.equal(w.__pongNativePresent('s','old',{}),false);
 assert.equal(v.style.getPropertyValue('opacity'),'');
 assert.equal(w.__pongNativePresent('s','page',{}),true);
 assert.equal(v.style.getPropertyValue('opacity'),'0');
});
test('native handoff restores style values and priority exactly on departure',()=>{
 const {w,v,ancestor,retired}=fixture();w.__pongNativePresent('s','page',{});
 assert.equal(ancestor.style.getPropertyValue('background'),'transparent');
 w.__pongDomSwapDepart();
 assert.equal(ancestor.style.getPropertyValue('background'),'black');
 assert.equal(ancestor.style.getPropertyPriority('background'),'important');
 assert.equal(v.style.getPropertyValue('opacity'),'');assert.deepEqual(retired,['s']);
 assert.equal(w.__pongNativeState,null);
});
test('new observed post immediately restores the original and names the retired owner',()=>{
 const {w,v,retired}=fixture();w.__pongNativePresent('s','page',{});
 w.__pongDomSwapObserveVideo('new',v);assert.deepEqual(retired,['s']);
 assert.equal(v.style.getPropertyValue('opacity'),'');
});
test('native trial is emulator-only and never labels playback position painted evidence',()=>{
 const source=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const method=source.slice(source.indexOf('private boolean auditNativeTikTokSwap'),source.indexOf('private void ensureTikTokVideoSurface'));
 assert.match(method,/"ranchu"\.equals\(Build.HARDWARE\)/);
 assert.match(method,/getBooleanExtra\("pong_audit_native_swap", false\)/);
 assert.doesNotMatch(method,/PongTikTokLiveSwapPresented|presentedMediaTime|setVolume\(1/);
});

test('native fragment startup is opt-in and declares exactly the existing MP4 parser',()=>{
 const source=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 assert.equal((source.match(/auditNativeTikTokSwap\(\) && getIntent\(\).getBooleanExtra\("pong_audit_native_fragment_start",false\)/g)||[]).length,2);
 assert.match(source,/appendQueryParameter\("transport","mse"\)/);
 assert.match(source,/new ProgressiveMediaSource.Factory\(dataSource,\(\)->new androidx.media3.extractor.Extractor\[\]\{\s*new androidx.media3.extractor.mp4.FragmentedMp4Extractor\(\)\}/);
 assert.match(source,/else factory=new ProgressiveMediaSource.Factory\(dataSource\)/);
 assert.match(source,/if\(auditNativeTikTokSwap\(\) && getIntent\(\).getBooleanExtra\("pong_audit_native_small_reads",false\)\)\s*factory.setContinueLoadingCheckIntervalBytes\(32\*1024\)/);
});

test('SurfaceView is a modern emulator opt-in below the unchanged control layers',()=>{
 const source=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 assert.match(source,/boolean surfaceTrial=auditNativeTikTokSwap\(\) && Build.VERSION.SDK_INT>=34 &&\s*getIntent\(\).getBooleanExtra\("pong_audit_native_surface",false\)/);
 assert.match(source,/surfaceTrial \? R.layout.pong_tiktok_surface_trial : R.layout.pong_tiktok_swap_player/);
 assert.match(source,/output.setZOrderOnTop\(false\)/);
 assert.match(source,/output.setZOrderMediaOverlay\(false\)/);
});

test('native first-frame and error notifications belong to the emitting media timeline',()=>{
 const source=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const analytics=source.slice(source.indexOf('tiktokVideoPlayer.addAnalyticsListener'),source.indexOf('tiktokVideoPlayer.addListener(new Player.Listener'));
 assert.match(analytics,/eventTime.timeline.getWindow\(eventTime.windowIndex/);
 assert.match(analytics,/emitted.equals\(tiktokVideoSessionId\)/);
 assert.match(analytics,/emitted.equals\(tiktokVideoPlayer.getCurrentMediaItem\(\).mediaId\)/);
 assert.match(analytics,/onRenderedFirstFrame\(EventTime eventTime,Object output,long renderTimeMs\)\s*\{\s*if\(!owns\(eventTime\)\)return;/);
 assert.match(analytics,/onPlayerError\(EventTime eventTime,PlaybackException error\)\s*\{\s*if\(!owns\(eventTime\)\)return;/);
});
