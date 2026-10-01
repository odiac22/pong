import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const number = (value, max = 86400000) => Math.min(max, Math.max(0, Number(value) || 0));
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;

// Deliberately exclude source URLs, HTML, titles, arbitrary errors and headers.
export function sanitizeDetectionFeedback(input) {
  if (input?.schema !== 1 || !Array.isArray(input.candidates) || input.candidates.length > 80) {
    throw new Error('Invalid detection feedback');
  }
  return {
    schema: 1,
    id: /^[a-z0-9-]{8,100}$/i.test(input.id || '') ? input.id : crypto.randomUUID(),
    version: /^\d+\.\d+\.\d+$/.test(input.version || '') ? input.version : 'unknown',
    receivedAt: new Date().toISOString(),
    mode: choice(input.mode, ['main', 'all'], 'all'), channel: input.channel === 2 ? 2 : 1,
    ignoreUnder30: input.ignoreUnder30 === true,
    stage: choice(input.stage, ['selection','capture','complete','failed'], 'selection'),
    evidence: {
      videoElements: number(input.evidence?.videoElements, 10000),
      iframeElements: number(input.evidence?.iframeElements, 10000),
      structuredDataBlocks: number(input.evidence?.structuredDataBlocks, 10000),
      players: (Array.isArray(input.evidence?.players) ? input.evidence.players : [])
        .filter(value => ['videojs','plyr','jwplayer','flowplayer','mediaelement'].includes(value)).slice(0, 5)
    },
    candidates: input.candidates.map(item => ({
      index: number(item?.index, 80),
      kind: choice(item?.kind, ['player','embed','link','direct'], 'player'),
      linkEvidence: choice(item?.linkEvidence, ['none','direct','path','video_attribute','text','play_or_duration','thumbnail','manual_link'], 'none'),
      tag: choice(item?.tag, ['VIDEO','IFRAME','A','EMBED','OBJECT','OTHER'], 'OTHER'),
      selected: item?.selected === true, mapped: item?.mapped === true, independent: item?.independent === true,
      durationSeconds: number(item?.durationSeconds), width: number(item?.width, 32768), height: number(item?.height, 32768),
      outcome: choice(item?.outcome, ['delivery_failed','sent','fetch_failed','not_verified','not_checked'], 'not_checked'),
      elapsedMs: number(item?.elapsedMs),
      failure: choice(item?.failure, ['extraction_error','none'], 'none'),
      attempts: (Array.isArray(item?.attempts) ? item.attempts : []).slice(0, 4).map(attempt => ({
        fetched: attempt?.fetched === true, verified: attempt?.verified === true, retry: attempt?.retry === true,
        extracted: number(attempt?.extracted, 1000), embeddedPlayers: number(attempt?.embeddedPlayers, 1000), pageDuration: number(attempt?.pageDuration),
        failure: choice(attempt?.failure, ['none','no_media','duration_filter','media_unverified','page_fetch'], 'none')
      }))
    }))
  };
}

export async function saveDetectionFeedback(directory, input) {
  const report = sanitizeDetectionFeedback(input);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${report.id}.json`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
  // A bounded local debugging history; re-sending the same selection updates it.
  const files = await fs.readdir(directory);
  const records = await Promise.all(files.filter(name => /^[a-z0-9-]{8,100}\.json$/i.test(name))
    .map(async name => ({ name, time: (await fs.stat(path.join(directory, name)).catch(() => ({mtimeMs: 0}))).mtimeMs })));
  records.sort((a, b) => b.time - a.time);
  await Promise.all(records.filter(record => record.time).slice(100).map(record => fs.unlink(path.join(directory, record.name)).catch(() => {})));
  return { ok: true, saved: true, id: report.id, candidates: report.candidates.length };
}
