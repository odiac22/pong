import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopCaptureJobs, preferredDesktopCaptureMediaUrls, rankDesktopCaptureMediaUrls } from './desktop-capture-jobs.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Job did not reach expected state');
}

test('accepts immediately, verifies on server, and reports only safe status', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commits = [];
  const jobs = createDesktopCaptureJobs({
    resolve: async (target, _context, verifying) => {
      verifying();
      await gate;
      return target.index === 0
        ? { video: { videoUrl: 'https://secret.invalid/stream?token=private', durationSeconds: 60 }, resolutionMs: 4, verificationMs: 8 }
        : { error: 'source_unavailable' };
    },
    commit: (_context, video) => { commits.push(video); },
    finish: () => {},
    active: () => true
  });
  const target = { pageUrl: 'https://secret.invalid/watch?token=private', title: 'Private title' };
  const accepted = jobs.start({ id: 'job-one', fingerprint: 'same', targets: [target, target], context: {} });
  assert.equal(accepted.status.state, 'running');
  assert.deepEqual(accepted.status.targets.map(item => item.state), ['queued', 'queued']);
  assert.equal(jobs.start({ id: 'job-one', fingerprint: 'same', targets: [], context: {} }).duplicate, true);
  assert.equal(jobs.start({ id: 'job-one', fingerprint: 'different', targets: [], context: {} }).duplicate, false);
  await tick();
  assert.equal(jobs.get('job-one').targets[0].state, 'verifying');
  release();
  await until(() => jobs.get('job-one').state === 'complete');
  const final = jobs.get('job-one');
  assert.equal(final.readyCount, 1);
  assert.equal(final.failedCount, 1);
  assert.equal(final.targets[1].error, 'source_unavailable');
  assert.equal(commits.length, 1);
  assert.doesNotMatch(JSON.stringify(final), /secret|token|Private/);
});

test('superseded capture cannot commit after its resolver finishes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let activeId = 'old';
  let committed = false;
  const jobs = createDesktopCaptureJobs({
    resolve: async () => { await gate; return { video: { videoUrl: 'https://cdn.invalid/video.mp4' } }; },
    commit: () => { committed = true; },
    finish: () => {},
    active: context => context.id === activeId
  });
  jobs.start({ id: 'old', fingerprint: 'one', targets: [{}], context: { id: 'old' } });
  await tick();
  activeId = 'new';
  release();
  await until(() => jobs.get('old').state === 'superseded');
  assert.equal(committed, false);
  assert.equal(jobs.get('old').targets[0].error, 'superseded');
});

test('a never-settling resolver reports timeout but keeps its real slot occupied', async () => {
  let started = 0;
  const jobs = createDesktopCaptureJobs({
    resolve: () => { started++; return new Promise(() => {}); },
    commit: () => {}, finish: () => {}, active: () => true,
    timeoutMs: 5, concurrency: 1
  });
  jobs.start({ id: 'timeout', fingerprint: 'one', targets: [{}], context: {} });
  await until(() => jobs.get('timeout').targets[0].error === 'timeout');
  assert.equal(jobs.get('timeout').targets[0].error, 'timeout');
  assert.equal(jobs.get('timeout').state, 'running');
  jobs.start({ id: 'queued', fingerprint: 'two', targets: [{}], context: {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(started, 1);
  assert.equal(jobs.get('queued').targets[0].state, 'resolving');
});

test('late resolver success after timeout cannot commit', async () => {
  let release, committed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = createDesktopCaptureJobs({
    resolve: async () => { await gate; return { video: { videoUrl: 'https://fixture.invalid/late.mp4' } }; },
    commit: () => { committed++; }, finish: () => {}, active: () => true,
    timeoutMs: 5, concurrency: 1
  });
  jobs.start({ id: 'late', fingerprint: 'one', targets: [{}], context: {} });
  await until(() => jobs.get('late').targets[0].error === 'timeout');
  assert.equal(jobs.get('late').state, 'running');
  release();
  await until(() => jobs.get('late').state === 'failed');
  assert.equal(committed, 0);
  assert.equal(jobs.get('late').targets[0].error, 'timeout');
});

test('cooperative resolver receives abort signal and frees its slot after rejection', async () => {
  let observedSignal, committed = 0;
  const jobs = createDesktopCaptureJobs({
    resolve: (_target, _context, _verifying, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort',
        () => reject(new Error('cancelled')), { once: true }));
    },
    commit: () => { committed++; }, finish: () => {}, active: () => true,
    timeoutMs: 5, concurrency: 1
  });
  jobs.start({ id: 'cooperative', fingerprint: 'one', targets: [{}], context: {} });
  await until(() => jobs.get('cooperative').state === 'failed');
  assert.equal(observedSignal.aborted, true);
  assert.equal(jobs.get('cooperative').targets[0].error, 'timeout');
  assert.equal(committed, 0);
});

test('abort-triggered resolver success cannot outrun the timeout rejection', async () => {
  let committed = 0;
  const jobs = createDesktopCaptureJobs({
    resolve: (_target, _context, _verifying, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ video: { videoUrl: 'https://fixture.invalid/late.mp4' } }),
        { once: true });
    }),
    commit: () => { committed++; }, finish: () => {}, active: () => true,
    timeoutMs: 5
  });
  jobs.start({ id: 'abort-success', fingerprint: 'one', targets: [{}], context: {} });
  await until(() => jobs.get('abort-success').state === 'failed');
  assert.equal(jobs.get('abort-success').targets[0].error, 'timeout');
  assert.equal(committed, 0);
});

