"""CPU-only checks for the disposable source-open stack sampler."""

from __future__ import annotations

import hashlib
import ast
import queue
from pathlib import Path
from types import SimpleNamespace
import unittest

from experiment_tiktok_source_open_trace import (
    SourceOpenSampler, authorized_source_open_request, classify_pipeline_stage,
    classify_source_stage,
    sanitize_cache_state, source_identity,
)


ROOT = Path(__file__).parent
FROZEN = ROOT / 'pong_exact_runtime' / 'frozen_methods.py'
SOURCE_POOL = ROOT / 'pong_swap_source_pool.py'


def anchored_line(path: Path, needle: str) -> int:
    matches = [number for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1)
               if needle in line]
    if len(matches) != 1:
        raise AssertionError(f'expected one source anchor for {needle!r}, found {len(matches)}')
    return matches[0]


def frame(name: str, line: int, path: Path, *, session=None, back=None, locals=None):
    return SimpleNamespace(
        f_code=SimpleNamespace(co_name=name, co_filename=str(path)),
        f_lineno=line, f_locals={**({'session': session} if session is not None else {}),
                                **(locals or {})},
        f_back=back,
    )


def make_session():
    return SimpleNamespace(id='a' * 32, source_opened_at=0, state='starting', stop=None,
                           source_url='http://127.0.0.1:8787/video-cache/stream?url='
                           'https%3A%2F%2Fwww.tiktok.com%2F%40example%2Fvideo%2F123'
                           '&profile=tiktok', prefetch=True, activation_requested=False)


