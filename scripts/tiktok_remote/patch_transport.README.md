# Default-off lossless patch transport experiment

This is CPU-only code; nothing imports it from the Android app, sidecar,
renderer, or UI. It does not activate a swap or change model quality.

Existing contract: the authenticated Pong Swap raw session accepts tightly
bounded RGB crop bytes at `PUT /remote-sessions/{id}/frame?seq=&timestampMs=`
and returns an exact same-size RGB crop with sequence/transformed/reset
headers. The current sidecar composites that crop into a complete frame and
encodes a video stream. A future *separately approved* adapter could compute
this patch from the returned crop versus the exact crop sent to the renderer.

The packet carries a 16-byte session nonce, scene epoch, sequence, exact
IEEE-754 media-time bits from PVFA's source header, shape, source SHA-256 and
result SHA-256. It chooses unchanged, changed-pixel horizontal runs, raw
rectangle, losslessly deflated rectangle, or exact full-crop fallback according
to packet size. The receiver reconstructs only against a retained byte-for-byte
copy of the source crop. One request can be in flight and one newer frame can
replace the pending frame. An older result is discarded if a newer frame was
captured. Navigation, ROI/face change, pause, or source replacement must bump
the scene epoch, cancel the old raw session, and clear transient pixels.

Integration constraints:

- The local source hash cannot be recomputed from a separately decoded video
  frame: color conversion, scaler, and timing can differ. Hash the **same
  bytes** delivered to the PC and retain them until the response resolves.
- The ROI position and display transform must be bound to the session/epoch.
  Shape alone cannot distinguish equal-sized ROIs. A local painter must use
  the original video's exact object-fit geometry and recheck current
  session/epoch/sequence/PTS immediately before every paint; it must clear a
  patch as soon as the underlying video advances. A returned old patch is not
  permission to hold old face pixels over a newer source frame.
- Keep renderer bearer credentials in the native/PC bridge. The TikTok page
  must never receive them. Keep the fixed loopback endpoint, one-in-flight
  bounds, exact approved-face session, and existing GPEN restoration config.
- Patch transport removes full-frame *return video encoding/decoding* only.
  It does not remove visible-frame capture, source upload, the full-resolution
  renderer work, GPU upload for a canvas overlay, or UI compositor jank. Thus
  it cannot yet establish sustained 30 FPS or visual alignment.

Synthetic 720×1280 RGB frame, changed 220×340 face ROI (no live pixels): full
crop 2,764,800 bytes; changed runs 227,232; raw rectangle 224,520; deflated
smooth rectangle 8,735; textured rectangle deflate 224,594, so raw rectangle
wins at 224,520. In one local CPU run, encode including both SHA-256 hashes
was 7.8–12.6 ms median; decode including hashes 2.9–3.1 ms; two hashes alone
about 2.25 ms. These figures are environment- and synthetic-pattern-specific,
not network, Android, GPU, or presentation benchmarks.
