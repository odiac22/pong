# Final Local validation — 2026-09-15

Pong version: 27.24

Both measurements used the real Pong UI button in a fresh, hidden, muted browser profile. A pass required five delivered artists, deterministic hard-text safety, and real playback time advancement for one distinct video from every artist.

| Flow | First artist | First playable | Five artists | Average | Playback matrix | Buffers |
|---|---:|---:|---:|---:|---:|---:|
| Local2 | 23.934 s | 25.576 s | 47.029 s | 9.406 s/artist | 53.749 s, 5/5 playable | 1 transient event |
| Local2.2 | 15.024 s | 16.609 s | 47.369 s | 9.474 s/artist | 50.734 s, 5/5 playable | 0 |

Both runs reported `hardSafe: true`, returned at least five accepted artists, and played five distinct source videos successfully.

Regression results:

- JavaScript: 87/87 passed.
- Python: 47/47 passed.
- Exact saved-history memory: 304/304 passed (179 accepts and 125 rejects).
- Protected ugly-reject cohort: 6/6 rejected.
- Explicit creator-label trans rejection remains enabled for Local2.

Final live services:

- Pong/API: port 8787.
- Preference AI: port 8791.
- Private headless source browser: port 18801.
- AI-worker idle shutdown: 15 minutes.

All disposable `pong-local2-pair-*` private benchmark profiles were removed after testing.
