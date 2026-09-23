const endpoint = process.env.PONG_ANDROID_CDP || 'http://127.0.0.1:9222';
const pagePattern = process.env.PONG_ANDROID_PAGE || '/pong';
const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('A JavaScript expression is required.');

const pages = await fetch(`${endpoint}/json`).then(response => response.json());
const page = pages.find(item => String(item.url || '').toLowerCase().includes(pagePattern.toLowerCase())) || pages[0];
if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable Android WebView page was found.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

const id = 1;
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Android WebView evaluation timed out.')), 10_000);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    clearTimeout(timer);
    resolve(message);
  };
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true }
  }));
});
socket.close();
if (reply.error || reply.result?.exceptionDetails) {
  throw new Error(JSON.stringify(reply.error || reply.result.exceptionDetails));
}
console.log(JSON.stringify(reply.result?.result?.value ?? null));
