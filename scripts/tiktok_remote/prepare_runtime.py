"""Create local pairing keys once, without logging or replacing existing keys.

Run explicitly during installation. This does not start any process, expose a
port, change presets, enter TikTok credentials, or weaken emulator authentication.
"""
import os
import secrets
from pathlib import Path


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name in ('tiktok-remote-pairing-token', 'remote-bridge-token'):
        path = directory/name
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if len(path.read_text(encoding='utf-8').strip()) < 32:
                raise ValueError('Existing '+name+' is invalid; it was not replaced')
        else:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(secrets.token_urlsafe(48))
    return {'ok': True, 'keys': 'present; values not logged'}


if __name__ == '__main__':
    import json
    root = Path(__file__).resolve().parents[2]
    print(json.dumps(prepare(root/'Pong Swap'/'cache')))
