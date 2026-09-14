"""Ingest proof: Podcast publication becomes one exact canonical UTC instant."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Media, Podcast, PodcastEpisode
from nexus.services.podcasts.ingest import sync_subscription_ingest
from nexus.services.podcasts.provider import PODCAST_PROVIDER
from tests.testkit.auth import UserRecord


def test_feedparser_datetime_ingest_persists_and_returns_canonical_utc(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    podcast_id = uuid4()
    db_session.add(
        Podcast(
            id=podcast_id,
            provider=PODCAST_PROVIDER,
            provider_podcast_id=f"publication-proof-{podcast_id}",
            title="Publication instant proof",
            feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
        )
    )
    db_session.flush()

    feedparser_datetime = datetime(2026, 3, 2, 6, 0, tzinfo=UTC)
    result = sync_subscription_ingest(
        db=db_session,
        viewer_id=test_user.id,
        podcast_id=podcast_id,
        feed_url=f"https://feeds.example.invalid/{podcast_id}.xml",
        selected_episodes=[
            {
                "podcast_index_episode_ref": "publication-proof-episode",
                "guid": "publication-proof-guid",
                "title": "Canonical publication episode",
                "audio_url": "https://media.example.invalid/publication-proof.mp3",
                "published_at": feedparser_datetime,
                "duration_seconds": 120,
            }
        ],
        now=datetime(2026, 3, 2, 7, 0, tzinfo=UTC),
    )
    assert result.ingested_episode_count == 1, (
        f"Podcast ingest did not persist the feedparser episode: {result!r}"
    )

    persisted = db_session.execute(
        select(Media.id, Media.published_date, PodcastEpisode.published_at)
        .join(PodcastEpisode, PodcastEpisode.media_id == Media.id)
        .where(PodcastEpisode.podcast_id == podcast_id)
    ).one()
    assert persisted.published_date == "2026-03-02T06:00:00Z", (
        "Podcast ingest persisted a non-canonical Media publication instant: "
        f"{persisted.published_date!r}"
    )
    assert persisted.published_at == feedparser_datetime, (
        f"Podcast ingest changed the exact episode publication instant: {persisted.published_at!r}"
    )

    response = authenticated_client.get(f"/media/{persisted.id}")
    assert response.status_code == 200, (
        f"canonical Podcast Media was not readable through the API: {response.text}"
    )
    assert response.json()["data"]["published_date"] == "2026-03-02T06:00:00Z", (
        "Podcast API returned a non-canonical publication instant: "
        f"{response.json()['data']['published_date']!r}"
    )
