(() => ({
  urls: allVideoUrls.length, metadata: allVideoMetadata.length,
  trackedKeys: random40ServerVideoCacheTracked.size,
  trackedIds: new Set([...random40ServerVideoCacheTracked.values()].map(v=>v.id)).size,
  ready: [...random40ServerVideoCacheTracked.values()].filter(v=>v.ready).length,
  wrappers: document.querySelectorAll('.video-wrapper').length,
  domNodes: document.querySelectorAll('*').length,
  pollingMs: RANDOM40_SERVER_VIDEO_CACHE_STATUS_MS,
  pollBatch: RANDOM40_SERVER_VIDEO_CACHE_STATUS_BATCH
}))()
