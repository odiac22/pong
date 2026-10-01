import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hostAvcDecoderMetadata} from './lib/tiktok-audit-device-metadata.mjs';

test('host AVC metadata uses launch property when runtime property is blank', () => {
  assert.equal(hostAvcDecoderMetadata('\n', '2\n'), '2');
  assert.equal(hostAvcDecoderMetadata('1\n', '2\n'), '1');
  assert.equal(hostAvcDecoderMetadata('0\n', '2\n'), '0');
  assert.equal(hostAvcDecoderMetadata('', ''), 'not enabled');
});

test('benchmark reads both device properties through the pure selector', () => {
  const source=readFileSync(new URL('./benchmark-tiktok-emulator.mjs',import.meta.url),'utf8');
  assert.match(source,/hostAvcDecoder:hostAvcDecoderMetadata\(/);
  assert.match(source,/getprop','qemu\.hwcodec\.avcdec'/);
  assert.match(source,/getprop','ro\.boot\.qemu\.hwcodec\.avcdec'/);
});
