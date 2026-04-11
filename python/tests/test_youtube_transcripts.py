"""Unit tests for YouTube transcript provider boundary."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass

import pytest

from nexus.services.youtube_transcripts import fetch_youtube_transcript

pytestmark = pytest.mark.unit


@dataclass
class _FakeFetchedTranscriptSnippet:
    start: float
    duration: float
    text: str


def _install_fake_provider(monkeypatch, fetch_impl):
    module = types.ModuleType("youtube_transcript_api")

    class FakeYouTubeTranscriptApi:
        def fetch(self, video_id: str):
            return fetch_impl(video_id)

    module.YouTubeTranscriptApi = FakeYouTubeTranscriptApi
    monkeypatch.setitem(sys.modules, "youtube_transcript_api", module)


class TestYoutubeTranscriptBoundary:
    def test_empty_video_id_returns_transcript_unavailable(self):
        result = fetch_youtube_transcript("")

        assert result["status"] == "failed", (
            f"expected failed status for empty video id, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"expected E_TRANSCRIPT_UNAVAILABLE for empty video id, got {result}"
        )

    def test_missing_dependency_maps_to_transcription_failed(self, monkeypatch):
        monkeypatch.setitem(
            sys.modules, "youtube_transcript_api", types.ModuleType("youtube_transcript_api")
        )

        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"expected failed status when provider class is missing, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPTION_FAILED", (
            f"expected E_TRANSCRIPTION_FAILED when provider class is missing, got {result}"
        )

    def test_known_unavailable_provider_error_maps_to_transcript_unavailable(self, monkeypatch):
        class NoTranscriptFound(Exception):
            pass

        def _raise_unavailable(_video_id: str):
            raise NoTranscriptFound("no transcript")

        _install_fake_provider(monkeypatch, _raise_unavailable)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"expected failed status for unavailable transcript, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"expected E_TRANSCRIPT_UNAVAILABLE for unavailable transcript, got {result}"
        )

    def test_timeout_provider_error_maps_to_transcription_timeout(self, monkeypatch):
        class ProviderTimeout(Exception):
            pass

        def _raise_timeout(_video_id: str):
            raise ProviderTimeout("timeout")

        _install_fake_provider(monkeypatch, _raise_timeout)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"expected failed status for provider timeout, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPTION_TIMEOUT", (
            f"expected E_TRANSCRIPTION_TIMEOUT for provider timeout, got {result}"
        )

    @pytest.mark.parametrize(
        "error_class_name",
        [
            "RequestBlocked",
            "IpBlocked",
            "PoTokenRequired",
            "InvalidVideoId",
            "VideoUnplayable",
        ],
    )
    def test_new_unavailable_provider_errors_map_to_transcript_unavailable(
        self, monkeypatch, error_class_name: str
    ):
        provider_error = type(error_class_name, (Exception,), {})

        def _raise_blocked(_video_id: str):
            raise provider_error("blocked")

        _install_fake_provider(monkeypatch, _raise_blocked)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"{error_class_name}: expected failed status for blocked provider request, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"{error_class_name}: expected E_TRANSCRIPT_UNAVAILABLE for blocked provider request, "
            f"got {result}"
        )

    def test_legacy_dict_segments_are_rejected_after_provider_cutover(self, monkeypatch):
        def _legacy_fetch(_video_id: str):
            return [{"start": 0.5, "duration": 1.0, "text": "legacy dict snippet"}]

        _install_fake_provider(monkeypatch, _legacy_fetch)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"expected failed status for legacy dict segments after cutover, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"expected E_TRANSCRIPT_UNAVAILABLE for legacy dict segments after cutover, got {result}"
        )

    def test_successful_fetch_normalizes_and_sorts_segments(self, monkeypatch):
        def _ok_fetch(_video_id: str):
            return [
                _FakeFetchedTranscriptSnippet(start=2.0, duration=1.5, text="second"),
                _FakeFetchedTranscriptSnippet(start=0.5, duration=1.0, text="first"),
            ]

        _install_fake_provider(monkeypatch, _ok_fetch)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "completed", (
            f"expected completed status for successful provider response, got {result}"
        )
        assert [segment["t_start_ms"] for segment in result["segments"]] == [500, 2000], (
            "expected transcript segments to be sorted by t_start_ms ascending"
        )
