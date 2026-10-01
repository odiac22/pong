"""Silent, read-only live transport probe. No gestures, audio, or saved images.

Runs against the already-started authenticated emulator only. Local WebRTC
results are NOT phone/Wi-Fi, touch-to-visible, or face-swap latency results.
"""
import argparse
import asyncio
import json
import secrets
import time
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from google.protobuf.empty_pb2 import Empty

from core import VERSION, Timings
from server import Emulator, make_app
from probe_quality import foreground_package, frame_window


class ObservedEmulator(Emulator):
    def __init__(self, *args):
        super().__init__(*args)
        self.metrics = Timings()
        self.count = 0
        self.bytes = 0
        self.first = self.last = None
        self.skipped_sequences = 0
        self.last_seq = None

    async def frames(self):
        async for rgb, seq, stamp in super().frames():
            now = time.perf_counter()
            if self.last is not None:
                self.metrics.add('captureInterval', (now - self.last) * 1000)
            else:
                self.first = now
            self.last = now
            self.count += 1
            self.bytes += rgb.nbytes
            if self.last_seq is not None:
                self.skipped_sequences += max(0, seq - self.last_seq - 1)
            self.last_seq = seq
            # SDK defines timestampUs as host Unix time before capture/copy.
            self.metrics.add('emulatorEstimatedFrameAgeAtCapture',
                             time.time() * 1000 - stamp / 1000)
            yield rgb, seq, stamp

    def report(self, start, end):
        return dict(frames=self.count, width=self.width, height=self.height,
                    **frame_window(self.count, self.first, self.last, start, end),
                    rawMiB=self.bytes / 1048576,
                    skippedSequences=self.skipped_sequences, timings=self.metrics.public())


async def direct_probe(emulator, seconds):
    began = time.perf_counter()
    first_ms = None
    async def capture():
        nonlocal first_ms
        async for _ in emulator.frames():
            if first_ms is None:
                first_ms = (time.perf_counter() - began) * 1000
    task = asyncio.create_task(capture())
    try:
        await asyncio.sleep(seconds)
        measurement_end = time.perf_counter()
        capture_report = emulator.report(began, measurement_end)
        if task.done():
            task.result()
        rpcs = Timings()
        for _ in range(20):
            t = time.perf_counter()
            await emulator.stub.getStatus(Empty(), metadata=emulator.metadata, timeout=3)
            rpcs.add('readOnlyStatusRpc', (time.perf_counter() - t) * 1000)
        return dict(mode='native_capture', firstFrameMs=first_ms,
                    capture=capture_report, rpc=rpcs.public())
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await emulator.close()


async def rtc_probe(emulator, seconds):
    token = secrets.token_hex(24)
    client = TestClient(TestServer(make_app(token, lambda: emulator)))
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    peer.addTransceiver('video', direction='recvonly')
    dc = peer.createDataChannel('pong-input', ordered=True)
    ready = asyncio.Future()
    opened = asyncio.Event()
    metrics = Timings()
    pending = {}
    received = []

    @peer.on('track')
    def track_received(track):
        if not ready.done():
            ready.set_result(track)

    @dc.on('open')
    def channel_opened():
        opened.set()

    @dc.on('message')
    def message(raw):
        data = json.loads(raw)
        if data.get('type') == 'pong' and data.get('id') in pending:
            metrics.add('localDataChannelRoundTrip',
                        (time.perf_counter() - pending.pop(data['id'])) * 1000)

    async def pings():
        n = 0
        while True:
            pending[n] = time.perf_counter()
            dc.send(json.dumps(dict(type='ping', id=n)))
            n += 1
            await asyncio.sleep(.25)

    async def frames(track):
        while True:
            frame = await track.recv()
            now = time.perf_counter()
            if received:
                metrics.add('decodedFrameInterval', (now - received[-1]) * 1000)
            received.append(now)
            if frame.width != emulator.width or frame.height != emulator.height:
                raise ValueError('Unexpected resized frame')

    tasks = []
    began = time.perf_counter()
    try:
        print('phase: rtc_start', flush=True)
        await client.start_server()
        auth = {'Authorization': 'Bearer ' + token}
        await peer.setLocalDescription(await peer.createOffer())
        print('phase: rtc_offer', flush=True)
        answer = await client.post('/offer', headers=auth,
                                  json=dict(sdp=peer.localDescription.sdp, type='offer'))
        if answer.status != 200:
            raise RuntimeError('Offer failed: ' + str(answer.status))
        await peer.setRemoteDescription(RTCSessionDescription(**await answer.json()))
        print('phase: rtc_wait_channel', flush=True)
        await asyncio.wait_for(opened.wait(), 10)
        track = await asyncio.wait_for(ready, 10)
        tasks = [asyncio.create_task(pings()), asyncio.create_task(frames(track))]
        print('phase: rtc_measure', flush=True)
        measurement_start = time.perf_counter()
        await asyncio.sleep(seconds)
        measurement_end = time.perf_counter()
        for task in tasks:
            if task.done():
                task.result()
        status = await (await client.get('/status', headers=auth)).json()
        return dict(mode='local_webrtc', decodedFrames=len(received),
                    decodedWindow=frame_window(len(received), received[0] if received else None,
                        received[-1] if received else None, measurement_start, measurement_end),
                    firstDecodedFrameMs=(received[0] - began) * 1000 if received else None,
                    timings=metrics.public(), capture=emulator.report(began, measurement_end), server=status,
                    visibleInputResponseMs=None, firstSwappedFrameMs=None)
    finally:
        print('phase: rtc_cleanup', flush=True)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.wait_for(peer.close(), 5)
        await asyncio.wait_for(client.close(), 5)
        print('phase: rtc_closed', flush=True)


