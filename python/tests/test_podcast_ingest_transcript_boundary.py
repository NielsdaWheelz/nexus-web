"""Podcast ingest must preserve transcript references without materializing them."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.ids import new_uuid7
from nexus.services.podcasts.ingest import sync_subscription_ingest
from nexus.services.transcripts.current import (
    ensure_media_transcript_state_row,
    set_media_transcript_state,
)

pytestmark = pytest.mark.integration


def test_ingest_stores_rss_transcript_ref_as_not_requested_without_artifacts(
    db_session,
    bootstrapped_user,
) -> None:
    viewer_id = bootstrapped_user
    podcast_id = uuid4()
    episode_ref = f"episode-{uuid4()}"
    rss_transcript_url = "https://cdn.example.com/show/episode.vtt"
    now = datetime.now(UTC)

    db_session.execute(
        text(
            """
            INSERT INTO podcasts (
                id, provider, provider_podcast_id, title, feed_url
            )
            VALUES (
                :id,
                'podcast_index',
                :provider_podcast_id,
                'Transcript Boundary',
                'https://feeds.example.com/transcript-boundary.xml'
            )
            """
        ),
        {
            "id": podcast_id,
            "provider_podcast_id": f"podcast-{podcast_id}",
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO podcast_subscriptions (id, user_id, podcast_id)
            VALUES (:id, :viewer_id, :podcast_id)
            """
        ),
        {
            "id": new_uuid7(),
            "viewer_id": viewer_id,
            "podcast_id": podcast_id,
        },
    )

    result = sync_subscription_ingest(
        db=db_session,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        feed_url="https://feeds.example.com/transcript-boundary.xml",
        selected_episodes=[
            {
                "podcast_index_episode_ref": episode_ref,
                "guid": "rss-guid",
                "title": "Stored reference only",
                "description_text": "No transcript should be fetched during ingest.",
                "description_html": None,
                "audio_url": "https://cdn.example.com/show/episode.mp3",
                "published_at": "2026-07-29T12:00:00Z",
                "duration_seconds": 60,
                "authors": [],
                "rss_transcript_refs": [
                    {
                        "url": rss_transcript_url,
                        "type": "text/vtt",
                        "language": "en",
                    }
                ],
                "rss_chapters": None,
                "language": "en",
                "feed_language": "en",
            }
        ],
        now=now,
    )
    assert result.ingested_episode_count == 1

    media_id = UUID(
        str(
            db_session.scalar(
                text(
                    """
                    SELECT episode_media_id
                    FROM podcast_episode_identities
                    WHERE podcast_id = :podcast_id
                      AND scheme = 'PodcastIndex'
                      AND value = :episode_ref
                    """
                ),
                {
                    "podcast_id": podcast_id,
                    "episode_ref": episode_ref,
                },
            )
        )
    )
    episode_row = db_session.execute(
        text(
            """
            SELECT episode.rss_transcript_url, media.processing_status
            FROM podcast_episodes episode
            JOIN media ON media.id = episode.media_id
            WHERE episode.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert tuple(episode_row) == (rss_transcript_url, "pending")

    state = db_session.execute(
        text(
            """
            SELECT
                transcript_state,
                transcript_coverage,
                semantic_status,
                last_request_reason,
                transcript_origin
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    assert tuple(state) == ("not_requested", "none", "none", None, None)

    artifact_counts = db_session.execute(
        text(
            """
            SELECT
                (SELECT count(*) FROM fragments WHERE media_id = :media_id),
                (
                    SELECT count(*)
                    FROM podcast_transcript_segments
                    WHERE media_id = :media_id
                ),
                (
                    SELECT count(*)
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                ),
                (
                    SELECT count(*)
                    FROM podcast_transcript_request_audits
                    WHERE media_id = :media_id
                ),
                (
                    SELECT count(*)
                    FROM content_chunks
                    WHERE owner_kind = 'media'
                      AND owner_id = :media_id
                      AND source_kind = 'transcript'
                )
            """
        ),
        {"media_id": media_id},
    ).one()
    assert tuple(artifact_counts) == (0, 0, 0, 0, 0)

    media_jobs = list(
        db_session.scalars(
            text(
                """
                SELECT kind
                FROM background_jobs
                WHERE payload ->> 'media_id' = :media_id
                ORDER BY kind
                """
            ),
            {"media_id": str(media_id)},
        )
    )
    assert media_jobs == ["enrich_metadata"]


def test_transcript_state_owner_requires_and_clears_origin(
    db_session,
    bootstrapped_user,
) -> None:
    media_id = uuid4()
    now = datetime.now(UTC)
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id
            )
            VALUES (
                :media_id,
                'web_article',
                'Transcript origin owner',
                'pending',
                :viewer_id
            )
            """
        ),
        {"media_id": media_id, "viewer_id": bootstrapped_user},
    )
    ensure_media_transcript_state_row(db_session, media_id=media_id, now=now)

    with pytest.raises(
        AssertionError,
        match="readable transcript state requires an owned transcript origin",
    ):
        set_media_transcript_state(
            db_session,
            media_id=media_id,
            transcript_state="ready",
            transcript_coverage="full",
            semantic_status="ready",
            last_request_reason="search",
            last_error_code=None,
            now=now,
        )

    set_media_transcript_state(
        db_session,
        media_id=media_id,
        transcript_state="ready",
        transcript_coverage="full",
        semantic_status="ready",
        last_request_reason="search",
        last_error_code=None,
        transcript_origin="Imported",
        now=now,
    )
    set_media_transcript_state(
        db_session,
        media_id=media_id,
        transcript_state="partial",
        transcript_coverage="partial",
        semantic_status="ready",
        last_request_reason="search",
        last_error_code=None,
        now=now,
    )
    assert tuple(
        db_session.execute(
            text(
                """
                SELECT transcript_state, transcript_origin
                FROM media_transcript_states
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).one()
    ) == ("partial", "Imported")

    with pytest.raises(
        AssertionError,
        match="non-readable transcript state cannot carry transcript origin",
    ):
        set_media_transcript_state(
            db_session,
            media_id=media_id,
            transcript_state="failed_provider",
            transcript_coverage="none",
            semantic_status="none",
            last_request_reason="search",
            last_error_code="E_TRANSCRIPT_UNAVAILABLE",
            transcript_origin="Publisher",
            now=now,
        )

    set_media_transcript_state(
        db_session,
        media_id=media_id,
        transcript_state="failed_provider",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason="search",
        last_error_code="E_TRANSCRIPT_UNAVAILABLE",
        now=now,
    )
    assert tuple(
        db_session.execute(
            text(
                """
                SELECT transcript_state, transcript_origin
                FROM media_transcript_states
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).one()
    ) == ("failed_provider", None)

    inserted_media_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id
            )
            VALUES (
                :media_id,
                'podcast_episode',
                'Inserted transcript origin',
                'pending',
                :viewer_id
            )
            """
        ),
        {"media_id": inserted_media_id, "viewer_id": bootstrapped_user},
    )
    set_media_transcript_state(
        db_session,
        media_id=inserted_media_id,
        transcript_state="ready",
        transcript_coverage="full",
        semantic_status="ready",
        last_request_reason="search",
        last_error_code=None,
        transcript_origin="Generated",
        now=now,
    )
    assert (
        db_session.scalar(
            text(
                """
            SELECT transcript_origin
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
            ),
            {"media_id": inserted_media_id},
        )
        == "Generated"
    )
