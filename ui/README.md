# Pong 30 UI

`pong-modern.css` and `pong-modern.js` are the maintained presentation sources.
Run `npm run build:ui` after changing either. It mechanically replaces only the
two marked inline blocks in `index.html`. Inline delivery intentionally keeps
Android refresh and the existing `/pong` server working without new asset routes,
server restarts, dependencies, or an APK. `npm run test:ui` checks synchronization.

Legacy handlers remain authoritative. Version 30.02 restores all existing controls
to their original parents and coordinates, with their original compact sizes.
There is no replacement dock, Tools drawer, or oversized header. The presentation
layer adds keyboard operation without relocating controls. The elapsed counter
fits within the original 30px progress strip. The extra bottom play button and
thumbnail control remain removed. Version 30.18 adds a full-player poster instead:
the first decoded frame and current paused frame are retained at native resolution.

The counter uses `pongFaceSwapProgressState` and existing seek ownership.
The capturePreview hook accepts only the current source/selected swap identity.
It also receives exact swapped seek images from the existing renderer. Cached
frames bridge source reloads, but never cross logical videos or selected faces.
There are at most three full-resolution canvases, no new media requests, no pixel
readback/serialization (cross-origin canvases remain displayable), and no per-frame
copy loop. Inaccessible media shows an honest loading/error placeholder until a
real frame is available; offscreen media retains the existing lazy network policy.

UI animations use short transform/opacity transitions and respect reduced motion.
Structural observers avoid per-frame subtree rescans. Listeners are cancelled on removal. The hidden Pong splash now stops its animation loop.

Tests:

```
npm run build:ui
npm run test:ui
node scripts/test-modern-ui-browser.mjs
```

The browser test requires the local Pong service and the specifically allowlisted
silent approved fixture server on port 18897. It uses a fresh incognito/headless,
muted browser and writes screenshots/reports to `E:/Pong Benchmarks/v3002-throughput/ui`.
It does not alter the user's active phone session or saved baseline settings.
