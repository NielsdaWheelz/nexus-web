"""YouTube caption import owns one strict provider and publication boundary."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from youtube_transcript_api import YouTubeTranscriptApi

from nexus.db.models import (
    Fragment,
    Media,
    MediaKind,
    MediaSourceAttempt,
    MediaTranscriptState,
    PodcastTranscriptionJob,
    PodcastTranscriptionUsageDaily,
    PodcastTranscriptRequestAudit,
    ProcessingStatus,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord


def _seed_youtube_video(db: Session, *, user: UserRecord) -> UUID:
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.video.value,
            title="YouTube caption import proof",
            processing_status=ProcessingStatus.ready_for_reading,
            provider="youtube",
            provider_id="youtube-caption-proof",
            created_by_user_id=user.id,
        )
    )
    db.flush()
    assert ensure_media_in_default_library(db, user.id, media_id)
    db.commit()
    return media_id


def test_youtube_caption_dry_run_and_import_use_video_owned_collections(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_id = _seed_youtube_video(db_session, user=test_user)
    provider_calls: list[str] = []

    def fetch_captions(
        _provider: YouTubeTranscriptApi,
        provider_video_id: str,
    ) -> list[SimpleNamespace]:
        provider_calls.append(provider_video_id)
        return [
            SimpleNamespace(
                text="Exact imported caption.",
                start=0,
                duration=1.5,
            )
        ]

    monkeypatch.setattr(
        YouTubeTranscriptApi,
        "fetch",
        fetch_captions,
    )
    library_revision_before = read_collection_revision(
        db_session,
        viewer_id=test_user.id,
        family=CollectionFamily.LibraryEntries,
    )
    podcast_revision_before = read_collection_revision(
        db_session,
        viewer_id=test_user.id,
        family=CollectionFamily.PodcastEpisodes,
    )
    podcast_usage_before = db_session.execute(
        select(
            PodcastTranscriptionUsageDaily.usage_date,
            PodcastTranscriptionUsageDaily.minutes_used,
            PodcastTranscriptionUsageDaily.minutes_reserved,
        )
        .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
        .order_by(PodcastTranscriptionUsageDaily.usage_date)
    ).all()

    forecast = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "quote", "dry_run": True},
    )

    assert forecast.status_code == 200, forecast.text
    assert forecast.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": "not_requested",
            "transcript_coverage": "none",
            "request_reason": "quote",
            "required_minutes": 0,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": False,
        }
    }
    assert provider_calls == []
    assert db_session.get(MediaTranscriptState, media_id) is None
    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.LibraryEntries,
        )
        == library_revision_before
    )
    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == podcast_revision_before
    )

    imported = authenticated_client.post(
        f"/media/{media_id}/transcript/request",
        json={"reason": "quote", "dry_run": False},
    )

    assert imported.status_code == 200, imported.text
    assert imported.json() == {
        "data": {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": "ready",
            "transcript_coverage": "full",
            "request_reason": "quote",
            "required_minutes": 0,
            "remaining_minutes": None,
            "fits_budget": True,
            "request_enqueued": False,
        }
    }
    assert provider_calls == ["youtube-caption-proof"]
    db_session.expire_all()

    transcript_state = db_session.get(MediaTranscriptState, media_id)
    assert transcript_state is not None
    assert transcript_state.transcript_state == "ready"
    assert transcript_state.transcript_coverage == "full"
    assert transcript_state.semantic_status == "pending"
    assert transcript_state.transcript_origin == "Imported"
    assert transcript_state.last_request_reason == "quote"

    fragments = db_session.scalars(
        select(Fragment).where(Fragment.media_id == media_id).order_by(Fragment.idx)
    ).all()
    assert len(fragments) == 1
    assert fragments[0].canonical_text == "Exact imported caption."
    assert fragments[0].t_start_ms == 0
    assert fragments[0].t_end_ms == 1_500

    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.LibraryEntries,
        )
        == library_revision_before + 1
    )
    assert (
        read_collection_revision(
            db_session,
            viewer_id=test_user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == podcast_revision_before
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == media_id)
        )
        == 0
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptionJob)
            .where(PodcastTranscriptionJob.media_id == media_id)
        )
        == 0
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(PodcastTranscriptRequestAudit)
            .where(PodcastTranscriptRequestAudit.media_id == media_id)
        )
        == 0
    )
    assert (
        db_session.execute(
            select(
                PodcastTranscriptionUsageDaily.usage_date,
                PodcastTranscriptionUsageDaily.minutes_used,
                PodcastTranscriptionUsageDaily.minutes_reserved,
            )
            .where(PodcastTranscriptionUsageDaily.user_id == test_user.id)
            .order_by(PodcastTranscriptionUsageDaily.usage_date)
        ).all()
        == podcast_usage_before
    )
