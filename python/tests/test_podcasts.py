"""Integration tests for S7 PR-01 podcast backend foundation.

Coverage targets:
- Global discovery metadata only (no episode media leakage).
- Subscription ingest windowing and default-library attachment.
- Global episode idempotency (GUID first, deterministic fallback second).
- Cross-subscriber reuse without redundant transcription jobs.
- Quota enforcement at transcription-work creation.
- Manual plan updates and UTC-day quota reset behavior.
- Transcript segment persistence and deterministic ordering.
- Transcript-unavailable playback-only capability semantics.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import text

from nexus.config import clear_settings_cache
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"bootstrap failed for user {user_id}: {response.status_code} {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


def _set_plan(
    auth_client,
    actor_user_id: UUID,
    target_user_id: UUID,
    *,
    plan_tier: str,
    daily_transcription_minutes: int | None,
    initial_episode_window: int,
) -> None:
    response = auth_client.put(
        f"/internal/podcasts/users/{target_user_id}/plan",
        json={
            "plan_tier": plan_tier,
            "daily_transcription_minutes": daily_transcription_minutes,
            "initial_episode_window": initial_episode_window,
        },
        headers=auth_headers(actor_user_id),
    )
    assert response.status_code == 200, (
        f"expected plan update to succeed, got {response.status_code}: {response.text}"
    )


def _mock_podcast_index(
    monkeypatch,
    *,
    podcasts: list[dict],
    episodes_by_podcast: dict[str, list[dict]],
) -> None:
    # EXTERNAL SEAM EXCEPTION:
    # PodcastIndex is an external API boundary; this seam avoids real network I/O
    # while preserving backend behavior assertions.
    def fake_search(self, query: str, limit: int) -> list[dict]:
        return podcasts[:limit]

    def fake_fetch(self, provider_podcast_id: str, limit: int) -> list[dict]:
        return episodes_by_podcast[str(provider_podcast_id)][:limit]

    monkeypatch.setattr("nexus.services.podcasts.PodcastIndexClient.search_podcasts", fake_search)
    monkeypatch.setattr(
        "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes",
        fake_fetch,
    )


def _subscribe(auth_client, user_id: UUID, payload: dict) -> dict:
    response = auth_client.post(
        "/podcasts/subscriptions",
        json=payload,
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, (
        f"subscribe failed unexpectedly: {response.status_code} {response.text}"
    )
    return response.json()["data"]


def _run_subscription_sync(
    direct_db: DirectSessionManager, user_id: UUID, podcast_id: UUID
) -> dict:
    from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now

    with direct_db.session() as session:
        result = run_podcast_subscription_sync_now(
            session,
            user_id=user_id,
            podcast_id=podcast_id,
        )
        session.commit()
    return result


def _podcast_payload(provider_podcast_id: str, title: str) -> dict:
    return {
        "provider_podcast_id": provider_podcast_id,
        "title": title,
        "author": "The Author",
        "feed_url": f"https://feeds.example.com/{provider_podcast_id}.xml",
        "website_url": f"https://example.com/{provider_podcast_id}",
        "image_url": f"https://example.com/{provider_podcast_id}.png",
        "description": f"Description for {title}",
    }


class TestPodcastDiscovery:
    def test_discovery_is_global_metadata_only(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_podcast_id = f"discover-{uuid4()}"
        podcast = _podcast_payload(provider_podcast_id, "Systems Thinking Weekly")
        # Simulate upstream over-sharing payload; route must still return metadata-only.
        podcast["episodes"] = [{"id": "ep-1"}]
        podcast["media_id"] = "should-not-leak"

        _mock_podcast_index(
            monkeypatch,
            podcasts=[podcast],
            episodes_by_podcast={provider_podcast_id: []},
        )

        response = auth_client.get(
            "/podcasts/discover?q=systems&limit=10",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"discover failed: {response.status_code} {response.text}"
        )
        data = response.json()["data"]
        assert len(data) == 1
        item = data[0]

        assert item["provider_podcast_id"] == provider_podcast_id
        assert item["title"] == "Systems Thinking Weekly"
        assert "episodes" not in item, "discovery response leaked episode rows"
        assert "media_id" not in item, "discovery response leaked media identity"


class TestPodcastSubscriptionSyncLifecycle:
    def test_subscribe_is_control_plane_only_and_returns_pending(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=2,
        )

        provider_podcast_id = f"control-plane-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Control Plane Podcast")

        def fail_if_called(self, provider_id: str, limit: int) -> list[dict]:
            _ = self, provider_id, limit
            raise AssertionError("subscribe request path must not fetch episodes directly")

        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes",
            fail_if_called,
        )

        response = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            "subscribe should acknowledge control-plane create/enqueue without data-plane work, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["sync_status"] == "pending"
        assert data["sync_enqueued"] is True

        with direct_db.session() as session:
            episode_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_episodes pe
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()
        assert episode_count == 0, "control-plane subscribe must not ingest episodes inline"

    def test_subscribe_rejects_invalid_feed_url(self, auth_client):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_podcast_id = f"invalid-feed-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Invalid Feed Podcast")
        payload["feed_url"] = "ftp://feeds.example.com/invalid.xml"

        response = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert response.status_code == 400, (
            "subscribe must reject non-http(s) feed URLs to keep downstream fetches safe, "
            f"got {response.status_code}: {response.text}"
        )
        error = response.json()["error"]
        assert error["code"] == "E_INVALID_REQUEST"

    def test_sync_job_ingests_window_and_marks_subscription_complete(
        self, auth_client, monkeypatch, direct_db
    ):
        # Data-plane worker path should ingest episodes and transition pending -> complete.
        from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now

        user_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=2,
        )

        provider_podcast_id = f"sync-complete-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Sync Complete Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-old",
                "guid": "guid-old",
                "title": "Episode Old",
                "audio_url": "https://cdn.example.com/old.mp3",
                "published_at": "2026-01-01T00:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "old"}],
            },
            {
                "provider_episode_id": "ep-newer",
                "guid": "guid-newer",
                "title": "Episode Newer",
                "audio_url": "https://cdn.example.com/newer.mp3",
                "published_at": "2026-02-01T00:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "newer"}],
            },
            {
                "provider_episode_id": "ep-newest",
                "guid": "guid-newest",
                "title": "Episode Newest",
                "audio_url": "https://cdn.example.com/newest.mp3",
                "published_at": "2026-03-01T00:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "newest"}],
            },
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert subscribe.status_code == 200
        podcast_id = subscribe.json()["data"]["podcast_id"]

        with direct_db.session() as session:
            job_result = run_podcast_subscription_sync_now(
                session,
                user_id=user_id,
                podcast_id=UUID(podcast_id),
            )
            session.commit()

        assert job_result["sync_status"] == "complete"

        with direct_db.session() as session:
            status_row = session.execute(
                text(
                    """
                    SELECT sync_status
                    FROM podcast_subscriptions
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            ).fetchone()
            media_rows = session.execute(
                text(
                    """
                    SELECT m.title
                    FROM library_media lm
                    JOIN media m ON m.id = lm.media_id
                    WHERE lm.library_id = :library_id
                      AND m.kind = 'podcast_episode'
                    ORDER BY m.title ASC
                    """
                ),
                {"library_id": default_library_id},
            ).fetchall()

        assert status_row is not None
        assert status_row[0] == "complete"
        assert [row[0] for row in media_rows] == ["Episode Newer", "Episode Newest"]

    def test_sync_job_marks_source_limited_when_provider_cap_hit(
        self, auth_client, monkeypatch, direct_db
    ):
        # If provider result appears capped and feed has no next-page path, surface source_limited.
        from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now

        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )

        monkeypatch.setenv("PODCAST_INGEST_PREFETCH_LIMIT", "150")
        clear_settings_cache()

        provider_podcast_id = f"source-limited-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Source Limited Podcast")
        capped_rows = [
            {
                "provider_episode_id": f"provider-{idx}",
                "guid": f"provider-guid-{idx}",
                "title": f"Episode {idx}",
                "audio_url": f"https://cdn.example.com/provider-{idx}.mp3",
                "published_at": "2024-01-01T00:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "x"}],
            }
            for idx in range(100)
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: capped_rows},
        )

        feed_xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Source Limited Podcast</title>
    <item>
      <guid>feed-guid-1</guid>
      <title>Feed Episode</title>
      <pubDate>Mon, 10 Mar 2026 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/feed-1.mp3" />
    </item>
  </channel>
