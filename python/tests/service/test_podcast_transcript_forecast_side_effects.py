"""Transcript forecasts audit the request without materializing transcript work state."""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    MediaKind,
    MediaTranscriptState,
    Podcast,
    PodcastEpisode,
    PodcastTranscriptionJob,
    PodcastTranscriptionUsageDaily,
    PodcastTranscriptRequestAudit,
    ProcessingStatus,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def test_transcript_forecast_only_persists_its_explicit_audit(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    podcast_id = uuid4()
    media_id = uuid4()
    db_session.add_all(
        [
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"forecast-purity-{podcast_id}",
                title="Forecast purity",
                feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
            ),
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title="Forecast-only episode",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=test_user.id,
            ),
        ]
    )
    db_session.flush()
    db_session.add(
        PodcastEpisode(
            media_id=media_id,
            podcast_id=podcast_id,
            duration_seconds=601,
        )
    )
    assert ensure_media_in_default_library(db_session, test_user.id, media_id)
    grant_entitlement_override(
        db_session,
        user_id=test_user.id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="transcript forecast side-effect proof",
        actor_label="nexus-test",
    )
    db_session.commit()

    response = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open", "dry_run": True},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": "not_requested",
            "transcript_coverage": "none",
            "request_reason": "episode_open",
            "required_minutes": 11,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": False,
        }
    }
    db_session.expire_all()

    assert db_session.get(MediaTranscriptState, media_id) is None
    assert db_session.get(PodcastTranscriptionJob, media_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptionUsageDaily)
            .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
        )
        == 0
    )
    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 1
    audit = audits[0]
    assert audit.requested_by_user_id == test_user.id
    assert audit.request_reason == "episode_open"
    assert audit.dry_run is True
    assert audit.outcome == "forecast"
    assert audit.required_minutes == 11
    assert audit.remaining_minutes is None
    assert audit.fits_budget is True
