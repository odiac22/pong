"""Fixed loopback gateway for the authenticated WebRTC sidecar.

Pong's existing authenticated/origin-checked /pong-swap proxy reaches this router.
Only the remote-control pairing token reaches the phone. Renderer and emulator
tokens stay on the PC. No arbitrary proxy URLs.
"""
from pathlib import Path
import asyncio
import secrets
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, ProxyHandler, HTTPRedirectHandler, build_opener
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _forward(method, operation, body, token):
    """Fixed loopback hop, off the ASGI loop, with no new runtime dependency."""
    request = UrlRequest('http://127.0.0.1:8820/'+operation,
        data=body if method == 'POST' else None, method=method,
        headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        upstream = opener.open(request, timeout=20)
    except HTTPError as error:
        upstream = error
    with upstream:
        content = upstream.read(64*1024+1)
        if len(content) > 64*1024:
            raise ValueError('Oversized control response')
        return upstream.code, content


def create_remote_gateway(token_path: Path):
    router = APIRouter(prefix='/remote')
    allowed = {'offer': 'POST', 'status': 'GET', 'disconnect': 'POST', 'swap': 'POST'}

    @router.api_route('/{operation}', methods=['GET', 'POST'])
    async def gateway(operation: str, request: Request):
        if allowed.get(operation) != request.method:
            raise HTTPException(404, 'Unknown remote operation')
        if request.client is None or request.client.host not in ('127.0.0.1', '::1'):
            raise HTTPException(403, 'Use the Pong gateway')
        try:
            token = token_path.read_text().strip()
        except OSError:
            raise HTTPException(503, 'TikTok remote is not started on the PC')
        if len(token) < 32:
            raise HTTPException(503, 'TikTok remote pairing is not configured')
        # LAN membership alone must not grant control of a logged-in account.
        # This is a remote-control pairing token, never the renderer token or a
        # TikTok credential. Node forwards it without logging its value.
        supplied = request.headers.get('authorization', '')
        if not supplied.startswith('Bearer ') or not secrets.compare_digest(supplied[7:], token):
            raise HTTPException(401, 'Pair this Pong client with TikTok remote first')
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 64 * 1024:
                raise HTTPException(413, 'Remote control request too large')
        try:
            status, content = await asyncio.to_thread(_forward, request.method, operation, bytes(body), token)
        except (URLError, OSError, ValueError):
            raise HTTPException(503, 'TikTok remote service is unavailable on the PC')
        return Response(content, status_code=status,
                        media_type='application/json',
                        headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    return router
