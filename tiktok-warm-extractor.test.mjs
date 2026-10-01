// Network integration test for Baseline 1.1 (skips when no URL list exists).
// node --test tiktok-warm-extractor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTikTokWarmExtractor, tikTokWarmExtractorScript } from './tiktok-warm-extractor.mjs';
import { createTikTokProgressTracker } from './video-cache-tiktok-progress.mjs';

const LIST = process.env.PONG_TIKTOK_TEST_URLS || 'F:\\pong-claude-bench\\tiktok-public-urls.txt';
const PYTHON = process.env.PONG_TIKTOK_TEST_PYTHON ||
  'C:\\Users\\arian\\Documents\\Codex\\2026-07-15\\files-mentioned-by-the-user-chatgpt\\work\\pong\\.pong-local-ai\\lora-venv\\Scripts\\python.exe';

test('warm extractor streams a complete, progressively publishable TikTok MP4', {skip: !existsSync(LIST) || !existsSync(PYTHON)}, async () => {
  const extractor = createTikTokWarmExtractor({python: PYTHON, script: tikTokWarmExtractorScript(process.cwd()), cwd: process.cwd()});
  try {
    for (const url of readFileSync(LIST, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 2)) {
      const record = {bytes: 0, totalBytes: 0};
      const file = path.join(os.tmpdir(), `pong-warm-${Date.now()}.mp4`);
      const output = await open(file, 'w');
      let position = 0;
      try {
        const tracker = createTikTokProgressTracker(record, {maxFileBytes: 512 * 1024 ** 2});
        const info = await extractor.resolve(url);
        const bytes = await extractor.stream(info, {
          maxBytes: 512 * 1024 ** 2,
          write: async chunk => { await output.write(chunk, 0, chunk.length, position); position += chunk.length; },
          onMetadata: length => tracker.stderr(`__PONG_TIKTOK_PROGRESS__${length}\n`),
          onBytes: chunk => tracker.bytes(chunk)
        });
        await output.close();
        assert.equal((await stat(file)).size, bytes);
        assert.equal(record.totalBytes, bytes, 'exact entity size published');
        assert.equal(record.progressiveMetadataValidated, true, 'H.264 fast-start metadata validated');
      } finally {
        await output.close().catch(() => {});
        await rm(file, {force: true});
      }
    }
  } finally {
    extractor.close();
  }
});

test('untrusted media hosts are refused before any byte is written', async () => {
  const extractor = createTikTokWarmExtractor({python: PYTHON, script: 'unused', cwd: process.cwd()});
  let wrote = false;
  await assert.rejects(extractor.stream({url: 'https://example.com/video/x.mp4', headers: {}}, {
    maxBytes: 1024, write: async () => { wrote = true; }, onMetadata: () => {}, onBytes: () => {}
  }), /Untrusted TikTok media host/);
  assert.equal(wrote, false);
  extractor.close();
});
