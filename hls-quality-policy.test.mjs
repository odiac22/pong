import test from 'node:test';import assert from 'node:assert/strict';
import {highestQualityHlsMaster} from './hls-quality-policy.mjs';
test('pins the highest declared rendition while keeping audio and encryption metadata',()=>{
 const m='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="sound.m3u8"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="a"\nhigh.m3u8\n';
 const r=highestQualityHlsMaster(m);assert.match(r,/high.m3u8/);assert.doesNotMatch(r,/low.m3u8/);assert.match(r,/sound.m3u8/);assert.match(r,/SESSION-KEY/);
});
test('pixel area then frame rate then bandwidth decide ties',()=>{
 const m='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1080x1920,FRAME-RATE=60\na\n#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080,FRAME-RATE=30\nb\n';
 assert.ok(highestQualityHlsMaster(m).endsWith('a\n'));
});
test('media playlists and single renditions are unchanged',()=>{
 for(const m of ['#EXTM3U\n#EXTINF:4,\nsegment.ts\n','#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000\none.m3u8'])assert.equal(highestQualityHlsMaster(m),m);
});
