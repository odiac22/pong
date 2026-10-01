import tempfile
import unittest
from pathlib import Path
from discovery import SourceDiscovery


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, pid, token='fixture-only', avd='source', serial='5580', port='8556'):
        path = self.root / f'pid_{pid}.ini'
        path.write_text(f'avd.id={avd}\nport.serial={serial}\ngrpc.port={port}\ngrpc.token={token}\n')
        return path

    def test_rotated_credentials_follow_only_the_same_source(self):
        initial = self.write(1)
        source = SourceDiscovery(initial, 'emulator-5580')
        initial.unlink()
        self.write(2, token='rotated-fixture')
        self.write(3, avd='receiver', serial='5582', port='8557')
        self.assertEqual(source.resolve(), ('127.0.0.1:8556', 'rotated-fixture'))

    def test_missing_duplicate_and_unauthenticated_source_fail_closed(self):
        initial = self.write(1)
        source = SourceDiscovery(initial, 'emulator-5580')
        duplicate = self.write(2)
        with self.assertRaises(ValueError): source.resolve()
        initial.unlink()
        self.write(2, token='')
        with self.assertRaises(ValueError): source.resolve()
        duplicate.unlink()
        with self.assertRaises(ValueError): source.resolve()

    def test_another_avd_cannot_replace_original_on_same_ports(self):
        initial = self.write(1)
        source = SourceDiscovery(initial, 'emulator-5580')
        self.write(1, avd='unrelated')
        with self.assertRaises(ValueError): source.resolve()

    def test_mismatched_device_and_invalid_ports_are_rejected(self):
        with self.assertRaises(ValueError): SourceDiscovery(self.write(1), 'emulator-5582')
        with self.assertRaises(ValueError): SourceDiscovery(self.write(1, port='65536'), 'emulator-5580')
