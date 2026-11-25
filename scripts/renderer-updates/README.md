# HyperSwap Adapt renderer update

The desktop renderer lives under the local Pong installation. Its source tree and model weights are outside this Git repository. The adjacent patch updates the existing renderer in place. From the Pong installation root, check and apply it with:

    git apply --check scripts/renderer-updates/adapt-hyperswap.patch
    git apply scripts/renderer-updates/adapt-hyperswap.patch

Run the regression checks with the renderer Python environment:

    & ".\Pong Swap\runtime\venv\Scripts\python.exe" scripts/renderer-updates/test_adapt_hyperswap.py

Reload the renderer when idle. Both Adapt session profiles select HyperSwap1C and retain the original swapper for sessions with Adapt off. Regular GPEN Adapt now uses the resident restoration ladder. The multi-face controller includes time waiting for the GPU in its quality decisions. Both restoration controllers estimate near-term headroom from recent playback feedback. Paused, stale and prefetched playback supplies no buffer forecast.
