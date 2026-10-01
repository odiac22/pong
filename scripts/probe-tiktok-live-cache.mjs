const url=process.argv[2]||'https://www.tiktok.com/@spambiebambi/video/7688542385621552397';
if(!/^https:\/\/www\.tiktok\.com\/@[\w.-]+\/video\/\d+$/.test(url))throw Error('Expected canonical TikTok page');
const started=performance.now(),response=await fetch('http://127.0.0.1:8787/video-cache/stream?profile=tiktok&url='+encodeURIComponent(url),{headers:{Range:'bytes=0-65535'},signal:AbortSignal.timeout(30000)});
const headerMs=performance.now()-started;
let bytes=0,firstByteMs=null;
if(response.ok){const reader=response.body.getReader();for(;;){const part=await reader.read();if(part.done)break;firstByteMs??=performance.now()-started;bytes+=part.value.byteLength}}
console.log(JSON.stringify({status:response.status,headerMs,firstByteMs,rangeBytes:bytes,totalBytes:response.headers.get('content-range')?.split('/')[1],completeMs:performance.now()-started}));