</rss>
"""

        def fake_http_get(url: str, **kwargs):
            _ = kwargs
            return httpx.Response(200, text=feed_xml, request=httpx.Request("GET", url))

        monkeypatch.setattr("nexus.services.podcasts.httpx.get", fake_http_get)

        subscribe = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert subscribe.status_code == 200
        podcast_id = subscribe.json()["data"]["podcast_id"]

        with direct_db.session() as session:
            job_result = run_podcast_subscription_sync_now(
                session,
                user_id=user_id,
                podcast_id=UUID(podcast_id),
            )
            session.commit()
            sync_status = session.execute(
                text(
                    """
                    SELECT sync_status
                    FROM podcast_subscriptions
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            ).scalar()

        assert job_result["sync_status"] == "source_limited"
        assert sync_status == "source_limited"


class TestPodcastSubscribeIngest:
    def test_subscribe_uses_configured_prefetch_limit(self, auth_client, monkeypatch, direct_db):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )

        monkeypatch.setenv("PODCAST_INGEST_PREFETCH_LIMIT", "7")
        clear_settings_cache()

        provider_podcast_id = f"prefetch-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Prefetch Podcast")
        observed: dict[str, int] = {"limit": -1}

        # EXTERNAL SEAM EXCEPTION:
        # Assert the configured prefetch limit is passed through to provider fetch.
        def fake_search(self, query: str, limit: int) -> list[dict]:
            return [payload]

        def fake_fetch(self, provider_id: str, limit: int) -> list[dict]:
            observed["limit"] = limit
            return [
                {
                    "provider_episode_id": "ep-prefetch-1",
                    "guid": "guid-prefetch-1",
                    "title": "Prefetch Episode",
                    "audio_url": "https://cdn.example.com/prefetch.mp3",
                    "published_at": "2026-03-02T00:00:00Z",
                    "duration_seconds": 120,
                    "transcript_segments": [
                        {"t_start_ms": 0, "t_end_ms": 1000, "text": "prefetch"},
                    ],
                }
            ]

        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.search_podcasts", fake_search
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes", fake_fetch
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        assert observed["limit"] == 7, (
            "expected subscribe ingest prefetch limit to come from config, "
            f"got limit={observed['limit']}"
        )

    def test_subscribe_feed_pagination_augments_provider_candidates(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=2,
        )

        monkeypatch.setenv("PODCAST_INGEST_PREFETCH_LIMIT", "150")
        clear_settings_cache()

        provider_podcast_id = f"feed-pages-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Feed Pagination Podcast")

        # EXTERNAL SEAM EXCEPTION:
        # Simulate provider hard-cap (100 episodes) where newest feed items are missing.
        old_provider_rows = [
            {
                "provider_episode_id": f"provider-{idx}",
                "guid": f"provider-guid-{idx}",
                "title": f"Episode Old {idx}",
                "audio_url": f"https://cdn.example.com/provider-{idx}.mp3",
                "published_at": f"2025-01-{(idx % 28) + 1:02d}T00:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": f"old-{idx}"},
                ],
            }
            for idx in range(100)
        ]

        def fake_fetch(self, provider_id: str, limit: int) -> list[dict]:
            _ = provider_id, limit
            return old_provider_rows

        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes", fake_fetch
        )

        page1_url = payload["feed_url"]
        page2_url = f"{payload['feed_url']}?page=2"
        page1_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Feed Pagination Podcast</title>
    <atom:link rel="next" href="{page2_url}" />
    <item>
      <guid>feed-guid-newest</guid>
      <title>Episode Newest</title>
      <pubDate>Mon, 10 Mar 2026 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/feed-newest.mp3" />
      <itunes:duration>00:10:00</itunes:duration>
    </item>
  </channel>
