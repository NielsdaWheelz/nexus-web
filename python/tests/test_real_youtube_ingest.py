"""Real YouTube transcript extraction smoke tests.

Exercises fetch_youtube_transcript against live YouTube videos with no mocks.
"""

from typing import Any

import pytest

from nexus.services.youtube_transcripts import fetch_youtube_transcript

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.network,
]

VIDEOS = [
    {
        "video_id": "VMj-3S1tku0",
        "label": "Andrej Karpathy - Micrograd Intro",
        "min_segments": 10,
    },
    {
        "video_id": "pdN-BjDx1_0",
        "label": "The Other Stuff Podcast - Aidan Gomez",
        "min_segments": 10,
    },
    {
        "video_id": "_b9tKsBau9U",
        "label": "Deep Learning with Yacine - AI Research",
        "min_segments": 10,
    },
]


@pytest.fixture(scope="module")
def transcript_results() -> dict[str, dict[str, Any]]:
    """Fetch each video transcript once to keep network tests efficient."""
    results: dict[str, dict[str, Any]] = {}
    for video in VIDEOS:
        result = fetch_youtube_transcript(video["video_id"])
        assert result["status"] in {"completed", "failed"}, (
            f"{video['label']}: expected status in ['completed', 'failed'], got {result}"
        )
        if result["status"] == "failed":
            assert result.get("error_code") == "E_TRANSCRIPT_UNAVAILABLE", (
                f"{video['label']}: expected E_TRANSCRIPT_UNAVAILABLE when transcript is "
                f"not retrievable from current network, got {result}"
            )
        results[video["video_id"]] = result
    return results


class TestRealYouTubeTranscriptExtraction:
    def test_corpus_has_completed_transcript_coverage(
        self,
        transcript_results: dict[str, dict[str, Any]],
    ):
        completed_labels = [
            video["label"]
            for video in VIDEOS
            if transcript_results[video["video_id"]]["status"] == "completed"
        ]
        if not completed_labels:
            pytest.skip(
                "all configured videos returned E_TRANSCRIPT_UNAVAILABLE from this "
                "network/IP; transcript-shape assertions are skipped intentionally"
            )
        assert completed_labels, (
            "expected at least one completed transcript across configured real videos"
        )

    @pytest.mark.parametrize("video", VIDEOS, ids=[item["label"] for item in VIDEOS])
    def test_extraction_has_segments_and_valid_timing(
        self,
        video: dict,
        transcript_results: dict[str, dict[str, Any]],
    ):
        result = transcript_results[video["video_id"]]
        if result["status"] != "completed":
            pytest.skip(
                f"{video['label']}: transcript unavailable from current network/IP: {result}"
            )

        segments = result["segments"]
        assert len(segments) >= video["min_segments"], (
            f"{video['label']}: expected at least {video['min_segments']} segments, "
            f"got {len(segments)}"
        )

        for index, segment in enumerate(segments):
            assert segment["t_start_ms"] >= 0, (
                f"{video['label']}: segment {index} had negative start time "
                f"{segment['t_start_ms']}"
            )
            assert segment["t_end_ms"] > segment["t_start_ms"], (
                f"{video['label']}: segment {index} had non-positive duration "
                f"(start={segment['t_start_ms']} end={segment['t_end_ms']})"
            )
            assert segment["text"] and str(segment["text"]).strip(), (
                f"{video['label']}: segment {index} had empty transcript text"
            )

    @pytest.mark.parametrize("video", VIDEOS, ids=[item["label"] for item in VIDEOS])
    def test_segments_sorted_by_start_time(
        self,
        video: dict,
        transcript_results: dict[str, dict[str, Any]],
    ):
        result = transcript_results[video["video_id"]]
        if result["status"] != "completed":
            pytest.skip(
                f"{video['label']}: transcript unavailable from current network/IP: {result}"
            )

        starts = [segment["t_start_ms"] for segment in result["segments"]]
        assert starts == sorted(starts), (
            f"{video['label']}: expected t_start_ms to be sorted ascending, got {starts[:20]}"
        )
