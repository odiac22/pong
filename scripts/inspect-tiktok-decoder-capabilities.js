(async()=>({
  secure:isSecureContext,decoder:typeof VideoDecoder,frame:typeof VideoFrame,
  offscreen:typeof OffscreenCanvas,
  configs:typeof VideoDecoder==='function'?await Promise.all(['avc1.64001f','avc1.4d401f'].map(async codec=>{
    const {supported,config}=await VideoDecoder.isConfigSupported({codec,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});
    return {supported,config};
  })):[]
}))()