test('timed-out jobs keep global concurrency bounded until underlying work settles', async () => {
  const pending = new Map();
  let active = 0, peak = 0, starts = 0, commits = 0;
  const jobs = createDesktopCaptureJobs({
    resolve: target => {
      starts++; active++; peak = Math.max(peak, active);
      return new Promise(resolve => pending.set(target.key, () => {
        active--; resolve({ video: { videoUrl: 'https://fixture.invalid/late.mp4' } });
      }));
    },
    commit: () => { commits++; }, finish: () => {}, active: () => true,
    timeoutMs: 8, concurrency: 2
  });
  jobs.start({ id: 'first', fingerprint: 'one',
    targets: [{key: 'a'}, {key: 'b'}], context: {} });
  jobs.start({ id: 'second', fingerprint: 'two',
    targets: [{key: 'c'}, {key: 'd'}], context: {} });
  await until(() => jobs.get('first').failedCount === 2);
  assert.equal(starts, 2);
  assert.equal(peak, 2);
  assert.equal(jobs.get('second').state, 'running');
  pending.get('a')(); pending.delete('a');
  await until(() => starts === 3);
  assert.equal(active, 2);
  for (const key of ['b', 'c', 'd']) {
    await until(() => pending.has(key));
    if (key === 'c') await until(() => jobs.get('second').targets[0].error === 'timeout');
    if (key === 'd') await until(() => jobs.get('second').targets[1].error === 'timeout');
    pending.get(key)(); pending.delete(key);
  }
  await until(() => jobs.get('first').state === 'failed' && jobs.get('second').state === 'failed');
  assert.equal(peak, 2);
  assert.equal(commits, 0);
});

test('page challenge is reported without leaking source details', async () => {
  const jobs = createDesktopCaptureJobs({
    resolve: async () => ({ error: 'page_challenge', detail: 'https://private.example/watch?token=secret' }),
    commit: () => { throw new Error('unexpected commit'); }, finish: () => {}, active: () => true
  });
  jobs.start({ id: 'challenged', fingerprint: 'one', targets: [{}], context: {} });
  await until(() => jobs.get('challenged').state === 'failed');
  const status = jobs.get('challenged');
  assert.equal(status.targets[0].error, 'page_challenge');
  assert.doesNotMatch(JSON.stringify(status), /private|token|secret/);
});

test('source-choice diagnostic allowlist cannot expose extra fields', async () => {
  const jobs=createDesktopCaptureJobs({resolve:async()=>({
    video:{videoUrl:'https://private.invalid/movie.mp4'},
    sourceSelection:{mode:'selected-source-upgrade',width:3840,height:2160,
      url:'https://private.invalid/?token=secret',cookies:'secret',probesOverlappedResolution:true}
  }),commit:()=>{},finish:()=>{},active:()=>true});
  jobs.start({id:'quality',fingerprint:'quality',targets:[{}],context:{}});
  await until(()=>jobs.get('quality').state==='complete');
  const result=jobs.get('quality');
  assert.equal(result.targets[0].sourceSelection.width,3840);
  assert.equal(result.targets[0].sourceSelection.verificationScope,'response-headers');
  assert.doesNotMatch(JSON.stringify(result),/private|secret|cookies|token/);
});

