# Offline Pong 2 FrameTimeline diagnostic

This is **not yet a physical-display FPS qualification**. Android 12+ FrameTimeline
can associate a Pong 2 app-surface frame with a SurfaceFlinger display frame by
`display_frame_token`; the matched SurfaceFlinger slice end is the presentation
timestamp. It does not prove changed video pixels on every refresh, and Android's
FrameTimeline documentation explicitly excludes some SurfaceView content.

`tiktok-frame-timeline.pbtxt` is a proposed, bounded metadata-only Perfetto
capture configuration. It enables FrameTimeline and process identity only: no
screen captures, media buffers, audio, logcat, or account contents. No capture
should be started during another benchmark. Device/version support and layer
coverage must first be checked on an authorized test run.

After an authorized trace exists, the official `trace_processor query -f` can
run `tiktok-frame-timeline.sql` against it and emit numeric CSV. The query
restricts frames to the exact Pong 2 process/layer and joins only matched
SurfaceFlinger display tokens. The offline parser accepts that CSV:

```
node scripts/summarize-tiktok-frame-timeline.mjs --csv numeric-frames.csv --windows trace-clock-windows.json --expected-windows 40
```

The windows file must be `{ "clock": "perfetto-trace-ns", "windows":
[{ "startNs": "...", "endNs": "..." }] }`, in ordered, non-overlapping
Perfetto nanoseconds. Host wall-clock timestamps are deliberately rejected;
the 40 clip boundaries need reliable trace-clock markers before per-clip
metrics can be claimed. Without that file, the parser returns discovery-only
counts, never an FPS claim. Output reports app-associated display updates,
per-window update rate and gaps, and app/SurfaceFlinger jank flags. An apparent
low app rate may simply mean a still photo or 30 FPS video, not UI jank.
