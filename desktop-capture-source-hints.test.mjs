import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceMediaHints, planSourceMediaHints, publicAddress, secureRangeProbe, shouldTrySourceMediaHints,
  verifySourceMediaHint } from './desktop-capture-source-hints.mjs';
import { preferredDesktopCaptureMediaUrls } from './desktop-capture-jobs.mjs';

const page = 'https://www.pexels.com/video/people-smiling-and-posing-8379044/';
const high = 'https://videos.pexels.com/video-files/8379044/8379044-uhd_3840_2160_25fps.mp4';
const low = 'https://videos.pexels.com/video-files/8379044/8379044-sd_640_360_25fps.mp4';
const hint = (url = high, overrides = {}) => ({ url, sourcePageUrl: page, durationSeconds: 10,
  width: 3840, height: 2160, ...overrides });

test('accepts selected-page rendition and ranks only its highest advertised quality', () => {
  const hints = normalizeSourceMediaHints(page, [hint(low, { width: 640, height: 360 }), hint()], 10);
  assert.equal(hints.length, 2);
  assert.deepEqual(preferredDesktopCaptureMediaUrls(hints.map(item => item.url), hints), [high]);
});

test('rejects unrelated, cross-site, private, and non-media hints', () => {
  const invalid = [
    hint(high, { sourcePageUrl: 'https://www.pexels.com/video/other-8379044/' }),
    hint('https://videos.pexels.com/video-files/8379045/8379045-uhd_3840_2160_25fps.mp4'),
    hint('https://unrelated.example.net/video/8379044.mp4'),
    hint('https://127.0.0.1/video/8379044.mp4'),
    hint('https://videos.pexels.com/video-files/8379044/8379044-preview.mp4'),
    hint('https://videos.pexels.com/video-files/8379044/8379044-image.jpg'),
  ];
  for (const candidate of invalid) assert.deepEqual(normalizeSourceMediaHints(page, [candidate], 10), []);
  assert.deepEqual(normalizeSourceMediaHints(page, Array(9).fill(hint()), 10), []);
});

test('rejects missing or conflicting duration and malformed dimensions', () => {
  for (const candidate of [hint(high, { durationSeconds: 0 }), hint(high, { durationSeconds: 40 }),
    hint(high, { durationSeconds: Infinity }), hint(high, { width: 3840, height: 0 })]) {
    assert.deepEqual(normalizeSourceMediaHints(page, [candidate], 10), []);
  }
  assert.equal(normalizeSourceMediaHints(page, [hint(high, { width: undefined, height: undefined })], 10).length, 1);
  assert.deepEqual(normalizeSourceMediaHints(page, [hint(
    'https://videos.pexels.com/video-files/8379044/8379044.mp4', { width: undefined, height: undefined }
  )], 10), []);
});

test('rejects private and reserved resolved IP addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.2',
    '172.16.0.1', '192.168.1.1', '192.88.99.1', '198.18.0.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fd00::1',
    '64:ff9b:1::1', '2001:2::1', '2001:db8::1', '2002::1', '3fff::1', 'ff02::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('probes a bound media hint with a bounded range before accepting it', async () => {
  const [candidate] = normalizeSourceMediaHints(page, [hint()], 10);
  let calls = 0;
  const result = await verifySourceMediaHint(candidate, { probeImpl: async (url, referer, timeoutMs) => {
    calls++;
    assert.equal(url.toString(), high);
    assert.equal(referer.toString(), page);
    assert.ok(timeoutMs > 0 && timeoutMs <= 8000);
    return { status: 206, type: 'video/mp4' };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { playable: true, mediaUrl: high });
});

test('hints are a fallback only after normal resolution fails without a quality decision', () => {
  assert.equal(shouldTrySourceMediaHints({ videoUrls: ['https://cdn.example/1080.mp4'] }, null), false);
  assert.equal(shouldTrySourceMediaHints(null, Object.assign(new Error('challenge'), { code: 'page_challenge' })), true);
  assert.equal(shouldTrySourceMediaHints({ videoUrls: [] }, null), true);
  assert.equal(shouldTrySourceMediaHints(null, Object.assign(new Error('quality'), { code: 'quality_unverified' })), false);
});

test('a bound 4K alternative upgrades a known 1440p desktop result', () => {
  const hints = normalizeSourceMediaHints(page, [hint()], 10);
  const result = planSourceMediaHints({videoUrls:[high.replace('3840_2160','2560_1440')], durationSeconds:10}, null, hints);
  assert.equal(result.mode, 'upgrade');
  assert.deepEqual(result.candidates.map(item=>item.url), [high]);
});

test('lower or equal browser rendition never replaces a better PC result', () => {
  const small = normalizeSourceMediaHints(page, [hint(low,{width:640,height:360})], 10);
  const same = normalizeSourceMediaHints(page, [hint()], 10);
  for (const hints of [small,same]) {
    assert.deepEqual(planSourceMediaHints({videoUrls:[high]},null,hints),{mode:'none',candidates:[]});
  }
});

test('unmeasured and adaptive desktop sources are not presumed lower quality', () => {
  const hints=normalizeSourceMediaHints(page,[hint()],10);
  for(const value of ['https://videos.pexels.com/8379044/opaque.mp4',
    'https://videos.pexels.com/8379044/master.m3u8',
    'https://videos.pexels.com/8379044/1280_720.m3u8']) {
    assert.equal(planSourceMediaHints({videoUrls:[value]},null,hints).mode,'none');
  }
});

test('identity/quality rejection is final and duration conflict cannot upgrade', () => {
  const hints=normalizeSourceMediaHints(page,[hint()],10);
  for(const code of ['quality_unverified','identity_unverified'])
    assert.equal(planSourceMediaHints(null,{code},hints).mode,'none');
  assert.equal(planSourceMediaHints({videoUrls:[low],durationSeconds:100},null,hints).mode,'none');
});

test('fallback retains only the highest hint instead of adding lower renditions', () => {
  const hints=normalizeSourceMediaHints(page,[hint(low,{width:640,height:360}),hint()],10);
  const result=planSourceMediaHints(null,{code:'page_challenge'},hints);
  assert.equal(result.mode,'fallback');assert.deepEqual(result.candidates.map(item=>item.url),[high]);
});

test('a bounded hint probe does not follow even a same-URL redirect', async () => {
  const [candidate] = normalizeSourceMediaHints(page, [hint()], 10);
  let calls = 0;
  const started = performance.now();
  const result = await verifySourceMediaHint(candidate, { timeoutMs: 35, probeImpl: async () => {
    calls++;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 302, location: high, type: '' };
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    return { status: 206, type: 'video/mp4' };
  } });
  assert.deepEqual(result, { playable: false });
  assert.equal(calls, 1);
  assert.ok(performance.now() - started < 250);
});

