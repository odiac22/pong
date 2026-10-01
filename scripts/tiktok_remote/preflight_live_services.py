"""Probe the already-running gateway/sidecar without input, audio, or launches.

Pairing keys stay local and are never included in the result. This is setup
validation, not touch latency, swap quality, or phone playback qualification.
"""
import asyncio
import json
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

ROOT = Path(__file__).resolve().parents[2]


async def main():
    token = (ROOT / 'Pong Swap/cache/tiktok-remote-pairing-token').read_text().strip()
    renderer_token = (ROOT / 'Pong Swap/cache/remote-bridge-token').read_text().strip()
    gateway = 'http://127.0.0.1:8787/pong-swap/remote'
    auth = {'Authorization': 'Bearer ' + token}
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    peer.addTransceiver('video', direction='recvonly')
    channel = peer.createDataChannel('pong-input', ordered=True)
    opened = asyncio.Event()
    track_future = asyncio.get_running_loop().create_future()
    pong = asyncio.get_running_loop().create_future()
    owned_controller = False
    render_session_id = None
    receiver = None
    report = {'scope': 'existing local services, no input or audio, no swapped frames',
              'audio': False, 'complete': False}

    @channel.on('open')
    def on_open():
        opened.set()

    @channel.on('message')
    def on_message(raw):
        data = json.loads(raw)
        if data.get('type') == 'pong' and not pong.done():
            pong.set_result(time.perf_counter())

    @peer.on('track')
    def on_track(track):
        if track.kind == 'video' and not track_future.done():
            track_future.set_result(track)

    async with ClientSession(timeout=ClientTimeout(total=20), trust_env=False) as http:
        async def api(method, url, headers=None, **kwargs):
            async with http.request(method, url, headers=headers, **kwargs) as response:
                if response.status >= 400:
                    raise RuntimeError('Preflight HTTP ' + str(response.status))
                return await response.json()

        try:
            status = await api('GET', gateway + '/status', auth)
            if any(s.get('connection') not in ('closed', 'failed') for s in status['sessions']):
                raise RuntimeError('Remote controller already owned; left untouched')
            report['remoteVersion'] = status['version']
            health = await api('GET', 'http://127.0.0.1:8792/health')
            report['rendererVersion'] = health['serviceVersion']
            if health['activeSessions']:
                raise RuntimeError('Ordinary renderer session active; preflight deferred')
            faces = await api('GET', 'http://127.0.0.1:8792/faces')
            face_id = next(f['id'] for f in faces['faces'] if f['name'] == 'Approved 3')
            renderer_auth = {'Authorization': 'Bearer ' + renderer_token}
            render = await api('POST', 'http://127.0.0.1:8792/remote-sessions', renderer_auth,
                               json={'faceId': face_id, 'width': 512, 'height': 512, 'fps': 30})
            render_session_id = render['session']['id']
            report['rendererBridgeSessionCreated'] = True
            began = time.perf_counter()
            await peer.setLocalDescription(await peer.createOffer())
            answer = await api('POST', gateway + '/offer', auth,
                               json={'type': 'offer', 'sdp': peer.localDescription.sdp})
            owned_controller = True
            await peer.setRemoteDescription(RTCSessionDescription(**answer))
            await asyncio.wait_for(opened.wait(), 12)
            track = await asyncio.wait_for(track_future, 5)
            frames = []

            async def receive():
                while True:
                    frame = await track.recv()
                    frames.append((time.perf_counter(), frame.width, frame.height))

            receiver = asyncio.create_task(receive())
            ping_start = time.perf_counter()
            channel.send(json.dumps({'type': 'ping', 'id': 'preflight'}))
            report['localPingMs'] = (await asyncio.wait_for(pong, 5) - ping_start) * 1000
            await asyncio.sleep(5)
            if receiver.done():
                receiver.result()
            if not frames:
                raise RuntimeError('Connected but no decoded frames')
            report.update(firstDecodedMs=(frames[0][0] - began) * 1000,
                          decodedFrames=len(frames), width=frames[0][1], height=frames[0][2],
                          connection=peer.connectionState, complete=True)
        finally:
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            await peer.close()
            if owned_controller:
                await api('POST', gateway + '/disconnect', auth, json={})
            if render_session_id:
                await api('DELETE', 'http://127.0.0.1:8792/remote-sessions/' + render_session_id,
                          {'Authorization': 'Bearer ' + renderer_token})
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(main(), 50))
