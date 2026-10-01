"""Bounded full-resolution bridge to the existing warm Pong renderer."""
import asyncio
import time
import numpy as np
from aiohttp import ClientSession, ClientTimeout
from core import normalized_roi


def composite_frame(rgb, data, bounds):
    """Publish an owned, immutable frame; never alter capture pixels in place."""
    x1, y1, x2, y2 = bounds
    result = rgb.copy()
    result[y1:y2, x1:x2] = np.frombuffer(data, np.uint8).reshape(y2-y1, x2-x1, 3)
    # Encoder wrapping can retain this buffer instead of copying the entire
    # screen again. The frame owns its allocation and is never mutated later.
    result.setflags(write=False)
    return result


class SwapBridge:
    def __init__(self, token):
        self.http = ClientSession(timeout=ClientTimeout(total=15), trust_env=False,
                                  headers={'Authorization': 'Bearer ' + token})
        self.base = 'http://127.0.0.1:8792/remote-sessions'
        self.session_id = None
        self.enabled = False
        self.face_id = ''
        self.roi = None
        self.shape = None
        self.revision = 0
        self.needs_cut = True
        self.error = None
        self.transformed = 0
        self.processed = 0
        self.last_render_ms = None
        self.first_swap_ms = None
        self.enabled_at = None
        self.lock = asyncio.Lock()

    async def _json(self, method, url, **kwargs):
        async with self.http.request(method, url, **kwargs) as response:
            if response.status >= 400:
                raise RuntimeError('Swap renderer HTTP ' + str(response.status))
            return await response.json()

    async def configure(self, body, width, height):
        requested_at = time.perf_counter()
        async with self.lock:
            self.revision += 1
            self.enabled = False
            self.error = None
            await self._delete()
            if not body.get('enabled'):
                return self.status()
            face = body.get('faceId')
            if not isinstance(face, str) or not face or len(face) > 200:
                raise ValueError('Select an approved face')
            if body.get('regionConfirmed') is not True:
                raise ValueError('Mark and confirm the video region first')
            roi = normalized_roi(body.get('roi'))
            if width < 1 or height < 1:
                raise ValueError('Wait for the live screen first')
            x1, y1, x2, y2 = self.bounds(roi, width, height)
            if min(x2 - x1, y2 - y1) < 64:
                raise ValueError('Video region is too small')
            payload = await self._json('POST', self.base,
                json={'faceId': face, 'width': x2-x1, 'height': y2-y1, 'fps': 30})
            self.session_id = payload.get('id') or payload.get('session', {}).get('id')
            if not self.session_id:
                raise RuntimeError('Renderer did not return a session')
            self.roi, self.face_id, self.shape = roi, face, (height, width)
            self.needs_cut = True
            self.enabled = True
            self.first_swap_ms = None
            self.enabled_at = requested_at
            return self.status()

    @staticmethod
    def bounds(roi, width, height):
        a,b,c,d = roi
        return int(a*width), int(b*height), min(width,int(c*width)), min(height,int(d*height))

    def reset(self, suspend=False):
        self.revision += 1
        self.needs_cut = True
        if suspend:
            self.enabled = False
            self.error = 'Swap paused for navigation. Re-enable on a video, not a profile or menu.'

    def begin_video(self):
        self.first_swap_ms = None
        self.enabled_at = time.perf_counter()
        self.needs_cut = True

    async def render(self, rgb, seq, stamp):
        revision = self.revision
        if not self.enabled or not self.session_id:
            return None
        if rgb.shape[:2] != self.shape:
            self.reset(suspend=True)
            self.error = 'Screen orientation changed; confirm the video region again.'
            return None
        x1,y1,x2,y2 = self.bounds(self.roi, rgb.shape[1], rgb.shape[0])
        crop = np.ascontiguousarray(rgb[y1:y2,x1:x2])
        cut = self.needs_cut
        self.needs_cut = False
        url = self.base + '/' + self.session_id + '/frame'
        try:
            async with self.http.put(url, params={'seq':str(seq),'cut':str(int(cut)),
                    'timestampMs':str(stamp/1000)}, data=crop.tobytes(),
                    headers={'Content-Type':'application/octet-stream'}) as response:
                if response.status >= 400:
                    raise RuntimeError('Swap frame HTTP ' + str(response.status))
                data = await response.read()
                if len(data) != crop.nbytes:
                    raise RuntimeError('Wrong renderer frame dimensions')
                if int(response.headers.get('X-Pong-Remote-Seq','-1')) != seq:
                    raise RuntimeError('Wrong renderer frame sequence')
                transformed = response.headers.get('X-Pong-Remote-Transformed') == '1'
                self.last_render_ms = float(response.headers.get('X-Pong-Remote-Render-Ms','0'))
        except Exception as exc:
            if revision == self.revision:
                self.error = str(exc)
                self.enabled = False
            return None
        if revision != self.revision or not self.enabled:
            return None
        self.processed += 1
        self.transformed += int(transformed)
        if transformed and self.first_swap_ms is None:
            self.first_swap_ms = (time.perf_counter()-self.enabled_at)*1000
        result = composite_frame(rgb, data, (x1, y1, x2, y2))
        return result, transformed

    async def _delete(self):
        old, self.session_id = self.session_id, None
        if old:
            try:
                async with self.http.delete(self.base + '/' + old) as response:
                    await response.read()
            except Exception:
                pass

    async def close(self):
        self.reset(suspend=True)
        await self._delete()
        await self.http.close()

    def status(self):
        return dict(enabled=self.enabled, faceId=self.face_id, roi=self.roi,
                    processedFrames=self.processed, transformedFrames=self.transformed,
                    renderMs=self.last_render_ms, firstSwappedFrameMs=self.first_swap_ms,
                    firstSwapScope='PC render completion; not phone presentation', error=self.error)
