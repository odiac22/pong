import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCapturedChunk, decodeCapturedRgba, frameByteLengths, rgbaToRgb,
  validateCreatedSession, validateOwnedResponse,
  ownedRestorationEvidence,
} from './lib/visible-frame-roundtrip.mjs';

test('RGBA conversion strips alpha without changing RGB pixels', () => {
  const rgba = Buffer.alloc(16 * 16 * 4);
  rgba.set([1, 2, 3, 0, 4, 5, 6, 255, 7, 8, 9, 17]);
  const rgb = rgbaToRgb(rgba, 16, 16);
  assert.deepEqual([...rgb.subarray(0, 9)], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(rgb.length, 16 * 16 * 3);
  assert.deepEqual(decodeCapturedRgba(rgba.toString('base64'), 16, 16), rgba);
});

test('full-resolution frame bounds reject malformed or oversized capture', () => {
  assert.deepEqual(frameByteLengths(720, 1280), {rgba: 3686400, rgb: 2764800});
  assert.throws(() => frameByteLengths(4096, 4096), /exceeds/);
  assert.throws(() => rgbaToRgb(Buffer.alloc(4), 16, 16), /wrong shape/);
  assert.throws(() => decodeCapturedRgba('not base64', 16, 16), /invalid/);
});

test('render ownership requires exact bytes, type, and sequence', () => {
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'x-pong-remote-seq': '1',
    'x-pong-remote-transformed': '1',
    'x-pong-remote-render-ms': '12.3',
  });
  const body = Buffer.alloc(16 * 16 * 3);
  assert.deepEqual(validateOwnedResponse(headers, body, 1, 16, 16),
    {transformed: true, renderMs: 12.3});
  assert.throws(() => validateOwnedResponse(headers, body, 2, 16, 16), /different sequence/);
  assert.throws(() => validateOwnedResponse(headers, body.subarray(1), 1, 16, 16), /wrong shape/);
});

test('created session ownership requires requested identity and dimensions', () => {
  const id = 'abcdefghijklmnopqrstuvwxyz123456';
  const created = {ok: true, session: {id, faceId: 'approved', width: 720, height: 1280}};
  assert.equal(validateCreatedSession(created, 'approved', 720, 1280), id);
  assert.throws(() => validateCreatedSession(created, 'other', 720, 1280), /requested owned session/);
  assert.throws(() => validateCreatedSession(created, 'approved', 360, 1280), /requested owned session/);
  assert.throws(() => validateCreatedSession(created, 'approved', 720, 1280,
    'tiktok-face-size'), /requested owned session/);
  created.session.restorationProfile = 'tiktok-face-size';
  assert.equal(validateCreatedSession(created, 'approved', 720, 1280,
    'tiktok-face-size'), id);
});

test('chunk decoder enforces bounded exact-length transport', () => {
  const chunk = Buffer.from([0, 1, 2, 253, 254, 255]);
  assert.deepEqual(decodeCapturedChunk(chunk.toString('base64'), chunk.length), chunk);
  assert.throws(() => decodeCapturedChunk(chunk.toString('base64'), 5), /wrong shape|invalid/);
  assert.throws(() => decodeCapturedChunk('not-base64', chunk.length), /invalid/);
  assert.throws(() => decodeCapturedChunk(chunk.toString('base64'), 96 * 1024 + 1), /invalid/);
});

test('restoration evidence is owned, sequence-specific and whitelisted', () => {
  const id='abcdefghijklmnopqrstuvwxyz123456';
  const status={ok:true,session:{id,faceId:'approved',width:720,height:1280,
    restorationProfile:'tiktok-face-size',lastSequence:1,frames:1,closed:false,
    transformedFrames:1,restorerModels:['GPEN512','GPEN1024','private-value'],
    adaptiveRestoration:{model:'GPEN512',sourceFaceCropPixels:300,GPEN512Frames:1,
      secret:'not copied'}}};
  const read=()=>ownedRestorationEvidence(status,id,'approved',720,1280,'tiktok-face-size');
  assert.deepEqual(read(),{transformedFrames:1,requiredModels:['GPEN512','GPEN1024'],
    actualModel:'GPEN512',sourceFaceCropPixels:300,gpen512Frames:1,gpen1024Frames:null});
  status.session.lastSequence=2;
  assert.throws(read,/submitted owned frame/);
});
