import {readFile,writeFile} from 'node:fs/promises';
const dir=process.argv[2];
const discovery=JSON.parse(await readFile(dir+'/discovery-valid/discovery.json','utf8'));
const rules={pexels:/\/video\/[^/]+-\d+\/?$/,pixabay:/\/videos\/[^/]+-\d+\/?$/,mixkit:/\/free-stock-video\/[^/]+-\d+\/?$/,coverr:/\/videos\/[^/]+$/,videezy:/\/[^/]+\/\d+-/,vecteezy:/\/video\/\d+-/,mazwai:/\/free-video\//,dareful:null,youtube:/\/watch\?v=/,wikimedia:/\/wiki\/File:.*\.(webm|ogv|mp4)$/i,nasa:/\/video\//,esa:/\/Videos\/\d{4}\/\d{2}\//,ted:/\/talks\/[^/]+$/,vimeo:/vimeo.com\/\d+$/};
const cases=[];
for(const site of discovery.sites){
 let links=site.links||[];
 if(site.site==='archive'){
  const r=await fetch('https://archive.org/advancedsearch.php?q=collection%3Aprelinger%20AND%20mediatype%3Amovies&fl%5B%5D=identifier&fl%5B%5D=title&rows=5&output=json');
  links=(await r.json()).response.docs.map(d=>({url:'https://archive.org/details/'+d.identifier,title:d.title}));
 }else links=links.filter(l=>site.site==='dareful'?l.title==='play video':rules[site.site]?.test(l.url));
 links=links.filter(l=>!/(?:kids|children|baby|erotic|nude|porn|sex)/i.test(l.url+' '+l.title));
 const seen=new Set();
 links=links.map(l=>{const u=new URL(l.url);u.hash='';if(site.site==='youtube'){const id=u.searchParams.get('v');u.search='';u.searchParams.set('v',id);}return {...l,url:u.href};}).filter(l=>!seen.has(l.url)&&seen.add(l.url)).slice(0,5);
 if(links.length<5)throw Error(site.site+' has only '+links.length+' identified pages');
 cases.push(...links.map((l,i)=>({site:site.site==='mazwai'?'magnific':site.site,ordinal:i+1,url:l.url,listingTitle:l.title,listingUrl:site.url})));
}
await writeFile(dir+'/manifest.json',JSON.stringify(cases,null,2));
console.log(JSON.stringify({sites:new Set(cases.map(c=>c.site)).size,clips:cases.length}));
