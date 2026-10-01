(() => {
  const state=JSON.parse(window.PongTikTokLiveIntegratedState?.()||'{}');
  const origin=value=>{try{return new URL(value,location.href).origin}catch{return ''}};
  return {pageOrigin:location.origin,streamOrigin:origin(state.streamUrl),hasStream:!!state.streamUrl,
    activeSession:!!state.sessionId,externalAuthority:!!document.querySelector('[data-pong-external-playback-authority="true"]')};
})()
