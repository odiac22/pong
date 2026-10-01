'use strict';
const $=s=>document.querySelector(s);let data,ratings={},active=[];
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
const media=id=>'media/'+encodeURIComponent(id);
function link(text,url){const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener';return n}
function fmt(n,suffix){return Number.isFinite(n)?n.toFixed(2)+suffix:'not measured'}
function metrics(label,m){return label+': first encoded bytes '+fmt(m?.firstEncodedByteMs,' ms')+' · render work '+fmt(m?.renderWorkFps,' FPS')+' · full producer '+fmt(m?.endToEndProducerFps,' FPS')}
function clearVideos(){for(const v of active){v.pause();v.removeAttribute('src');v.load()}active=[]}
function comparisonVideo(id,card){
 const labels=el('div');labels.className='comparison-labels';labels.append(el('strong','BEFORE · left'),el('strong','AFTER · right'));card.append(labels);
 const v=el('video');v.src=media(id);v.controls=true;v.muted=true;v.defaultMuted=true;v.playsInline=true;v.preload='metadata';v.setAttribute('aria-label','Synchronized before and after face comparison');
 v.addEventListener('volumechange',()=>{if(!v.muted)v.muted=true});active.push(v);card.append(v);
 const error=el('p');error.className='error';error.setAttribute('role','status');v.addEventListener('error',()=>{error.textContent='Your browser could not play this comparison. The original MP4 downloads below remain available.'});card.append(error);
 card.append(link('Download synchronized face comparison',media(id)+'?download=1'));
}
function scoreSlider(name,title,value){
 const label=el('label');label.className='score';const heading=el('span',title),readout=el('output'),input=el('input');
 input.type='range';input.min='0';input.max='10';input.step='0.01';input.name=name;input.value=Number.isFinite(value)?value.toFixed(2):'5';
 input.setAttribute('aria-label',title+' from zero to ten');input.dataset.touched=String(Number.isFinite(value));
 const show=()=>{readout.textContent=input.dataset.touched==='true'?Number(input.value).toFixed(2):'Not scored';input.setAttribute('aria-valuetext',readout.textContent)};
 const touch=()=>{input.dataset.touched='true';show()};input.addEventListener('input',touch);input.addEventListener('pointerdown',touch);
 const adjust=el('div');adjust.className='fine-adjust';for(const [text,delta] of [['−0.01',-.01],['+0.01',.01]]){const b=el('button',text);b.type='button';b.setAttribute('aria-label',title+' '+(delta<0?'decrease':'increase')+' by 0.01');b.onclick=()=>{input.value=Math.min(10,Math.max(0,Number(input.value)+delta)).toFixed(2);touch()};adjust.append(b)}
 show();label.append(heading,readout,input,adjust);return {label,input};
}
function ratingForm(candidate,row,clip){
 const form=el('form'),scores=el('div');scores.className='scores';const saved=ratings[row.comparisonKey],inputs=[];
 for(const [key,name] of [['before','Before quality'],['after','After quality']]){const s=scoreSlider(key,name,saved?.[key]);scores.append(s.label);inputs.push(s.input)}
 const commentLabel=el('label','What looks better or worse? (optional)'),comment=el('textarea');comment.maxLength=2000;comment.value=saved?.comment||'';commentLabel.append(comment);
 const submit=el('button','Save my scores'),state=el('p',saved?'Saved on PC · '+new Date(saved.updatedAt).toLocaleString():'Move both sliders to score · 0.00–10.00');state.setAttribute('role','status');submit.type='submit';state.className=saved?'saved':'';form.append(scores,commentLabel,submit,state);
 form.onsubmit=async e=>{e.preventDefault();if(inputs.some(i=>i.dataset.touched!=='true')){state.textContent='Please choose both scores before saving.';state.className='error';return}submit.disabled=true;state.textContent='Saving…';try{
  const r=await fetch('ratings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({experimentId:candidate.id,clip:clip.id,comparisonKey:row.comparisonKey,before:Number(inputs[0].value),after:Number(inputs[1].value),comment:comment.value})});
  const j=await r.json();if(!r.ok)throw Error(j.error||'Save failed');ratings[row.comparisonKey]=j.rating;state.textContent='Saved on PC · '+new Date(j.rating.updatedAt).toLocaleTimeString();state.className='saved';
 }catch(e){state.textContent=e.message;state.className='error'}finally{submit.disabled=false}};return form;
}
function draw(){
 clearVideos();const target=$('#clip-grid');target.replaceChildren();const candidate=data.candidates.find(c=>c.id===$('#candidate').value);
 $('#candidate-note').textContent=candidate?.description||'Candidate videos appear only after rendering and file-integrity checks.';
 let count=0,beforeSeconds=0,afterSeconds=0;
 for(const row of candidate?.clips||[]){const clip=data.clips.find(c=>c.id===row.clip),b=row.before?.metrics||clip?.metrics;count+=row.integrity?.frames||row.metrics?.frames||0;beforeSeconds+=b?.wallSeconds||0;afterSeconds+=row.metrics?.wallSeconds||0}
 const summary=$('#speed-summary');summary.textContent='';
 if(count&&beforeSeconds&&afterSeconds){const before=count/beforeSeconds,after=count/afterSeconds,gain=after-before,percent=100*(after/before-1);summary.textContent='Five-clip producer speed: '+before.toFixed(2)+' → '+after.toFixed(2)+' FPS · '+(gain>=0?'+':'')+gain.toFixed(2)+' FPS ('+(percent>=0?'+':'')+percent.toFixed(2)+'%). Includes clip startup/encoding, excludes advance model preparation. Not measured phone-display FPS.'}
 for(const clip of data.clips){
  const card=el('article');card.className='card';card.append(el('h3',clip.title));const row=candidate?.clips.find(r=>r.clip===clip.id);
  if(!clip.ready||!row?.ready){card.append(el('p','Comparison not ready yet.'));target.append(card);continue}
  if(row.comparison?.ready)comparisonVideo(candidate.id+'-comparison-'+clip.id,card);
  else card.append(el('p','The synchronized face comparison is being prepared. Original full-frame files are available below.'));
  const originals=el('div');originals.className='originals';originals.append(link('Before · original full-frame MP4',media(row.before?.ready?candidate.id+'-before-'+clip.id:'baseline-'+clip.id)+'?download=1'),link('After · original full-frame MP4',media(candidate.id+'-'+clip.id)+'?download=1'));card.append(originals);
  const details=el('p',metrics('Before',row.before?.metrics||clip.metrics)+'\n'+metrics('After',row.metrics));details.className='metrics';card.append(details,ratingForm(candidate,row,clip));target.append(card);
 }
}
async function load(){try{
 const [m,r]=await Promise.all([fetch('manifest',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Manifest unavailable');return r.json()}),fetch('ratings',{cache:'no-store'}).then(r=>r.json())]);data=m;ratings=r.ratings||{};
 $('#identity').textContent=(m.faceName||'Approved 8')+' · GPEN1024 baseline · Silent';$('#note').textContent=m.note;const select=$('#candidate'),old=select.value;select.replaceChildren(new Option('Choose an available experiment',''));
 for(const c of m.candidates)select.add(new Option(c.name,c.id));const unscored=m.candidates.find(c=>c.clips.some(row=>!ratings[row.comparisonKey]));select.value=m.candidates.some(c=>c.id===old)?old:unscored?.id||m.candidates[0]?.id||'';draw();
 $('#tests').replaceChildren(...(m.tests||[]).map(t=>{const n=el('div');n.className='test';n.append(el('strong',t.number+'. '+t.name),el('div',t.status),el('div',t.summary||''));return n}));
 $('#face-grid').replaceChildren(...m.faces.map(f=>{const n=el('div');n.className='face'+(f.id===m.faceId?' selected':'');const img=el('img');img.loading='lazy';img.src=media('face-'+f.id);img.alt=f.name;n.append(img,el('strong',f.name));return n}));
 $('#inventory').textContent=m.inventory?.note||'';$('#experiments-list').replaceChildren(...(m.inventory?.items||[]).map(i=>el('p',i.name+': '+i.status)));$('#status').textContent='Updated '+new Date().toLocaleTimeString()+' · '+m.candidates.length+' comparisons available';
 }catch(e){$('#status').textContent='Could not load review: '+e.message}}
$('#candidate').onchange=draw;$('#reload').onclick=load;load();
