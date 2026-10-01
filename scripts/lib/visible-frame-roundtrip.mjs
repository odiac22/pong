export const MAX_RGB_BYTES = 16 * 1024 * 1024;

export function frameByteLengths(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 16 || height < 16 || width > 4096 || height > 4096) {
    throw Error('invalid source dimensions');
  }
  const rgb = width * height * 3;
  if (rgb > MAX_RGB_BYTES) throw Error('full-resolution frame exceeds remote API limit');
  return {rgba: width * height * 4, rgb};
}

export function rgbaToRgb(rgba, width, height) {
  const lengths = frameByteLengths(width, height);
  if (!(rgba instanceof Uint8Array) || rgba.byteLength !== lengths.rgba) {
    throw Error('RGBA frame has wrong shape');
  }
  const rgb = Buffer.allocUnsafe(lengths.rgb);
  for (let src = 0, dst = 0; src < rgba.byteLength; src += 4) {
    rgb[dst++] = rgba[src];
    rgb[dst++] = rgba[src + 1];
    rgb[dst++] = rgba[src + 2];
  }
  return rgb;
}

export function decodeCapturedRgba(base64, width, height) {
  const {rgba} = frameByteLengths(width, height);
  if (typeof base64 !== 'string' || base64.length !== 4 * Math.ceil(rgba / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw Error('invalid captured RGBA transport');
  }
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.byteLength !== rgba) throw Error('captured RGBA has wrong shape');
  return decoded;
}

export function decodeCapturedChunk(base64, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 96 * 1024 ||
      typeof base64 !== 'string' ||
      base64.length !== 4 * Math.ceil(expectedBytes / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw Error('invalid captured chunk transport');
  }
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.byteLength !== expectedBytes) throw Error('captured chunk has wrong shape');
  return decoded;
}

export function validateCreatedSession(created, faceId, width, height,
                                       restorationProfile = 'default') {
  const session = created?.session;
  if (created?.ok !== true || typeof session?.id !== 'string' ||
      !/^[A-Za-z0-9_-]{20,80}$/.test(session.id) ||
      session.faceId !== faceId || session.width !== width || session.height !== height ||
      (session.restorationProfile == null
        ? restorationProfile !== 'default'
        : session.restorationProfile !== restorationProfile)) {
    throw Error('remote API did not return the requested owned session');
  }
  return session.id;
}

export function validateOwnedResponse(headers, body, sequence, width, height) {
  const {rgb} = frameByteLengths(width, height);
  if (!(body instanceof Uint8Array) || body.byteLength !== rgb) {
    throw Error('rendered RGB has wrong shape');
  }
  if (headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
      'application/octet-stream') throw Error('unexpected rendered content type');
  if (headers.get('x-pong-remote-seq') !== String(sequence)) {
    throw Error('rendered frame belongs to a different sequence');
  }
  const transformed = headers.get('x-pong-remote-transformed');
  if (transformed !== '0' && transformed !== '1') {
    throw Error('missing transformed status');
  }
  const renderMs = Number(headers.get('x-pong-remote-render-ms'));
  if (!Number.isFinite(renderMs) || renderMs < 0) throw Error('invalid render time');
  return {transformed: transformed === '1', renderMs};
}

// Whitelist numeric/model evidence only; never persist arbitrary service fields.
export function ownedRestorationEvidence(status, sessionId, faceId, width, height, profile) {
  validateCreatedSession(status, faceId, width, height, profile);
  const s = status.session;
  if (s.id !== sessionId || s.lastSequence !== 1 || s.frames !== 1 || s.closed !== false) {
    throw Error('restoration evidence is not from the submitted owned frame');
  }
  const a = s.adaptiveRestoration || {};
  const number = key => Number.isFinite(a[key]) && a[key] >= 0 ? a[key] : null;
  const allowed = new Set(['GPEN256', 'GPEN512', 'GPEN1024']);
  return {
    transformedFrames: s.transformedFrames,
    requiredModels: (s.restorerModels || []).filter(v => allowed.has(v)),
    actualModel: allowed.has(a.model) ? a.model : null,
    sourceFaceCropPixels: number('sourceFaceCropPixels'),
    gpen512Frames: number('GPEN512Frames'), gpen1024Frames: number('GPEN1024Frames'),
  };
}
