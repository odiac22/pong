import threading
import types
import unittest

from experiment_tiktok_encoder_trace import EncoderHandoffTrace, install


class Session:
    def __init__(self, identifier):
        self.id = identifier


def original_emit_shape():
    encoder_write_started = 0
    encoder_write_seconds = 0
    return encoder_write_started + encoder_write_seconds


class FakeFrame:
    def __init__(self, session, record, *, wrote=True):
        self.f_code = types.SimpleNamespace(
            co_name='emit_pending_output',
            co_varnames=('encoder_write_started', 'encoder_write_seconds'),
        )
        self.f_locals = {'session': session, 'record': record}
        if wrote:
            self.f_locals.update(encoder_write_started=12.0,
                                 encoder_write_seconds=0.003)


class FakeWriter:
    def __init__(self):
        self.probe = types.SimpleNamespace(complete_fragment_count=0)
        self.source_bytes = 0
        self.bytes_written = 0

    def write(self, chunk):
        self.source_bytes += len(chunk)
        self.bytes_written += len(chunk)
        self.probe.complete_fragment_count += 1
        return True


class FakeEngine:
    def __init__(self):
        self._sessions_lock = threading.RLock()
        self._sessions = {}
        self.created = []
        # Emulate the scoped stage-service instance admission wrapper.
        self.create_session = self.create_session
        self.health = self.health

    def create_session(self, **kwargs):
        session = Session('session-' + str(len(self.created)))
        self.created.append((session, kwargs))
        return session

    def health(self):
        return {'ready': True}


class EncoderTraceTests(unittest.TestCase):
    def test_actual_record_values_only_after_completed_write(self):
        trace = EncoderHandoffTrace(max_frames=2)
        session = Session('private-id')
        trace.register(session)
        row = {'frameIndex': 7, 'timelineSeconds': 0.233333333,
               'result': object()}
        trace.record_emit_return(FakeFrame(session, row, wrote=False), 12.1)
        self.assertEqual(trace.status()['sessions'][0]['stdinHandoffs'], [])
        trace.record_emit_return(FakeFrame(session, row), 12.1)
        trace.record_emit_return(FakeFrame(session, {**row, 'frameIndex': 8}), 12.2)
        trace.record_emit_return(FakeFrame(session, {**row, 'frameIndex': 9}), 12.3)
        rows = trace.status()['sessions'][0]['stdinHandoffs']
        self.assertEqual([r['frameIndex'] for r in rows], [7, 8])
        self.assertEqual(rows[0]['inputPtsSeconds'], 0.233333333)
        self.assertNotIn('private-id', str(trace.status()))
        self.assertNotIn('result', str(trace.status()))

    def test_first_fragment_is_one_shot(self):
        trace = EncoderHandoffTrace()
        session = Session('x')
        trace.register(session)
        writer = FakeWriter()
        trace.record_first_fragment(session, writer, 0, 4.0)
        self.assertIsNone(trace.status()['sessions'][0]['firstCompleteFragment'])
        writer.write(b'abc')
        trace.record_first_fragment(session, writer, 0, 4.2)
        writer.write(b'def')
        trace.record_first_fragment(session, writer, 1, 4.4)
        first = trace.status()['sessions'][0]['firstCompleteFragment']
        self.assertEqual((first['atPerf'], first['sourceBytes'], first['spoolBytes']),
                         (4.2, 3, 3))

    def test_new_feeder_thread_profile_sees_real_nested_emit_locals(self):
        trace = EncoderHandoffTrace()
        session = Session('thread-profile')
        trace.register(session)
        previous = threading.getprofile()
        try:
            threading.setprofile(trace.profile)
            def feeder():
                def emit_pending_output(record):
                    encoder_write_started = 6.0
                    # Access the closure exactly as the frozen producer does.
                    session.id
                    encoder_write_seconds = 0.002
                    return encoder_write_started + encoder_write_seconds
                emit_pending_output({'frameIndex': 3, 'timelineSeconds': 0.1})
            worker = threading.Thread(target=feeder)
            worker.start()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
        finally:
            threading.setprofile(previous)
        rows = trace.status()['sessions'][0]['stdinHandoffs']
        self.assertEqual([(r['frameIndex'], r['inputPtsSeconds']) for r in rows],
                         [(3, 0.1)])

    def test_install_scopes_tiktok_and_restores_all_hooks(self):
        engine = FakeEngine()
        original_write = FakeWriter.write
        original_create = engine.create_session
        original_health = engine.health
        previous_profile = threading.getprofile()
        trace = install(engine, FakeWriter)
        try:
            self.assertIs(install(engine, FakeWriter), trace)
            engine.create_session(restoration_profile='default')
            session = engine.create_session(restoration_profile='tiktok-face-size')
            self.assertEqual(len(trace.status()['sessions']), 1)
            self.assertTrue(engine.health()['encoderHandoffTrace']['active'])
            # The class wrapper records the first boundary without changing
            # the writer's returned value or bytes.
            writer = FakeWriter()
            def caller():
                session.id  # Caller local mirrors frozen _produce_session.
                return writer.write(b'abc')
            self.assertTrue(caller())
            self.assertEqual(writer.bytes_written, 3)
            self.assertEqual(trace.status()['sessions'][0]['firstCompleteFragment']['spoolBytes'], 3)
        finally:
            trace.close()
        self.assertIs(FakeWriter.write, original_write)
        self.assertIs(threading.getprofile(), previous_profile)
        self.assertEqual(engine.health(), original_health())
        self.assertEqual(engine.create_session(restoration_profile='default').id,
                         'session-2')


if __name__ == '__main__':
    unittest.main()
