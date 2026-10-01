import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await fs.readFile(new URL('../local-ai-server.mjs', import.meta.url), 'utf8');
const restore = source.slice(source.indexOf('if (process.env.PONG_RECALL_RESTORE_FILE)'),
  source.indexOf('function simpCityRecallChannel(rawChannel)'));
async function run(item) {
  const state = {}, calls = [];
  const context = { process: { env: { PONG_RECALL_RESTORE_FILE: 'local-snapshot' } },
    fs: { readFile: async () => JSON.stringify({ channels: [item] }) },
    simpCityRecallChannels: new Map([[2, state]]),
    authorizeGenericMediaUrl: (raw, referer) => {
      if (!raw.startsWith('https://media.example/')) throw Error('non-public source');
      calls.push({ raw, referer });
    } };
  await vm.runInNewContext(`(async()=>{${restore}})()`, context);
  return { state, calls };
}
test('idle restart restores all validated variants and per-video Referer', async () => {
  const result = await run({ channel: 2, recall: { genericBundles: [{ videos: [{
    videoUrl: 'https://media.example/hd.mp4',
    videoUrls: ['https://media.example/hd.mp4', 'https://media.example/other.mp4'],
    pageUrl: 'https://page.example/watch' }] }] }, mediaCapture: { state: 'complete' } });
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(c => c.referer === 'https://page.example/watch'));
  assert.equal(result.state.payload.genericBundles[0].videos.length, 1);
});
test('invalid variants stay unauthorized without losing valid cards', async () => {
  const result = await run({ channel: 2, recall: { genericBundles: [{ videos: [{
    videoUrl: 'http://127.0.0.1/private', videoUrls: ['https://media.example/hd.mp4'] }] }] } });
  assert.equal(result.calls.length, 1);
});
test('active snapshots are still rejected', async () => {
  for (const item of [{ pending: {} }, { recall: { live: true } }, { mediaCapture: { state: 'running' } }]) {
    await assert.rejects(run({ channel: 2, ...item }), /Only idle Recall/);
  }
});
test('long HD files fit under the per-file cap without exceeding the total budget', () => {
  const declaration = source.match(/const VIDEO_FILE_CACHE_MAX_FILE_BYTES =[\s\S]*?;/)[0];
  for (const max of [12 * 1024 ** 3, 1024 ** 3]) {
    const cap = vm.runInNewContext(`${declaration}\nVIDEO_FILE_CACHE_MAX_FILE_BYTES`, {
      VIDEO_FILE_CACHE_MAX_BYTES: max, process: { env: {} } });
    assert.equal(cap, Math.min(max, 4 * 1024 ** 3));
    assert.ok(cap > 256 * 1024 ** 2);
  }
});
