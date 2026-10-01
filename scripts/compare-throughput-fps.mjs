// Completion-based throughput comparison, separate from paced presentation.
import {readFile, writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw Error('Usage: baseline.json candidate.json [comparison.json]');
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const after = JSON.parse(await readFile(afterPath, 'utf8'));
const fixtures = report => report.clips.map(c => Object.fromEntries(
  ['clip', 'sha256', 'sourceFps', 'width', 'height', 'duration'].map(k => [k, c[k]])));
const counts = report => report.clips.map(c => Object.fromEntries(
  ['frames', 'transformedFrames', 'inferenceFrames', 'temporalReuseFrames', 'fps',
    'sourceFrameStride', 'selectedFaceId'].map(k => [k, c.final[k]])));
const contract = {
  complete: before.completed === true && after.completed === true,
  silent: before.silent === true && after.silent === true,
  sameSettings: isDeepStrictEqual(before.settings, after.settings),
  sameFace: isDeepStrictEqual(before.face, after.face),
  sameFixturesAndOrder: isDeepStrictEqual(fixtures(before), fixtures(after)),
  sameFrameCountsAndCadence: isDeepStrictEqual(counts(before), counts(after)),
};
if (!Object.values(contract).every(Boolean)) throw Error('Comparison contract failed: '+JSON.stringify(contract));
const median = values => {
  const sorted = [...values].sort((a,b) => a-b), m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m-1]+sorted[m])/2;
};
const clips = after.clips.map((c, i) => ({
  clip: c.clip, baselineWorkFps: before.clips[i].workFps, candidateWorkFps: c.workFps,
  baselineEndToEndFps: before.clips[i].endToEndFps, candidateEndToEndFps: c.endToEndFps,
  frames: c.final.frames, transformedFrames: c.final.transformedFrames,
  workPass: c.workFps >= 34, completionPass: c.endToEndFps >= 34,
}));
const result = {baseline: beforePath, candidate: afterPath, contract,
  scope: 'Completed HTTP render+encode; no browser pacing. Whole-clip rates include target-absent frames.', clips,
  medianWorkFps: median(clips.map(c => c.candidateWorkFps)),
  medianEndToEndFps: median(clips.map(c => c.candidateEndToEndFps)),
  passed: clips.every(c => c.workPass && c.completionPass)
    && median(clips.map(c => c.candidateEndToEndFps)) >= 40};
if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 2;
