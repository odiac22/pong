import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { normalizeTikTokMediaHint, tikTokHintTarget } from '../../tiktok-media-hints.mjs';
import { publicAddress } from '../../desktop-capture-source-hints.mjs';

const MAX_PROBE_BYTES = 4096;
const RANGE = 'bytes=0-1023';

export function buildSelectedSnapshotExpression(source) {
  const start = source.indexOf('  const canonical =');
  const end = source.indexOf('  const profileForwardVideos =');
  if (start < 0 || end <= start || !source.slice(start, end).includes('  const mediaHint =') ||
      !source.slice(start, end).includes('  const postCard =')) {
    throw Error('TikTok observer parser anchors changed');
  }
  const helpers = source.slice(start, end);
  return `(()=>{${helpers}
    if (document.hidden) return null;
    const video=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')]
      .filter(v=>getComputedStyle(v).display!=='none')
      .map(v=>({v,area:area(v)})).sort((a,b)=>
        (b.area+(b.area>innerWidth*innerHeight*.22&&!b.v.paused?1e9:0))-
        (a.area+(a.area>innerWidth*innerHeight*.22&&!a.v.paused?1e9:0)))[0]?.v;
    if (!video || !video.isConnected || area(video)<=innerWidth*innerHeight*.22) return null;
    const card=postCard(video);
    if (!card?.isConnected || !card.contains(video) || card.querySelector('[data-e2e="ad-tag"]')) return null;
    const found=reactVideo(card,true),pageUrl=videoPage(video,card);
    if (found?.kind!=='video' || !found.id || !pageUrl || found.url!==pageUrl ||
        !pageUrl.endsWith('/video/'+found.id)) return null;
    const hint=mediaHint(card);
    const own=(object,key)=>{try{return Object.getOwnPropertyDescriptor(object,key)?.value}catch{return undefined}};
    const source=video.currentSrc||video.src||'',itemVideo=own(found.item,'video');
    const formatRows=own(itemVideo,'bitrateInfo');
    const rows=Array.isArray(formatRows)?formatRows.slice(0,30):[];
    const addresses=[own(itemVideo,'playAddr'),...rows.map(row=>own(row,'PlayAddr'))];
    const currentSrcBound=addresses.some(address=>{
      const urls=own(address,'UrlList');
      return Array.isArray(urls)&&urls.slice(0,3).includes(source);
    });
    return {id:found.id,pageUrl,locationHref:location.href,
      currentSrc:source,currentSrcBound,width:video.videoWidth||0,
      height:video.videoHeight||0,readyState:video.readyState||0,
      hint:hint?.videoId===found.id&&hint?.pageUrl===pageUrl?hint:null};
  })()`;
}

export function sameSelectedSnapshot(first, next) {
  return Boolean(first && next && first.id===next.id && first.pageUrl===next.pageUrl &&
    first.locationHref===next.locationHref && first.currentSrc===next.currentSrc &&
    first.currentSrcBound===next.currentSrcBound &&
    first.hint?.size===next.hint?.size && first.hint?.width===next.hint?.width &&
    first.hint?.height===next.hint?.height && first.hint?.urls?.[0]===next.hint?.urls?.[0]);
}

export function planSelectedMediaProbes(snapshot) {
  const normalized = normalizeTikTokMediaHint(snapshot?.pageUrl, snapshot?.hint);
  if (!snapshot?.id || !snapshot.pageUrl?.endsWith('/video/'+snapshot.id)) return [];
  const advertised=normalized?.videoId===snapshot.id?tikTokHintTarget(normalized.urls[0]):null;
  const result = advertised?[{kind:'advertised-highest-h264',url:advertised.href}]:[];
  const current = snapshot.currentSrcBound===true?tikTokHintTarget(snapshot.currentSrc):null;
  if (current && current.href!==advertised?.href) result.push({kind:'current-playing',url:current.href});
  return result;
}

