import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const service = await readFile(new URL('../Pong Swap/pong_swap_service.py', import.meta.url), 'utf8');
const engine = await readFile(new URL('../Pong Swap/pong_swap_engine.py', import.meta.url), 'utf8');
const config = await readFile(new URL('../Pong Swap/pong_swap_config.py', import.meta.url), 'utf8');

assert.match(source, /function normalizePongFaceSwapFaceIds\(values, maximum = 16\)/);
assert.match(source, /function pongFaceSwapSelectionKey[\s\S]*?\.join\(','\)/);
assert.match(source, /Multi face…/);
assert.match(source, /Use selected/);
assert.match(source, /faceIds:\s*normalizePongFaceSwapFaceIds\(faceId\)/g);
const seek = source.match(/async function preparePongFaceSwapSeek\([^]*?\n}/)[0];
assert.match(seek, /faceId: pongFaceSwapPrimaryFaceId\(faceId\)/);
assert.match(seek, /faceIds: normalizePongFaceSwapFaceIds\(faceId\)/);
assert.match(source, /setPongFaceSwapSelection\(\[\]\)/);
assert.match(service, /faceIds:\s*list\[str\][^\n]*max_length=MAX_MULTI_FACES/);
assert.match(source, /Number\(payload.multiFaceMax\) \|\| 5/);
assert.match(source, /pickerFaceIds.length > multiFaceMax/);
assert.match(engine, /multi_face_consensus.observe\(selection, float\(timeline_seconds\)\)/);
assert.match(engine, /100 if multi_face_consensus is not None/);
assert.match(service, /face_ids=payload\.faceIds/);
assert.match(engine, /choose_compatible_identity\([\s\S]*?minimum_similarity=minimum_similarity/);
assert.match(engine, /session\.selected_face_id = selection\.candidate\.face_id/);
assert.match(engine, /session\.compatibility_status = "no-compatible-face"/);
assert.match(engine, /INTERNAL_FACE_DETECT_SCORE = 0\.45/);
assert.match(engine, /compatible_identity_rankings\([\s\S]*?minimum_similarity=source_match_threshold/);
assert.match(engine, /reason="approved-source-switch"/);
assert.match(config, /"FaceLockSlider": 100/);
assert.match(config, /"label": "Face Lock Strictness"[\s\S]*?"min": 0,[\s\S]*?"max": 100,[\s\S]*?"step": 1/);
assert.match(config, /label="Face Match Strictness"[\s\S]*?min=0,[\s\S]*?max=100,[\s\S]*?step=1/);

const inlineScripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]);
inlineScripts.forEach((script, index) => {
  new vm.Script(script, { filename: `index.html:inline-${index + 1}` });
});

console.log('face-swap multi-selection contract tests passed');