class SourceOpenTraceTest(unittest.TestCase):
    def test_direct_renderer_route_auth_and_disabled_behavior(self):
        valid = 'a' * 32
        self.assertTrue(authorized_source_open_request('127.0.0.1', valid, enabled=True))
        self.assertTrue(authorized_source_open_request('::1', valid, enabled=True))
        self.assertFalse(authorized_source_open_request('127.0.0.1', valid,
                                                        enabled=True, proxied=True))
        for host, session_id, enabled in (
            ('10.0.2.2', valid, True), ('192.168.1.5', valid, True),
            ('127.0.0.1', valid, False), ('127.0.0.1', 'bad', True),
        ):
            self.assertFalse(authorized_source_open_request(host, session_id, enabled=enabled))

        # Extract the real route without importing the GPU/service singleton.
        source = ast.parse((ROOT / 'pong_swap_service.py').read_text(encoding='utf-8'))
        route = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name == 'source_open_diagnostic')
        route.decorator_list = []
        namespace = {
            'SOURCE_OPEN_SAMPLER': None,
            'authorized_source_open_request': authorized_source_open_request,
            'HTTPException': type('HTTPException', (Exception,), {}),
        }
        module = ast.Module(body=[ast.ImportFrom(module='__future__',
                            names=[ast.alias(name='annotations')], level=0), route], type_ignores=[])
        code = compile(ast.fix_missing_locations(module), '<source-open-route>', 'exec')
        exec(code, namespace)
        request = SimpleNamespace(client=SimpleNamespace(host='127.0.0.1'), headers={})
        with self.assertRaises(namespace['HTTPException']):
            namespace['source_open_diagnostic'](request, valid)
        namespace['SOURCE_OPEN_SAMPLER'] = object()
        with self.assertRaises(namespace['HTTPException']):
            namespace['source_open_diagnostic'](
                SimpleNamespace(client=SimpleNamespace(host='192.168.1.5'), headers={}), valid)
        session = make_session()
        session.config = {'runtime': {'tiktokRestorerProfile': 'tiktok-face-size'}}
        namespace['SOURCE_OPEN_SAMPLER'] = SourceOpenSampler()
        namespace['ENGINE'] = SimpleNamespace(session=lambda _id: session)
        namespace['_source_open_cache_snapshot'] = lambda _url: {
            'status': 'ready', 'bytes': 100, 'sourceUrl': 'signed-secret'
        }
        result = namespace['source_open_diagnostic'](request, valid)
        self.assertTrue(result['ok'])
        self.assertEqual(result['diagnostic']['cache']['status'], 'ready')
        self.assertNotIn('signed-secret', repr(result))
        cache_calls = []
        namespace['_source_open_cache_snapshot'] = lambda _url: cache_calls.append(True)
        without_cache = namespace['source_open_diagnostic'](request, valid, include_cache=False)
        self.assertIsNone(without_cache['diagnostic']['cache'])
        self.assertEqual(cache_calls, [])
        request.headers['x-pong-proxy'] = '1'
        with self.assertRaises(namespace['HTTPException']):
            namespace['source_open_diagnostic'](request, valid, include_cache=False)
        request.headers.clear()
        session.config = {'runtime': {'tiktokRestorerProfile': 'default'}}
        with self.assertRaises(namespace['HTTPException']):
            namespace['source_open_diagnostic'](request, valid, include_cache=False)

    def test_frozen_and_baseline_have_required_stage_anchors(self):
        for path in (FROZEN, ROOT / 'pong_swap_engine.py'):
            for anchor in ('_prefetch_source_open_gate.acquire(', '_standby_sources.take(',
                           'av.open(candidate_url', 'decode_queue.get(timeout=0.10)',
                           '_yield_prefetch_for_foreground(session)',
                           'session.condition.wait(timeout=0.025)'):
                self.assertGreater(anchored_line(path, anchor), 0)

    def test_session_specific_decoder_queue_and_foreground_yield(self):
        session = make_session()
        session.scrub_suspended = SimpleNamespace(is_set=lambda: False)
        decoded = queue.Queue(maxsize=3)
        decoded.put(('rgb-frame', 0.0))
        producer = frame('_produce_session', anchored_line(FROZEN, 'decode_queue: queue.Queue[Any]'),
                         FROZEN, session=session, locals={'decode_queue': decoded})
        decode_frame = frame('decode_source', anchored_line(FROZEN, 'for decoded in container.decode(video_stream):'),
                             FROZEN, session=session)
        yield_frame = frame('feed', anchored_line(FROZEN, 'self._yield_prefetch_for_foreground(session)'),
                            FROZEN, session=session, locals={'decode_queue': decoded})
        yield_call = frame('_yield_prefetch_for_foreground',
                           anchored_line(ROOT / 'pong_swap_engine.py', 'session.condition.wait(timeout=0.01)'),
                           ROOT / 'pong_swap_engine.py', session=session, back=yield_frame)
        threads = [('PongSwapProducer-tiktok', producer), ('PongSwapDecode-tiktok', decode_frame),
                   ('PongSwapFeed-tiktok', yield_call)]
        stage = classify_pipeline_stage(session, threads)
        self.assertEqual(stage['decoderStage'], 'source_decode')
        self.assertEqual(stage['feedStage'], 'foreground_yield')
        self.assertEqual(stage['decodedQueueDepth'], 1)
        self.assertFalse(stage['scrubSuspended'])
        other = make_session()
        self.assertEqual(classify_pipeline_stage(other, threads)['decodedQueueDepth'], None)
        self.assertEqual(classify_pipeline_stage(other, threads)['feedStage'], 'not_observed')

    def test_queue_get_scrub_and_decoder_queue_put_are_distinct(self):
        session = make_session()
        session.scrub_suspended = SimpleNamespace(is_set=lambda: True)
        decoded = queue.Queue(maxsize=3)
        queue_get = frame('feed', anchored_line(FROZEN, 'decode_queue.get(timeout=0.10)'),
                          FROZEN, session=session, locals={'decode_queue': decoded})
        stage = classify_pipeline_stage(session, [('PongSwapFeed-tiktok', queue_get)])
        self.assertEqual(stage['feedStage'], 'queue_get')
        self.assertEqual(stage['decodedQueueDepth'], 0)
        self.assertTrue(stage['scrubSuspended'])
        scrub = frame('feed', anchored_line(FROZEN, 'session.condition.wait(timeout=0.025)'),
                      FROZEN, session=session, locals={'decode_queue': decoded})
        self.assertEqual(classify_pipeline_stage(session, [('PongSwapFeed-tiktok', scrub)])['feedStage'],
                         'scrub_wait')
        decoder = frame('decode_source', anchored_line(FROZEN, 'if not publish_decoded((frame, timeline_seconds)):'),
                        FROZEN, session=session)
        publishing = frame('publish_decoded', anchored_line(FROZEN, 'decode_queue.put(item, timeout=0.05)'),
                           FROZEN, session=session, back=decoder)
        self.assertEqual(classify_pipeline_stage(session, [('PongSwapDecode-tiktok', publishing)])
                         ['decoderStage'], 'queue_put')

    def test_pipeline_observation_times_are_bounded_and_not_exact_decode_claims(self):
        tick = iter((10.0, 10.2, 10.5))
        sampler = SourceOpenSampler(clock=lambda: next(tick))
        session = make_session()
        session.scrub_suspended = SimpleNamespace(is_set=lambda: False)
        decoded = queue.Queue(maxsize=3)
        feed = frame('feed', anchored_line(FROZEN, 'decode_queue.get(timeout=0.10)'),
                     FROZEN, session=session, locals={'decode_queue': decoded})
        first = sampler.sample(session, thread_frames=[('PongSwapFeed-tiktok', feed)])
        self.assertIsNone(first['firstQueueNonemptyObservedMs'])
        self.assertEqual(first['feedStage'], 'queue_get')
        decoded.put(('rgb-frame', 0.0))
        second = sampler.sample(session, thread_frames=[('PongSwapFeed-tiktok', feed)])
        self.assertEqual(second['firstQueueNonemptyObservedMs'], 200.0)
        self.assertEqual(second['feedStageObservedMs'], 200.0)
        session.activation_requested = True
        session.scrub_suspended = SimpleNamespace(is_set=lambda: True)
        third = sampler.sample(session, thread_frames=[('PongSwapFeed-tiktok', feed)])
        self.assertEqual(third['activationObservedMs'], 500.0)
        self.assertTrue(third['scrubSuspended'])
        self.assertNotIn('rgb-frame', repr(third))

    def test_gate_take_and_open_are_distinct(self):
        session = make_session()
        gate = frame('open_source', anchored_line(FROZEN, '_prefetch_source_open_gate.acquire('),
                     FROZEN, session=session)
        self.assertEqual(classify_source_stage(session, [('PongSwapOpen-tiktok', gate)]), 'gate_wait')
        take = frame('open_candidate', anchored_line(FROZEN, '_standby_sources.take('),
                     FROZEN, session=session)
        self.assertEqual(classify_source_stage(session, [('PongSwapRoute-tiktok-1', take)]), 'standby_take')
        open_frame = frame('open_candidate', anchored_line(FROZEN, 'av.open(candidate_url'),
                           FROZEN, session=session)
        self.assertEqual(classify_source_stage(session, [('PongSwapRoute-tiktok-1', open_frame)]), 'av_open')
        nested_take = frame('take', anchored_line(SOURCE_POOL, 'entry = self._ready.pop(url, None)'),
                            SOURCE_POOL, back=frame('open_candidate',
                            anchored_line(FROZEN, '_standby_sources.take('), FROZEN, session=session))
        self.assertEqual(classify_source_stage(session, [('PongSwapRoute-tiktok-1', nested_take)]), 'standby_take')
        other = make_session()
        self.assertEqual(classify_source_stage(other, [('PongSwapRoute-tiktok-1', open_frame)]),
                         'not_observed')
        session.source_opened_at = 1.0
        self.assertEqual(classify_source_stage(session, [('PongSwapRoute-tiktok-1', open_frame)]), 'opened')

    def test_identity_and_cache_fields_cannot_leak_urls(self):
        session = make_session()
        identity = source_identity(session.source_url)
        expected = hashlib.sha256(b'www.tiktok.com/@example/video/123').hexdigest()[:32]
        self.assertEqual(identity, {'routeFamily': 'cache_stream', 'hostClass': 'loopback',
                                    'cacheId': expected})
        self.assertEqual(source_identity('http://10.0.2.2:8787/video-cache/media/' + expected)
                         ['hostClass'], 'emulator_alias')
        cache = sanitize_cache_state({
            'status': 'ready', 'bytes': 985596, 'totalBytes': 985596,
            'sourceUrl': 'https://signed.example/private?token=secret',
            'failure': {'category': 'network', 'attempts': 3, 'stderr': 'secret'},
        })
        self.assertEqual(cache['status'], 'ready')
        self.assertEqual(cache['failureAttempts'], 3)
        self.assertNotIn('secret', repr(cache))
        self.assertNotIn('sourceUrl', cache)
        self.assertEqual(sanitize_cache_state({'status': 'surprise', 'bytes': float('nan')})
                         ['status'], 'missing')

    def test_sampler_tracks_stage_without_touching_session(self):
        tick = iter((10.0, 10.5, 11.0))
        sampler = SourceOpenSampler(clock=lambda: next(tick))
        session = make_session()
        sampler.mark_created(session, {'status': 'idle', 'sourceUrl': 'secret'})
        sampler.mark_created(session, {'status': 'ready'})
        opened = frame('open_candidate', anchored_line(FROZEN, 'av.open(candidate_url'),
                       FROZEN, session=session)
        threads = [('PongSwapRoute-tiktok-1', opened)]
        first = sampler.sample(session, cache_state={'status': 'missing'}, thread_frames=threads)
        second = sampler.sample(session, cache_state={'status': 'queued'}, thread_frames=threads)
        self.assertEqual(first['stage'], 'av_open')
        self.assertEqual(first['stageObservedMs'], 0)
        self.assertEqual(first['cacheAtCreation']['status'], 'idle')
        self.assertEqual(second['stageObservedMs'], 500)
        self.assertEqual(second['cache']['status'], 'queued')
        self.assertNotIn('@example', repr(second))
        session.source_opened_at = 12.0
        third = sampler.sample(session, thread_frames=threads)
        self.assertEqual(third['stage'], 'opened')
        self.assertEqual(third['stageObservedMs'], 0)
        self.assertEqual(third['previousStage'], 'av_open')
        self.assertEqual(third['previousStageObservedMs'], 1000)


if __name__ == '__main__':
    unittest.main()
