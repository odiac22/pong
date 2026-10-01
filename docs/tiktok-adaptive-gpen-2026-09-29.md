# TikTok-only size-adaptive GPEN

User choice: GPEN512 for small faces, GPEN1024 for large faces. Not a timed startup-quality downgrade.

Implemented a validated `restorationProfile` on foreground, seek and prefetch session requests. Default remains the saved preset. Each session gets a private configuration clone. Face size is estimated from source-frame eye spacing / 0.33; promotion to 1024 occurs at 512 source pixels, demotion below 448. Invalid geometry retains 1024. Video dimensions, restoration strength, masks and saved settings are unchanged. Temporal restoration signatures already include the model name.

Both graphs are warmed before frame processing. Initial live trials exposed a new regression: cleanup evicted 512 while a matching warm signature incorrectly claimed readiness. Fixed production residency retention, rechecked readiness on cached warm admission, and added a 60-second inter-swipe retention grace. No creation occurs inside the per-frame restoration check. Added model-selection diagnostics to session status.

Also tested a TikTok compositor change: no repeated seeks while a decoder seek is in flight, a 500ms interval between alignment seeks, and actual video-frame callback evidence before initial reveal. Stale callbacks cannot reveal a prior session. Already-swapped pixels remain during buffer recovery; future-offset loops remain hidden until aligned.

## Verification and limitations

- Python policy/regression suite: 31 passing tests (adaptive policy, actual residency method, hair, male-target and multi-face).
- JavaScript suite: 23 pre-existing/expanded TikTok tests plus 5 new frame-sync tests pass.
- Paired release APK build succeeded (29.04); no version bump was made by this task.
- Each renderer activation compared saved config before/after: unchanged.
- Live telemetry proved both 512 and 1024 used within one session (331 small-model calls, 8 large-model calls in one sampled session; another used predominantly 1024 at source crop ~1010px).
- Latest sampled warm session: first transformed frame ~80ms after session creation, first byte ~188ms. This is NOT swipe-to-visible latency.
- Last complete five-swipe run: measured current-session visible stream plus transformed-frame evidence at 9164ms, 3163ms, 8444ms, no qualifying new session within 12s, 7849ms. Sources differ from earlier tests, so these are not a controlled speedup claim. One no-result trial retained the prior session, indicating a navigation/handoff failure as well.
- No claim that every visible frame was transformed: backend counters are session-level evidence. First-visible sampling includes polling delay. Tests were muted.
- The under-one-second end-to-end target is **not met**. Remaining work includes source/prefetch ownership, late face acquisition, failed navigation and native handoff/catch-up timing. Do not label this a finished latency fix.

Raw last-run telemetry: `C:/Users/arian/Documents/New project/tiktok-adaptive-live-1790717702871.json`.

Pong 1 APK installed with `adb install -r`; app data retained and the existing selected-face list/enabled state restored from memory. Post-install status confirmed TikTok overlay active and `tiktok-face-size` session. A ~780px crop used GPEN1024 (244 transformed frames), with first transformed frame ~156ms after session creation. However, that session spent ~12.25s doing 244 frame work units (~20fps); the 30fps original outran its buffered swapped stream, which remained hidden. This is a remaining throughput failure, not fixed by fast first inference. GPEN512/1024 are both resident and health has no last error. No full latency/smoothness qualification is claimed.