export function sanitizedSelectedMetadata(snapshot) {
  const hint=normalizeTikTokMediaHint(snapshot?.pageUrl,snapshot?.hint);
  let currentClass='none';
  if (snapshot?.currentSrc) {
    currentClass=snapshot.currentSrc.startsWith('blob:')?'blob':
      tikTokHintTarget(snapshot.currentSrc)?'allowed-tiktok-cdn':'other-unprobed';
  }
  return {
    videoIdHash:snapshot?.id?createHash('sha256').update(snapshot.id).digest('hex').slice(0,16):'',
    declaredResolution:hint?{width:hint.width,height:hint.height}:null,
    declaredSizeBytes:hint?.size||0,
    advertisedCodec:hint?.codec||'',
    highestHintValid:Boolean(hint),
    currentPlayingUrlClass:currentClass,
    currentPlayingBoundToPost:snapshot?.currentSrcBound===true,
    currentBufferDecoded:{width:Number(snapshot?.width)||0,height:Number(snapshot?.height)||0,
      readyState:Number(snapshot?.readyState)||0},
    qualityIndependentlyVerified:false
  };
}

export function tiktokMediaHostClass(raw) {
  const url=tikTokHintTarget(raw);
  if (!url) return 'rejected';
  if (url.hostname.endsWith('.tiktokcdn-us.com')) return 'tiktokcdn-us';
  if (url.hostname.endsWith('.tiktokcdn.com')) return 'tiktokcdn';
  return 'tiktok';
}

export async function boundedSelectedRangeProbe(raw, {
  timeoutMs=4500, expectedSize=0, lookupImpl=lookup, requestImpl=https.request
}={}) {
  const url=tikTokHintTarget(raw);
  if (!url) return {outcome:'rejected',httpStatus:0,contentType:'',byteCount:0};
  const deadline=performance.now()+Math.min(8000,Math.max(1,Number(timeoutMs)||4500));
  let addresses,timer;
  try {
    addresses=await Promise.race([
      lookupImpl(url.hostname,{all:true}),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,deadline-performance.now()));})
    ]);
  } catch { addresses=null; } finally { clearTimeout(timer); }
  if (!Array.isArray(addresses) || !addresses.length ||
      addresses.some(row=>!publicAddress(row.address))) {
    return {outcome:'dns-rejected',httpStatus:0,contentType:'',byteCount:0};
  }
  const address=addresses[0],remaining=Math.max(0,Math.ceil(deadline-performance.now()));
  if (!remaining) return {outcome:'timeout',httpStatus:0,contentType:'',byteCount:0};
  return new Promise(resolve=>{
    let settled=false,bytes=0,status=0,type='',range='',encoding='',wallTimer,request;
    const finish=outcome=>{
      if (settled) return;
      settled=true;clearTimeout(wallTimer);request?.destroy();
      const total=Number(/^bytes 0-1023\/(\d+)$/i.exec(range)?.[1]||0);
      resolve({outcome,httpStatus:status,contentType:type,byteCount:bytes,
        rangeSatisfied:status===206 && /^bytes 0-1023\/\d+$/i.test(range),
        matchesDeclaredSize:expectedSize>0 && total>0 ? total===expectedSize : null,
        identityEncoding:!encoding||encoding==='identity'});
    };
    request=requestImpl(url,{method:'GET',
      lookup:(_host,options,cb)=>cb(null,options?.all?[address]:address.address,address.family),
      headers:{range:RANGE,accept:'video/mp4','accept-encoding':'identity',
        referer:'https://www.tiktok.com/',
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'}},response=>{
      status=Number(response.statusCode)||0;
      const rawType=String(response.headers['content-type']||'').split(';')[0].toLowerCase();
      type=['video/mp4','text/html','application/json','application/octet-stream'].includes(rawType)
        ?rawType:rawType?'other':'';
      range=String(response.headers['content-range']||'');
      encoding=String(response.headers['content-encoding']||'').toLowerCase();
      response.on('data',chunk=>{
        bytes+=Math.min(chunk.length,MAX_PROBE_BYTES-bytes);
        if (bytes>=MAX_PROBE_BYTES) finish('body-cap');
      });
      response.once('end',()=>finish('complete'));
      response.once('error',()=>finish('response-error'));
    });
    wallTimer=setTimeout(()=>finish('timeout'),remaining);
    request.once('error',()=>finish('request-error'));
    request.end();
  });
}
