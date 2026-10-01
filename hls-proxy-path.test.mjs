import test from 'node:test';
import assert from 'node:assert/strict';
import { genericHlsProxyPath, isGenericHlsProxyPath } from './hls-proxy-path.mjs';

test('preserves HLS playlist, MPEG-TS, fMP4, audio, key and subtitle extensions', () => {
  for (const suffix of ['m3u8', 'ts', 'm4s', 'mp4', 'aac', 'key', 'vtt']) {
    const source = `https://media.example/asset.${suffix}?signature=a%2Fb&n=3`;
    const proxy = new URL(genericHlsProxyPath(source), 'http://127.0.0.1:8787');
    assert.equal(proxy.pathname, `/generic-media/hls/resource.${suffix}`);
    assert.equal(proxy.searchParams.get('url'), source);
    assert.ok(isGenericHlsProxyPath(proxy.pathname));
  }
});

test('does not mistake query suffixes for media extensions or invent formats', () => {
  assert.equal(new URL(genericHlsProxyPath('https://media.example/segment?name=x.ts'), 'http://localhost').pathname, '/generic-media/hls');
  assert.equal(new URL(genericHlsProxyPath('https://media.example/SEGMENT.TS?x=.mp4'), 'http://localhost').pathname, '/generic-media/hls/resource.ts');
});

test('legacy URLs remain valid and unrelated paths are not authorized', () => {
  assert.ok(isGenericHlsProxyPath('/generic-media/hls'));
  for (const path of ['/generic-media/hls/', '/generic-media/hls/anything.ts', '/generic-media/hls/resource.ts/extra', '/generic-media/hls/resource.%2e', '/proxy', '/generic-media/hls-not-media']) {
    assert.equal(isGenericHlsProxyPath(path), false);
  }
});
