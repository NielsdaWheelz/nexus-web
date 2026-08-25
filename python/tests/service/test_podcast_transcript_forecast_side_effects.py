"""Transcript forecasts audit the request without materializing transcript work state."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    FailureStage,
    Media,
    MediaKind,
    MediaSourceAttempt,
    MediaTranscriptState,
    Podcast,
    PodcastEpisode,
    PodcastTranscriptionJob,
    PodcastTranscriptionUsageDaily,
    PodcastTranscriptRequestAudit,
    ProcessingStatus,
)
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import (
    JobExecutionContext,
    claim_job,
    find_nonterminal_jobs_for_payload,
    get_job,
)
from nexus.jobs.worker import _terminal_resource_failure
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media_source_ingest import run_source_attempt
from nexus.services.transcript_segments import TranscriptSegmentInput
from nexus.services.transcripts.current import publish_source_transcript
from tests.testkit.auth import UserRecord
from tests.testkit.external_server import NASA_TRANSCRIPT_URL


def _seed_transcription_episode(
    db: Session,
    *,
    user: UserRecord,
    title: str,
    transcription_limit_minutes: int | None = None,
    rss_transcript_url: str | None = None,
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
            rss_transcript_url=rss_transcript_url,
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


def _run_claimed_transcript_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    actor_user_id: UUID,
    worker_id: str,
) -> dict[str, object]:
    db.expire_all()
    attempt = db.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == media_id)
    ).one()
    assert attempt.job_id is not None
    claimed = claim_job(
        db,
        job_id=attempt.job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("ingest_media_source",),
    )
    attempt_id = attempt.id
    job_id = attempt.job_id
    db.commit()
    assert claimed is not None

    return run_source_attempt(
        session_factory=sessionmaker(
            bind=db.get_bind(),
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ),
        media_id=media_id,
        attempt_id=attempt_id,
        actor_user_id=actor_user_id,
        request_id=None,
        context=JobExecutionContext(
            job_id=job_id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
            resource_class="Heavy",
        ),
    )


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


def test_semantic_repair_is_zero_cost_collection_pure_and_idempotent(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Shared semantic repair episode",
    )
    other_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        other_user_id,
        f"semantic-repair-{other_user_id}@example.invalid",
    )
    assert ensure_media_in_default_library(db_session, other_user_id, media_id)

    publish_source_transcript(
        db_session,
        media_id=media_id,
        request_reason="episode_open",
        transcript_coverage="full",
        transcript_segments=(
            TranscriptSegmentInput(
                segment_idx=0,
                canonical_text="One shared transcript segment.",
                t_start_ms=0,
                t_end_ms=1_500,
                speaker_label=None,
            ),
        ),
        transcript_origin="Generated",
        now=datetime.now(UTC),
    )
    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    transcript_state.semantic_status = "failed"
    db_session.commit()

    viewers = (test_user.id, other_user_id)
    families = (
        CollectionFamily.LibraryEntries,
        CollectionFamily.PodcastEpisodes,
    )
    revisions_before = {
        (viewer_id, family): read_collection_revision(
            db_session,
            viewer_id=viewer_id,
            family=family,
        )
        for viewer_id in viewers
        for family in families
    }

    response = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "search", "dry_run": False},
    )

    assert response.status_code == 202, response.text
    assert response.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": "ready",
            "transcript_coverage": "full",
            "request_reason": "search",
            "required_minutes": 0,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": True,
        }
    }
    db_session.expire_all()

    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.semantic_status == "pending"
    assert transcript_state.last_request_reason == "search"
    jobs = find_nonterminal_jobs_for_payload(
        db_session,
        kind="podcast_reindex_semantic_job",
        expected_payload_match={"media_id": str(media_id)},
    )
    assert len(jobs) == 1
    assert jobs[0].payload == {
        "media_id": str(media_id),
        "requested_by_user_id": str(test_user.id),
        "request_reason": "search",
        "request_id": None,
    }
    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 1
    assert audits[0].outcome == "queued"
    assert audits[0].required_minutes == 0
    assert audits[0].remaining_minutes is None
    assert audits[0].fits_budget is True
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptionUsageDaily)
            .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
        )
        == 0
    )
    for viewer_id in viewers:
        for family in families:
            assert (
                read_collection_revision(
                    db_session,
                    viewer_id=viewer_id,
                    family=family,
                )
                == revisions_before[(viewer_id, family)]
            )

    repeated = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "highlight", "dry_run": False},
    )

    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": "ready",
            "transcript_coverage": "full",
            "request_reason": "highlight",
            "required_minutes": 0,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": False,
        }
    }
    db_session.expire_all()
    jobs = find_nonterminal_jobs_for_payload(
        db_session,
        kind="podcast_reindex_semantic_job",
        expected_payload_match={"media_id": str(media_id)},
    )
    assert len(jobs) == 1
    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit)
        .where(PodcastTranscriptRequestAudit.media_id == media_id)
        .order_by(
            PodcastTranscriptRequestAudit.created_at,
            PodcastTranscriptRequestAudit.id,
        )
    ).all()
    assert [audit.outcome for audit in audits] == ["queued", "idempotent"]
    assert [audit.required_minutes for audit in audits] == [0, 0]
    assert [audit.request_reason for audit in audits] == ["search", "highlight"]
    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.semantic_status == "pending"
    assert transcript_state.last_request_reason == "search"
    for viewer_id in viewers:
        for family in families:
            assert (
                read_collection_revision(
                    db_session,
                    viewer_id=viewer_id,
                    family=family,
                )
                == revisions_before[(viewer_id, family)]
            )


def test_rss_sidecar_admission_queues_once_without_generated_quota(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Publisher transcript episode",
        rss_transcript_url="https://feeds.example.invalid/episode-transcript.vtt",
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

    assert response.status_code == 202, response.text
    assert response.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "transcript_state": "queued",
            "transcript_coverage": "none",
            "request_reason": "episode_open",
            "required_minutes": 0,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": True,
        }
    }
    db_session.expire_all()

    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "queued"
    assert transcript_state.transcript_coverage == "none"
    assert transcript_state.semantic_status == "none"

    job = db_session.get(PodcastTranscriptionJob, media_id)
    assert job is not None
    assert job.status == "pending"
    assert job.reserved_minutes == 0
    assert job.reservation_usage_date is None

    attempts = db_session.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == media_id)
    ).all()
    assert len(attempts) == 1
    assert attempts[0].source_type == "podcast_episode_transcript"
    assert attempts[0].status == "queued"
    assert attempts[0].source_payload["request_reason"] == "episode_open"

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
        == revision_before + 1
    )

    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit).where(
            PodcastTranscriptRequestAudit.media_id == media_id
        )
    ).all()
    assert len(audits) == 1
    assert audits[0].outcome == "queued"
    assert audits[0].required_minutes == 0
    assert audits[0].remaining_minutes is None
    assert audits[0].fits_budget is True


def test_batch_quota_rejection_rolls_back_every_episode_admission(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    first_media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Atomic batch episode one",
        transcription_limit_minutes=15,
    )
    podcast_id = db_session.scalar(
        select(PodcastEpisode.podcast_id).where(PodcastEpisode.media_id == first_media_id)
    )
    assert podcast_id is not None
    second_media_id = uuid4()
    db_session.add(
        Media(
            id=second_media_id,
            kind=MediaKind.podcast_episode.value,
            title="Atomic batch episode two",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    db_session.add(
        PodcastEpisode(
            media_id=second_media_id,
            podcast_id=podcast_id,
            duration_seconds=601,
        )
    )
    assert ensure_media_in_default_library(db_session, test_user.id, second_media_id)
    db_session.commit()

    media_ids = (first_media_id, second_media_id)
    revisions_before = {
        family: read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=family,
        )
        for family in (CollectionFamily.LibraryEntries, CollectionFamily.PodcastEpisodes)
    }
    target = {
        "kind": "PodcastEpisodeQuery",
        "podcastId": str(podcast_id),
        "selection": {"state": "all"},
        "reason": "quote",
    }
    forecast = authenticated_client.post(
        "/media/transcript/forecasts",
        json=target,
    )
    assert forecast.status_code == 200, forecast.text
    forecast_data = forecast.json()["data"]
    assert forecast_data["eligibleCount"] == 2
    assert forecast_data["requiredMinutes"] == 22
    assert forecast_data["fitsBudget"] is False

    rejected = authenticated_client.post(
        "/media/transcript/request/batch",
        json={
            "target": target,
            "selectionFingerprint": forecast_data["selectionFingerprint"],
        },
    )
    assert rejected.status_code == 429, rejected.text

    db_session.expire_all()
    for model in (
        MediaTranscriptState,
        PodcastTranscriptionJob,
        MediaSourceAttempt,
    ):
        assert (
            db_session.scalar(
                select(func.count()).select_from(model).where(model.media_id.in_(media_ids))
            )
            == 0
        )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptionUsageDaily)
            .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
        )
        == 0
    )
    audit_outcomes = db_session.scalars(
        select(PodcastTranscriptRequestAudit.outcome).where(
            PodcastTranscriptRequestAudit.media_id.in_(media_ids)
        )
    ).all()
    assert sorted(audit_outcomes) == ["forecast", "forecast"]
    for media_id in media_ids:
        assert (
            find_nonterminal_jobs_for_payload(
                db_session,
                kind="ingest_media_source",
                expected_payload_match={"media_id": str(media_id)},
            )
            == []
        )
    for family, revision_before in revisions_before.items():
        assert (
            read_collection_revision(
                db_session,
                viewer_id=test_user.id,
                family=family,
            )
            == revision_before
        )


def test_worker_quota_rejection_commits_its_audit_before_terminal_failure(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Publisher fallback quota rejection",
        transcription_limit_minutes=5,
        rss_transcript_url="https://feeds.example.invalid/unsupported-transcript.bin",
    )
    admitted = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open", "dry_run": False},
    )
    assert admitted.status_code == 202, admitted.text
    revisions_after_admission = {
        family: read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=family,
        )
        for family in (
            CollectionFamily.AuthorWorks,
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastEpisodes,
        )
    }

    result = _run_claimed_transcript_source_attempt(
        db_session,
        media_id=media_id,
        actor_user_id=test_user.id,
        worker_id="publisher-fallback-quota-worker",
    )

    assert result["status"] == "failed"
    assert result["error_code"] == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    db_session.expire_all()
    media = db_session.get(Media, media_id)
    assert media is not None
    assert media.processing_status == ProcessingStatus.failed
    assert media.failure_stage == FailureStage.transcribe
    assert media.last_error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "failed_quota"
    assert transcript_state.transcript_coverage == "none"
    assert transcript_state.semantic_status == "none"
    transcription_job = db_session.get(PodcastTranscriptionJob, media_id)
    assert transcription_job is not None
    assert transcription_job.status == "failed"
    assert transcription_job.error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    assert transcription_job.reserved_minutes == 0
    source_attempt = db_session.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == media_id)
    ).one()
    assert source_attempt.status == "failed"
    assert source_attempt.error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    audits = db_session.scalars(
        select(PodcastTranscriptRequestAudit)
        .where(PodcastTranscriptRequestAudit.media_id == media_id)
        .order_by(
            PodcastTranscriptRequestAudit.created_at,
            PodcastTranscriptRequestAudit.id,
        )
    ).all()
    assert [audit.outcome for audit in audits] == ["queued", "rejected_quota"]
    rejected = audits[1]
    assert rejected.requested_by_user_id == test_user.id
    assert rejected.request_reason == "episode_open"
    assert rejected.required_minutes == 11
    assert rejected.remaining_minutes == 5
    assert rejected.fits_budget is False
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptionUsageDaily)
            .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
        )
        == 0
    )
    for family, revision_after_admission in revisions_after_admission.items():
        assert (
            read_collection_revision(
                db_session,
                viewer_id=test_user.id,
                family=family,
            )
            == revision_after_admission + 1
        )


def test_publisher_transcript_worker_publishes_semantics_and_revisions_once(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Exactly-once publisher transcript",
        rss_transcript_url=NASA_TRANSCRIPT_URL,
    )
    admitted = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open", "dry_run": False},
    )
    assert admitted.status_code == 202, admitted.text
    revisions_after_admission = {
        family: read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=family,
        )
        for family in (CollectionFamily.LibraryEntries, CollectionFamily.PodcastEpisodes)
    }

    result = _run_claimed_transcript_source_attempt(
        db_session,
        media_id=media_id,
        actor_user_id=test_user.id,
        worker_id="publisher-transcript-worker",
    )

    assert result["status"] == "completed"
    assert result["source_type"] == "podcast_episode_transcript"
    assert int(result["segment_count"]) > 0
    db_session.expire_all()
    semantic_jobs = find_nonterminal_jobs_for_payload(
        db_session,
        kind="podcast_reindex_semantic_job",
        expected_payload_match={"media_id": str(media_id)},
    )
    assert len(semantic_jobs) == 1
    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "ready"
    assert transcript_state.transcript_coverage == "full"
    assert transcript_state.semantic_status == "pending"
    assert transcript_state.transcript_origin == "Publisher"
    transcription_job = db_session.get(PodcastTranscriptionJob, media_id)
    assert transcription_job is not None
    assert transcription_job.status == "completed"
    source_attempt = db_session.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == media_id)
    ).one()
    assert source_attempt.status == "succeeded"
    for family, revision_after_admission in revisions_after_admission.items():
        assert (
            read_collection_revision(
                db_session,
                viewer_id=test_user.id,
                family=family,
            )
            == revision_after_admission + 1
        )


def test_podcast_transcript_resource_terminal_repairs_domain_state_once(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id = _seed_transcription_episode(
        db_session,
        user=test_user,
        title="Resource-limited podcast transcript",
    )
    admitted = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "episode_open", "dry_run": False},
    )
    assert admitted.status_code == 202, admitted.text
    revisions_after_admission = {
        family: read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=family,
        )
        for family in (
            CollectionFamily.AuthorWorks,
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastEpisodes,
        )
    }
    attempt = db_session.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == media_id)
    ).one()
    assert attempt.job_id is not None
    worker_id = "podcast-resource-terminal-worker"
    claimed = claim_job(
        db_session,
        job_id=attempt.job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("ingest_media_source",),
    )
    db_session.commit()
    assert claimed is not None

    settlement = _terminal_resource_failure(
        db_session,
        claimed=claimed,
        worker_id=worker_id,
        projection="SourceAttemptMedia",
        dimension="Memory",
    )
    db_session.commit()

    assert settlement == "ResourceFailed"
    queue_job = get_job(db_session, claimed.id)
    assert queue_job is not None
    assert queue_job.status == "dead"
    assert queue_job.error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    assert queue_job.result == {"kind": "ResourceFailure", "dimension": "Memory"}
    db_session.expire_all()
    media = db_session.get(Media, media_id)
    assert media is not None
    assert media.processing_status == ProcessingStatus.failed
    assert media.failure_stage == FailureStage.transcribe
    assert media.last_error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    source_attempt = db_session.get(MediaSourceAttempt, attempt.id)
    assert source_attempt is not None
    assert source_attempt.status == "failed"
    assert source_attempt.error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    transcription_job = db_session.get(PodcastTranscriptionJob, media_id)
    assert transcription_job is not None
    assert transcription_job.status == "failed"
    assert transcription_job.error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    assert transcription_job.reserved_minutes == 0
    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "failed_provider"
    assert transcript_state.transcript_coverage == "none"
    assert transcript_state.semantic_status == "none"
    usage = db_session.scalar(
        select(PodcastTranscriptionUsageDaily).where(
            PodcastTranscriptionUsageDaily.user_id == test_user.id
        )
    )
    assert usage is not None
    assert usage.minutes_used == 0
    assert usage.minutes_reserved == 0
    for family, revision_after_admission in revisions_after_admission.items():
        assert (
            read_collection_revision(
                db_session,
                viewer_id=test_user.id,
                family=family,
            )
            == revision_after_admission + 1
        )
