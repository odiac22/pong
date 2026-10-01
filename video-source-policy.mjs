// The standalone userscript contains this same pure function (verified by tests).
export function primaryVideoEvidence(html, pageUrl) {
  const source=String(html||'');
  const canonical=value=>{try{const u=new URL(typeof value==='object'?value?.['@id']||value?.url:value,pageUrl);u.hash='';return u.href.replace(/\/$/,'');}catch{return '';}};
  const page=canonical(pageUrl),objects=[];
  const walk=(v,depth=0)=>{
    if(!v||typeof v!=='object'||depth>12)return;
    if([v['@type']].flat().some(t=>/(?:^|\/)VideoObject$/.test(String(t))))objects.push(v);
    for(const [k,item]of Object.entries(v))if(k==='@graph'||k==='mainEntity'||Array.isArray(v))walk(item,depth+1);
  };
  for(const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(!/\btype\s*=\s*["']application\/ld\+json["']/i.test(m[1]))continue;
    try{walk(JSON.parse(m[2]));}catch{}
  }
  const matched=objects.filter(o=>[o.url,o['@id'],o.mainEntityOfPage,o.acquireLicensePage].some(v=>v&&canonical(v)===page));
  const chosen=matched.length===1?matched[0]:objects.length===1?objects[0]:null;
  if(!chosen)return null;
  const content=typeof chosen.contentUrl==='string'?chosen.contentUrl:'';
  let anchor;try{anchor=new URL(content,pageUrl);if(!/^https?:$/.test(anchor.protocol)||!content)return null;}catch{return null;}
  const media=/\.(?:mp4|m4v|mov|webm|mkv|m3u8|ogv)(?:[?#]|$)/i;
  if(!media.test(anchor.href))return null;
  // Alternate encodes may share the authoritative content's asset directory.
  // Generic /video/ or /media/ buckets are NOT an identity proof.
  const parent=anchor.pathname.slice(0,anchor.pathname.lastIndexOf('/')+1);
  const parts=parent.split('/').filter(Boolean);
  const safeDirectory=parts.length>=2&&!/^(?:videos?|media|files?|assets?|uploads?|download|mp4|hd|sd|(?:19|20)\d{2})$/i.test(parts.at(-1)||'');
  const decoded=source.replace(/\\u002f/gi,'/').replace(/\\u0026/gi,'&').replace(/\\\//g,'/').replace(/&amp;/gi,'&');
  const urls=[anchor.href];
  if(safeDirectory){
    for(const m of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8|ogv)(?:\?[^\s"'<>\\]*)?/gi)){
      try{const u=new URL(m[0]);if(u.origin===anchor.origin&&u.pathname.startsWith(parent)&&u.pathname.slice(parent.length).indexOf('/')<0&&!/(?:preview|trailer|thumb|watermark)/i.test(u.pathname)&&!urls.includes(u.href))urls.push(u.href);}catch{}
    }
  }
  const score=value=>{
    const pathname=new URL(value).pathname;
    const dimensions=pathname.match(/(?:^|[_/-])(\d{3,4})[_x](\d{3,4})(?:[_./-]|$)/i);
    if(dimensions)return Number(dimensions[1])*Number(dimensions[2]);
    const height=Number(pathname.match(/(?:^|[_/-])(\d{3,4})p?(?:\.[a-z0-9]+$|[_/-])/i)?.[1]||0);
    return height>=144&&height<=4320?height*height*16/9:0;
  };
  // Known rendition sizes rank above unknown progressive files; the declared
  // content remains the tie-breaker. HLS masters are kept authoritative.
  urls.sort((a,b)=>Number(/master\.m3u8/i.test(b))-Number(/master\.m3u8/i.test(a))||score(b)-score(a));
  const rawDuration=String(chosen.duration||'');
  const iso=rawDuration.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  const durationSeconds=iso&&!Number(iso[1])&&!Number(iso[2])?Number(iso[3]||0)*86400+Number(iso[4]||0)*3600+Number(iso[5]||0)*60+Number(iso[6]||0):Number(rawDuration)||0;
  return {videoUrls:urls.slice(0,12),title:String(chosen.name||'').trim(),durationSeconds,contentUrl:anchor.href,identityEvidence:'page-video-object'};
}
