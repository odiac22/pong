(() => ({worker:typeof Worker,mediaSourceHandle:typeof MediaSourceHandle,
 workerMediaSource:window.MediaSource?.canConstructInDedicatedWorker===true,
 secure:isSecureContext,crossOriginIsolated}))()
