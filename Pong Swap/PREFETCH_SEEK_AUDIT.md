# Pong face-swap prefetch, Paperclip, and seek audit

Date: 2026-09-16

Scope: read-only audit of `index.html`, `pong_swap_service.py`, and
`pong_swap_engine.py`.  This note intentionally does not change the live
runtime while the baseline capture is in progress.

## Measured evidence

The partial real-Android baseline in
`logs/optimization-20260916/baseline-android-test1-2026-09-17T04-27-40-927Z/report.json`
is sufficient to isolate a client/server handoff cost:

| transition | prepared | pre-opened | visible swapped frame |
|---|---:|---:|---:|
| next video 1 | yes | yes | 1,925 ms |
| next video 2 | yes | yes | 2,742 ms |
| Paperclip | yes | yes | 7,533 ms |
| forward seek | no | no | 4,037 ms |

The current service telemetry also showed active sessions with three
`bytes=0-` stream requests, while speculative sessions each owned a media
request.  `stream_session()` always starts at spool offset zero, so these are
full restarts rather than resumptions.

## Root causes

### P0: "pre-opened" media is thrown away during adoption

`attachPongFaceSwapPrefetch()` binds the prepared session as
`stream?preload=1`.  That endpoint deliberately ends after the finite warm-up
fragment.  `startPongFaceSwap()` then activates the session, replaces
`video.src` with the same session's non-preload URL, and calls `video.load()`.
The WebView discards its decoded frame and buffered bytes and opens a new HTTP
request from byte zero.  The `preopened` data flag therefore describes a
session that was opened earlier, not a reader that is actually reused.

This explains why server preparation can precede a swipe by 12--20 seconds and
the user still waits 1.9--7.5 seconds after the swipe.

### P0: too many speculative media readers for Android WebView

The scheduler creates six next-card prefetches plus one Paperclip prefetch.
Every ready wrapper-backed entry is attached to a `<video>`.  On the direct LAN
path Pong is served by Node HTTP/1.1; Android/Chromium has a small per-origin
connection budget, and each open media response and status request consumes
that budget.  Even where HTTP/2 is present, several attached videos consume
decoder/demux resources.  Seven client attachments can delay the visible
reader despite the GPU having finished the swap.

Server-only GPU prefetches are cheap enough to retain.  Client media
attachments need a separate, much smaller budget.

### P0: seek is stop-first and cannot coalesce gestures

`seekPongVideoTo()` calls `startPongFaceSwap()`.  The latter destroys the
visible session before creating/preparing the replacement.  A seek therefore
turns a working stream into a cold stream and exposes the entire open, decode,
swap, encode, proxy, and WebView startup path.  The baseline measured 4,037 ms.

If a user scrubs while `pongFaceSwapBusy` is true, the request is simply
rejected.  The progress bar has already moved, so this looks like a reset or a
seek back to the old position.  Rapid scrub gestures are not coalesced.

### P1: Paperclip prediction and Paperclip navigation are separate algorithms

`getPongFaceSwapNextPaperclipSources()` selects best-loaded / next-active /
first-active.  `navigateToNextPasteEvent()` has additional Erome, paired
SimpCity/TikTok, and history behavior.  They can choose different events.  In
that case a valid prepared Paperclip session exists for the wrong artist and
the visible artist starts cold.

### P1: `mediaFragmentReady` means headers observed, not browser-decodable

The new engine correctly improves on the old `firstByteAt` test by requiring
`moof` and `mdat`, plus the requested frame count.  Observing the `mdat` header
does not by itself prove that the complete first media fragment is present.
With the current 0.35-second prebuffer and 0.15-second fragment target this will
usually be safe, but the browser's `loadeddata` event should remain the final
client-ready signal.  If prebuffer is reduced later, parse complete top-level
MP4 box lengths before declaring the spool fragment complete.

## Minimal patch plan

### 1. Add a bounded persistent-attachment stream mode

Decouple the two existing stream flags in `pong_swap_service.py`:

- `?preload=1`: keep the current finite diagnostic/server-preload response.
- `?attach=1`: `activate=False`, `finite_preload=False`; stream the prepared
  spool and then wait on the same response for activation.
- normal stream: `activate=True`, `finite_preload=False`.