test('same-asset lower and opaque redirected renditions cannot inherit advertised quality', async () => {
  const [candidate] = normalizeSourceMediaHints(page, [hint()], 10);
  for (const location of [low, high+'?quality=360',
    'https://videos.pexels.com/video-files/8379044/8379044.mp4']) {
    let calls=0;
    const result=await verifySourceMediaHint(candidate,{probeImpl:async()=>{
      calls++;
      return calls===1?{status:302,location,type:''}:{status:206,type:'video/mp4'};
    }});
    assert.deepEqual(result,{playable:false});
    assert.equal(calls,1);
  }
});

test('DNS resolution is inside the same probe deadline', async () => {
  const started = performance.now();
  const result = await secureRangeProbe(new URL(high), new URL(page), 25,
    { lookupImpl: () => new Promise(() => {}) });
  assert.equal(result, null);
  assert.ok(performance.now() - started < 250);
});

test('cancellation stops a pending hint and is forwarded to its network probe', async () => {
  const [candidate]=normalizeSourceMediaHints(page,[hint()],10);
  const controller=new AbortController();let observed;
  const pending=verifySourceMediaHint(candidate,{signal:controller.signal,probeImpl:(_media,_page,_timeout,options)=>{
    observed=options.signal;return new Promise(()=>{});
  }});
  controller.abort();
  assert.deepEqual(await pending,{playable:false});
  assert.equal(observed,controller.signal);
  let calls=0;
  assert.deepEqual(await verifySourceMediaHint(candidate,{signal:controller.signal,probeImpl:()=>{calls++;}}),{playable:false});
  assert.equal(calls,0);
});

test('cancellation during DNS cannot begin an HTTP request later', async () => {
  const controller=new AbortController();let finishDns;
  const pending=secureRangeProbe(new URL(high),new URL(page),8000,{signal:controller.signal,
    lookupImpl:()=>new Promise(resolve=>{finishDns=resolve;})});
  controller.abort();
  assert.equal(await pending,null);
  finishDns([{address:'8.8.8.8',family:4}]);
});

test('a private address in any DNS answer prevents a media request', async () => {
  const result = await secureRangeProbe(new URL(high), new URL(page), 25,
    { lookupImpl: async () => [{ address: '8.8.8.8', family: 4 },
      { address: '192.88.99.1', family: 4 }] });
  assert.equal(result, null);
});

test('rejects challenge pages and private or unrelated redirects', async () => {
  const [candidate] = normalizeSourceMediaHints(page, [hint()], 10);
  const challenge = await verifySourceMediaHint(candidate, { probeImpl: async () =>
    ({ status: 403, type: 'text/html' }) });
  assert.deepEqual(challenge, { playable: false });
  for (const destination of ['https://127.0.0.1/video/8379044.mp4',
    'https://videos.other.org/video/8379044.mp4',
    'https://videos.pexels.com/video-files/8379045/8379045.mp4']) {
    let calls = 0;
    const result = await verifySourceMediaHint(candidate, { probeImpl: async () => {
      calls++;
      return { status: 302, location: destination, type: '' };
    } });
    assert.deepEqual(result, { playable: false });
    assert.equal(calls, 1);
  }
});
