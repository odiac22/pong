import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine/Rope'))
from rope.gpen_user_review import validate


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = Path('E:/Pong Benchmarks/user-quality-review-2026-09-30/gpen1024-fp16-islands-7-9-11-13-15-r3/candidate.plan')
        if not cls.plan.exists():
            raise unittest.SkipTest('Local release artifact unavailable')
        cls.payload = cls.plan.read_bytes()
        cls.manifest = json.loads(Path(str(cls.plan)+'.manifest.json').read_text())
        cls.identity = {k: cls.manifest[k] for k in
                        ('modelSha256', 'edge', 'tensorrt', 'cuda', 'gpu', 'capability', 'tf32', 'int8')}

    def test_exact_approved_artifact(self):
        result = validate(self.manifest, self.identity, self.plan, self.payload)
        self.assertEqual(result['sha256'], hashlib.sha256(self.payload).hexdigest())
        self.assertIn('user-reviewed', result['precisionPolicy'])

    def test_altered_engine_rejected(self):
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            validate(self.manifest, self.identity, self.plan, self.payload+b'x')

    def test_hardware_and_precision_mismatches(self):
        for key in ('edge', 'gpu', 'modelSha256', 'tensorrt', 'cuda', 'capability', 'tf32', 'int8'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(self.manifest, {**self.identity, key: 'different'}, self.plan, self.payload)

    def test_self_asserted_manifest_rejected(self):
        with self.assertRaises(ValueError):
            validate({**self.manifest, 'planSha256': '0'*64}, self.identity, self.plan, self.payload)

    def test_evidence_hash_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['evidence']['combined']['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            validate(manifest, self.identity, self.plan, self.payload)

    def test_wrong_path_rejected(self):
        with self.assertRaisesRegex(ValueError, 'path changed'):
            validate(self.manifest, self.identity, self.plan.with_name('other.plan'), self.payload)


if __name__ == '__main__':
    unittest.main()
