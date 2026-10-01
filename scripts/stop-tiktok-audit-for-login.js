(() => {
  // Stop the diagnostic sampler cleanly; its owner runs normal session cleanup.
  // No TikTok state, cookie, or account data is changed.
  window.__pongAuditSnapshot = () => { throw new Error('Login prompt appeared; audit stopped without scoring blocked navigation'); };
  return {stopRequested:true};
})()
