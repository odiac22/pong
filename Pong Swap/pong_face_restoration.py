"""Owner-approved restoration strength, applied only to session/preview copies."""
import re


def apply_face_restoration(config, face_id):
    parameters = config.get('parameters', {})
    runtime = config.get('runtime', {})
    marker = '_faceRestorationBaseline'
    if re.fullmatch(r'approved-28-[a-f0-9]+', str(face_id or '')):
        if marker not in runtime:
            runtime[marker] = parameters.get('RestorerSlider', 100)
        parameters['RestorerSlider'] = 50
    elif marker in runtime:
        parameters['RestorerSlider'] = runtime.pop(marker)
    return config
