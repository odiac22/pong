// Publish a growing TikTok MP4 only when its exact entity size and complete
// fast-start H.264 video metadata are both known. No estimated byte counts.
const PREFIX = '__PONG_TIKTOK_PROGRESS__';
export const TIKTOK_PROGRESS_TEMPLATE = `download:${PREFIX}%(progress.total_bytes)j`;
export function createTikTokProgressTracker(record, {maxFileBytes, onInvalid=()=>{}, now=Date.now}) {
  let lineBuffer='',prefix=Buffer.alloc(0),validated=false,total=0,failed=false;
  const cap=2*1024*1024;
  const publish=()=>{
    if(failed||!validated||!total)return;
    record.totalBytes=total;record.contentType='video/mp4';
    record.headersReadyAt ||= now();record.progressiveMetadataValidated=true;
  };
  const fail=()=>{if(!failed){failed=true;onInvalid(new Error('TikTok download entity size changed'));}};
  return {
    stderr(chunk){
      lineBuffer+=String(chunk);
      const lines=lineBuffer.split(/\r?\n/);lineBuffer=lines.pop().slice(-8192);
      for(const line of lines){
        if(!line.startsWith(PREFIX))continue;
        const raw=line.slice(PREFIX.length).trim();
        if(!/^\d+$/.test(raw))continue;
        const value=Number(raw);
        if(!Number.isSafeInteger(value)||value<=0||value>maxFileBytes)continue;
        if(total&&total!==value){fail();return;}
        total=value;publish();
      }
    },
    bytes(chunk){
      if(validated||failed||prefix.length>=cap)return;
      prefix=Buffer.concat([prefix,chunk.subarray(0,cap-prefix.length)]);
      let offset=0,ftyp=false;
      while(offset+8<=prefix.length){
        let size=prefix.readUInt32BE(offset),header=8;
        const type=prefix.toString('ascii',offset+4,offset+8);
        if(size===1){if(offset+16>prefix.length)return;const big=prefix.readBigUInt64BE(offset+8);if(big>BigInt(Number.MAX_SAFE_INTEGER))return;size=Number(big);header=16;}
        if(size<header||offset+size>prefix.length)return;
        if(type==='ftyp')ftyp=true;
        if(type==='moov'&&ftyp){
          const moov=prefix.subarray(offset+header,offset+size),latin=moov.toString('latin1');
          let position=-1,video=false;
          while((position=moov.indexOf('hdlr',position+1))>=0){if(position+16<=moov.length&&moov.toString('ascii',position+12,position+16)==='vide'){video=true;break;}}
          validated=video&&/avc1|avc3/.test(latin)&&!/hvc1|hev1/.test(latin);
          if(validated){prefix=Buffer.alloc(0);publish();}return;
        }
        offset+=size;
      }
    }
  };
}
