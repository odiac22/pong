"""Uses synthetic frames only. Passing this is NOT a TikTok/Android latency result."""
import asyncio
import unittest
import numpy as np
from aiohttp.test_utils import TestClient, TestServer
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from server import make_app, Session, Emulator


class FakeEmulator:
    def __init__(self):
        self.inputs = []
        self.closed = False

    async def frames(self):
        for seq in range(300):
            await asyncio.sleep(1 / 30)
            yield np.full((64, 64, 3), seq % 255, dtype=np.uint8), seq, 0

    async def touch(self, x, y, pressure):
        self.inputs.append((x, y, pressure))

    async def key(self, key):
        self.inputs.append(key)

    async def close(self):
        self.closed = True


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.emulator = FakeEmulator()
        self.client = TestClient(TestServer(make_app('s' * 48, lambda: self.emulator)))
        await self.client.start_server()
        self.auth = {'Authorization': 'Bearer ' + 's' * 48}

    async def asyncTearDown(self):
        await self.client.close()

    async def test_api_requires_auth(self):
        for method, route in [('get', '/status'), ('post', '/offer'), ('post', '/disconnect')]:
            response = await getattr(self.client, method)(route)
            self.assertEqual(response.status, 401)

    async def test_wrong_origin_rejected(self):
        response = await self.client.get('/status', headers={**self.auth, 'Origin': 'https://untrusted.invalid'})
        self.assertEqual(response.status, 403)

    async def test_health_truthful_and_no_store(self):
        response = await self.client.get('/status', headers=self.auth)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual((await response.json())['sessions'], [])

    async def test_offer_rejects_non_object_json(self):
        response = await self.client.post('/offer', headers=self.auth, json=[])
        self.assertEqual(response.status, 400)

    async def test_simultaneous_offers_allow_one_controller(self):
        peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        peer.addTransceiver('video', direction='recvonly')
        peer.createDataChannel('pong-input', ordered=True)
        try:
            await peer.setLocalDescription(await peer.createOffer())
            payload = {'sdp': peer.localDescription.sdp, 'type': 'offer'}
            responses = await asyncio.gather(*(
                self.client.post('/offer', headers=self.auth, json=payload)
                for _ in range(2)))
            self.assertEqual(sorted(response.status for response in responses), [200, 409])
            self.assertEqual(len((await (await self.client.get('/status', headers=self.auth)).json())['sessions']), 1)
        finally:
            await peer.close()

    async def test_three_sequential_connections_close_before_reuse(self):
        for _ in range(3):
            peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            peer.addTransceiver('video', direction='recvonly')
            channel = peer.createDataChannel('pong-input', ordered=True)
            opened = asyncio.Event()
            channel.on('open', lambda: opened.set())
            try:
                await asyncio.wait_for(peer.setLocalDescription(await peer.createOffer()), 3)
                response = await asyncio.wait_for(self.client.post('/offer', headers=self.auth,
                    json={'sdp': peer.localDescription.sdp, 'type': 'offer'}), 3)
                self.assertEqual(response.status, 200)
                await asyncio.wait_for(peer.setRemoteDescription(
                    RTCSessionDescription(**await response.json())), 3)
                await asyncio.wait_for(opened.wait(), 3)
            finally:
                await asyncio.wait_for(peer.close(), 3)
            response = await asyncio.wait_for(self.client.post('/disconnect', headers=self.auth, json={}), 3)
            self.assertEqual(response.status, 200)

    async def test_disconnect_waits_for_inflight_touch_then_releases(self):
        started = asyncio.Event()
        finish = asyncio.Event()

        async def delayed_touch(x, y, pressure):
            if pressure:
                started.set()
                await finish.wait()
            self.emulator.inputs.append((x, y, pressure))

        self.emulator.touch = delayed_touch
        session = Session(self.emulator)
        control_task = asyncio.create_task(session.control())
        try:
            session.inputs.put_nowait((dict(type='touch', seq=1, action='down', x=.3, y=.8), 0))
            await asyncio.wait_for(started.wait(), 2)
            closing = asyncio.create_task(session.close())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            another_close = asyncio.create_task(session.close())
            await asyncio.sleep(0)
            self.assertFalse(another_close.done())
            finish.set()
            await asyncio.wait_for(asyncio.gather(closing, another_close), 2)
            self.assertEqual(self.emulator.inputs, [(.3, .8, 1), (.3, .8, 0)])
        finally:
            finish.set()
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
            await session.close()

    async def test_cancelled_close_caller_does_not_abandon_cleanup(self):
        closing_channel = asyncio.Event()
        finish_channel_close = asyncio.Event()

        async def delayed_close():
            closing_channel.set()
            await finish_channel_close.wait()
            self.emulator.closed = True

        self.emulator.close = delayed_close
        session = Session(self.emulator)
        first_close = asyncio.create_task(session.close())
        try:
            await asyncio.wait_for(closing_channel.wait(), 2)
            first_close.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first_close
            self.assertFalse(session.close_done.is_set())
            second_close = asyncio.create_task(session.close())
            await asyncio.sleep(0)
            self.assertFalse(second_close.done())
            finish_channel_close.set()
            await asyncio.wait_for(second_close, 2)
            self.assertTrue(session.close_done.is_set())
            self.assertTrue(self.emulator.closed)
        finally:
            finish_channel_close.set()
            await asyncio.wait_for(session.close(), 2)

    async def test_web_rtc_video_and_control_roundtrip(self):
        peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        peer.addTransceiver('video', direction='recvonly')
        channel = peer.createDataChannel('pong-input', ordered=True)
        opened = asyncio.Event()
        incoming = asyncio.Queue()
        track_ready = asyncio.Future()

        @channel.on('open')
        def on_open():
            opened.set()

        @channel.on('message')
        def on_message(message):
            import json
            incoming.put_nowait(json.loads(message))

        @peer.on('track')
        def on_track(track):
            if not track_ready.done():
                track_ready.set_result(track)

        try:
            await peer.setLocalDescription(await peer.createOffer())
            response = await self.client.post('/offer', headers=self.auth,
                json={'sdp': peer.localDescription.sdp, 'type': 'offer'})
            self.assertEqual(response.status, 200)
            answer = await response.json()
            await peer.setRemoteDescription(RTCSessionDescription(**answer))
            await asyncio.wait_for(opened.wait(), 5)
            track = await asyncio.wait_for(track_ready, 5)
            frame = await asyncio.wait_for(track.recv(), 5)
            self.assertEqual((frame.width, frame.height), (64, 64))
            channel.send('{"type":"ping","id":123}')
            self.assertEqual(await asyncio.wait_for(incoming.get(), 2), {'type': 'pong', 'id': 123})
            channel.send('{"type":"touch","seq":1,"action":"down","x":0.2,"y":0.4}')
            ack = await asyncio.wait_for(incoming.get(), 2)
            self.assertEqual(ack['type'], 'inputAck')
            self.assertIn('not visible', ack['scope'])
            self.assertEqual(self.emulator.inputs[-1], (.2, .4, 1))
            # A second controller cannot steal the first one's authenticated session.
            response = await self.client.post('/offer', headers=self.auth,
                json={'sdp': peer.localDescription.sdp, 'type': 'offer'})
            self.assertEqual(response.status, 409)
            await self.client.post('/disconnect', headers=self.auth, json={})
            self.assertEqual(self.emulator.inputs[-1], (.2, .4, 0))
            self.assertTrue(self.emulator.closed)
        finally:
            await peer.close()

    async def test_disconnect_releases_finger(self):
        s = Session(self.emulator)
        s.touch.accept(dict(seq=1, action='down', x=.3, y=.8))
        await s.close()
        await s.close()
        self.assertEqual(self.emulator.inputs, [(.3, .8, 0)])


    async def test_static_screen_delivers_first_frame_without_motion(self):
        async def static_frames():
            yield np.zeros((64, 64, 3), dtype=np.uint8), 0, 0
            await asyncio.Event().wait()
        self.emulator.frames = static_frames
        peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        peer.addTransceiver('video', direction='recvonly')
        peer.createDataChannel('pong-input', ordered=True)
        incoming = asyncio.Future()
        @peer.on('track')
        def track_ready(track):
            incoming.set_result(track)
        try:
            await peer.setLocalDescription(await peer.createOffer())
            response = await self.client.post('/offer', headers=self.auth,
                json={'sdp': peer.localDescription.sdp, 'type': 'offer'})
            await peer.setRemoteDescription(RTCSessionDescription(**await response.json()))
            track = await asyncio.wait_for(incoming, 2)
            frame = await asyncio.wait_for(track.recv(), 1)
            self.assertEqual((frame.width, frame.height), (64, 64))
            state = await (await self.client.get('/status', headers=self.auth)).json()
            session = state['sessions'][0]
            self.assertEqual(session['capturedFrames'], 1)
            self.assertGreater(session['displayKeepaliveFrames'], 0)
        finally:
            await peer.close()


if __name__ == '__main__':
    unittest.main()
