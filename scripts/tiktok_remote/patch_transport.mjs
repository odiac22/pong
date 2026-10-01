// Default-off, CPU-only experiment. No renderer/service/device integration.
// Lossless changed-pixel runs or deflated bounding rectangle for one owned RGB(A) frame.
import {createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';

export const HEADER_BYTES=112;
export const MAX_PIXEL_BYTES=16*1024*1024;
const MAGIC=0x50564650; // PVFP
const MODE_SAME=0,MODE_RUNS=1,MODE_FULL=2,MODE_RECT_DEFLATE=3,MODE_RECT_RAW=4;
const hash=bytes=>createHash('sha256').update(bytes).digest();
const owned=bytes=>{
  if(!(bytes instanceof Uint8Array))throw Error('RGB(A) bytes required');
  return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
};
// The existing PVFA source envelope stores mediaTime as IEEE-754 f64 at byte
// 32. Preserve those exact eight bits; rounding to milliseconds/microseconds
// could alias distinct source frames or permit a response for the wrong PTS.
export function mediaTimeBits(seconds){
  if(!Number.isFinite(seconds)||seconds<0||Object.is(seconds,-0))
    throw Error('invalid source media time');
  const bytes=Buffer.allocUnsafe(8);bytes.writeDoubleBE(seconds);
  return bytes.readBigUInt64BE();
}
const validPtsBits=bits=>{
  if(typeof bits!=='bigint'||bits<0n||bits>0xffffffffffffffffn)return false;
  const bytes=Buffer.allocUnsafe(8);bytes.writeBigUInt64BE(bits);
  const value=bytes.readDoubleBE();
  return Number.isFinite(value)&&value>=0&&!Object.is(value,-0);
};
const u32=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
const validMeta=meta=>{
  if(!meta||!(meta.nonce instanceof Uint8Array)||meta.nonce.length!==16||
      !u32(meta.epoch)||!u32(meta.sequence)||meta.sequence===0||
      !validPtsBits(meta.ptsBits)||
      !Number.isInteger(meta.width)||meta.width<16||meta.width>4096||
      !Number.isInteger(meta.height)||meta.height<16||meta.height>4096||
      ![3,4].includes(meta.channels)||
      meta.width*meta.height*meta.channels>MAX_PIXEL_BYTES)throw Error('invalid patch ownership or shape');
  return meta.width*meta.height*meta.channels;
};
const pixelChanged=(a,b,at,channels)=>{
  for(let c=0;c<channels;c++)if(a[at+c]!==b[at+c])return true;
  return false;
};

export function encodePatch(meta,sourceBytes,renderedBytes){
  const expected=validMeta(meta),source=owned(sourceBytes),rendered=owned(renderedBytes);
  if(source.length!==expected||rendered.length!==expected)throw Error('patch frame shape mismatch');
  const {width,height,channels}=meta;
  const runs=[];
  let runBytes=0,minX=width,minY=height,maxX=-1,maxY=-1,oversize=false;
  for(let y=0;y<height&&!oversize;y++){
    for(let x=0;x<width;){
      const at=(y*width+x)*channels;
      if(!pixelChanged(source,rendered,at,channels)){x++;continue;}
      const start=x;
      do{x++;}while(x<width&&pixelChanged(source,rendered,(y*width+x)*channels,channels));
      const length=x-start;
      minX=Math.min(minX,start);minY=Math.min(minY,y);
      maxX=Math.max(maxX,x-1);maxY=Math.max(maxY,y);
      runs.push({x:start,y,length});runBytes+=8+length*channels;
      if(runBytes>=expected){oversize=true;break;}
    }
  }
  let mode=MODE_SAME,payload=Buffer.alloc(0),count=0;
  if(oversize){mode=MODE_FULL;payload=rendered;}
  else if(runs.length){
    mode=MODE_RUNS;count=runs.length;
    payload=Buffer.allocUnsafe(runBytes);
    let offset=0;
    for(const run of runs){
      payload.writeUInt16BE(run.x,offset);payload.writeUInt16BE(run.y,offset+2);
      payload.writeUInt16BE(run.length,offset+4);payload.writeUInt16BE(0,offset+6);
      offset+=8;
      const begin=(run.y*width+run.x)*channels,bytes=run.length*channels;
      rendered.copy(payload,offset,begin,begin+bytes);offset+=bytes;
    }
    const rectWidth=maxX-minX+1,rectHeight=maxY-minY+1;
    const rectangle=Buffer.allocUnsafe(rectWidth*rectHeight*channels);
    for(let y=0;y<rectHeight;y++){
      const begin=((minY+y)*width+minX)*channels;
      rendered.copy(rectangle,y*rectWidth*channels,begin,begin+rectWidth*channels);
    }
    if(8+rectangle.length<payload.length){
      mode=MODE_RECT_RAW;count=0;
      payload=Buffer.allocUnsafe(8+rectangle.length);
      payload.writeUInt16BE(minX,0);payload.writeUInt16BE(minY,2);
      payload.writeUInt16BE(rectWidth,4);payload.writeUInt16BE(rectHeight,6);
      rectangle.copy(payload,8);
    }
    const compressed=deflateRawSync(rectangle,{level:1});
    if(12+compressed.length<payload.length){
      mode=MODE_RECT_DEFLATE;count=0;
      payload=Buffer.allocUnsafe(12+compressed.length);
      payload.writeUInt16BE(minX,0);payload.writeUInt16BE(minY,2);
      payload.writeUInt16BE(rectWidth,4);payload.writeUInt16BE(rectHeight,6);
      payload.writeUInt32BE(compressed.length,8);compressed.copy(payload,12);
    }
    if(payload.length>=expected){mode=MODE_FULL;count=0;payload=rendered;}
  }
  const packet=Buffer.allocUnsafe(HEADER_BYTES+payload.length);
  packet.fill(0,0,HEADER_BYTES);
  packet.writeUInt32BE(MAGIC,0);packet[4]=1;packet[5]=channels;packet[6]=mode;
  owned(meta.nonce).copy(packet,8);
  packet.writeUInt32BE(meta.epoch,24);packet.writeUInt32BE(meta.sequence,28);
  packet.writeBigUInt64BE(meta.ptsBits,32);
  packet.writeUInt16BE(width,40);packet.writeUInt16BE(height,42);
  packet.writeUInt32BE(count,44);
  hash(source).copy(packet,48);hash(rendered).copy(packet,80);
  payload.copy(packet,HEADER_BYTES);
  return packet;
}

export function decodePatch(packetBytes,sourceBytes,expected){
  const bytes=owned(packetBytes),source=owned(sourceBytes);
  const expectedBytes=validMeta(expected);
  if(bytes.length<HEADER_BYTES||bytes.length>HEADER_BYTES+MAX_PIXEL_BYTES||
      bytes.readUInt32BE(0)!==MAGIC||bytes[4]!==1||bytes[7]!==0)
    throw Error('invalid patch envelope');
  const channels=bytes[5],mode=bytes[6];
  if(channels!==expected.channels||bytes.readUInt32BE(24)!==expected.epoch||
      bytes.readUInt32BE(28)!==expected.sequence||
      bytes.readBigUInt64BE(32)!==expected.ptsBits||
      bytes.readUInt16BE(40)!==expected.width||bytes.readUInt16BE(42)!==expected.height||
      !bytes.subarray(8,24).equals(owned(expected.nonce)))throw Error('stale or foreign patch owner');
  if(source.length!==expectedBytes||!hash(source).equals(bytes.subarray(48,80)))
    throw Error('patch source frame mismatch');
  const count=bytes.readUInt32BE(44),out=Buffer.from(source);
  if(mode===MODE_SAME){
    if(count!==0||bytes.length!==HEADER_BYTES)throw Error('invalid unchanged packet');
  }else if(mode===MODE_FULL){
    if(count!==0||bytes.length!==HEADER_BYTES+expectedBytes)throw Error('invalid full packet');
    bytes.copy(out,0,HEADER_BYTES);
  }else if(mode===MODE_RUNS){
    if(!count||count>expected.width*expected.height)throw Error('invalid run count');
    let offset=HEADER_BYTES,lastY=-1,lastEnd=0;
    for(let i=0;i<count;i++){
      if(offset+8>bytes.length)throw Error('truncated patch run');
      const x=bytes.readUInt16BE(offset),y=bytes.readUInt16BE(offset+2),
        length=bytes.readUInt16BE(offset+4),reserved=bytes.readUInt16BE(offset+6);
      offset+=8;
      if(!length||reserved||y>=expected.height||x+length>expected.width||
          y<lastY||(y===lastY&&x<lastEnd))throw Error('overlapping or invalid patch run');
      const n=length*channels;
      if(offset+n>bytes.length)throw Error('truncated patch pixels');
      bytes.copy(out,(y*expected.width+x)*channels,offset,offset+n);
      offset+=n;lastY=y;lastEnd=x+length;
    }
    if(offset!==bytes.length)throw Error('trailing patch bytes');
  }else if(mode===MODE_RECT_DEFLATE||mode===MODE_RECT_RAW){
    if(count!==0||bytes.length<HEADER_BYTES+(mode===MODE_RECT_RAW?8:12))
      throw Error('invalid rectangle packet');
    const at=HEADER_BYTES,x=bytes.readUInt16BE(at),y=bytes.readUInt16BE(at+2),
      width=bytes.readUInt16BE(at+4),height=bytes.readUInt16BE(at+6);
    if(!width||!height||x+width>expected.width||y+height>expected.height||
        (mode===MODE_RECT_RAW&&bytes.length!==at+8+width*height*channels))
      throw Error('invalid rectangle bounds');
    const targetLength=width*height*channels;
    let rectangle;
    if(mode===MODE_RECT_RAW)rectangle=bytes.subarray(at+8);
    else{
      const compressedLength=bytes.readUInt32BE(at+8);
      if(compressedLength!==bytes.length-at-12)throw Error('invalid rectangle bounds');
      try{rectangle=inflateRawSync(bytes.subarray(at+12),{maxOutputLength:targetLength});}
      catch{throw Error('invalid compressed rectangle');}
    }
    if(rectangle.length!==targetLength)throw Error('invalid decompressed rectangle size');
    for(let row=0;row<height;row++){
      rectangle.copy(out,((y+row)*expected.width+x)*channels,
        row*width*channels,(row+1)*width*channels);
    }
  }else throw Error('invalid patch mode');
  if(!hash(out).equals(bytes.subarray(80,112)))throw Error('patch result integrity mismatch');
  return out;
}

// At most one request in flight plus one replaceable latest frame. An epoch
// change invalidates both; completion uses the captured exact source bytes.
export class PatchFlightGate{
  constructor(nonce,epoch){
    this.nonce=Buffer.from(owned(nonce));this.epoch=epoch;this.active=null;
    this.pending=null;this.lastSequence=0;this.lastPtsBits=-1n;
    validMeta({nonce:this.nonce,epoch,sequence:1,ptsBits:mediaTimeBits(0),width:16,height:16,channels:3});
  }
  offer(meta,source){
    validMeta(meta);
    if(!owned(meta.nonce).equals(this.nonce)||meta.epoch!==this.epoch||
        meta.sequence<=this.lastSequence||meta.ptsBits<=this.lastPtsBits||
        (this.active&&(meta.sequence<=this.active.meta.sequence||meta.ptsBits<=this.active.meta.ptsBits))||
        (this.pending&&(meta.sequence<=this.pending.meta.sequence||meta.ptsBits<=this.pending.meta.ptsBits)))
      throw Error('stale or foreign frame offer');
    const frame={meta:{...meta,nonce:Buffer.from(owned(meta.nonce))},source:Buffer.from(owned(source))};
    if(frame.source.length!==meta.width*meta.height*meta.channels)throw Error('offered frame shape mismatch');
    if(this.active){
      this.pending?.source.fill(0);
      this.pending=frame;return {sent:false,replacedLatest:true};
    }
    this.active=frame;return {sent:true,replacedLatest:false};
  }
  complete(packet){
    if(!this.active)throw Error('no frame in flight');
    const {meta,source}=this.active;
    const reconstructed=decodePatch(packet,source,meta);
    // A newer captured frame supersedes this exact source. Never offer its
    // old pixels to a painter even though the response itself was authentic.
    const superseded=!!this.pending;
    source.fill(0);
    if(superseded)reconstructed.fill(0);
    this.lastSequence=meta.sequence;this.lastPtsBits=meta.ptsBits;
    this.active=this.pending;this.pending=null;
    return {frame:superseded?null:reconstructed,meta,next:this.active,
      droppedAsStale:superseded};
  }
  reset(epoch){
    if(!u32(epoch)||epoch<=this.epoch)throw Error('newer scene epoch required');
    this.active?.source.fill(0);this.pending?.source.fill(0);
    this.epoch=epoch;this.active=null;this.pending=null;
    this.lastSequence=0;this.lastPtsBits=-1n;
  }
}
