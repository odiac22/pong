"""Reload rotated emulator credentials locally without changing source identity."""
from pathlib import Path


def read_discovery(path):
    path = Path(path)
    if path.stat().st_size > 65536:
        raise ValueError('Invalid emulator discovery file')
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)


class SourceDiscovery:
    def __init__(self, path, device):
        path = Path(path)
        initial = read_discovery(path)
        self.root = path.parent
        self.identity = tuple(initial.get(k, '') for k in ('avd.id', 'port.serial', 'grpc.port'))
        if (not all(self.identity) or device != 'emulator-' + self.identity[1]
                or not initial.get('grpc.token', '').strip()):
            raise ValueError('Authenticated source discovery does not match the device')
        if not all(v.isdecimal() and 1 <= int(v) <= 65535 for v in self.identity[1:]):
            raise ValueError('Invalid emulator discovery ports')

    def resolve(self):
        matches = []
        for path in self.root.glob('pid_*.ini'):
            try:
                data = read_discovery(path)
            except (OSError, UnicodeError, ValueError):
                continue
            if tuple(data.get(k, '') for k in ('avd.id', 'port.serial', 'grpc.port')) == self.identity:
                matches.append(data)
        # Never select a different emulator or guess between stale discoveries.
        if len(matches) != 1 or not matches[0].get('grpc.token', '').strip():
            raise ValueError('The authenticated TikTok source is unavailable or ambiguous')
        return '127.0.0.1:' + self.identity[2], matches[0]['grpc.token'].strip()
