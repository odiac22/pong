from __future__ import annotations

import io
import struct
import unittest

import pong_swap_engine


def mp4_box(
    box_type: bytes,
    payload: bytes = b"",
    *,
    extended_size: bool = False,
    extends_to_eof: bool = False,
) -> bytes:
    """Build the top-level ISO-BMFF boxes needed by these CPU-only tests."""
    if len(box_type) != 4:
        raise ValueError("an MP4 box type must be exactly four bytes")
    if extends_to_eof:
        return struct.pack(">I4s", 0, box_type) + payload
    if extended_size:
        return struct.pack(">I4sQ", 1, box_type, 16 + len(payload)) + payload
    return struct.pack(">I4s", 8 + len(payload), box_type) + payload


class FragmentProbeContractTests(unittest.TestCase):
    """Contract for the incremental fMP4 readiness probe used by the spooler.

    This intentionally exercises byte chunks rather than FFmpeg, a browser, or
    the face-swap pipeline.  The spooler may announce a fragment only after a
    complete top-level ``moof`` box and its subsequent complete top-level
    ``mdat`` box have arrived.
    """

    def new_probe(self):
        probe_type = getattr(pong_swap_engine, "_FragmentedMp4Probe", None)
        if probe_type is None:
            self.skipTest("_FragmentedMp4Probe is not implemented yet")
        return probe_type()

    def test_runtime_exposes_the_box_length_aware_probe(self) -> None:
        self.assertIsNotNone(
            getattr(pong_swap_engine, "_FragmentedMp4Probe", None),
            "pong_swap_engine must expose _FragmentedMp4Probe for the spool "
            "writer; substring searches for b'moof'/b'mdat' are not a safe "
            "playability signal",
        )

    @staticmethod
    def init_segment() -> bytes:
        return mp4_box(b"ftyp", b"isom") + mp4_box(b"moov", b"metadata")

    @staticmethod
    def fragment(*, extended_size: bool = False) -> bytes:
        return mp4_box(
            b"moof",
            b"fragment-index",
            extended_size=extended_size,
        ) + mp4_box(
            b"mdat",
            bytes(range(64)),
            extended_size=extended_size,
        )

    def test_complete_moof_and_mdat_are_ready_and_record_exact_end(self) -> None:
        probe = self.new_probe()
        payload = self.init_segment() + self.fragment()

        self.assertTrue(probe.feed(payload))
        self.assertTrue(probe.media_fragment_ready)
        self.assertEqual(probe.first_complete_fragment_end, len(payload))

    def test_first_fragment_end_excludes_later_top_level_boxes(self) -> None:
        probe = self.new_probe()
        first_fragment = self.init_segment() + self.fragment()
        payload = first_fragment + mp4_box(b"free", b"later padding")

        self.assertTrue(probe.feed(payload))
        self.assertEqual(
            probe.first_complete_fragment_end,
            len(first_fragment),
        )

    def test_counts_every_complete_fragment_and_records_latest_end(self) -> None:
        probe = self.new_probe()
        first = self.init_segment() + self.fragment()
        second = self.fragment(extended_size=True)

        self.assertTrue(probe.feed(first))
        self.assertTrue(probe.feed(second))
        self.assertEqual(probe.complete_fragment_count, 2)
        self.assertEqual(probe.first_complete_fragment_end, len(first))
        self.assertEqual(probe.last_complete_fragment_end, len(first) + len(second))

    def test_discards_parsed_prefix_instead_of_retaining_an_entire_video(self) -> None:
        probe = self.new_probe()
        prefix = mp4_box(b"free", b"x" * (1024 * 1024))
        fragment = self.fragment()

        self.assertTrue(probe.feed(prefix + fragment))
        self.assertGreater(probe._discarded, 0)
        self.assertLess(len(probe._buffer), 1024 * 1024)

    def test_box_names_inside_payload_do_not_count_as_top_level_boxes(self) -> None:
        probe = self.new_probe()
        deceptive = mp4_box(
            b"free",
            b"these bytes mention moof and later mdat but are only payload",
        )

        self.assertFalse(probe.feed(deceptive))
        self.assertFalse(probe.media_fragment_ready)
        self.assertIsNone(probe.first_complete_fragment_end)

    def test_mdat_header_and_partial_payload_are_not_ready(self) -> None:
        probe = self.new_probe()
        moof = mp4_box(b"moof", b"index")
        mdat = mp4_box(b"mdat", b"x" * 128)

        self.assertFalse(probe.feed(moof + mdat[:8]))
        self.assertFalse(probe.feed(mdat[8:-1]))
        self.assertFalse(probe.media_fragment_ready)
        self.assertTrue(probe.feed(mdat[-1:]))
        self.assertEqual(
            probe.first_complete_fragment_end,
            len(moof) + len(mdat),
        )

    def test_every_two_chunk_split_preserves_box_boundaries(self) -> None:
        payload = self.init_segment() + self.fragment()
        for split_at in range(len(payload) + 1):
            with self.subTest(split_at=split_at):
                probe = self.new_probe()
                ready_after_first = probe.feed(payload[:split_at])
                self.assertEqual(ready_after_first, split_at == len(payload))
                ready_after_second = probe.feed(payload[split_at:])
                self.assertEqual(ready_after_second, split_at != len(payload))
                self.assertEqual(
                    probe.first_complete_fragment_end,
                    len(payload),
                )

    def test_one_byte_chunks_split_both_standard_headers_and_payloads(self) -> None:
        probe = self.new_probe()
        payload = self.init_segment() + self.fragment()

        for byte_offset, value in enumerate(payload, start=1):
            ready = probe.feed(bytes((value,)))
            self.assertEqual(ready, byte_offset == len(payload))

        self.assertEqual(probe.first_complete_fragment_end, len(payload))

    def test_extended_64_bit_box_sizes_are_supported_across_split_headers(self) -> None:
        probe = self.new_probe()
        init = self.init_segment()
        fragment = self.fragment(extended_size=True)
        payload = init + fragment

        # Split inside the 64-bit largesize fields of both boxes.
        first_split = len(init) + 11
        moof_length = len(mp4_box(b"moof", b"fragment-index", extended_size=True))
        second_split = len(init) + moof_length + 13
        self.assertFalse(probe.feed(payload[:first_split]))
        self.assertFalse(probe.feed(payload[first_split:second_split]))
        self.assertTrue(probe.feed(payload[second_split:]))
        self.assertEqual(probe.first_complete_fragment_end, len(payload))

    def test_zero_sized_mdat_completes_only_when_end_of_stream_is_known(self) -> None:
        probe = self.new_probe()
        moof = mp4_box(b"moof", b"index")
        open_ended_mdat = mp4_box(
            b"mdat",
            b"media bytes with no declared end",
            extends_to_eof=True,
        )

        self.assertFalse(probe.feed(moof + open_ended_mdat))
        self.assertFalse(probe.media_fragment_ready)
        self.assertTrue(probe.feed(b"", eof=True))
        self.assertEqual(
            probe.first_complete_fragment_end,
            len(moof) + len(open_ended_mdat),
        )

    def test_mdat_before_moof_does_not_satisfy_the_fragment(self) -> None:
        probe = self.new_probe()
        prefix_mdat = mp4_box(b"mdat", b"unassociated-media")
        moof = mp4_box(b"moof", b"index")
        interstitial = mp4_box(b"free", b"padding")
        associated_mdat = mp4_box(b"mdat", b"associated-media")

        self.assertFalse(probe.feed(prefix_mdat + moof + interstitial))
        self.assertTrue(probe.feed(associated_mdat))
        self.assertEqual(
            probe.first_complete_fragment_end,
            len(prefix_mdat) + len(moof) + len(interstitial) + len(associated_mdat),
        )

    def test_a_new_moof_replaces_an_unpaired_moof(self) -> None:
        probe = self.new_probe()
        abandoned = mp4_box(b"moof", b"old-index")
        current = mp4_box(b"moof", b"current-index")
        media = mp4_box(b"mdat", b"current-media")

        self.assertFalse(probe.feed(abandoned + current))
        self.assertTrue(probe.feed(media))
        self.assertEqual(
            probe.first_complete_fragment_end,
            len(abandoned) + len(current) + len(media),
        )

    def test_invalid_declared_sizes_fail_instead_of_looping_or_marking_ready(self) -> None:
        for malformed in (
            struct.pack(">I4s", 7, b"moof"),
            struct.pack(">I4sQ", 1, b"mdat", 15),
        ):
            with self.subTest(malformed=malformed):
                probe = self.new_probe()
                with self.assertRaises(ValueError):
                    probe.feed(malformed)

    def test_fixed_size_truncation_at_eof_never_becomes_ready(self) -> None:
        probe = self.new_probe()
        moof = mp4_box(b"moof", b"index")
        mdat = mp4_box(b"mdat", b"payload")

        self.assertFalse(probe.feed(moof + mdat[:-1]))
        self.assertFalse(probe.feed(b"", eof=True))
        self.assertFalse(probe.media_fragment_ready)
        self.assertIsNone(probe.first_complete_fragment_end)

    def test_transport_padding_stays_between_fragments_and_preserves_media(self) -> None:
        sink = io.BytesIO()
        writer = pong_swap_engine._FragmentedMp4TransportWriter(
            sink,
            minimum_fragment_bytes=256,
        )
        source = self.init_segment() + self.fragment() + self.fragment()

        for offset in range(0, len(source), 17):
            writer.write(source[offset:offset + 17])
        writer.finish()

        padded = sink.getvalue()
        verification = self.new_probe()
        self.assertTrue(verification.feed(padded, eof=True))
        self.assertEqual(verification.complete_fragment_count, 2)
        self.assertEqual(writer.probe.complete_fragment_count, 2)
        self.assertEqual(writer.source_bytes, len(source))
        self.assertEqual(writer.bytes_written, len(padded))
        self.assertGreater(writer.padding_bytes, 0)
        self.assertEqual(len(padded), len(source) + writer.padding_bytes)
        self.assertIn(b"free", padded)

    def test_large_fragments_receive_no_transport_padding(self) -> None:
        sink = io.BytesIO()
        writer = pong_swap_engine._FragmentedMp4TransportWriter(
            sink,
            minimum_fragment_bytes=32,
        )
        source = self.init_segment() + self.fragment()

        self.assertTrue(writer.write(source))
        self.assertFalse(writer.finish())
        self.assertEqual(writer.padding_bytes, 0)
        self.assertEqual(sink.getvalue(), source)

    def test_transport_padding_can_be_grouped_into_fewer_free_boxes(self) -> None:
        sink = io.BytesIO()
        writer = pong_swap_engine._FragmentedMp4TransportWriter(
            sink,
            minimum_fragment_bytes=256,
            padding_interval_fragments=2,
        )
        source = self.init_segment() + self.fragment() + self.fragment()

        writer.write(source)
        writer.finish()

        padded = sink.getvalue()
        verification = self.new_probe()
        verification.feed(padded, eof=True)
        self.assertEqual(verification.complete_fragment_count, 2)
        self.assertEqual(padded.count(b"free"), 1)
        self.assertGreater(writer.padding_bytes, 0)


if __name__ == "__main__":
    unittest.main()
