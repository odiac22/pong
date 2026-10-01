const port = Number(process.env.PONG_CDP_PORT || 9225);
const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('Pass a JavaScript expression to evaluate');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const target = targets.find(candidate => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error(`No page target on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 15_000);
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error || message.result?.exceptionDetails) {
      reject(new Error(message.error?.message || message.result.exceptionDetails.text));
      return;
    }
    resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, userGesture: false },
  }));
});

socket.close();
console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