</rss>
"""
        page2_xml = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Feed Pagination Podcast</title>
    <item>
      <guid>feed-guid-newer</guid>
      <title>Episode Newer</title>
      <pubDate>Sun, 09 Mar 2026 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/feed-newer.mp3" />
      <itunes:duration>00:10:00</itunes:duration>
    </item>
  </channel>
</rss>
"""

        # EXTERNAL SEAM EXCEPTION:
        # Feed URL pagination is an external HTTP boundary; mock deterministic pages.
        def fake_http_get(url: str, **kwargs):
            _ = kwargs
            if url == page1_url:
                return httpx.Response(200, text=page1_xml, request=httpx.Request("GET", url))
            if url == page2_url:
                return httpx.Response(200, text=page2_xml, request=httpx.Request("GET", url))
            raise AssertionError(f"unexpected feed page url: {url}")

        monkeypatch.setattr("nexus.services.podcasts.httpx.get", fake_http_get)

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT m.title
                    FROM library_media lm
                    JOIN media m ON m.id = lm.media_id
                    WHERE lm.library_id = :library_id
                      AND m.kind = 'podcast_episode'
                    ORDER BY m.title ASC
                    """
                ),
                {"library_id": default_library_id},
            ).fetchall()

        titles = [row[0] for row in rows]
        assert titles == ["Episode Newer", "Episode Newest"], (
            "expected feed pagination fallback to recover newest episodes beyond provider cap, "
            f"got titles={titles}"
        )

    def test_subscribe_ingests_only_newest_plan_window(self, auth_client, monkeypatch, direct_db):
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=2,
        )

        provider_podcast_id = f"window-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Windowed Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-old",
                "guid": "guid-old",
                "title": "Episode Old",
                "audio_url": "https://cdn.example.com/old.mp3",
                "published_at": "2026-01-01T00:00:00Z",
                "duration_seconds": 600,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "old"},
                ],
            },
            {
                "provider_episode_id": "ep-newer",
                "guid": "guid-newer",
                "title": "Episode Newer",
                "audio_url": "https://cdn.example.com/newer.mp3",
                "published_at": "2026-02-01T00:00:00Z",
                "duration_seconds": 600,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "newer"},
                ],
            },
            {
                "provider_episode_id": "ep-newest",
                "guid": "guid-newest",
                "title": "Episode Newest",
                "audio_url": "https://cdn.example.com/newest.mp3",
                "published_at": "2026-03-01T00:00:00Z",
                "duration_seconds": 600,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "newest"},
                ],
            },
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT m.title
                    FROM library_media lm
                    JOIN media m ON m.id = lm.media_id
                    WHERE lm.library_id = :library_id
                      AND m.kind = 'podcast_episode'
                    ORDER BY m.title ASC
                    """
                ),
                {"library_id": default_library_id},
            ).fetchall()

        titles = [row[0] for row in rows]
        assert titles == ["Episode Newer", "Episode Newest"], (
            f"expected only newest two episodes under plan window=2, got titles={titles}"
        )

    def test_guid_identity_prevents_duplicates_across_retries(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )

        provider_podcast_id = f"guid-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Guid Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-guid-1",
                "guid": "global-guid-1",
                "title": "Guid Episode",
                "audio_url": "https://cdn.example.com/guid.mp3",
                "published_at": "2026-03-02T00:00:00Z",
                "duration_seconds": 300,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "guid"},
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))
        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_episodes pe
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                      AND pe.guid = 'global-guid-1'
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert count == 1, f"expected one GUID-identified episode row, got {count}"

    def test_fallback_identity_prevents_duplicates_when_guid_missing(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )

        provider_podcast_id = f"fallback-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Fallback Podcast")

        state = {"calls": 0}

        # EXTERNAL SEAM EXCEPTION:
        # Alternate external API payloads across calls to verify deterministic
        # fallback identity is stable even when provider_episode_id changes.
        def fake_search(self, query: str, limit: int) -> list[dict]:
            return [payload]

        def fake_fetch(self, provider_id: str, limit: int) -> list[dict]:
            state["calls"] += 1
            provider_episode_id = "ep-a" if state["calls"] == 1 else "ep-b"
            return [
                {
                    "provider_episode_id": provider_episode_id,
                    "guid": None,
                    "title": "No GUID Episode",
                    "audio_url": "https://cdn.example.com/no-guid.mp3",
                    "published_at": "2026-03-02T01:00:00Z",
                    "duration_seconds": 120,
                    "transcript_segments": [
                        {"t_start_ms": 0, "t_end_ms": 1000, "text": "same"},
                    ],
                }
            ]

        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.search_podcasts", fake_search
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes", fake_fetch
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))
        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_episodes pe
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert count == 1, f"expected one fallback-identified episode row, got {count}"

    def test_second_subscriber_reuses_episode_without_redundant_transcription_job(
        self, auth_client, monkeypatch, direct_db
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        default_a = _bootstrap_user(auth_client, user_a)
        default_b = _bootstrap_user(auth_client, user_b)

        _set_plan(
            auth_client,
            user_a,
            user_a,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )
        _set_plan(
            auth_client,
            user_b,
            user_b,
            plan_tier="free",
            daily_transcription_minutes=500,
            initial_episode_window=1,
        )

        provider_podcast_id = f"shared-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Shared Episode Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-shared-1",
                "guid": "shared-guid-1",
                "title": "Shared Episode",
                "audio_url": "https://cdn.example.com/shared.mp3",
                "published_at": "2026-03-02T02:00:00Z",
                "duration_seconds": 120,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "shared"},
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_a = _subscribe(auth_client, user_a, payload)
        _run_subscription_sync(direct_db, user_a, UUID(subscribe_a["podcast_id"]))
        subscribe_b = _subscribe(auth_client, user_b, payload)
        _run_subscription_sync(direct_db, user_b, UUID(subscribe_b["podcast_id"]))

        with direct_db.session() as session:
            media_a = session.execute(
                text(
                    """
                    SELECT lm.media_id
                    FROM library_media lm
                    JOIN media m ON m.id = lm.media_id
                    WHERE lm.library_id = :library_id
                      AND m.kind = 'podcast_episode'
                    """
                ),
                {"library_id": default_a},
            ).scalar()
            media_b = session.execute(
                text(
                    """
                    SELECT lm.media_id
                    FROM library_media lm
                    JOIN media m ON m.id = lm.media_id
                    WHERE lm.library_id = :library_id
                      AND m.kind = 'podcast_episode'
                    """
                ),
                {"library_id": default_b},
            ).scalar()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_transcription_jobs j
                    JOIN podcast_episodes pe ON pe.media_id = j.media_id
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert media_a is not None, "first subscriber did not get episode attachment"
        assert media_b is not None, "second subscriber did not get episode attachment"
        assert media_a == media_b, "expected both subscribers to share same global media row"
        assert job_count == 1, f"expected one transcription job globally, got {job_count}"


