"""Explicit disposable acquisition test service; never a production entrypoint.

The ordinary service first verifies its frozen renderer. This test then changes
only the two guarded acquisition/scheduling copies on the idle engine instance.
No source hashes, model bindings, saved settings, or renderer stages are edited.
"""

import argparse
from types import MethodType


def install(engine, app, *, hair_precheck=False):
    state = {"installed": False, "experimental": True,
             "scope": "tiktok-face-size", "hairPrecheck": bool(hair_precheck)}

    def startup():
        from experiment_tiktok_acquisition import install as install_trial
        binding = getattr(engine, "_pong_exact_bootstrap", None)
        if not binding or not binding[0].installed:
            raise RuntimeError("Acquisition trial requires the qualified frozen renderer")
        handle = install_trial(engine, qualified=True, hair_precheck=hair_precheck)
        original_health = engine.health

        def health(_engine, *args, **kwargs):
            result = original_health(*args, **kwargs)
            result["acquisitionTrial"] = dict(state)
            return result

        engine.health = MethodType(health, engine)
        engine._tiktok_acquisition_trial = handle
        state["installed"] = True

    app.router.add_event_handler("startup", startup)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hair-precheck", action="store_true")
    parser.add_argument("--port", type=int, default=8792)
    args = parser.parse_args()
    import pong_swap_service
    import uvicorn
    install(pong_swap_service.ENGINE, pong_swap_service.app,
            hair_precheck=args.hair_precheck)
    uvicorn.run(pong_swap_service.app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
