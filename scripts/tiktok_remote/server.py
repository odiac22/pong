"""Opt-in, silent WebRTC remote emulator prototype; no live Pong server mutations.

Run with the separate dependency directory on PYTHONPATH. Generate controller
bindings from the installed emulator's own proto (see README), not a guessed API.
"""
import argparse
import asyncio
import json
import time
import os
import subprocess
from fractions import Fraction
from pathlib import Path

import av
import grpc
import numpy as np
from aiohttp import web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack

from core import VERSION, Timings, TouchState, InputMailbox, authorized


class Emulator:
    def __init__(self, endpoint, token, bindings, adb=None, device='emulator-5580'):
        import sys
        sys.path.insert(0, str(bindings))
        import emulator_controller_pb2 as pb
        import emulator_controller_pb2_grpc as rpc
        self.pb = pb
        # Control is strictly loopback and authenticated. No arbitrary remote target.
        if not endpoint.startswith("127.0.0.1:"):
            raise ValueError("emulator endpoint must be loopback")
        if not token:
            raise ValueError("authenticated emulator token is required")
        self.channel = grpc.aio.insecure_channel(endpoint, options=[
            ("grpc.max_receive_message_length", 64 * 1024 * 1024)])
        self.stub = rpc.EmulatorControllerStub(self.channel)
        self.metadata = (("authorization", "Bearer " + token),)
        self.width, self.height = 0, 0
        self.adb, self.device = adb, device

    async def video_region(self):
        from video_region import video_region
        if not self.adb:
            return None
        process = await asyncio.create_subprocess_exec(str(self.adb), '-s', self.device,
            'exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 5)
            if process.returncode or len(output) > 2_000_000:
                return None
            return video_region(output.decode('utf-8', errors='replace'), self.width, self.height)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def frames(self):
        # Native resolution; no PNG compression or screenshot subprocess per frame.
        call = self.stub.streamScreenshot(self.pb.ImageFormat(format=self.pb.ImageFormat.RGB888),
                                          metadata=self.metadata)
        try:
            async for image in call:
                w, h = image.format.width, image.format.height
                if w <= 0 or h <= 0 or w * h > 16_777_216 or len(image.image) != w * h * 3:
                    continue
                self.width, self.height = w, h
                # Protobuf exposes owned immutable bytes. The ndarray retains that
                # byte buffer even after the next RPC message arrives: no extra
                # 7.6 MB copy is needed for a 1080x2340 RGB frame.
                rgb = np.frombuffer(image.image, np.uint8).reshape(h, w, 3)
                yield rgb, image.seq, image.timestampUs
        finally:
            call.cancel()

    async def touch(self, x, y, pressure):
        if not self.width or not self.height:
            raise ValueError("waiting for emulator display dimensions")
        touch = self.pb.Touch(x=min(self.width - 1, round(x * self.width)),
                              y=min(self.height - 1, round(y * self.height)),
                              identifier=0, pressure=pressure)
        await self.stub.sendTouch(self.pb.TouchEvent(touches=[touch]),
                                  metadata=self.metadata, timeout=1)

    async def key(self, key):
        if key not in ("GoBack", "Enter", "Backspace", "Tab"):
            raise ValueError("unsupported navigation key")
        await self.stub.sendKey(self.pb.KeyboardEvent(key=key, eventType=2),
                                metadata=self.metadata, timeout=1)

    async def close(self):
        await self.channel.close()


def wrap_rgb_frame(rgb):
    """Retain an immutable RGB buffer through encode without copying its pixels.

    Do not use this with a capture backend that reuses/mutates its input buffer.
    Mutable sources (including test fixtures) take the defensive-copy path.
    """
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("expected packed RGB uint8")
    if rgb.flags.c_contiguous and not rgb.flags.writeable:
        return av.VideoFrame.from_numpy_buffer(rgb, format="rgb24")
    return av.VideoFrame.from_ndarray(rgb, format="rgb24")


class RemoteTrack(VideoStreamTrack):
    def __init__(self, session):
        super().__init__()
        self.session = session
        self.epoch = time.perf_counter()
        self.last_seq = -1
        self.last_submit = 0.0

    async def recv(self):
        s = self.session
        while not s.closed:
            # Capture emits only changed screens. Receivers may hold a frame
            # until the next RTP timestamp arrives, so a still profile/menu
            # must also get display keepalives. These are never new inference.
            interval = 1 / 30 if s.submitted < 3 else .1
            timeout = max(.001, interval - (time.perf_counter() - self.last_submit))
            try:
                await asyncio.wait_for(s.changed.wait(), timeout=timeout if s.latest else None)
            except asyncio.TimeoutError:
                pass
            if s.closed or s.error:
                break
            item = s.latest
            s.changed.clear()
            if item is None:
                continue
            rgb, seq, received = item
            repeated = seq == self.last_seq
            self.last_seq = seq
            # At most one frame in flight. Capture replaces stale waiting frames;
            # this prototype reports drops rather than pretending they were swapped.
            frame = wrap_rgb_frame(rgb)
            frame.pts = max(1, round((time.perf_counter() - self.epoch) * 90000))
            frame.time_base = Fraction(1, 90000)
            if repeated:
                s.display_keepalives += 1
            else:
                s.timings.add("captureToEncoderSubmission", (time.perf_counter() - received) * 1000)
            s.submitted += 1
            self.last_submit = time.perf_counter()
            return frame
        from aiortc.mediastreams import MediaStreamError
        raise MediaStreamError


class Session:
    def __init__(self, emulator, swap_bridge=None):
        self.emulator = emulator
        self.swap_bridge = swap_bridge
        self.raw_latest = None
        self.render_changed = asyncio.Event()
        self.gesture_start = None
        self.gesture_swapping = False
        self.gesture_active = False
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.changed = asyncio.Event()
        self.latest = None
        self.timings = Timings()
        self.touch = TouchState()
        self.closed = False
        self.close_done = asyncio.Event()
        self.close_task = None
        self.captured = self.submitted = self.replaced = 0
        self.display_keepalives = 0
        self.error = None
        self.inputs = InputMailbox(maxsize=128)
        self.input_lock = asyncio.Lock()
        self.tasks = []
        self.dc = None
        self.last_message = time.monotonic()
        self.auto_face = None
        self.region = None
        self.region_task = None
        self.region_epoch = 0
        self.pc.addTrack(RemoteTrack(self))

        @self.pc.on("datachannel")
        def datachannel(channel):
            if self.dc is not None or channel.label != "pong-input":
                channel.close()
                return
            self.dc = channel

            @channel.on("close")
            def closed():
                asyncio.create_task(self.close())

            @channel.on("message")
            def message(raw):
                try:
                    if not isinstance(raw, str) or len(raw) > 2048:
                        raise ValueError("invalid message")
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError("invalid message")
                    self.last_message = time.monotonic()
                    if data.get("type") == "ping":
                        channel.send(json.dumps({"type": "pong", "id": data.get("id")}))
                    else:
                        replaced = self.inputs.put_nowait((data, time.perf_counter()))
                        if replaced is not None:
                            self.send({'type': 'inputCoalesced', 'seq': replaced})
                except (ValueError, asyncio.QueueFull):
                    # Release touches and disconnect on overflow: never lose an UP
                    # then keep accepting unrelated later events.
                    asyncio.create_task(self.close())

        @self.pc.on("connectionstatechange")
        async def connectionstatechange():
            if not self.closed and self.pc.connectionState in ("failed", "closed", "disconnected"):
                await self.close()

    def send(self, data):
        if self.dc and self.dc.readyState == "open":
            self.dc.send(json.dumps(data))

    async def capture(self):
        try:
            async for rgb, seq, timestamp in self.emulator.frames():
                if self.closed:
                    break
                received = time.perf_counter()
                orientation_changed = self.raw_latest is not None and self.raw_latest[0].shape != rgb.shape
                self.raw_latest = rgb, seq, timestamp, received
                if orientation_changed and self.auto_face:
                    self.region_epoch += 1
                    self.region = None
                    self.swap_bridge.reset(suspend=True)
                    self.schedule_region(resume=True)
                self.captured += 1
                if self.swap_bridge and self.swap_bridge.enabled and not self.gesture_active:
                    self.render_changed.set()
                else:
                    self.publish(rgb, seq, received)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.error = "Emulator capture unavailable; check authenticated connection."
            self.send({"type": "error", "message": self.error})

    def publish(self, rgb, seq, received):
        if self.closed:
            return
        if self.changed.is_set():
            self.replaced += 1
        self.latest = rgb, seq, received
        self.changed.set()

    async def render(self):
        """One inference in flight, one replaceable capture, no growing FIFO."""
        last_seq = -1
        while not self.closed:
            await self.render_changed.wait()
            self.render_changed.clear()
            item = self.raw_latest
            if not item or self.gesture_active or not self.swap_bridge.enabled:
                continue
            rgb, seq, stamp, received = item
            if seq == last_seq:
                continue
            last_seq = seq
            result = await self.swap_bridge.render(rgb, seq, stamp)
            if self.closed or self.gesture_active:
                continue
            if result is not None and self.swap_bridge.enabled:
                rendered, transformed = result
                self.publish(rendered, seq, received)
                self.send({"type": "swapFrame", "seq": seq, "transformed": transformed,
                           "scope": "PC render completion, not client presentation"})
            elif not self.swap_bridge.enabled and self.raw_latest:
                current, current_seq, _, current_received = self.raw_latest
                self.publish(current, current_seq, current_received)

    async def configure_swap(self, body):
        if self.swap_bridge is None:
            raise ValueError("Face renderer is not configured on this PC")
        if not self.raw_latest:
            raise ValueError("Wait for the live video first")
        rgb = self.raw_latest[0]
        if body.get('automaticRegion') is True and body.get('enabled'):
            epoch = self.region_epoch
            face = body.get('faceId')
            if not isinstance(face, str) or not face or len(face) > 200 or ',' in face:
                raise ValueError('Choose one approved face for TikTok')
            self.auto_face = face
            self.swap_bridge.reset(suspend=True)
            if self.region_task:
                await self.region_task
            if not self.region:
                await self.refresh_region()
            if self.closed or epoch != self.region_epoch or self.auto_face != face:
                raise ValueError('Video changed; waiting for the current video area')
            if not self.region:
                raise ValueError('Open a TikTok video; face swap will resume there automatically')
            body = {**body, 'roi': self.region, 'regionConfirmed': True}
        elif not body.get('enabled'):
            self.auto_face = None
            self.region_epoch += 1
        state = await self.swap_bridge.configure(body, rgb.shape[1], rgb.shape[0])
        self.render_changed.set()
        return state

    async def refresh_region(self, resume=False):
        epoch, face = self.region_epoch, self.auto_face
        try:
            region = await self.emulator.video_region()
        except Exception:
            region = None
        if self.closed or epoch != self.region_epoch or self.gesture_active:
            return
        self.region = region
        if resume and face and face == self.auto_face and region and self.raw_latest:
            rgb = self.raw_latest[0]
            try:
                await self.swap_bridge.configure({'enabled':True, 'faceId':face,
                    'roi':region, 'regionConfirmed':True}, rgb.shape[1], rgb.shape[0])
                if self.closed or epoch != self.region_epoch:
                    self.swap_bridge.reset(suspend=True)
                else:
                    self.render_changed.set()
            except Exception:
                self.swap_bridge.reset(suspend=True)

    def schedule_region(self, resume=False):
        if not hasattr(self.emulator, 'video_region'):
            return
        if self.region_task and not self.region_task.done():
            self.region_task.cancel()
        self.region_task = asyncio.create_task(self.refresh_region(resume))

    async def control(self):
        try:
            while not self.closed:
                message, received = await self.inputs.get()
                started = time.perf_counter()
                try:
                    kind = message.get("type")
                    async with self.input_lock:
                        if self.closed:
                            break
                        if kind == "touch":
                            touch = self.touch.accept(message)
                            action = message.get("action")
                            if action == "down":
                                self.region_epoch += 1
                                self.gesture_start = touch[:2]
                                self.gesture_active = True
                                self.gesture_swapping = bool(self.swap_bridge and self.swap_bridge.enabled)
                                if self.swap_bridge:
                                    self.swap_bridge.reset()
                            await self.emulator.touch(*touch)
                            if action in ("up", "cancel"):
                                self.gesture_active = False
                                if self.swap_bridge and self.gesture_swapping:
                                    dx = touch[0] - self.gesture_start[0]
                                    dy = touch[1] - self.gesture_start[1]
                                    feed_swipe = action == "up" and abs(dy) > .12 and abs(dy) > 1.4 * abs(dx)
                                    self.swap_bridge.reset(suspend=not feed_swipe)
                                    if feed_swipe:
                                        self.swap_bridge.begin_video()
                                    self.raw_latest = None
                                    self.latest = None
                                    self.render_changed.clear()
                                # A feed swipe preserves the verified video layout.
                                # Other gestures can enter a profile/menu; revalidate
                                # asynchronously, never block the input ACK on ADB.
                                dx = touch[0] - self.gesture_start[0]
                                dy = touch[1] - self.gesture_start[1]
                                feed_swipe = action == 'up' and abs(dy) > .12 and abs(dy) > 1.4 * abs(dx)
                                if not feed_swipe or not self.region:
                                    self.region = None
                                    self.schedule_region(resume=bool(self.auto_face))
                        elif kind == "key":
                            self.region_epoch += 1
                            self.region = None
                            if self.swap_bridge:
                                self.swap_bridge.reset(suspend=True)
                            await self.emulator.key(message.get("key"))
                            self.schedule_region(resume=bool(self.auto_face))
                        else:
                            raise ValueError("unsupported control message")
                    done = time.perf_counter()
                    self.timings.add("inputQueue", (started - received) * 1000)
                    self.timings.add("emulatorRpcAcknowledgement", (done - started) * 1000)
                    self.send({"type": "inputAck", "seq": message.get("seq"),
                               "rpcMs": round((done - started) * 1000, 3),
                               "queueMs": round((started - received) * 1000, 3),
                               "scope": "RPC acceptance, not visible UI response"})
                except Exception:
                    self.send({"type": "error", "message": "Input rejected or emulator unavailable."})
                    await self.close()
        except asyncio.CancelledError:
            raise

    def start(self):
        self.tasks = [asyncio.create_task(self.capture()), asyncio.create_task(self.control()),
                      asyncio.create_task(self.watchdog())]
        if self.swap_bridge is not None:
            self.tasks.append(asyncio.create_task(self.render()))
            self.schedule_region()

    async def watchdog(self):
        while not self.closed:
            await asyncio.sleep(1)
            if time.monotonic() - self.last_message > 15:
                await self.close()

    async def close(self):
        if self.close_task is None:
            self.closed = True
            self.changed.set()
            self.close_task = asyncio.create_task(self._finish_close(asyncio.current_task()))
        # Request cancellation must not report cleanup complete while a touch,
        # WebRTC transport, or emulator channel is still being released.
        await asyncio.shield(self.close_task)

    async def _finish_close(self, caller):
        try:
            if self.region_task:
                self.region_task.cancel()
                await asyncio.gather(self.region_task, return_exceptions=True)
            async with self.input_lock:
                if self.touch.active:
                    try:
                        await self.emulator.touch(*self.touch.last, 0)
                    except Exception:
                        pass
                    self.touch.active = False
            for task in self.tasks:
                if task is not caller:
                    task.cancel()
            await asyncio.gather(*(task for task in self.tasks if task is not caller), return_exceptions=True)
            if self.swap_bridge is not None:
                await self.swap_bridge.close()
            try:
                await self.pc.close()
            finally:
                await self.emulator.close()
        finally:
            self.latest = None
            self.raw_latest = None
            self.changed.set()
            self.close_done.set()

    def status(self):
        return {"version": VERSION, "connection": self.pc.connectionState,
                "capturedFrames": self.captured, "submittedFrames": self.submitted,
                "automaticRegionReady": bool(self.region),
                "displayKeepaliveFrames": self.display_keepalives,
                "submittedFreshFrames": self.submitted - self.display_keepalives,
                "replacedWaitingFrames": self.replaced, "timings": self.timings.public(),
                "coalescedMoveInputs": self.inputs.coalesced,
                "audio": "disabled", "swap": self.swap_bridge.status() if self.swap_bridge else {"enabled": False, "error": "renderer not configured"},
                "transportQualityQualified": False,
                "visibleResponseMs": None,
                "error": self.error}


def make_app(token, emulator_factory, swap_factory=None):
    sessions = set()
    controller_lock = asyncio.Lock()
    @web.middleware
    async def security(request, handler):
        # Static shell contains no session data. Every API call requires pairing.
        if request.path != "/" and not authorized(
                request.headers.get("Authorization", "").removeprefix("Bearer "), token):
            raise web.HTTPUnauthorized()
        origin = request.headers.get("Origin")
        if origin and origin != f"{request.scheme}://{request.host}":
            raise web.HTTPForbidden()
        response = await handler(request)
        response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                 "X-Content-Type-Options": "nosniff",
                                 "X-Frame-Options": "DENY"})
        return response
    app = web.Application(middlewares=[security], client_max_size=64 * 1024)

    async def home(request):
        return web.FileResponse(Path(__file__).with_name("client.html"))

    async def offer(request):
        data = await request.json()
        if not isinstance(data, dict) or data.get("type") != "offer" or not isinstance(data.get("sdp"), str):
            raise web.HTTPBadRequest()
        async with controller_lock:
            if any(not s.close_done.is_set() for s in sessions):
                raise web.HTTPConflict(text="A controller is already connected.")
            sessions.clear()
            try:
                emulator = emulator_factory()
            except ValueError:
                raise web.HTTPServiceUnavailable(text='Start the authenticated TikTok source emulator first.')
            session = Session(emulator, swap_factory() if swap_factory else None)
            sessions.add(session)
            try:
                await session.pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type="offer"))
                await session.pc.setLocalDescription(await session.pc.createAnswer())
                session.start()
                return web.json_response({"sdp": session.pc.localDescription.sdp, "type": "answer"})
            except asyncio.CancelledError:
                await session.close()
                raise
            except Exception:
                await session.close()
                raise web.HTTPBadRequest(text="Could not negotiate remote session.")

    async def status(request):
        return web.json_response({"version": VERSION, "automaticVideoRegion": True,
                                 "sessions": [s.status() for s in sessions]})

    async def disconnect(request):
        async with controller_lock:
            await asyncio.gather(*(s.close() for s in sessions))
        return web.json_response({"ok": True})

    async def cleanup(app):
        await asyncio.gather(*(s.close() for s in sessions))

    async def swap(request):
        data = await request.json()
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text="Expected an object")
        live = [s for s in sessions if not s.closed]
        if len(live) != 1:
            raise web.HTTPConflict(text="Connect a live screen first")
        try:
            state = await live[0].configure_swap(data)
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
        return web.json_response({"ok": True, "swap": state})

    app.router.add_get("/", home)
    app.router.add_post("/offer", offer)
    app.router.add_get("/status", status)
    app.router.add_post("/disconnect", disconnect)
    app.router.add_post("/swap", swap)
    app.on_cleanup.append(cleanup)
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8820)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--emulator-discovery", type=Path, required=True)
    parser.add_argument("--pairing-token-file", type=Path, required=True)
    parser.add_argument("--renderer-token-file", type=Path)
    parser.add_argument("--adb", type=Path, default=Path(os.environ.get('LOCALAPPDATA', '')) / 'Android/Sdk/platform-tools/adb.exe')
    parser.add_argument("--device", default='emulator-5580')
    args = parser.parse_args()
    from discovery import SourceDiscovery
    try:
        discovery = SourceDiscovery(args.emulator_discovery, args.device)
    except (OSError, ValueError):
        parser.error('Authenticated emulator discovery must match the source device')
    token = args.pairing_token_file.read_text().strip()
    if len(token) < 32:
        parser.error("pairing token must contain at least 32 characters")
    swap_factory = None
    if args.renderer_token_file:
        from swap_bridge import SwapBridge
        renderer_token = args.renderer_token_file.read_text().strip()
        if len(renderer_token) < 32:
            parser.error("renderer token must contain at least 32 characters")
        swap_factory = lambda: SwapBridge(renderer_token)
    def emulator_factory():
        endpoint, grpc_token = discovery.resolve()
        return Emulator(endpoint, grpc_token, args.bindings, args.adb, args.device)
    app = make_app(token, emulator_factory, swap_factory)
    # Loopback by default. Phone access requires an authenticated HTTPS gateway;
    # do not expose emulator control or credentials directly on the LAN.
    web.run_app(app, host="127.0.0.1", port=args.port, access_log=None)


if __name__ == "__main__":
    main()
