// Bounded demuxer for Pong's single-track, unencrypted AVC fMP4 output only.
// Not a general media-file parser. Unsupported layouts fail closed to MSE.
(() => {
  const MAX_BOX=32*1024*1024;
  const text=(b,p)=>String.fromCharCode(...b.subarray(p,p+4));
  const u32=(b,p)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(p);
  const i32=(b,p)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getInt32(p);
  const u64=(b,p)=>{const n=u32(b,p)*4294967296+u32(b,p+4);if(!Number.isSafeInteger(n))throw Error('Unsafe MP4 offset');return n;};
  function boxes(b,start=0,end=b.length){
    const out=[];let p=start;
    while(p<end){
      if(p+8>end)throw Error('Truncated MP4 child');
      const small=u32(b,p),header=small===1?16:8;
      if(p+header>end)throw Error('Truncated MP4 header');
      const size=small===1?u64(b,p+8):small;
      if(size<header||size>MAX_BOX||p+size>end)throw Error('Invalid MP4 child size');
      out.push({type:text(b,p+4),start:p,body:p+header,end:p+size,size});p+=size;
    }
    return out;
  }
  const child=(b,box,type)=>boxes(b,box.body,box.end).find(x=>x.type===type);
  class PongAvcFragments {
    constructor(onConfig,onSample){this.onConfig=onConfig;this.onSample=onSample;this.pending=new Uint8Array();this.offset=0;this.config=null;this.fragment=null;this.defaults={};}
    init(b,moov){
      const tracks=boxes(b,moov.body,moov.end).filter(x=>x.type==='trak');
      if(tracks.length!==1)throw Error('Direct decoder requires one AVC track');
      const trak=tracks[0],mdia=child(b,trak,'mdia'),tkhd=child(b,trak,'tkhd');
      if(!mdia||!tkhd)throw Error('Missing video track');
      const mdhd=child(b,mdia,'mdhd'),hdlr=child(b,mdia,'hdlr'),minf=child(b,mdia,'minf');
      if(!mdhd||!hdlr||text(b,hdlr.body+8)!=='vide'||!minf)throw Error('Not a video-only stream');
      const stbl=child(b,minf,'stbl'),stsd=stbl&&child(b,stbl,'stsd');
      if(!stsd||u32(b,stsd.body+4)!==1)throw Error('Unsupported sample description');
      const entry=boxes(b,stsd.body+8,stsd.end)[0];
      if(entry.type!=='avc1'||entry.body+78>entry.end)throw Error('Unsupported video codec');
      const avcc=boxes(b,entry.body+78,entry.end).find(x=>x.type==='avcC');
      if(!avcc||avcc.end-avcc.body<7)throw Error('Missing AVC configuration');
      const description=b.slice(avcc.body,avcc.end);
      const timescale=u32(b,mdhd.body+(b[mdhd.body]===1?20:12));
      if(!timescale)throw Error('Invalid media timescale');
      this.track=u32(b,tkhd.body+(b[tkhd.body]===1?20:12));this.timescale=timescale;
      const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
      this.config={codec:'avc1.'+[...description.slice(1,4)].map(x=>x.toString(16).padStart(2,'0')).join(''),
        codedWidth:view.getUint16(entry.body+24),codedHeight:view.getUint16(entry.body+26),description};
      const mvex=child(b,moov,'mvex'),trex=mvex&&child(b,mvex,'trex');
      if(trex&&u32(b,trex.body+4)===this.track)this.defaults={duration:u32(b,trex.body+12),size:u32(b,trex.body+16),flags:u32(b,trex.body+20)};
      this.onConfig(this.config);
    }
    parseFragment(b,moof,absolute){
      if(!this.config)throw Error('Fragment before AVC configuration');
      const trafs=boxes(b,moof.body,moof.end).filter(x=>x.type==='traf');
      if(trafs.length!==1)throw Error('Unsupported fragment track count');
      const traf=trafs[0],tfhd=child(b,traf,'tfhd'),tfdt=child(b,traf,'tfdt');
      if(!tfhd||!tfdt||u32(b,tfhd.body+4)!==this.track)throw Error('Invalid fragment header');
      const flags=u32(b,tfhd.body)&0xffffff;let pos=tfhd.body+8,base=absolute;
      if(flags&1){base=u64(b,pos);pos+=8;}
      else if(!(flags&0x020000))throw Error('Unspecified fragment base');
      if(flags&2)pos+=4;
      const defs={...this.defaults};
      for(const [flag,key] of [[8,'duration'],[16,'size'],[32,'flags']])if(flags&flag){defs[key]=u32(b,pos);pos+=4;}
      let time=b[tfdt.body]===1?u64(b,tfdt.body+4):u32(b,tfdt.body+4),data=null;
      const samples=[];
      for(const trun of boxes(b,traf.body,traf.end).filter(x=>x.type==='trun')){
        const f=u32(b,trun.body)&0xffffff,count=u32(b,trun.body+4);let p=trun.body+8,firstFlags;
        if(count>10000)throw Error('Too many fragment samples');
        if(f&1){data=base+i32(b,p);p+=4;}if(f&4){firstFlags=u32(b,p);p+=4;}
        if(data===null)throw Error('Missing sample data offset');
        for(let i=0;i<count;i++){
          let duration=defs.duration,size=defs.size,sampleFlags=i===0&&firstFlags!==undefined?firstFlags:defs.flags,composition=0;
          if(f&0x100){duration=u32(b,p);p+=4;}if(f&0x200){size=u32(b,p);p+=4;}
          if(f&0x400){sampleFlags=u32(b,p);p+=4;}if(f&0x800){composition=b[trun.body]===1?i32(b,p):u32(b,p);p+=4;}
          if(p>trun.end||!duration||!size||size>MAX_BOX)throw Error('Invalid fragment sample');
          samples.push({offset:data,size,timestamp:Math.round((time+composition)*1e6/this.timescale),duration:Math.round(duration*1e6/this.timescale),type:(sampleFlags&0x10000)?'delta':'key'});
          data+=size;time+=duration;
        }
      }
      this.fragment=samples;
    }
    async push(chunk){
      if(this.pending.length+chunk.length>MAX_BOX)throw Error('MP4 buffer limit exceeded');
      const joined=new Uint8Array(this.pending.length+chunk.length);joined.set(this.pending);joined.set(chunk,this.pending.length);let consumed=0;
      while(joined.length-consumed>=8){
        const small=u32(joined,consumed),header=small===1?16:8;if(joined.length-consumed<header)break;
        const size=small===1?u64(joined,consumed+8):small;
        if(size<header||size>MAX_BOX)throw Error('Unsupported MP4 box size');
        if(joined.length-consumed<size)break;
        const b=joined.subarray(consumed,consumed+size),box={type:text(b,4),start:0,body:header,end:size,size},absolute=this.offset+consumed;
        if(box.type==='moov')this.init(b,box);
        else if(box.type==='moof'){if(this.fragment)throw Error('Missing fragment media');this.parseFragment(b,box,absolute);}
        else if(box.type==='mdat'){
          if(!this.fragment)throw Error('Media before fragment');
          for(const sample of this.fragment){const at=sample.offset-absolute;if(at<header||at+sample.size>size)throw Error('Sample outside media data');await this.onSample({...sample,data:b.slice(at,at+sample.size)});}
          this.fragment=null;
        }else if(!['ftyp','free','skip','sidx','styp','mfra'].includes(box.type))throw Error('Unsupported MP4 box '+box.type);
        consumed+=size;
      }
      this.pending=joined.slice(consumed);this.offset+=consumed;
    }
    finish(){if(this.pending.length||this.fragment)throw Error('Truncated AVC stream');}
  }
  globalThis.PongAvcFragments=PongAvcFragments;
})();
