import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeDetectionFeedback, saveDetectionFeedback } from './detection-feedback.mjs';

const fixture = () => ({ schema: 1, version: '7.18.0', id: 'synthetic-selection-0001', site: 'fixture.invalid',
  stage: 'complete', candidates: [{ index: 1, kind: 'player', tag: 'VIDEO', selected: true, outcome: 'sent',
    attempts: [{ fetched: true, extracted: 2, verified: true }] }] });

test('feedback excludes credentials, URLs, markup and arbitrary error strings at every level', () => {
  const report = fixture();
  report.cookie = 'SECRET'; report.sourceUrl = 'https://fixture.invalid/?token=SECRET'; report.html = 'SECRET';
  report.candidates[0].url = 'SECRET'; report.candidates[0].error = 'SECRET'; report.candidates[0].attempts[0].headers = 'SECRET';
  const value = sanitizeDetectionFeedback(report);
  assert.equal(JSON.stringify(value).includes('SECRET'), false);
  assert.equal('site' in value, false);
  assert.equal(value.candidates[0].outcome, 'sent');
  assert.equal(value.candidates[0].selected, true);
});
test('feedback rejects oversized candidate sets and bounds malformed numbers and enum values', () => {
  assert.throws(() => sanitizeDetectionFeedback({ schema: 1, candidates: Array(81).fill({}) }));
  const report = fixture(); report.id = '../../outside'; report.site = 'https://secret.invalid/token';
  Object.assign(report.candidates[0], { width: Infinity, elapsedMs: -100, outcome: 'SECRET' });
  const clean = sanitizeDetectionFeedback(report);
  assert.match(clean.id, /^[a-z0-9-]+$/); assert.equal('site' in clean, false);
  assert.equal(clean.candidates[0].width, 32768); assert.equal(clean.candidates[0].elapsedMs, 0);
  assert.equal(clean.candidates[0].outcome, 'not_checked');
});
test('reports survive disk readback and a retry updates the same report', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-feedback-test-'));
  try {
    const report = fixture();
    const first = await saveDetectionFeedback(directory, report);
    report.candidates[0].outcome = 'delivery_failed';
    const second = await saveDetectionFeedback(directory, report);
    assert.equal(first.id, second.id);
    assert.equal((await fs.readdir(directory)).length, 1);
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${first.id}.json`), 'utf8'));
    assert.equal(stored.candidates[0].outcome, 'delivery_failed');
  } finally {
    // Remove only files created inside this test's explicitly allocated folder.
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
});