async def run(args):
    discovery = dict(line.split('=', 1) for line in args.discovery.read_text().splitlines()
                     if '=' in line)
    token = discovery.get('grpc.token', '').strip()
    if not token:
        raise ValueError('Authenticated running emulator required')
    endpoint = '127.0.0.1:' + str(int(discovery['grpc.port']))
    results = []
    report = dict(version=VERSION, scope='read-only local capture/transport; no audio or swap',
                  mode=args.mode, seconds=args.seconds, runs=results, complete=False)
    for n in range(args.repeats):
        print('run: ' + str(n + 1), flush=True)
        emulator = ObservedEmulator(endpoint, token, args.bindings)
        probe = direct_probe if args.mode == 'native' else rtc_probe
        foreground_samples = []
        async def check_foreground():
            proc = await asyncio.create_subprocess_exec(str(args.adb), '-s', args.serial,
                'shell', 'dumpsys', 'activity', 'activities', stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            try:
                output, _ = await asyncio.wait_for(proc.communicate(), 4)
            except BaseException:
                proc.kill()
                await proc.wait()
                raise
            package = foreground_package(output.decode('utf-8', errors='replace'))
            foreground_samples.append(dict(elapsedSeconds=round(time.perf_counter()-run_started, 3),
                expectedForeground=proc.returncode == 0 and package == args.expected_package))

        async def monitor_foreground():
            while True:
                await asyncio.sleep(1)
                await check_foreground()

        run_started = time.perf_counter()
        monitor = None
        try:
            if args.adb:
                await check_foreground()
                if not foreground_samples[-1]['expectedForeground']:
                    raise RuntimeError('Expected application is not foreground; benchmark refused')
                monitor = asyncio.create_task(monitor_foreground())
            result = await asyncio.wait_for(probe(emulator, args.seconds), args.seconds + 30)
            if monitor:
                if monitor.done():
                    monitor.result()
                await check_foreground()
            result['foregroundChecks'] = foreground_samples
            result['expectedAppVerified'] = bool(foreground_samples) and all(x['expectedForeground'] for x in foreground_samples)
            result['validForAppTransport'] = result['expectedAppVerified']
        except Exception as exc:
            report['errorType'] = type(exc).__name__
            args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
            raise
        finally:
            if monitor:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            await emulator.close()
        result['run'] = n + 1
        results.append(result)
        print(json.dumps(result), flush=True)
        args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    report['complete'] = True
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--discovery', type=Path, required=True)
    p.add_argument('--bindings', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--mode', choices=['native', 'rtc'], default='native')
    p.add_argument('--seconds', type=float, default=10)
    p.add_argument('--repeats', type=int, default=3)
    p.add_argument('--adb', type=Path)
    p.add_argument('--serial', default='emulator-5580')
    p.add_argument('--expected-package', default='com.zhiliaoapp.musically')
    a = p.parse_args()
    if not 1 <= a.seconds <= 30 or not 1 <= a.repeats <= 10:
        p.error('Use 1-30 seconds and 1-10 repeats')
    asyncio.run(run(a))
