// Keep one highest-declared rendition while retaining media groups / keys.
// Both browser and swap decoder then consume the same source quality.
export function highestQualityHlsMaster(text) {
  const lines=String(text||'').split(/\r?\n/),variants=[];
  for(let i=0;i<lines.length;i++){
    if(!/^#EXT-X-STREAM-INF:/i.test(lines[i]))continue;
    let uri=i+1;while(uri<lines.length&&(!lines[uri].trim()||lines[uri].startsWith('#')))uri++;
    if(uri===lines.length)continue;
    const dimensions=lines[i].match(/\bRESOLUTION=(\d+)x(\d+)/i);
    const pixels=dimensions?Number(dimensions[1])*Number(dimensions[2]):0;
    const bandwidth=Number(lines[i].match(/(?:^|[:,])BANDWIDTH=(\d+)/i)?.[1]||0);
    const fps=Number(lines[i].match(/\bFRAME-RATE=([\d.]+)/i)?.[1]||0);
    variants.push({header:i,uri,pixels,bandwidth,fps});
  }
  if(variants.length<2)return text;
  const best=[...variants].sort((a,b)=>b.pixels-a.pixels||b.fps-a.fps||b.bandwidth-a.bandwidth)[0];
  const drop=new Set(variants.filter(v=>v!==best).flatMap(v=>[v.header,v.uri]));
  return lines.filter((_,i)=>!drop.has(i)).join('\n');
}
