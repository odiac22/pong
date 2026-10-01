(() => ({observer:window.__pongTikTokObserverStats,path:location.pathname,
 originalVideos:document.querySelectorAll('video:not(.pong-tiktok-swap-stream)').length,
 cards:document.querySelectorAll('[data-e2e="recommend-list-item-container"]').length,
 memory:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,limit:performance.memory.jsHeapSizeLimit}:null}))()
