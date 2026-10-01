import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

class MediaSourceStartupTests(unittest.TestCase):
    def test_explicit_mse_keeps_normal_browser_sniff_guard(self):
        tree=ast.parse((Path(__file__).parent/'pong_swap_engine.py').read_text(encoding='utf-8'))
        method=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='stream_startup_ready')
        scope={};exec(compile(ast.Module(body=[method],type_ignores=[]),'startup','exec'),scope)
        state=SimpleNamespace(media_fragment_ready=False,complete_fragments=0,browser_startup_ready=lambda:False)
        ready=scope['stream_startup_ready']
        self.assertFalse(ready(state,True))
        state.media_fragment_ready=True
        self.assertFalse(ready(state,True))
        state.complete_fragments=1
        self.assertTrue(ready(state,True))
        self.assertFalse(ready(state))
        state.browser_startup_ready=lambda:True
        self.assertTrue(ready(state))
