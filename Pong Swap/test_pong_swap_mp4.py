import struct
import unittest
from pong_swap_mp4 import MovieDurationInitializer, set_movie_duration

def box(kind, payload):
    return struct.pack('>I4s', 8 + len(payload), kind) + payload

def header(kind, version=0, scale=1000):
    p = bytearray(100)
    p[0] = version
    if kind != b'tkhd':
        struct.pack_into('>I', p, 20 if version else 12, scale)
    return box(kind, p)

class DurationTests(unittest.TestCase):
    def test_versions_and_track_order(self):
        for version in (0, 1):
            track = box(b'trak', header(b'tkhd',version)+box(b'mdia',header(b'mdhd',version,30000)))
            init = box(b'moov', track+header(b'mvhd',version))
            result = set_movie_duration(init, 12.5)
            self.assertEqual(len(init),len(result))
            width = 8 if version else 4
            for kind, offset, expected in ((b'mvhd',24 if version else 16,12500),(b'mdhd',24 if version else 16,375000),(b'tkhd',28 if version else 20,12500)):
                at=result.index(kind)+4+offset
                self.assertEqual(int.from_bytes(result[at:at+width],'big'),expected)

    def test_all_chunk_sizes_samples_untouched(self):
        init=box(b'moov',header(b'mvhd'))
        media=box(b'moof',b'sample timestamps')+box(b'mdat',bytes(range(256)))
        source=box(b'ftyp',b'isom0000')+init+media
        expected=box(b'ftyp',b'isom0000')+set_movie_duration(init,15)+media
        for size in (1,3,7,9,64,10000):
            parser=MovieDurationInitializer(15)
            output=b''.join(parser.feed(source[n:n+size]) for n in range(0,len(source),size))+parser.feed(b'',eof=True)
            self.assertEqual(output,expected)

    def test_unknown_and_malformed_passthrough(self):
        for seconds in (0,-1,float('inf'),float('nan')):
            source=box(b'moov',header(b'mvhd'))
            self.assertEqual(MovieDurationInitializer(seconds).feed(source),source)
        for source in (b'abc',box(b'moov',b'broken'),struct.pack('>I4s',0,b'moov')+b'x'):
            parser=MovieDurationInitializer(12)
            self.assertEqual(parser.feed(source)+parser.feed(b'',eof=True),source)

if __name__=='__main__':unittest.main()
