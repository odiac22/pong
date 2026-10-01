import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `${name} closes`);
  return source.slice(start, end + 2);
}
function context(enabled) {
  const sandbox = { URL, Number, Set, String };
  vm.createContext(sandbox);
  vm.runInContext(`const SOURCE_OPEN_CACHE_DIAGNOSTICS_ENABLED = ${enabled};\n` +
    [extract('isLoopbackAddress'), extract('sourceOpenCacheDiagnosticAllowed'),
      extract('sourceOpenCacheDiagnosticRecord')].join('\n'), sandbox);
  return sandbox;
}
function allowed(sandbox, overrides = {}) {
  const id = 'a'.repeat(32);
  const req = {
    method: 'GET', url: `/video-cache/diagnostics/record?id=${id}`,
    socket: { remoteAddress: '127.0.0.1' }, headers: {},
    ...overrides,
  };
  const parsed = new URL(req.url, 'http://127.0.0.1:8787');
  return vm.runInContext('sourceOpenCacheDiagnosticAllowed', sandbox)(req, parsed);
}

assert.equal(allowed(context(false)), false, 'default off');
const enabled = context(true);
assert.equal(allowed(enabled), true);
assert.equal(allowed(enabled, { socket: { remoteAddress: '::1' } }), true);
assert.equal(allowed(enabled, { socket: { remoteAddress: '192.168.1.2' } }), false);
assert.equal(allowed(enabled, { socket: { remoteAddress: '10.0.2.2' } }), false);
assert.equal(allowed(enabled, { headers: { origin: 'https://example.test' } }), false);
assert.equal(allowed(enabled, { method: 'POST' }), false);
assert.equal(allowed(enabled, { url: '/video-cache/diagnostics/record?id=bad' }), false);
assert.equal(allowed(enabled, { url: '/video-cache/diagnostics/record?id=' +
  'a'.repeat(32) + '&padding=' + 'x'.repeat(180) }), false);

const record = vm.runInContext('sourceOpenCacheDiagnosticRecord', enabled)({
  status: 'error', bytes: 17, totalBytes: 200, failureCategory: 'timeout',
  failureAttempts: 2, sourceUrl: 'https://signed.test/?secret=token',
  aliases: ['private-url'], error: 'raw-secret',
});
assert.equal(record.status, 'error');
assert.equal(record.failure.category, 'timeout');
assert.equal(record.failure.attempts, 2);
assert.equal(record.bytes, 17);
assert.doesNotMatch(JSON.stringify(record), /secret|signed|private-url|aliases/);
assert.equal(vm.runInContext('sourceOpenCacheDiagnosticRecord', enabled)(null).status, 'missing');

const route = source.slice(source.indexOf("if (requestUrl.pathname === '/video-cache/diagnostics/record')"),
  source.indexOf("if ((req.method === 'GET' || req.method === 'HEAD') && /^\\/pong", source.indexOf("if (requestUrl.pathname === '/video-cache/diagnostics/record')")));
assert.match(route, /sourceOpenCacheDiagnosticAllowed\(req, requestUrl\)/);
assert.match(route, /videoFileCacheRecords\.get\(id\)/);
assert.doesNotMatch(route, /touchVideoFileCacheHeartbeat|queueVideoFileCacheUrl|pumpVideoFileCache/);
const proxy = extract('proxyPongSwapRequest');
assert.ok(proxy.indexOf("requestUrl.pathname.startsWith('/pong-swap/diagnostics/')") <
  proxy.indexOf('await ensurePongSwapService'), 'proxy rejects diagnostics before service launch');
assert.match(proxy, /'x-pong-proxy': '1'/, 'all forwarded paths carry a renderer-visible proxy marker');

console.log('source-open helper route: 16 CPU checks passed');
