// Bound hidden browser ownership independently of listing/request concurrency.
export function createMediaBrowserLimiter(limit = 2, waitMs = 15000) {
  let active = 0;
  const queue = [];
  const grant = resolve => {
    active++;
    let released = false;
    resolve(() => {
      if (released) return; released = true; active--;
      const next = queue.shift();
      if (next) { clearTimeout(next.timer); grant(next.resolve); }
    });
  };
  return () => new Promise((resolve, reject) => {
    if (active < limit) return grant(resolve);
    if (queue.length >= 32) return reject(new Error('Video browser queue is full; retry shortly'));
    const item = {resolve, timer: null};
    item.timer = setTimeout(() => {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      reject(new Error('Video browser queue deadline exceeded; retry shortly'));
    }, waitMs);
    queue.push(item);
  });
}
