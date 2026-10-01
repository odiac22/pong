// Compare only complete, settings-identical, byte-identical fixture runs.
import {readFile, writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {summarizePlaybackFps} from './playback-fps-metrics.mjs';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw Error('Usage: baseline.json candidate.json [comparison.json]');
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const after = JSON.parse(await readFile(afterPath, 'utf8'));
const contract = {
  complete: before.completed === true && after.completed === true,
  sameSettings: isDeepStrictEqual(before.settings, after.settings),
  sameFace: before.face === after.face,
  sameFixtures: isDeepStrictEqual(before.fixtureEvidence, after.fixtureEvidence),
  sameClipOrder: isDeepStrictEqual(before.clips.map(c => c.clip), after.clips.map(c => c.clip)),
};
if (!Object.values(contract).every(Boolean)) throw Error('Comparison contract failed: '+JSON.stringify(contract));
const b = summarizePlaybackFps(before), a = summarizePlaybackFps(after);
const result = {
  baseline: beforePath, candidate: afterPath, contract,
  scope: 'Full real-app headless playback of local fixtures; render-work FPS is not source cadence or end-to-end generation.',
  clips: a.clips.map((row, i) => ({
    clip: row.clip, baselineWorkFps: b.clips[i].renderWorkFps, candidateWorkFps: row.renderWorkFps,
    generationGainPercent: 100*(row.renderWorkFps/b.clips[i].renderWorkFps-1),
    baselineBufferCount: b.clips[i].bufferCount, candidateBufferCount: row.bufferCount,
    baselineBufferSeconds: b.clips[i].bufferSeconds, candidateBufferSeconds: row.bufferSeconds,
    baselineTransformedRatio: b.clips[i].transformedRatio, candidateTransformedRatio: row.transformedRatio,
    presentationFps: row.browserPresentedFps, minimumPassed: row.renderWorkAtLeast34,
  })),
  baselineSummary: b, candidateSummary: a,
  passed: a.allRenderWorkAtLeast34 && a.medianRenderWorkAtLeast40 && a.allZeroBuffering,
};
if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 2;
