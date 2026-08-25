"""Transcript forecasts audit the request without materializing transcript work state."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

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
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def _seed_transcription_episode(
    db: Session,
    *,
    user: UserRecord,
    title: str,
    transcription_limit_minutes: int | None = None,
) -> UUID:
    podcast_id = uuid4()
    media_id = uuid4()
    db.add_all(
        [
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"transcript-admission-{podcast_id}",
                title="Transcript admission proof",
                feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
            ),
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title=title,
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user.id,
            ),
        ]
    )
    db.flush()
    db.add(
        PodcastEpisode(
            media_id=media_id,
            podcast_id=podcast_id,
            duration_seconds=601,
        )
    )
    assert ensure_media_in_default_library(db, user.id, media_id)
    grant_entitlement_override(
        db,
        user_id=user.id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode=(
            "custom" if transcription_limit_minutes is not None else "unlimited"
        ),
        transcription_minutes_limit_monthly=transcription_limit_minutes,
        expires_at=None,
        reason="transcript admission proof",
        actor_label="nexus-test",
    )
    db.commit()
    return media_id


def test_transcript_forecast_only_persists_its_explicit_audit(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Forecast-only episode",
    )

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


def test_transcript_admission_resets_one_existing_job_and_reserves_once(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Explicit admission episode",
    )
    stale_instant = datetime(2026, 1, 1, tzinfo=UTC)
    db_session.add(
        PodcastTranscriptionJob(
            media_id=media_id,
            requested_by_user_id=None,
            request_reason="search",
            reserved_minutes=0,
            reservation_usage_date=None,
            status="failed",
            error_code="E_TRANSCRIPTION_FAILED",
            attempts=3,
            started_at=stale_instant,
            completed_at=stale_instant,
        )
    )
    db_session.commit()

    response = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "quote", "dry_run": False},
    )

    assert response.status_code == 202, response.text
    assert response.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "transcript_state": "queued",
            "transcript_coverage": "none",
            "request_reason": "quote",
            "required_minutes": 11,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": True,
        }
    }
    db_session.expire_all()

    job = db_session.get(PodcastTranscriptionJob, media_id)
    assert job is not None
    assert job.requested_by_user_id == test_user.id
    assert job.request_reason == "quote"
    assert job.reserved_minutes == 11
    assert job.reservation_usage_date is not None
    assert job.status == "pending"
    assert job.error_code is None
    assert job.attempts == 3
    assert job.started_at is None
    assert job.completed_at is None

    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "queued"
    assert transcript_state.transcript_coverage == "none"
    assert transcript_state.semantic_status == "none"
    assert transcript_state.last_request_reason == "quote"
    assert transcript_state.last_error_code is None

    usage_rows = db_session.scalars(
        select(PodcastTranscriptionUsageDaily).where(
            PodcastTranscriptionUsageDaily.user_id == test_user.id
        )
    ).all()
    assert len(usage_rows) == 1
    assert usage_rows[0].minutes_used == 0
    assert usage_rows[0].minutes_reserved == 11

    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 1
    assert audits[0].dry_run is False
    assert audits[0].outcome == "queued"
    assert audits[0].required_minutes == 11
    assert audits[0].remaining_minutes is None
    assert audits[0].fits_budget is True


def test_quota_rejection_audits_without_materializing_transcript_work_state(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Quota-rejected episode",
        transcription_limit_minutes=5,
    )
    revision_before = read_collection_revision(
        db_session,
        viewer_id=test_user.id,
        family=CollectionFamily.PodcastEpisodes,
    )

    response = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open", "dry_run": False},
    )

    assert response.status_code == 429, response.text
    assert response.json()["error"]["code"] == "E_PODCAST_QUOTA_EXCEEDED"
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
    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == revision_before
    )
    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 1
    assert audits[0].dry_run is False
    assert audits[0].outcome == "rejected_quota"
    assert audits[0].required_minutes == 11
    assert audits[0].remaining_minutes == 5
    assert audits[0].fits_budget is False


def test_repeated_inflight_request_is_state_and_collection_idempotent(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Idempotent admission episode",
    )

    admitted = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "quote", "dry_run": False},
    )
    assert admitted.status_code == 202, admitted.text
    revision_after_admission = read_collection_revision(
        db_session,
        viewer_id=test_user.id,
        family=CollectionFamily.PodcastEpisodes,
    )

    repeated = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "search", "dry_run": False},
    )

    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "transcript_state": "queued",
            "transcript_coverage": "none",
            "request_reason": "search",
            "required_minutes": 11,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": False,
        }
    }
    db_session.expire_all()

    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == revision_after_admission
    )
    job = db_session.get(PodcastTranscriptionJob, media_id)
    assert job is not None
    assert job.request_reason == "quote"
    assert job.reserved_minutes == 11
    assert job.status == "pending"

    usage_rows = db_session.scalars(
        select(PodcastTranscriptionUsageDaily).where(
            PodcastTranscriptionUsageDaily.user_id == test_user.id
        )
    ).all()
    assert len(usage_rows) == 1
    assert usage_rows[0].minutes_used == 0
    assert usage_rows[0].minutes_reserved == 11

    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 2
    audits_by_outcome = {audit.outcome: audit for audit in audits}
    assert set(audits_by_outcome) == {"queued", "idempotent"}
    assert audits_by_outcome["queued"].request_reason == "quote"
    assert audits_by_outcome["idempotent"].request_reason == "search"
