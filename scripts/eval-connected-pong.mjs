const port = Number(process.argv[2] || 9223);
const expression = Buffer.from(String(process.argv[3] || ''), 'base64').toString('utf8');
const targetPattern = String(process.argv[4] || '').trim();
if (!expression) throw new Error('Pass a base64-encoded JavaScript expression');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const matcher = targetPattern ? new RegExp(targetPattern, 'i') : /Pong/i;
const target = targets.find(item => (
  item.type === 'page' && matcher.test(`${item.title || ''} ${item.url || ''}`)
)) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error('Connected Pong WebView target was not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

const id = 1;
const result = new Promise((resolve, reject) => {
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    socket.close();
    if (message.exceptionDetails) {
      reject(new Error(
        message.exceptionDetails.exception?.description ||
        message.exceptionDetails.text ||
        'Runtime.evaluate failed'
      ));
    }
    else resolve(message.result?.result?.value);
  };
});
socket.send(JSON.stringify({
  id,
  method: 'Runtime.evaluate',
  params: { expression, returnByValue: true, awaitPromise: true }
}));

const value = await result;
if (typeof value === 'string') {
  try {
    console.log(JSON.stringify(JSON.parse(value), null, 2));
  } catch (_) {
    console.log(value);
  }
} else {
  console.log(JSON.stringify(value, null, 2));
}
