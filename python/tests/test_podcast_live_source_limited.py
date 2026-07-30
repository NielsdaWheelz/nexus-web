"""Live Podcast sync reports identity loss instead of silently claiming Complete."""

from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.ids import new_uuid7
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.net.safe_fetch import SafeFetchResult
from nexus.services.podcasts.poll import run_podcast_subscription_sync_now
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_live_sync_marks_aliasless_candidate_source_limited(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid4()
    podcast_id = uuid4()
    subscription_id = new_uuid7()
    provider_podcast_id = f"aliasless-live-{podcast_id}"
    feed_url = f"https://feeds.example.com/{podcast_id}.xml"
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("podcast_subscriptions", "id", subscription_id)
    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        db.execute(
            text(
                """
                INSERT INTO podcasts (
                    id, provider, provider_podcast_id, title, feed_url
                )
                VALUES (
                    :podcast_id,
                    'podcast_index',
                    :provider_podcast_id,
                    'Aliasless Live Sync',
                    :feed_url
                )
                """
            ),
            {
                "podcast_id": podcast_id,
                "provider_podcast_id": provider_podcast_id,
                "feed_url": feed_url,
            },
        )
        db.execute(
            text(
                """
                INSERT INTO podcast_subscriptions (
                    id, user_id, podcast_id, sync_status
                )
                VALUES (
                    :subscription_id, :viewer_id, :podcast_id, 'pending'
                )
                """
            ),
            {
                "subscription_id": subscription_id,
                "viewer_id": user_id,
                "podcast_id": podcast_id,
            },
        )
        db.commit()

    def fetch_aliasless_episode(
        _client: object,
        _provider_podcast_id: str,
        _limit: int,
    ) -> list[dict[str, object]]:
        return [
            {
                "title": "Identity Lost",
                "published_at": "2026-07-01T00:00:00Z",
                "duration_seconds": 60,
            }
        ]

    empty_feed = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Aliasless Live Sync</title></channel></rss>
"""

    def fetch_feed(url: str, **_kwargs: object) -> SafeFetchResult:
        return SafeFetchResult(
            final_url=url,
            content_type="application/rss+xml",
            content=empty_feed,
            text=empty_feed.decode(),
        )

    monkeypatch.setattr(
        "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
        fetch_aliasless_episode,
    )
    monkeypatch.setattr("nexus.services.podcasts.feed.safe_get", fetch_feed)

    with direct_db.session() as db:
        result = run_podcast_subscription_sync_now(
            db,
            user_id=user_id,
            podcast_id=podcast_id,
        )

    assert result.sync_status == "source_limited", (
        "an exposed live candidate without any stable alias must not report Complete"
    )
    assert result.source_limited is True
    assert result.ingested_episode_count == 0
    with direct_db.session() as db:
        assert (
            db.scalar(
                text(
                    """
                    SELECT count(*)
                    FROM podcast_episodes
                    WHERE podcast_id = :podcast_id
                    """
                ),
                {"podcast_id": podcast_id},
            )
            == 0
        ), "aliasless candidates must never materialize Podcast episode Media"
