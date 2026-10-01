"""No GPU required: readiness includes a successful FP32 execution."""
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from pong_swap_identity import FairFacePresentationClassifier


class PresentationWarmupTests(unittest.TestCase):
    def session(self):
        session = Mock()
        session.get_outputs.return_value = [SimpleNamespace(name='gender', shape=[1, 2], type='tensor(float)')]
        session.get_inputs.return_value = [SimpleNamespace(name='input')]
        session.get_providers.return_value = ['CPUExecutionProvider']
        session.run.return_value = [np.array([[.25, .75]], dtype=np.float32)]
        return session

    def runtime(self, session):
        return SimpleNamespace(SessionOptions=SimpleNamespace,
            GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_ALL=99),
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL=0),
            InferenceSession=Mock(return_value=session))

    def test_ready_only_after_successful_execution_and_no_repeated_probes(self):
        classifier = FairFacePresentationClassifier(Path('unused.onnx'))
        session = self.session()
        observed = []
        session.run.side_effect = lambda *args: observed.append(classifier.ready)
        runtime = self.runtime(session)
        with patch.object(Path, 'is_file', return_value=True), patch.dict(sys.modules, onnxruntime=runtime):
            classifier.warm()
            classifier.warm()
        self.assertEqual(observed, [False])
        self.assertTrue(classifier.ready)
        self.assertEqual(session.run.call_count, 1)
        tensor = session.run.call_args.args[1]['input']
        self.assertEqual(tensor.shape, (1, 3, 224, 224))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(np.isfinite(tensor).all())

    def test_execution_failure_remains_unready_and_can_retry(self):
        classifier = FairFacePresentationClassifier(Path('unused.onnx'))
        session = self.session()
        session.run.side_effect = RuntimeError('provider failed')
        runtime = self.runtime(session)
        with patch.object(Path, 'is_file', return_value=True), patch.dict(sys.modules, onnxruntime=runtime):
            with self.assertRaisesRegex(RuntimeError, 'provider failed'):
                classifier.warm()
            self.assertFalse(classifier.ready)
            session.run.side_effect = None
            classifier.warm()
        self.assertTrue(classifier.ready)
        self.assertEqual(runtime.InferenceSession.call_count, 2)

    def test_backend_change_and_unload_require_new_probe(self):
        classifier = FairFacePresentationClassifier(Path('unused.onnx'))
        session = self.session()
        runtime = self.runtime(session)
        with patch.object(Path, 'is_file', return_value=True), patch.dict(sys.modules, onnxruntime=runtime):
            classifier.warm()
            classifier.set_backend('cuda')
            self.assertFalse(classifier.ready)
            classifier.warm()
            classifier.unload()
            self.assertFalse(classifier.ready)
            classifier.warm()
        self.assertEqual(session.run.call_count, 3)
        self.assertEqual(classifier.backend, 'cuda')

    def test_health_stays_unready_until_probe_and_metadata_publish(self):
        classifier = FairFacePresentationClassifier(Path('unused.onnx'))
        session = self.session()
        entered, release = threading.Event(), threading.Event()
        def probe(*_args):
            entered.set()
            self.assertTrue(release.wait(2))
            return [np.array([[.25, .75]], dtype=np.float32)]
        session.run.side_effect = probe
        runtime = self.runtime(session)
        failures = []
        with patch.object(Path, 'is_file', return_value=True), patch.dict(sys.modules, onnxruntime=runtime):
            worker = threading.Thread(target=lambda: self._warm_worker(classifier, failures))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertFalse(classifier.ready)
                self.assertEqual(classifier.health_snapshot(), (False, 'cpu', ()))
            finally:
                release.set()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(classifier.health_snapshot(), (True, 'cpu', ('CPUExecutionProvider',)))

    @staticmethod
    def _warm_worker(classifier, failures):
        try:
            classifier.warm()
        except Exception as exc:
            failures.append(exc)

    def test_classify_rewarms_if_unloaded_during_crop(self):
        classifier = FairFacePresentationClassifier(Path('unused.onnx'))
        session = self.session()
        runtime = self.runtime(session)
        frame = np.full((224, 224, 3), 127, dtype=np.uint8)
        keypoints = np.zeros((5, 2), dtype=np.float32)
        with patch.object(Path, 'is_file', return_value=True), patch.dict(sys.modules, onnxruntime=runtime):
            classifier.warm()
            crop_calls = 0
            def crop(*_args):
                nonlocal crop_calls
                crop_calls += 1
                if crop_calls == 1:
                    classifier.unload()
                return frame
            with patch.object(classifier, '_crop', side_effect=crop):
                result = classifier.classify(frame, keypoints)
        self.assertTrue(classifier.ready)
        self.assertEqual(result.label, 'female')
        self.assertEqual(runtime.InferenceSession.call_count, 2)
        self.assertEqual(session.run.call_count, 3)


if __name__ == '__main__':
    unittest.main()
