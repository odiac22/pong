// Opt-in identity for independent video elements on the same source page.
// Legacy captures without an ID retain their one-page/one-video behavior.
export function normalizeRecallVideoId(value) {
  const id = String(value || '');
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : '';
}
export function recallMediaIdentity(pageUrl, logicalVideoId) {
  const id = normalizeRecallVideoId(logicalVideoId);
  return id ? `${pageUrl}\n${id}` : String(pageUrl || '');
}
export function mergeRecallCapturedVideos(existing, incoming) {
  const merged = [...(Array.isArray(existing) ? existing : [])];
  const indexes = new Map(merged.map((video, index) => [recallMediaIdentity(video.pageUrl, video.logicalVideoId), index]));
  for (const video of incoming) {
    const key = recallMediaIdentity(video.pageUrl, video.logicalVideoId);
    const index = indexes.get(key);
    if (index !== undefined) merged[index] = {
      ...merged[index], ...video,
      browserRelayUrl: video.browserRelayUrl || merged[index].browserRelayUrl || ''
    };
    else { indexes.set(key, merged.length); merged.push(video); }
  }
  return merged;
}
