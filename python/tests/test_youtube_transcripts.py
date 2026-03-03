"""Unit tests for YouTube transcript provider boundary."""

from __future__ import annotations

import sys
import types

import pytest

from nexus.services.youtube_transcripts import fetch_youtube_transcript

pytestmark = pytest.mark.unit


def _install_fake_provider(monkeypatch, get_transcript_impl):
    module = types.ModuleType("youtube_transcript_api")

    class FakeYouTubeTranscriptApi:
        @staticmethod
        def get_transcript(video_id: str):
            return get_transcript_impl(video_id)

    module.YouTubeTranscriptApi = FakeYouTubeTranscriptApi
    monkeypatch.setitem(sys.modules, "youtube_transcript_api", module)


class TestYoutubeTranscriptBoundary:
    def test_empty_video_id_returns_transcript_unavailable(self):
        result = fetch_youtube_transcript("")

        assert result["status"] == "failed"
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE"

    def test_missing_dependency_maps_to_transcription_failed(self, monkeypatch):
        # Simulate successful module import but missing expected API attribute.
        monkeypatch.setitem(
            sys.modules, "youtube_transcript_api", types.ModuleType("youtube_transcript_api")
        )

        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed"
        assert result["error_code"] == "E_TRANSCRIPTION_FAILED"

    def test_known_unavailable_provider_error_maps_to_transcript_unavailable(self, monkeypatch):
        class NoTranscriptFound(Exception):
            pass

        def _raise_unavailable(_video_id: str):
            raise NoTranscriptFound("no transcript")

        _install_fake_provider(monkeypatch, _raise_unavailable)

        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed"
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE"

    def test_timeout_provider_error_maps_to_transcription_timeout(self, monkeypatch):
        class ProviderTimeout(Exception):
            pass

        def _raise_timeout(_video_id: str):
            raise ProviderTimeout("timeout")

        _install_fake_provider(monkeypatch, _raise_timeout)

        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed"
        assert result["error_code"] == "E_TRANSCRIPTION_TIMEOUT"
