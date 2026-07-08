"""Integration tests for POST /walknotes/transcribe-audio."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.podcasts.deepgram_adapter import TranscriptionResult
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _post_audio(
    client: TestClient,
    user_id,
    audio: bytes = b"fake-audio-bytes",
    content_type: str = "audio/webm;codecs=opus",
    max_duration_seconds: float = 120.0,
) -> object:
    return client.post(
        "/walknotes/transcribe-audio",
        files={"audio": ("voice.webm", audio, content_type)},
        data={
            "content_type": content_type,
            "max_duration_seconds": str(max_duration_seconds),
        },
        headers=auth_headers(user_id),
    )


def _grant_transcribe(direct_db: DirectSessionManager, user_id) -> None:
    """Grant unlimited transcription entitlement and commit so the app session sees it.

    The billing_entitlement_override_events table has a FK to billing_entitlement_overrides
    (NO ACTION), so events must be registered for cleanup before overrides (LIFO order ensures
    events are deleted first).
    """
    # LIFO: overrides registered first → deleted second; events registered second → deleted first
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="walknotes test",
            actor_label="test",
        )
        session.commit()


class TestWalknotesTranscribeAudio:
    def test_unauthenticated_request_returns_401(self, client):
        response = client.post(
            "/walknotes/transcribe-audio",
            files={"audio": ("voice.webm", b"data", "audio/webm")},
            data={"content_type": "audio/webm", "max_duration_seconds": "10"},
        )
        assert response.status_code == 401

    def test_free_user_without_transcribe_entitlement_returns_429(
        self, auth_client: TestClient, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)

        # First request bootstraps the user (free tier, no entitlement grant)
        response = _post_audio(auth_client, user_id)

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "E_PODCAST_QUOTA_EXCEEDED"

    def test_audio_over_10mb_returns_file_too_large(
        self,
        auth_client: TestClient,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        _grant_transcribe(direct_db, user_id)

        oversized = b"x" * (10 * 1024 * 1024 + 1)
        response = _post_audio(auth_client, user_id, audio=oversized)

        # E_FILE_TOO_LARGE maps to HTTP 400 in this codebase (not 413)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_FILE_TOO_LARGE"

    def test_successful_transcription_returns_transcript_and_duration(
        self,
        auth_client: TestClient,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        _grant_transcribe(direct_db, user_id)

        fake_result = TranscriptionResult(
            status="completed",
            segments=[
                {"text": "Hello world.", "t_start_ms": 0, "t_end_ms": 1500, "speaker_label": None},
                {"text": "Nice walk.", "t_start_ms": 1500, "t_end_ms": 3000, "speaker_label": None},
            ],
        )

        monkeypatch.setattr(
            "nexus.services.podcasts.deepgram_adapter.DeepgramClient.transcribe_raw_audio",
            lambda self, audio_bytes, content_type: fake_result,
        )

        response = _post_audio(auth_client, user_id)

        assert response.status_code == 200
        payload = response.json()["data"]
        assert payload["transcript"] == "Hello world. Nice walk."
        assert payload["duration_ms"] == 3000

    def test_transcription_failure_returns_502(
        self,
        auth_client: TestClient,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        _grant_transcribe(direct_db, user_id)

        fake_result = TranscriptionResult(
            status="failed",
            error_code="E_TRANSCRIPTION_FAILED",
            error_message="Provider returned error",
        )

        monkeypatch.setattr(
            "nexus.services.podcasts.deepgram_adapter.DeepgramClient.transcribe_raw_audio",
            lambda self, audio_bytes, content_type: fake_result,
        )

        response = _post_audio(auth_client, user_id)

        assert response.status_code == 502

    def test_transcript_unavailable_from_adapter_returns_409(
        self,
        auth_client: TestClient,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        _grant_transcribe(direct_db, user_id)

        fake_result = TranscriptionResult(
            status="failed",
            error_code="E_TRANSCRIPT_UNAVAILABLE",
            error_message="Transcript unavailable",
        )

        monkeypatch.setattr(
            "nexus.services.podcasts.deepgram_adapter.DeepgramClient.transcribe_raw_audio",
            lambda self, audio_bytes, content_type: fake_result,
        )

        response = _post_audio(auth_client, user_id)

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_TRANSCRIPT_UNAVAILABLE"
