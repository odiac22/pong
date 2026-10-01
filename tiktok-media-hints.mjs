// Page-supplied URLs are untrusted input, never general-purpose proxy targets.
export function tikTokHintTarget(raw) {
  if(typeof raw!=='string'||raw.length>8192)return null;
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return null;
    if(!/^v\d+[a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com)$/i.test(u.hostname))return null;
    if(!u.pathname.startsWith('/video/'))return null;
    return u;
  }catch{return null;}
}
export function normalizeTikTokMediaHint(page, hint, now=Date.now()) {
  if(!hint||typeof hint!=='object')return null;
  let p;try{p=new URL(page)}catch{return null;}
  const id=p.pathname.match(/^\/@[A-Za-z0-9._-]{2,64}\/video\/(\d{15,22})\/?$/)?.[1];
  if(p.protocol!=='https:'||!['www.tiktok.com','m.tiktok.com','tiktok.com'].includes(p.hostname)||!id||hint.videoId!==id)return null;
  if(!/^h264|^avc1/i.test(String(hint.codec||'')))return null;
  const width=Number(hint.width),height=Number(hint.height),size=Number(hint.size);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<16||height<16||width>8192||height>8192)return null;
  if(!Number.isSafeInteger(size)||size<1024||size>5*1024**3)return null;
  const urls=[...new Set((Array.isArray(hint.urls)?hint.urls:[]).slice(0,3).map(x=>tikTokHintTarget(x)?.href).filter(Boolean))].slice(0,2);
  return urls.length?{videoId:id,urls,width,height,size,codec:'h264',receivedAt:now}:null;
}

// Never switch entities after publishing a prefix. The caller owns cleanup
// and invokes the established extractor only when no bytes were published.
export async function streamTikTokMediaHint(hint, {request,write,onMetadata,onBytes,signal,maxBytes}) {
  if(!hint?.urls?.length)throw Error('No validated TikTok source hint');
  let lastError;
  for(const candidate of hint.urls){
    let bytes=0;
    try {
      let url=candidate,response;
      for(let redirects=0;redirects<=3;redirects++){
        const target=tikTokHintTarget(url);if(!target)throw Error('Untrusted TikTok media redirect');
        response=await request(target,signal);
        if([301,302,303,307,308].includes(response.statusCode)){
          const location=response.headers.location;response.destroy();
          if(!location||redirects===3)throw Error('TikTok media redirect limit');
          url=new URL(location,target).href;continue;
        }
        break;
      }
      const length=Number(response.headers['content-length']);
      if(response.statusCode!==200||!Number.isSafeInteger(length)||length!==hint.size||length>maxBytes||
        !/^video\/mp4(?:;|$)/i.test(String(response.headers['content-type']||''))||
        response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){
        response.destroy();throw Error('TikTok media hint response not a matching MP4');
      }
      onMetadata(length);
      for await (const chunk of response){
        if(signal?.aborted)throw Error('TikTok media hint cancelled');
        bytes+=chunk.length;if(bytes>length)throw Error('TikTok media hint entity overflow');
        await write(chunk);onBytes(chunk,bytes);
      }
      if(bytes!==length)throw Error('TikTok media hint entity truncated');
      return {bytes,transport:'webview-source-hint'};
    }catch(error){lastError=error;if(bytes||signal?.aborted)throw error;}
  }
  throw lastError||Error('TikTok media hint unavailable');
}
