# Live Pong 1 observations — September 29, 2026

Physical phone, wireless ADB/CDP, silent tests. No quality settings changed.

## Reproduced before correction

- Independent 120-second run: ten injected swipes remained on card 4.
- Scroll tracing showed the next card initially selected geometrically, followed by a return to the prior scroll position within 200–500 ms. The old video's playback restarted at zero.
- The navigation function returned true despite the later snap-back. The earlier brief passing test did not cover this state.
- Blurring the old focused card did not resolve the failure.
- Screenshot showed Pong's Buffering 0% overlay on top of TikTok.
- The upper Swap ready panel had independent readiness logic; the earlier small-button correction did not cover it.

## Corrections installed/applied

- Swipes invoke TikTok's actual feed-navigation-next/previous control when available, preserving its state transition rather than only scrolling its DOM.
- Disabled navigation does not report success. Scroll-only fallback remains for layouts without those controls and is not proven reliable there.
- Fixed a startup null-reference introduced by the earlier mode-restoration change: restoration now waits for Pong WebView availability.
- Upper ready panel now also requires transformed-frame evidence tied to the current presented session. This evidence is session-level, not proof every visible frame contains a swapped face.

## Full post-install retest

- 120,883 ms; ten independent injected swipes.
- Eleven distinct cards, ten card changes, all in forward sequence.
- Zero original-video readyState<2 samples (approximately one-second sampling; this does not prove zero dropped frames or subsecond stalls).
- TikTok stayed available during this run; restart restored TikTok mode after the startup correction.
- Nineteen existing/added regression tests passed before the final upper-panel evidence gate was applied live.

## Remaining observed issues, not claimed fixed

- Some swapped layers stayed hidden while the original played for several seconds; one became visible only after the original looped (roughly ten seconds).
- Two cards had swapped media readyState 0 through much of their dwell interval.
- Occasional overlay timing offsets and a readyState dip at a loop boundary were observed.
- The upper panel correction was applied live after the two-minute playback run, without a reload. Further continuous visibility validation is still needed.
- Source titles, account identifiers, URLs, and authentication data are intentionally omitted.
