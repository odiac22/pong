import {readFileSync,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {createTikTokProgressTracker,TIKTOK_PROGRESS_TEMPLATE} from '../video-cache-tiktok-progress.mjs';
const source=readFileSync('local-ai-server.mjs','utf8');
const code=source.slice(source.indexOf('async function downloadTikTokVideoFile('),source.indexOf('function simpCityTikTokProfileCandidates('));
const context={path,fs,spawn,createWriteStream,process,Buffer,createTikTokProgressTracker,TIKTOK_PROGRESS_TEMPLATE,
 LOCAL_AI_DIR:path.resolve('.pong-local-ai'),VIDEO_FILE_CACHE_MAX_FILE_BYTES:4*1024**3};
vm.runInNewContext(code,context);
const sourceUrl=process.argv[2]||'https://www.tiktok.com/@spambiebambi/video/7689552051906432270';
if(!/^https:\/\/www\.tiktok\.com\/@[\w.-]+\/video\/\d+$/.test(sourceUrl))throw Error('Expected canonical TikTok video');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/progressive-${Date.now()}.mp4`;
const started=Date.now(),record={sourceUrl,bytes:0},controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),45000);let firstMetadataMs=null,bytesAtMetadata=null;
const observer=setInterval(()=>{if(firstMetadataMs===null&&record.headersReadyAt){firstMetadataMs=record.headersReadyAt-started;bytesAtMetadata=record.bytes}},10);
try{
 await context.downloadTikTokVideoFile(record,output,controller);
 console.log(JSON.stringify({file:output,progressive:!!record.progressiveMetadataValidated,metadataMs:firstMetadataMs??record.headersReadyAt-started,bytesAtMetadata,completeMs:Date.now()-started,bytes:record.bytes,totalBytes:record.totalBytes}));
}catch(error){console.log(JSON.stringify({failed:true,aborted:controller.signal.aborted,errorClass:error.name}));process.exitCode=1}
finally{clearTimeout(timer);clearInterval(observer)}
