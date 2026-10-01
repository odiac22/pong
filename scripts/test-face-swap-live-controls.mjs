import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, service, engine, config] = await Promise.all([
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('Pong Swap/pong_swap_service.py', root), 'utf8'),
  readFile(new URL('Pong Swap/pong_swap_engine.py', root), 'utf8'),
  readFile(new URL('Pong Swap/pong_swap_config.py', root), 'utf8'),
]);

test('approved faces require a three-second hold before permanent deletion', () => {
  assert.match(html, /function attachPongFacePermanentDeleteHold\b/);
  assert.match(html, /setTimeout\(async \(\) => \{[\s\S]*?deletePongFaceSwapFace\(face\)[\s\S]*?\}, 3000\)/);
  assert.match(html, /setPointerCapture\(event\.pointerId\)/);
  assert.match(html, /addEventListener\('lostpointercapture', cancel\)/);
  assert.match(html, /addEventListener\('click', cancel, \{ capture: true \}\)/);
  assert.match(html, /\/pong-swap\/faces\/\$\{encodeURIComponent\(face\.id\)\}[\s\S]*?method:\s*'DELETE'/);
  assert.match(service, /@app\.delete\("\/faces\/\{face_id\}"\)/);
  assert.match(engine, /def delete_face\(self, face_id: str\)/);
  assert.match(engine, /resolved\.is_relative_to\(root\)/);
});

test('Pong contains a movable compact schema-driven live settings panel', () => {
  assert.match(html, /id="pong-face-swap-settings-panel"/);
  assert.match(html, /width:\s*min\(246px,\s*calc\(100vw - 12px\)\)/);
  assert.match(html, /function initializePongFaceSwapSettingsPanel\b/);
  assert.match(html, /setPointerCapture/);
  assert.match(html, /settingsSchema/);
  assert.match(html, /schedulePongFaceSwapSettingsPreview/);
  assert.match(html, /\/pong-swap\/settings\/preview/);
  assert.match(service, /@app\.put\("\/settings\/preview"\)/);
  assert.match(engine, /persist:\s*bool\s*=\s*True/);
});

test('Send commits a baseline and creates a timestamped prior-baseline backup', () => {
  assert.match(html, /id="pong-face-swap-settings-send"/);
  assert.match(html, /function commitPongFaceSwapSettingsBaseline\b/);
  assert.match(service, /ENGINE\.update_config\(payload, persist=True, backup=True\)/);
  assert.match(config, /PRESET_HISTORY_DIR/);
  assert.match(config, /strftime\("%Y%m%dT%H%M%S\.%fZ"\)/);
  assert.match(config, /shutil\.copy2\(CURRENT_PRESET, backup_path\)/);
});

