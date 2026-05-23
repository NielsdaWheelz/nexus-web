"""Unit tests for YouTube transcript provider boundary."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass

import pytest

from nexus.config import get_settings
from nexus.services.youtube_transcripts import fetch_youtube_transcript

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _settings_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
    monkeypatch.setenv("NEXUS_ENV", "test")
    monkeypatch.setenv("SUPABASE_JWKS_URL", "http://localhost:54321/auth/v1/.well-known/jwks.json")
    monkeypatch.setenv("SUPABASE_ISSUER", "http://localhost:54321/auth/v1")
    monkeypatch.setenv("SUPABASE_AUDIENCES", "authenticated")
    monkeypatch.setenv("PODCASTS_ENABLED", "false")
    monkeypatch.setenv("YOUTUBE_DATA_API_KEY", "test-youtube-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@dataclass
class _FakeFetchedTranscriptSnippet:
    start: float
    duration: float
    text: str


def _install_fake_provider(monkeypatch, fetch_impl, init_impl=None):
    module = types.ModuleType("youtube_transcript_api")

    class FakeYouTubeTranscriptApi:
        def __init__(self, *args, **kwargs):
            if init_impl is not None:
                init_impl(*args, **kwargs)

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

    def test_provider_http_client_uses_configured_timeout(self, monkeypatch):
        monkeypatch.setenv("YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS", "12.5")
        get_settings.cache_clear()
        captured: dict[str, float | None] = {}

        def _capture_request(_session, _method, _url, **kwargs):
            captured["timeout"] = kwargs.get("timeout")

        monkeypatch.setattr("requests.sessions.Session.request", _capture_request)

        def _capture_http_client(*_args, http_client, **_kwargs):
            http_client.get("https://example.invalid/transcript")

        def _ok_fetch(_video_id: str):
            return [_FakeFetchedTranscriptSnippet(start=0.5, duration=1.0, text="first")]

        try:
            _install_fake_provider(monkeypatch, _ok_fetch, _capture_http_client)
            result = fetch_youtube_transcript("dQw4w9WgXcQ")
        finally:
            get_settings.cache_clear()

        assert result["status"] == "completed", (
            f"expected completed status for successful provider response, got {result}"
        )
        assert captured["timeout"] == 12.5, (
            f"expected configured YouTube transcript timeout, got {captured}"
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

    def test_dict_segment_rows_without_provider_attributes_are_rejected(self, monkeypatch):
        def _fetch_dict_rows(_video_id: str):
            return [{"start": 0.5, "duration": 1.0, "text": "dict row snippet"}]

        _install_fake_provider(monkeypatch, _fetch_dict_rows)
        result = fetch_youtube_transcript("dQw4w9WgXcQ")

        assert result["status"] == "failed", (
            f"expected failed status for dict rows without provider attributes, got {result}"
        )
        assert result["error_code"] == "E_TRANSCRIPT_UNAVAILABLE", (
            f"expected E_TRANSCRIPT_UNAVAILABLE for dict rows without provider attributes, got {result}"
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
