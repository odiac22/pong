// Explicit phone routing is fail-closed: never substitute a PC fetch.
export function phoneConnectionCaptureRequested(payload) {
  return payload?.phoneConnectionOnly === true;
}

export function phoneConnectionFileCandidates(urls) {
  return (urls || []).filter(value => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && /\.(?:mp4|webm|mov|m4v)(?:$)/i.test(url.pathname);
    } catch { return false; }
  });
}

export function phoneConnectionVideoRecord(video, relayUrl) {
  return {
    ...video,
    videoUrl: relayUrl,
    browserRelayUrl: relayUrl,
    // Do not expose PC fallback candidates to automatic playback recovery.
    videoUrls: [],
    phoneConnectionOnly: true
  };
}
