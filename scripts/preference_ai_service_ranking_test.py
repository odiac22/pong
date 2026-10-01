"""Contract tests for Local2's ranking-only thumbnail endpoint.

All image loading and model inference are mocked. No network, audio, video, or
production preference database is accessed.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="pong-ranking-test-"))
os.environ["PONG_PREFERENCE_DATA_DIR"] = str(TEST_DATA_DIR)

import preference_ai_service as service  # noqa: E402


class FakeRankAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.images: list[Image.Image] = []
        self.urls: list[str] = []

    def rank_independent_taste_images(
        self, images: list[Image.Image], *, image_urls: list[str]
    ) -> list[float | None]:
        self.calls += 1
        self.images = list(images)
        self.urls = list(image_urls)
        return [round(image.getpixel((0, 0))[0] / 255.0, 6) for image in images]


def fake_image_for_url(url: str) -> Image.Image:
    value = 204 if "/b.jpg" in url else 51
    return Image.new("RGB", (8, 8), (value, 0, 0))


class Local2ThumbnailRankingContractTests(unittest.TestCase):
    def test_response_preserves_every_input_slot_and_is_anonymous(self) -> None:
        adapter = FakeRankAdapter()
        urls = [
            "https://coomerfans.com/a.jpg",
            "https://invalid.example/not-allowed.jpg",
            "https://coomerfans.com/b.jpg",
            "https://coomerfans.com/a.jpg",
        ]
        before = {
            path.relative_to(TEST_DATA_DIR).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in TEST_DATA_DIR.rglob("*") if path.is_file()
        }
        with (
            patch.object(service, "fetch_image", side_effect=fake_image_for_url) as loader,
            patch.object(service, "local2_clean_adapter", return_value=adapter),
            patch.object(service, "local2_clean_revision", return_value="test-revision"),
        ):
            result = service.local2_clean_rank_thumbnails({"thumbnailUrls": urls})

        self.assertEqual([0, 1, 2, 3], [item["index"] for item in result["items"]])
        self.assertEqual([0.2, None, 0.8, 0.2], [item["rank"] for item in result["items"]])
        self.assertEqual([True, False, True, True], [item["available"] for item in result["items"]])
        self.assertEqual(1, adapter.calls)
        self.assertEqual(2, len(adapter.images), "duplicate URLs must be inferred once")
        self.assertEqual(2, loader.call_count, "duplicate URLs must be fetched once and mapped twice")
        self.assertEqual(3, result["ranked"])
        self.assertTrue(result["head_available"])
        self.assertEqual("memory-only", result["input_storage"])
        serialized = json.dumps(result).lower()
        for forbidden in (
            "decision", "verdict", "accepted", "rejected", "reason_code",
            "hard_verified", "preference_threshold",
        ):
            self.assertNotIn(forbidden, serialized)
        for url in urls:
            self.assertNotIn(url.lower(), serialized)
        after = {
            path.relative_to(TEST_DATA_DIR).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in TEST_DATA_DIR.rglob("*") if path.is_file()
        }
        self.assertEqual(before, after, "ranking must not persist images, vectors, or feedback")

    def test_bounds_are_validated_before_image_io(self) -> None:
        invalid_payloads = [
            [],
            {},
            {"thumbnailUrls": "https://coomerfans.com/a.jpg"},
            {"thumbnailUrls": []},
            {"thumbnailUrls": ["https://coomerfans.com/a.jpg"] * 17},
            {"thumbnailUrls": [123]},
            {"thumbnailUrls": ["x" * 2049]},
        ]
        with patch.object(service, "fetch_image", side_effect=AssertionError("must not load")) as loader:
            for payload in invalid_payloads:
                with self.subTest(payload_type=type(payload).__name__):
                    with self.assertRaises(ValueError):
                        service.local2_clean_rank_thumbnails(payload)
        self.assertEqual(0, loader.call_count)

        with (
            patch.object(service, "fetch_image", side_effect=fake_image_for_url) as loader,
            patch.object(service, "local2_clean_adapter", return_value=FakeRankAdapter()),
            patch.object(service, "local2_clean_revision", return_value="test-revision"),
        ):
            result = service.local2_clean_rank_thumbnails({
                "thumbnailUrls": ["https://coomerfans.com/a.jpg"] * 16
            })
        self.assertEqual(16, result["count"])
        self.assertEqual(1, loader.call_count)

    def test_inference_failure_closes_every_decoded_image(self) -> None:
        loaded: list[Image.Image] = []

        def load(url: str) -> Image.Image:
            image = fake_image_for_url(url)
            loaded.append(image)
            return image

        class BrokenAdapter:
            @staticmethod
            def rank_independent_taste_images(
                images: list[Image.Image], *, image_urls: list[str]
            ) -> list[float | None]:
                raise ValueError("model output mismatch")

        with (
            patch.object(service, "fetch_image", side_effect=load),
            patch.object(service, "local2_clean_adapter", return_value=BrokenAdapter()),
        ):
            with self.assertRaisesRegex(ValueError, "model output mismatch"):
                service.local2_clean_rank_thumbnails({
                    "thumbnailUrls": [
                        "https://coomerfans.com/a.jpg",
                        "https://coomerfans.com/b.jpg",
                    ]
                })
        self.assertEqual(2, len(loaded))
        for image in loaded:
            with self.assertRaises(ValueError):
                image.getpixel((0, 0))

    def test_missing_head_keeps_loaded_slots_without_manufacturing_scores(self) -> None:
        class MissingHeadAdapter:
            @staticmethod
            def rank_independent_taste_images(
                images: list[Image.Image], *, image_urls: list[str]
            ) -> list[float | None]:
                return [None] * len(images)

        with (
            patch.object(service, "fetch_image", side_effect=fake_image_for_url),
            patch.object(service, "local2_clean_adapter", return_value=MissingHeadAdapter()),
            patch.object(service, "local2_clean_revision", return_value="test-revision"),
        ):
            result = service.local2_clean_rank_thumbnails({
                "thumbnailUrls": ["https://coomerfans.com/a.jpg"]
            })
        self.assertTrue(result["items"][0]["available"])
        self.assertIsNone(result["items"][0]["rank"])
        self.assertFalse(result["head_available"])
        self.assertEqual(0, result["ranked"])

    def test_handler_maps_validation_to_400_and_blocks_browser_origin(self) -> None:
        def make_handler(origin: str = "") -> tuple[service.Handler, list[tuple[int, object]]]:
            handler = object.__new__(service.Handler)
            handler.path = "/local2-clean/rank-thumbnails"
            handler.headers = {"Origin": origin} if origin else {}
            handler.read_json = lambda: {"thumbnailUrls": []}  # type: ignore[method-assign]
            sent: list[tuple[int, object]] = []
            handler.send_json = lambda status, value: sent.append((status, value))  # type: ignore[method-assign]
            return handler, sent

        handler, sent = make_handler()
        with patch.dict(service.SERVICE_STATE, {"ready": True}):
            handler.do_POST()
        self.assertEqual(400, sent[0][0])

        browser_handler, browser_sent = make_handler("https://coomerfans.com")
        browser_handler.do_POST()
        self.assertEqual(403, browser_sent[0][0])


class Local22HistoryOnlyContractTests(unittest.TestCase):
    def classify(self, *, probability: float, feedback: dict[str, str] | None = None) -> dict[str, object]:
        image = Image.new("RGB", (8, 8), (128, 64, 32))
        with (
            patch.object(service, "load_candidate_images", return_value=([image], ["https://coomerfans.com/a.jpg"])),
            patch.object(service, "local2_known_feedback", return_value=feedback),
            patch.object(service, "history_only_probability", return_value=probability),
            patch.object(service.VISION, "analyze", return_value={
                "feature": service.np.zeros(1154, dtype=service.np.float32),
                "clearBodyImages": 0,
            }) as analyze,
            patch.object(service, "local2_clean_revision", return_value="history-test"),
        ):
            result = service.local2_clean_classify_admitted({
                "preferencePolicy": "local22-history-only",
                "artist": {"artistUrl": "https://coomerfans.com/u/onlyfans/1/example"},
                "candidateImageUrls": ["https://coomerfans.com/a.jpg"],
            })
        self.assertFalse(analyze.call_args.kwargs["include_semantics"])
        return result

    def test_one_history_head_is_the_only_new_artist_decision(self) -> None:
        accepted = self.classify(probability=0.8)
        rejected = self.classify(probability=0.2)
        self.assertEqual("accept", accepted["decision"])
        self.assertEqual("reject", rejected["decision"])
        self.assertTrue(accepted["history_only"])
        self.assertEqual({}, accepted["checks"])
        self.assertFalse(accepted["requires_qwen_review"])

    def test_direct_historical_label_preserves_regression_behavior(self) -> None:
        result = self.classify(
            probability=0.9,
            feedback={"label": "reject", "reason": "prior Red-X", "source": "test"},
        )
        self.assertEqual("reject", result["decision"])
        self.assertEqual("exact_history_feedback", result["reason_code"])
        self.assertTrue(result["exact_feedback_applied"])

def tearDownModule() -> None:
    try:
        service.STORE.db.close()
    finally:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
