"""Run signed-manager touch qualification against an isolated 7.35.1 snapshot."""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'signed_manager_harness', Path(__file__).with_name('qualify-current-tampermonkey-manager.py')
)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)

output = Path(r'E:\Pong Benchmarks\v3031-tampermonkey-7351-w3c')
case = sys.argv[1] if len(sys.argv) > 1 else 'w3c'
harness.OUT = output
harness.REPORT = output / ('report-nasa' if case == 'nasa' else 'report-w3c')
harness.SNAP = output / 'server' / 'universal-video-scraper.user.js'
harness.SITES = ([('NASA+', 'https://plus.nasa.gov/video/moon-base-update-lunar-landers/')]
                 if case == 'nasa' else
                 [('W3C HTML5 media events', 'https://www.w3.org/2010/05/video/mediaevents.html')])

if __name__ == '__main__':
    harness.main()
