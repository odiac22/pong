"""CPU-only ownership tests for the Windows native-DLL bootstrap."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).parent / 'engine' / 'Rope' / 'rope' / '_native_dlls.py'


def load_module():
    spec = importlib.util.spec_from_file_location('native_dll_bootstrap_contract', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeDllBootstrapTests(unittest.TestCase):
    def test_directory_handle_is_retained_for_process_lifetime(self):
        module = load_module()
        handle = object()
        calls = []
        fake_path = SimpleNamespace(
            dirname=lambda _value: 'C:/fixture/tensorrt_libs',
            isdir=lambda _value: True,
            basename=lambda value: value.rsplit('/', 1)[-1],
        )
        module.sys = SimpleNamespace(platform='win32')
        module.importlib = SimpleNamespace(
            import_module=lambda _name: SimpleNamespace(__file__='C:/fixture/tensorrt_libs/__init__.py')
        )
        module.os = SimpleNamespace(
            path=fake_path,
            add_dll_directory=lambda value: calls.append(value) or handle,
        )
        module._BOOTSTRAPPED = False
        module._NATIVE_DLL_DIRECTORY_HANDLES.clear()

        self.assertEqual(module.ensure_native_dll_search_path(), ['C:/fixture/tensorrt_libs'])
        self.assertEqual(calls, ['C:/fixture/tensorrt_libs'])
        self.assertEqual(module._NATIVE_DLL_DIRECTORY_HANDLES, [handle])

        self.assertEqual(module.ensure_native_dll_search_path(), [])
        self.assertEqual(calls, ['C:/fixture/tensorrt_libs'])
        self.assertEqual(module._NATIVE_DLL_DIRECTORY_HANDLES, [handle])


if __name__ == '__main__':
    unittest.main()
