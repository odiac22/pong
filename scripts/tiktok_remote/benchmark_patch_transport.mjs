// Synthetic CPU-only sizing/timing. Generates no images and saves no pixels.
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {encodePatch,decodePatch,HEADER_BYTES,mediaTimeBits} from './patch_transport.mjs';

const width=720,height=1280,channels=3;
const roi={x:250,y:420,width:220,height:340};
const meta={nonce:Buffer.alloc(16,0x5a),epoch:9,sequence:1,
  ptsBits:mediaTimeBits(1/30),width,height,channels};
const source=Buffer.allocUnsafe(width*height*channels);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*channels;
  source[at]=(x+y)&255;source[at+1]=(x*3+y)&255;source[at+2]=(x+y*2)&255;
}
const time=(fn,count=5)=>{
  fn();const samples=[];
  for(let i=0;i<count;i++){
    const start=performance.now();fn();samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);return Math.round(samples[Math.floor(count/2)]*1000)/1000;
};
const rectangle=frame=>{
  const out=Buffer.allocUnsafe(roi.width*roi.height*channels);
  for(let y=0;y<roi.height;y++){
    const begin=((roi.y+y)*width+roi.x)*channels;
    frame.copy(out,y*roi.width*channels,begin,begin+roi.width*channels);
  }
  return out;
};

const results=[];
for(const pattern of ['smooth-face-roi','textured-face-roi']){
  const rendered=Buffer.from(source);let random=0x12345678;
  for(let y=roi.y;y<roi.y+roi.height;y++)for(let x=roi.x;x<roi.x+roi.width;x++){
    const at=(y*width+x)*channels;
    if(pattern==='smooth-face-roi'){
      rendered[at]=((x-roi.x)>>3)&255;rendered[at+1]=((y-roi.y)>>3)&255;
      rendered[at+2]=127;
    }else for(let c=0;c<channels;c++){
      random^=random<<13;random^=random>>>17;random^=random<<5;
      rendered[at+c]=random&255;
    }
  }
  const rawBytes=rendered.length;
  const runBytes=HEADER_BYTES+roi.height*(8+roi.width*channels);
  const rect=rectangle(rendered);
  const rawRectangleBytes=HEADER_BYTES+8+rect.length;
  const compressedRectangleBytes=HEADER_BYTES+12+deflateRawSync(rect,{level:1}).length;
  const packet=encodePatch(meta,source,rendered);
  if(!decodePatch(packet,source,meta).equals(rendered))throw Error('lossless reconstruction failed');
  const hashMs=time(()=>{
    createHash('sha256').update(source).digest();
    createHash('sha256').update(rendered).digest();
  });
  const encodeMs=time(()=>encodePatch(meta,source,rendered));
  const decodeMs=time(()=>decodePatch(packet,source,meta));
  results.push({pattern,frame:`${width}x${height} RGB`,changedRoi:roi,
    rawFullBytes:rawBytes,changedRunsBytes:runBytes,
    rawRectangleBytes,
    deflatedRectangleBytes:compressedRectangleBytes,
    selectedPacketBytes:packet.length,selectedMode:packet[6],
    syntheticCpuMedianMs:{twoSha256:hashMs,encodeIncludingHashes:encodeMs,
      decodeIncludingHashes:decodeMs},losslessVerified:true});
}
console.log(JSON.stringify({scope:'synthetic CPU-only; no mobile/network/GPU/presentation speed claim',results},null,2));