test('Reset applies the saved baseline as a preview without persisting it', () => {
  assert.match(html, /id="pong-face-swap-settings-reset"/);
  assert.match(html, /function resetPongFaceSwapSettingsToBaseline\b/);
  assert.match(
    html,
    /resetPongFaceSwapSettingsToBaseline\(\)[\s\S]*?settings\s*=\s*clonePongFaceSwapConfig\(pongFaceSwapState\.settingsBaseline\)[\s\S]*?schedulePongFaceSwapSettingsPreview\(0\)/,
  );
  const start = html.indexOf('function resetPongFaceSwapSettingsToBaseline(');
  const resetSource = html.slice(start, html.indexOf('\nfunction initializePongFaceSwapSettingsPanel(', start));
  assert.doesNotMatch(resetSource, /\/pong-swap\/settings['"`]|persist:\s*true|commitPongFaceSwapSettingsBaseline\s*\(/);
  assert.match(html, /pong-face-swap-settings-send[\s\S]*?commitPongFaceSwapSettingsBaseline\(\)/);
});

test('Default applies original factory settings as a preview without replacing the baseline', () => {
  assert.match(html, /id="pong-face-swap-settings-default"[^>]*>Default<\/button>/);
  assert.match(service, /"defaultConfig":\s*default_config\(\)/);
  assert.match(html, /settingsDefault:\s*null/);
  assert.match(html, /payload\.defaultConfig\s*\|\|\s*payload\.baselineConfig/);
  const start = html.indexOf('function defaultPongFaceSwapSettingsForPreview(');
  assert.ok(start >= 0);
  const defaultSource = html.slice(start, html.indexOf('\nfunction initializePongFaceSwapSettingsPanel(', start));
  assert.match(defaultSource, /selectivePongFaceSwapDefaultConfig\([\s\S]*?settingsBaseline[\s\S]*?settingsDefault[\s\S]*?settingsSchema/);
  assert.match(defaultSource, /schedulePongFaceSwapSettingsPreview\(0\)/);
  assert.doesNotMatch(defaultSource, /\/pong-swap\/settings['"`]|persist:\s*true|commitPongFaceSwapSettingsBaseline\s*\(/);
  assert.match(html, /PONG_FACE_SWAP_SELECTIVE_DEFAULT_PARAMETERS\s*=\s*new Set\(\[[\s\S]*?'RestorerSwitch'[\s\S]*?'RestorerTypeTextSel'[\s\S]*?'RestorerSlider'/);
  assert.match(html, /PONG_FACE_SWAP_SELECTIVE_DEFAULT_PARAMETERS\s*=\s*new Set\(\[[\s\S]*?'StrengthSwitch'[\s\S]*?'StrengthSlider'[\s\S]*?'LikenessSlider'[\s\S]*?'EmbExtrapSlider'[\s\S]*?'ThresholdSlider'[\s\S]*?'DetectScoreSlider'/);
  assert.match(html, /pongFaceSwapSettingGroup\(name\)\s*===\s*'Mask, edges & occlusion'/);
  assert.match(config, /"RestorerTypeTextSel"\s*:\s*"GPEN512"/,
    'the Default preview must retain GPEN512 as its selected restorer option');
  const cloneStart = html.indexOf('function clonePongFaceSwapConfig(');
  const cloneSource = html.slice(cloneStart, html.indexOf('\nfunction pongFaceSwapRuntimeControlSpec(', cloneStart));
  assert.match(cloneSource, /value\s*\?\?\s*\{\}/);
  assert.doesNotMatch(cloneSource, /value\s*\|\|\s*\{\}/);
  assert.doesNotMatch(
    html.slice(html.indexOf('const PONG_FACE_SWAP_SELECTIVE_DEFAULT_PARAMETERS'), html.indexOf('function defaultPongFaceSwapSettingsForPreview(')),
    /'RestorerDetTypeTextSel'|'DetectTypeTextSel'|'DetectInputSizeTextSel'|'FindSimilarThresholdSlider'/,
  );

  const groupStart = html.indexOf('function pongFaceSwapSettingGroup(');
  const groupSource = html.slice(groupStart, html.indexOf('\nfunction setPongFaceSwapSettingsStatus(', groupStart));
  const selectiveStart = html.indexOf('const PONG_FACE_SWAP_SELECTIVE_DEFAULT_PARAMETERS');
  const selectiveSource = html.slice(selectiveStart, html.indexOf('\nfunction defaultPongFaceSwapSettingsForPreview(', selectiveStart));
  const applySelectiveDefaults = new Function(
    `${cloneSource}\n${groupSource}\n${selectiveSource}\nreturn selectivePongFaceSwapDefaultConfig;`,
  )();
  const baseline = {
    runtime: { encoderCq: 18 },
    parameters: {
      RestorerSwitch: true, DiffSlider: 42, DetectScoreSlider: 56,
      DetectTypeTextSel: 'Retinaface', ColorRedSlider: 17,
    },
  };
  const defaults = {
    runtime: { encoderCq: 23 },
    parameters: {
      RestorerSwitch: false, DiffSlider: 0, DetectScoreSlider: 45,
      DetectTypeTextSel: 'SCRDF', ColorRedSlider: 0,
    },
  };
  const selected = applySelectiveDefaults(baseline, defaults, [
    { name: 'DiffSlider' }, { name: 'ColorRedSlider' }, { name: 'DetectTypeTextSel' },
  ]);
  assert.equal(selected.parameters.RestorerSwitch, false);
  assert.equal(selected.parameters.DiffSlider, 0, 'numeric zero must remain a number, not become an object');
  assert.equal(typeof selected.parameters.DiffSlider, 'number');
  assert.equal(selected.parameters.DetectScoreSlider, 45);
  assert.equal(selected.parameters.DetectTypeTextSel, 'Retinaface');
  assert.equal(selected.parameters.ColorRedSlider, 17);
  assert.equal(selected.runtime.encoderCq, 18);
  assert.deepEqual(baseline.parameters, {
    RestorerSwitch: true, DiffSlider: 42, DetectScoreSlider: 56,
    DetectTypeTextSel: 'Retinaface', ColorRedSlider: 17,
  });
});

test('live edits hold the exact paused frame and replace the swap in place', () => {
  assert.match(html, /function capturePongFaceSwapSettingsFrame\b/);
  assert.match(html, /__pongSwapPresentedMediaTime/);
  assert.match(html, /createPongFaceSwapTransitionOverlay\([\s\S]*?freezeFrameOnly:\s*true/);
  assert.match(html, /sessionFaceId\s*=\s*setPongFaceSwapSelection\([\s\S]*?startPongFaceSwap\(sessionFaceId,\s*\{[\s\S]*?startSeconds:\s*frame\.startSeconds/);
  assert.match(html, /forcePlaying:\s*frame\.wasPlaying/);
  assert.match(html, /preserveCurrentUntilActivation:\s*!result\.lifecycleRestart/);
  assert.match(html, /preserveTransitionOverlay:\s*wrapper\s*===\s*snapshot\?\.wrapper/);
  assert.match(html, /detachMedia:\s*wrapper\s*!==\s*snapshot\?\.wrapper/);
  assert.match(html, /Live preview applied · exact frame held/);
  assert.match(html, /wrapper\.dataset\.playIntent === 'true' \|\| \(!video\.paused && !video\.ended\)/);
  assert.match(html, /if \(frame\.wasPlaying && frame\.wrapper\?\.isConnected\)[\s\S]*?playVideoCleanly\(resumedVideo\)/);
});

test('Face Match Strictness tightens identity and female-male presentation gates', () => {
  assert.match(config, /label="Face Match Strictness"/);
  assert.match(config, /Higher values require closer facial[\s\S]*?central-face appearance[\s\S]*?female\/male visual-presentation evidence/);
  assert.match(engine, /presentation_confidence_for_strictness\(\s*minimum_similarity\s*\)/);
  assert.match(engine, /minimum_presentation_confidence=minimum_presentation_confidence/);
});

test('rapid live edits coalesce to the latest value without exposing an undecoded frame', () => {
  assert.match(html, /settingsApplyPending:\s*null/);
  assert.match(html, /async function drainPongFaceSwapSettingsPreview\b/);
  assert.match(html, /pongFaceSwapState\.settingsApplyPending\s*=\s*\{\s*config:\s*snapshot,\s*generation\s*\}/);
  assert.match(html, /A newer slider value arrived while the server accepted this one/);
  assert.match(html, /wrapper\.__pongFaceSwapSettingsHoldActive\s*!==\s*true[\s\S]*?clearPongFaceSwapTransitionOverlay\(wrapper\)/);
  assert.match(html, /waitForPongFaceSwapPresentedFrame\(frame\.wrapper,\s*replacementGeneration\)/);
  assert.doesNotMatch(html, /Could not render the updated setting on the held frame/);
});

test('each rendered still replaces the decoded image node for Android WebView repaint', () => {
  assert.match(html, /const previousImage = editor\.image/);
  assert.match(html, /const nextImage = document\.createElement\('img'\)/);
  assert.match(html, /previousImage\.replaceWith\(nextImage\)/);
  assert.match(html, /editor\.image = nextImage/);
  assert.match(html, /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/);
  assert.match(html, /Picture updated · \$\{swapper\} \+ \$\{restorer\}/);
});

test('late encoder status cannot repaint a retired face-swap session', () => {
  assert.match(html, /function monitorPongFaceSwapEncoding[\s\S]*?const stillOwnsSession = \(\) => Boolean/);
  assert.match(
    html,
    /await pongFaceSwapBackgroundFetch[\s\S]*?if \(!stillOwnsSession\(\)\) \{[\s\S]*?hidePongFaceSwapLoading\(generation\)/
  );
});

test('controls edit a zoomable cached still and close back to video before rebuilding', () => {
  assert.match(html, /className = 'pong-swap-frame-editor'/);
  assert.match(html, /function createPongFaceSwapFrameEditor\b/);
  assert.match(html, /setPongFaceSwapFrameEditorZoom\(editor,[\s\S]*?Math\.min\(8/);
  assert.match(html, /root\.addEventListener\('wheel'/);
  assert.match(html, /type:\s*'pinch'/);
  assert.match(html, /root\.style\.width = `\$\{rect\.width\}px`/);
  assert.match(html, /\/pong-swap\/frame-previews/);
  assert.match(html, /dataUrl = editor\.canvas\.toDataURL\('image\/jpeg', 0\.94\)/);
  assert.match(html, /id="pong-face-swap-settings-faces"/);
  assert.match(html, /id="pong-face-swap-settings-view-controls"/);
  assert.match(html, /id="pong-face-swap-settings-face-button"/);
  assert.match(html, /id="pong-face-swap-settings-original"/);
  assert.match(html, /id="pong-face-swap-settings-video"/);
  assert.match(html, /function setPongFaceSwapFrameEditorView\b/);
  assert.match(html, /function capturePongFaceSwapOriginalFrame\b/);
  assert.match(html, /function stopPongFaceSwapSettingsPauseGuard\b/);
  assert.match(html, /video\.addEventListener\('play', enforcePause\)/);
  assert.match(html, /function renderPongFaceSwapSettingsFaces\b/);
  assert.match(html, /editor\.frame\.faceId = face\.id/);
  assert.match(html, /putPongFaceSwapSettingsPreview\(config,[\s\S]*?stopPongFaceSwapForSettingsPreview\(editor\.frame\)/);
  assert.match(html, /config: appliedConfig,[\s\S]*faceId: requestedFaceId,[\s\S]*targetX: editor\.frame\.manualTarget\?\.x/);
  assert.match(html, /renderPongFaceSwapSettingsSnapshot\(job\.config, job\.generation\)/);
  assert.match(html, /closePongFaceSwapSettingsPanel\(\{\s*persist = false\s*\}/);
  assert.match(html, /Back to Video is a UI transition, not a GPU barrier/);
  assert.match(html, /releasePongFaceSwapSettingsFrame\(frame\.wrapper\)[\s\S]*?playVideoCleanly\(frame\.video\)/);
  assert.match(html, /await disposePongFaceSwapFrameEditor\(\)[\s\S]*?void \(async \(\) =>/);
  assert.match(html, /applyPongFaceSwapSettingsPreview\(snapshot, generation, frame\)/);
  assert.match(service, /@app\.post\("\/frame-previews"\)/);
  assert.match(service, /@app\.put\("\/frame-previews\/\{preview_id\}"\)/);
  assert.match(service, /@app\.get\("\/frame-previews\/\{preview_id\}\/original"\)/);
  assert.match(service, /@app\.get\("\/faces\/\{face_id\}\/source"\)/);
  assert.match(engine, /"sourceImageUrl": f"\/pong-swap\/faces\/\{face\.id\}\/source"/);
  assert.match(engine, /class FramePreview:/);
  assert.match(engine, /def frame_preview_original\b/);
  assert.match(engine, /def render_frame_preview\b/);
});

test('Face Detect exposes tappable boxes and carries the manual target into playback', () => {
  assert.match(html, /id = 'pong-face-detect-button'/);
  assert.match(html, /function openQuickPongFaceDetect\b/);
  assert.match(html, /function togglePongFaceSwapFaceDetect\b/);
  assert.match(html, /className = 'pong-swap-face-detect-box'/);
  assert.match(html, /pongFaceSwapState\.manualTargets\.set\(playable\.source, target\)/);
  assert.match(html, /editor\.frame\.wasPlaying = true/);
  assert.match(html, /closePongFaceSwapSettingsPanel\(\{ persist: false \}\)/);
  assert.match(html, /targetX: manualTarget\?\.x \?\? null/);
  assert.match(html, /targetY: manualTarget\?\.y \?\? null/);
  assert.match(html, /identityEmbedding: Array\.isArray\(face\.identityEmbedding\)/);
  assert.match(html, /targetEmbedding: manualTarget\?\.identityEmbedding \|\| \[\]/);
  assert.match(service, /@app\.get\("\/frame-previews\/\{preview_id\}\/faces"\)/);
  assert.match(service, /manual_target_x=payload\.targetX/);
  assert.match(service, /manual_target_embedding=payload\.targetEmbedding/);
  assert.match(engine, /def frame_preview_faces\b/);
  // Fast geometry-only previews defer identity inference; the full/manual
  // selection path must still return its measured embedding unchanged.
  assert.match(engine, /"identityEmbedding": \[\] if preview\.geometry_only else identity_embedding\.tolist\(\)/);
  assert.match(engine, /target_identity_lock_threshold\(strictness\)/);
  assert.match(engine, /manual_target_point: tuple\[float, float\] \| None/);
});
