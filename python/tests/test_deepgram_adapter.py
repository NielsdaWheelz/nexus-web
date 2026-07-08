"""Unit tests for DeepgramClient.transcribe_raw_audio."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from nexus.errors import ApiErrorCode
from nexus.services.podcasts.deepgram_adapter import DeepgramClient

pytestmark = pytest.mark.unit


def _client(*, api_key: str | None = "test-key") -> DeepgramClient:
    return DeepgramClient(
        api_key=api_key,
        base_url="https://api.deepgram.test",
        model="nova-2",
        timeout_seconds=30.0,
        use_fixtures=False,
        fixture_dir=None,
    )


def _deepgram_channel_response(transcript: str, duration_seconds: float) -> dict[str, Any]:
    """Minimal Deepgram response shape for the channel/alternatives path."""
    return {
        "metadata": {"duration": duration_seconds},
        "results": {"channels": [{"alternatives": [{"transcript": transcript}]}]},
    }


def _mock_httpx_post(status_code: int, payload: Any) -> MagicMock:
    request = httpx.Request("POST", "https://api.deepgram.test/v1/listen")
    response = httpx.Response(
        status_code=status_code,
        request=request,
        content=json.dumps(payload).encode("utf-8"),
    )
    mock = MagicMock(return_value=response)
    return mock


class TestTranscribeRawAudio:
    def test_returns_completed_result_with_transcript_on_success(self):
        client = _client()
        payload = _deepgram_channel_response("Hello world.", 3.2)

        with patch("httpx.post", _mock_httpx_post(200, payload)):
            result = client.transcribe_raw_audio(b"fake-audio", "audio/webm;codecs=opus")

        assert result.status == "completed"
        assert len(result.segments) == 1
        assert result.segments[0]["text"] == "Hello world."
        assert result.segments[0]["t_start_ms"] == 0
        assert result.segments[0]["t_end_ms"] == 3200

    def test_returns_failure_when_no_api_key(self):
        client = _client(api_key=None)

        result = client.transcribe_raw_audio(b"fake-audio", "audio/webm;codecs=opus")

        assert result.status == "failed"
        assert result.error_code == ApiErrorCode.E_TRANSCRIPTION_FAILED.value

    def test_posts_raw_bytes_without_json_body(self, monkeypatch: pytest.MonkeyPatch):
        client = _client()
        captured: dict[str, Any] = {}

        def fake_post(url: str, *, headers: dict, params: dict, content: bytes, timeout: float):
            captured["url"] = url
            captured["headers"] = headers
            captured["params"] = params
            captured["content"] = content
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                request=request,
                content=json.dumps(_deepgram_channel_response("ok", 1.0)).encode("utf-8"),
            )

        monkeypatch.setattr("httpx.post", fake_post)
        audio = b"\x00\x01\x02"
        client.transcribe_raw_audio(audio, "audio/webm;codecs=opus")

        assert captured["content"] == audio
        assert captured["headers"]["Content-Type"] == "audio/webm;codecs=opus"
        assert "diarize" not in captured["params"]
        assert captured["params"]["smart_format"] == "true"
        assert captured["params"]["punctuate"] == "true"
        assert captured["params"]["language"] == "en"

    def test_returns_timeout_error_on_httpx_timeout(self, monkeypatch: pytest.MonkeyPatch):
        client = _client()

        def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        monkeypatch.setattr("httpx.post", fake_post)
        result = client.transcribe_raw_audio(b"audio", "audio/webm")

        assert result.status == "failed"
        assert result.error_code == ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value

    def test_returns_failed_error_on_http_status_error(self, monkeypatch: pytest.MonkeyPatch):
        client = _client()

        def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
            request = httpx.Request("POST", "https://api.deepgram.test/v1/listen")
            response = httpx.Response(500, request=request, content=b"server error")
            raise httpx.HTTPStatusError("server error", request=request, response=response)

        monkeypatch.setattr("httpx.post", fake_post)
        result = client.transcribe_raw_audio(b"audio", "audio/webm")

        assert result.status == "failed"
        assert result.error_code == ApiErrorCode.E_TRANSCRIPTION_FAILED.value

    def test_returns_timeout_error_on_408_http_status(self, monkeypatch: pytest.MonkeyPatch):
        client = _client()

        def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
            request = httpx.Request("POST", "https://api.deepgram.test/v1/listen")
            response = httpx.Response(408, request=request, content=b"timeout")
            raise httpx.HTTPStatusError("timeout", request=request, response=response)

        monkeypatch.setattr("httpx.post", fake_post)
        result = client.transcribe_raw_audio(b"audio", "audio/webm")

        assert result.status == "failed"
        assert result.error_code == ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value

    def test_returns_unavailable_when_segments_empty(self, monkeypatch: pytest.MonkeyPatch):
        client = _client()

        def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
            request = httpx.Request("POST", "https://api.deepgram.test/v1/listen")
            return httpx.Response(
                200,
                request=request,
                content=json.dumps({"results": {}}).encode("utf-8"),
            )

        monkeypatch.setattr("httpx.post", fake_post)
        result = client.transcribe_raw_audio(b"audio", "audio/webm")

        assert result.status == "failed"
        assert result.error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value

    def test_transcribe_url_path_still_exists(self):
        """Regression guard: the original transcribe(audio_url) method must not be removed."""
        client = _client()
        assert callable(client.transcribe)
