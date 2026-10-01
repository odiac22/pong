"""Gateway authorization tests; no emulator, live services or real tokens."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from starlette.requests import Request
from pong_remote_gateway import create_remote_gateway


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'token'
        self.token = 'a'*48
        self.path.write_text(self.token)
        self.endpoint = create_remote_gateway(self.path).routes[0].endpoint
        self.mock = patch('pong_remote_gateway._forward', return_value=(200, b'{"ok":true}'))
        self.forward = self.mock.start()

    async def asyncTearDown(self):
        self.mock.stop()
        self.temp.cleanup()

    async def call(self, operation='status', method='GET', header=None, host='127.0.0.1', body=b''):
        headers = [] if header is None else [(b'authorization', header.encode())]
        scope = {'type':'http','method':method,'path':'/remote/'+operation,
                 'headers':headers,'client':(host,12345),'query_string':b''}
        async def receive():
            return {'type':'http.request','body':body,'more_body':False}
        try:
            return await self.endpoint(operation, Request(scope, receive))
        except HTTPException as exc:
            return exc

    async def test_requires_pairing_even_on_loopback(self):
        for header in (None, 'Bearer wrong', self.token):
            self.assertEqual((await self.call(header=header)).status_code, 401)
        self.forward.assert_not_called()

    async def test_rejects_direct_lan_client(self):
        self.assertEqual((await self.call(header='Bearer '+self.token, host='192.168.1.20')).status_code, 403)

    async def test_forwards_only_fixed_target_and_pairing_token(self):
        response = await self.call('swap', 'POST', 'Bearer '+self.token, body=b'{"enabled":false}')
        self.assertEqual(response.status_code, 200)
        self.forward.assert_called_once_with('POST', 'swap', b'{"enabled":false}', self.token)
        self.assertEqual(response.headers['cache-control'], 'no-store')

    async def test_rejects_wrong_method_and_unknown_operation(self):
        self.assertEqual((await self.call('offer', header='Bearer '+self.token)).status_code, 404)
        self.assertEqual((await self.call('shell','POST',header='Bearer '+self.token)).status_code, 404)
        self.forward.assert_not_called()

    async def test_request_size_is_bounded_before_forwarding(self):
        self.assertEqual((await self.call('offer','POST','Bearer '+self.token,body=b'x'*65537)).status_code, 413)
        self.forward.assert_not_called()

    async def test_missing_token_reports_not_ready(self):
        self.path.unlink()
        self.assertEqual((await self.call(header='Bearer '+self.token)).status_code, 503)

    async def test_short_token_refused(self):
        self.path.write_text('short')
        self.assertEqual((await self.call(header='Bearer '+self.token)).status_code, 503)

    async def test_unavailable_sidecar_is_service_unavailable(self):
        self.forward.side_effect = OSError('unavailable')
        self.assertEqual((await self.call(header='Bearer '+self.token)).status_code, 503)


if __name__ == '__main__':
    unittest.main()