test('known 1080p file beats known 480p HLS and previews are excluded', () => {
  assert.deepEqual(preferredDesktopCaptureMediaUrls([
    'https://cdn.invalid/movie_480P.m3u8',
    'https://cdn.invalid/movie_1080P.mp4',
    'https://cdn.invalid/preview_2160P.mp4'
  ]), ['https://cdn.invalid/movie_1080P.mp4']);
});

test('trailer filename is allowed only with selected inline source identity', () => {
  const trailer='https://media.example.org/sintel/trailer.mp4';
  assert.deepEqual(preferredDesktopCaptureMediaUrls([trailer]),[]);
  assert.deepEqual(preferredDesktopCaptureMediaUrls([trailer],[{url:trailer,selectedInline:true,type:'video/mp4'}]),[trailer]);
});

test('numeric HQPorner rendition filenames select 1080 over 360', () => {
  assert.deepEqual(preferredDesktopCaptureMediaUrls([
    'https://cdn.invalid/movie/360.mp4',
    'https://cdn.invalid/movie/720.mp4',
    'https://cdn.invalid/movie/1080.mp4'
  ]), ['https://cdn.invalid/movie/1080.mp4']);
});

test('selected element dimensions and labels rank only matching source URLs', () => {
  const low='https://cdn.example/media/opaque-a.mp4';
  const high='https://cdn.example/media/opaque-b.mp4';
  const unrelated='https://cdn.example/media/other.mp4';
  const sources=[{url:low,width:1280,height:720,type:'video/mp4'},
    {url:high,width:1920,height:1080,type:'video/mp4'},
    {url:unrelated,width:7680,height:4320,type:'video/mp4'}];
  assert.deepEqual(preferredDesktopCaptureMediaUrls([low,high],sources),[high]);
  assert.equal(rankDesktopCaptureMediaUrls([low,high],sources)[0].evidence,'selected_source_dimensions');
  assert.deepEqual(preferredDesktopCaptureMediaUrls([low,high],[{url:low,label:'360p'},{url:high,label:'Full HD'}]),[high]);
});

test('filename dimensions beat numeric asset ids; unknown quality remains explicit',()=>{
  const files=['https://cdn.example/videos/1213/1213-720.mp4',
    'https://cdn.example/videos/1213/1213-1080.mp4'];
  assert.deepEqual(preferredDesktopCaptureMediaUrls(files),[files[1]]);
  const opaque=rankDesktopCaptureMediaUrls(['https://cdn.example/opaque.mp4']);
  assert.equal(opaque[0].known,false);
  assert.equal(opaque[0].evidence,'unknown');
});

test('23-link batch processes two at a time and waits for commit before advancing', async () => {
  const pending = new Map();
  const started = [];
  let activeCount = 0, peak = 0, committed = 0, releaseFirstCommit;
  const firstCommit = new Promise(resolve => { releaseFirstCommit = resolve; });
  const jobs = createDesktopCaptureJobs({
    resolve: async target => {
      started.push(target.index);
      activeCount++; peak = Math.max(peak, activeCount);
      await new Promise(resolve => pending.set(target.index, resolve));
      activeCount--;
      return { video: { index: target.index, videoUrl: 'https://fixture.invalid/media.mp4' } };
    },
    commit: async (_context, video) => {
      if (video.index === 0) await firstCommit;
      committed++;
    },
    finish: () => {}, active: () => true
  });
  jobs.start({ id: 'batch-23', fingerprint: '23', targets: Array.from({ length: 23 }, () => ({})), context: {} });
  await tick();
  assert.deepEqual(started, [0, 1]);
  pending.get(0)(); pending.delete(0);
  await tick();
  assert.deepEqual(started, [0, 1], 'A resolved link does not advance before its Recall commit finishes');
  releaseFirstCommit();
  await tick();
  assert.deepEqual(started, [0, 1, 2], 'One completed link starts exactly one queued link');
  for (let round = 0; round < 30 && jobs.get('batch-23').state === 'running'; round++) {
    for (const [index, release] of [...pending]) { pending.delete(index); release(); }
    await tick();
    assert.ok(activeCount <= 2);
  }
  assert.equal(peak, 2);
  assert.equal(committed, 23);
  assert.equal(jobs.get('batch-23').readyCount, 23);
  assert.equal(jobs.get('batch-23').state, 'complete');
});