Attach an eligible prefetch immediately after its session id exists with
`?attach=1`, not only after server `prepared=true`.  Record `entry.browserReady`
on `loadeddata`/`canplay`.  On adoption:

1. POST `/activate`.
2. Keep the existing `video.src` and existing reader.
3. Do **not** call `video.load()`.
4. Apply the saved audio/play intent and play the same element.

If the held reader errors or never reaches `loadeddata`, fall back once to the
current normal-stream reload path.

### 2. Split server prefetch count from attachment count

Keep up to six server-side session prefetches, but allow at most two held media
attachments in addition to the active video:

- one immediate next-video attachment;
- one exact next-Paperclip first-video attachment.

The other prepared entries remain server-only (`wrapper` may be known, but no
`video.src` is changed).  This prevents seven speculative media readers from
competing with the visible stream.  Start with a hard budget of two and tune
only from Android network/decoder evidence.

Track these independently:

- `entry.serverReady`
- `entry.attached`
- `entry.browserReady`
- `entry.adopted`

Do not overload one `ready` boolean for all four phases.

### 3. Use one Paperclip destination resolver

Extract the non-mutating destination choice from
`navigateToNextPasteEvent()` into `resolveNextPaperclipEventIndex()`.  Both
navigation and face-swap Paperclip prefetch must call it.  Include history,
paired TikTok, Erome mode, visited/retired state, and loaded-first behavior.

### 4. Make seek prepare-first and last-intent-wins

For an active swap:

1. Store a monotonically increasing seek generation and the latest requested
   absolute target.
2. Create a prefetch session at that target without stopping the visible
   session.
3. Wait for server `prepared` (and optionally a single held reader's
   `loadeddata`).
4. If a newer target exists, cancel the stale replacement.
5. Atomically adopt the latest replacement, then delete the old session.

While a swap is still becoming ready, retain the latest pending seek instead
of returning false; run it immediately after readiness.  Preserve the old
frame/progress display until the replacement is playable.  This does not make
MP4 source switching gapless, but it removes the expensive blank/cold interval
and prevents apparent reset-to-zero behavior.

### 5. Instrument the actual phases

Add timestamps to each entry/session and expose them in benchmark snapshots:

- session POST start/end
- server `preparedAt`
- attachment `loadstart`
- attachment `loadeddata`
- activation POST start/end
- first `playing`/`requestVideoFrameCallback`
- stream request count

The critical metric is swipe/seek action to the first rendered swapped frame,
not session creation to first byte.

## Exact verification

1. **Server held-reader lifecycle test**
   - create one prefetch;
   - open one `?attach=1` response;
   - wait for prepared bytes;
   - assert `streamRequests == 1` and `subscribers == 1`;
   - activate and verify bytes/frames continue on that response;
   - abort/delete and assert subscriber/resource cleanup.

2. **Desktop E2E preload adoption test**
   - instrument CDP `Network.requestWillBeSent`;
   - swipe across three videos;
   - assert each adopted held session has exactly one stream GET, no second
     `loadstart`, correct face, and correct source;
   - assert at most two non-active held attachments at every sample.

3. **Paperclip routing test**
   - exercise Erome, SimpCity/TikTok pair, history-forward, visited, and retired
     cases;
   - assert resolver output, prefetched source, and actual destination are the
     same event/global index;
   - assert Paperclip held session has one stream GET.

4. **Seek test**
   - forward, backward, and two rapid scrub targets;
   - assert the latest target wins, landing error <= 0.20 seconds;
   - assert progress never reports zero while replacement prepares;
   - assert old session remains usable until replacement is prepared and is
     then retired;
   - assert no unswapped frame becomes visible.

5. **Real Android benchmark**
   - run the exact three albums and Test 1 flow;
   - sample attachment count, stream requests, and first rendered swapped
     frame for every transition;
   - compare median and p90 with the baseline values above;
   - require no missing transitions and no >20-second timeout before evaluating
     the speed pass.

## Recommended implementation order

1. Persistent held reader + two-attachment budget.
2. Shared Paperclip destination resolver.
3. Prepare-first/coalesced seek.
4. Only then tune fragment/prebuffer duration; otherwise a smaller prebuffer
   merely makes a buffer that adoption still discards.