class TestPodcastQuotaAndPlans:
    def test_free_tier_over_quota_fails_with_stable_error_and_enqueues_nothing(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=5,
            initial_episode_window=1,
        )

        provider_podcast_id = f"quota-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Quota Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-quota-1",
                "guid": "guid-quota-1",
                "title": "Too Long Episode",
                "audio_url": "https://cdn.example.com/long.mp3",
                "published_at": "2026-03-02T03:00:00Z",
                "duration_seconds": 600,  # 10 minutes
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "long"},
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        response = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            "subscribe should acknowledge and enqueue sync in control plane, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["sync_status"] == "pending"

        sync_result = _run_subscription_sync(direct_db, user_id, UUID(data["podcast_id"]))
        assert sync_result["sync_status"] == "failed"
        assert sync_result["error_code"] == "E_PODCAST_QUOTA_EXCEEDED"

        with direct_db.session() as session:
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_transcription_jobs j
                    JOIN podcast_episodes pe ON pe.media_id = j.media_id
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert job_count == 0, "quota-blocked sync must enqueue zero transcription jobs"

    def test_manual_plan_change_applies_immediately(self, auth_client, monkeypatch, direct_db):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=5,
            initial_episode_window=1,
        )

        provider_podcast_id = f"plan-shift-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Plan Shift Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-plan-1",
                "guid": "guid-plan-1",
                "title": "Paid Plan Unlock",
                "audio_url": "https://cdn.example.com/paid.mp3",
                "published_at": "2026-03-02T04:00:00Z",
                "duration_seconds": 600,  # exceeds free 5m quota
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "paid"},
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        blocked = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert blocked.status_code == 200
        blocked_data = blocked.json()["data"]
        blocked_result = _run_subscription_sync(
            direct_db, user_id, UUID(blocked_data["podcast_id"])
        )
        assert blocked_result["sync_status"] == "failed"
        assert blocked_result["error_code"] == "E_PODCAST_QUOTA_EXCEEDED"

        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=1,
        )

        allowed = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert allowed.status_code == 200, (
            "expected subscribe to succeed immediately after paid plan assignment, "
            f"got {allowed.status_code}: {allowed.text}"
        )
        allowed_data = allowed.json()["data"]
        allowed_result = _run_subscription_sync(
            direct_db, user_id, UUID(allowed_data["podcast_id"])
        )
        assert allowed_result["sync_status"] == "complete"

    def test_quota_usage_resets_at_utc_day_boundary(self, auth_client, monkeypatch, direct_db):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=5,
            initial_episode_window=1,
        )

        yesterday = date.today() - timedelta(days=1)
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO podcast_transcription_usage_daily
                        (user_id, usage_date, minutes_used, updated_at)
                    VALUES (:user_id, :usage_date, :minutes_used, :updated_at)
                    ON CONFLICT (user_id, usage_date)
                    DO UPDATE SET
                        minutes_used = EXCLUDED.minutes_used,
                        updated_at = EXCLUDED.updated_at
                    """
                ),
                {
                    "user_id": user_id,
                    "usage_date": yesterday,
                    "minutes_used": 5,
                    "updated_at": datetime.now(UTC),
                },
            )
            session.commit()

        provider_podcast_id = f"utc-reset-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "UTC Reset Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-utc-1",
                "guid": "guid-utc-1",
                "title": "Today Episode",
                "audio_url": "https://cdn.example.com/today.mp3",
                "published_at": "2026-03-02T05:00:00Z",
                "duration_seconds": 300,  # exactly 5 minutes
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1000, "text": "today"},
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        response = auth_client.post(
            "/podcasts/subscriptions",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            "expected quota to reset on UTC day boundary; "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        sync_result = _run_subscription_sync(direct_db, user_id, UUID(data["podcast_id"]))
        assert sync_result["sync_status"] == "complete"

    def test_quota_usage_ledger_uses_utc_sync_time_not_local_date_today(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=10,
            initial_episode_window=1,
        )

        provider_podcast_id = f"utc-ledger-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "UTC Ledger Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-utc-ledger-1",
                "guid": "guid-utc-ledger-1",
                "title": "UTC Ledger Episode",
                "audio_url": "https://cdn.example.com/utc-ledger.mp3",
                "published_at": "2026-03-02T05:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "utc"}],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)

        fixed_now = datetime(2030, 1, 2, 3, 4, 5, tzinfo=UTC)
        wrong_local_today = date(1999, 1, 1)

        class FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is None:
                    return fixed_now.replace(tzinfo=None)
                return fixed_now.astimezone(tz)

        class WrongLocalDate(date):
            @classmethod
            def today(cls):
                return wrong_local_today

        monkeypatch.setattr("nexus.services.podcasts.datetime", FixedDatetime)
        monkeypatch.setattr("nexus.services.podcasts.date", WrongLocalDate)

        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            usage_date = session.execute(
                text(
                    """
                    SELECT usage_date
                    FROM podcast_transcription_usage_daily
                    WHERE user_id = :user_id
                    """
                ),
                {"user_id": user_id},
            ).scalar()

        assert usage_date == fixed_now.date(), (
            "usage ledger must bucket by UTC sync execution date, not host-local date.today()"
        )
        assert usage_date != wrong_local_today


class TestPodcastTranscriptPersistence:
    def test_transcript_segments_persist_with_deterministic_order_and_diarization_fallback(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=1,
        )

        provider_podcast_id = f"segments-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Segments Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-segments-1",
                "guid": "guid-segments-1",
                "title": "Ordered Segment Episode",
                "audio_url": "https://cdn.example.com/segments.mp3",
                "published_at": "2026-03-02T06:00:00Z",
                "duration_seconds": 120,
                # Intentionally unsorted to verify deterministic order on persistence/read.
                "transcript_segments": [
                    {
                        "t_start_ms": 5000,
                        "t_end_ms": 6500,
                        "text": "second segment",
                        "speaker_label": None,
                    },
                    {
                        "t_start_ms": 1000,
                        "t_end_ms": 2500,
                        "text": "first segment",
                        "speaker_label": "Host",
                    },
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            media_id = session.execute(
                text(
                    """
                    SELECT pe.media_id
                    FROM podcast_episodes pe
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert media_id is not None, "expected ingested podcast media row"

        fragments_response = auth_client.get(
            f"/media/{media_id}/fragments",
            headers=auth_headers(user_id),
        )
        assert fragments_response.status_code == 200, (
            f"expected transcript fragments to be readable, got {fragments_response.status_code}: "
            f"{fragments_response.text}"
        )
        fragments = fragments_response.json()["data"]

        starts = [frag["t_start_ms"] for frag in fragments]
        idxs = [frag["idx"] for frag in fragments]
        assert starts == sorted(starts), f"segments not ordered by t_start_ms: {starts}"
        assert len(set(idxs)) == len(idxs), f"expected unique (media_id, idx), got idxs={idxs}"
        assert fragments[0]["speaker_label"] == "Host"
        assert fragments[1]["speaker_label"] is None

    def test_transcript_unavailable_is_playback_only_with_stable_error_code(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=1,
        )

        provider_podcast_id = f"unavailable-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Unavailable Transcript Podcast")
        episodes = [
            {
                "provider_episode_id": "ep-unavailable-1",
                "guid": "guid-unavailable-1",
                "title": "Unavailable Transcript Episode",
                "audio_url": "https://cdn.example.com/playable.mp3",
                "published_at": "2026-03-02T07:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": None,
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            media_id = session.execute(
                text(
                    """
                    SELECT pe.media_id
                    FROM podcast_episodes pe
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).scalar()

        assert media_id is not None, "expected podcast media row"

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media = media_response.json()["data"]

        assert media["last_error_code"] == "E_TRANSCRIPT_UNAVAILABLE"
        caps = media["capabilities"]
        assert caps["can_play"] is True
        assert caps["can_read"] is False
        assert caps["can_highlight"] is False
        assert caps["can_quote"] is False
        assert caps["can_search"] is False
