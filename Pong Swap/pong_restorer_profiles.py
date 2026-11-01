"""User-visible restoration presets and their existing model weights."""
FACE_FINISH_PRESETS=('GPEN257','GPEN357')
def physical_restorer(name):
    return 'GPEN256' if name in FACE_FINISH_PRESETS else name

def restorer_for_mode(name,three_x):
    # Only the paired custom preset changes with topology. Explicit standard
    # model selections must remain effective when multi-face mode is enabled.
    if three_x:return 'GPEN357' if name=='GPEN257' else name
    return 'GPEN257' if name=='GPEN357' else name

def finish_enabled(config):
    return bool(config.get('runtime',{}).get('approvedFaceFinishEnabled',False))
