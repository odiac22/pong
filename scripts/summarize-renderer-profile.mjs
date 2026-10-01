import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
for(const profile of data.profiles||[]){
 const self=new Map(),inclusive=new Map();
 profile.samples?.forEach((sample,i)=>{
  const weight=profile.weights?.[i]??1,last=sample.at(-1);
  self.set(last,(self.get(last)||0)+weight);
  for(const index of new Set(sample))inclusive.set(index,(inclusive.get(index)||0)+weight);
 });
 const top=map=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,14).map(([index,total])=>({
  name:data.shared.frames[index]?.name,file:data.shared.frames[index]?.file?.replaceAll('\\','/').split('/').slice(-2).join('/'),
  line:data.shared.frames[index]?.line,total
 }));
 console.log(JSON.stringify({thread:profile.name,units:profile.unit,self:top(self),inclusive:top(inclusive)}));
}
