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

    # EXTERNAL SEAM EXCEPTION:
    # Podcast transcription is an external provider boundary. This default
    # test seam mirrors legacy transcript_segments payload behavior so existing
    # lifecycle tests can focus on ingest contracts, while allowing specific
    # tests to override transcription outcomes explicitly.
    def fake_transcribe(audio_url: str) -> dict[str, object]:
        normalized_audio_url = str(audio_url or "").strip()
        for episode_rows in episodes_by_podcast.values():
            for episode in episode_rows:
                episode_audio_url = str(episode.get("audio_url") or "").strip()
                if episode_audio_url != normalized_audio_url:
                    continue

                override = episode.get("mock_transcription_result")
                if isinstance(override, dict):
                    return override

                transcript_segments = episode.get("transcript_segments")
                if isinstance(transcript_segments, list) and transcript_segments:
                    return {
                        "status": "completed",
                        "segments": transcript_segments,
                        "diagnostic_error_code": None,
                    }

                return {
                    "status": "failed",
                    "error_code": "E_TRANSCRIPT_UNAVAILABLE",
                    "error_message": "Transcript unavailable",
                }

        return {
            "status": "failed",
            "error_code": "E_TRANSCRIPT_UNAVAILABLE",
            "error_message": "Transcript unavailable",
        }

    monkeypatch.setattr("nexus.services.podcasts.PodcastIndexClient.search_podcasts", fake_search)
    monkeypatch.setattr(
        "nexus.services.podcasts.PodcastIndexClient.fetch_recent_episodes",
        fake_fetch,
    )
    monkeypatch.setattr(
        "nexus.services.podcasts._transcribe_podcast_audio",
        fake_transcribe,
        raising=False,
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
    direct_db: DirectSessionManager,
    user_id: UUID,
    podcast_id: UUID,
    *,
    run_transcription_jobs: bool = True,
    stub_enqueue: bool = True,
) -> dict:
    from nexus.services import podcasts as podcast_service
    from nexus.tasks.podcast_sync_subscription import run_podcast_subscription_sync_now
    from nexus.tasks.podcast_transcribe_episode import run_podcast_transcribe_now

    original_enqueue = podcast_service._enqueue_podcast_transcription_job

    def _enqueue_stub(*, media_id: UUID, requested_by_user_id: UUID | None) -> bool:
        _ = media_id, requested_by_user_id
        return True

    if stub_enqueue:
        podcast_service._enqueue_podcast_transcription_job = _enqueue_stub

    try:
        with direct_db.session() as session:
            result = run_podcast_subscription_sync_now(
                session,
                user_id=user_id,
                podcast_id=podcast_id,
            )
            if run_transcription_jobs:
                pending_jobs = session.execute(
                    text(
                        """
                        SELECT j.media_id, j.requested_by_user_id
                        FROM podcast_transcription_jobs j
                        JOIN podcast_episodes pe ON pe.media_id = j.media_id
                        WHERE pe.podcast_id = :podcast_id
                          AND j.status = 'pending'
                        ORDER BY j.media_id ASC
                        """
                    ),
                    {"podcast_id": podcast_id},
                ).fetchall()
                for row in pending_jobs:
                    run_podcast_transcribe_now(
                        session,
                        media_id=row[0],
                        requested_by_user_id=row[1],
                    )
            session.commit()
        return result
    finally:
        podcast_service._enqueue_podcast_transcription_job = original_enqueue


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
    def test_transcript_segments_are_sourced_from_transcription_provider_not_discovery_payload(
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

        provider_podcast_id = f"provider-source-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Provider Source Boundary Podcast")
        audio_url = "https://cdn.example.com/provider-source.mp3"
        episodes = [
            {
                "provider_episode_id": "ep-provider-source-1",
                "guid": "guid-provider-source-1",
                "title": "Provider Source Episode",
                "audio_url": audio_url,
                "published_at": "2026-03-02T06:00:00Z",
                "duration_seconds": 120,
                "transcript_segments": [
                    {
                        "t_start_ms": 0,
                        "t_end_ms": 900,
                        "text": "payload transcript segment should be ignored",
                        "speaker_label": "PayloadSpeaker",
                    }
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        provider_segments = [
            {
                "t_start_ms": 1200,
                "t_end_ms": 2600,
                "text": "provider transcript segment",
                "speaker_label": "ProviderSpeaker",
            }
        ]
        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "completed",
                "segments": provider_segments,
                "diagnostic_error_code": None,
            },
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
        assert media_id is not None

        fragments_response = auth_client.get(
            f"/media/{media_id}/fragments",
            headers=auth_headers(user_id),
        )
        assert fragments_response.status_code == 200, (
            f"expected transcript fragments to be readable, got {fragments_response.status_code}: "
            f"{fragments_response.text}"
        )
        fragments = fragments_response.json()["data"]
        assert len(fragments) == 1
        assert fragments[0]["canonical_text"] == "provider transcript segment"
        assert fragments[0]["speaker_label"] == "ProviderSpeaker"
        assert "payload transcript segment should be ignored" not in fragments[0]["canonical_text"]

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

    def test_diarization_fallback_success_is_readable_and_retains_diagnostic_error_code(
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

        provider_podcast_id = f"diarization-fallback-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Diarization Fallback Podcast")
        audio_url = "https://cdn.example.com/diarization-fallback.mp3"
        episodes = [
            {
                "provider_episode_id": "ep-diarization-fallback-1",
                "guid": "guid-diarization-fallback-1",
                "title": "Diarization Fallback Episode",
                "audio_url": audio_url,
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
        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "completed",
                "segments": [
                    {
                        "t_start_ms": 500,
                        "t_end_ms": 1800,
                        "text": "fallback transcript",
                        "speaker_label": None,
                    }
                ],
                "diagnostic_error_code": "E_DIARIZATION_FAILED",
            },
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT m.id, m.processing_status, m.last_error_code
                    FROM media m
                    JOIN podcast_episodes pe ON pe.media_id = m.id
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).fetchone()
            assert media_row is not None
            media_id = media_row[0]

            job_row = session.execute(
                text(
                    """
                    SELECT status, error_code
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()

        assert media_row[1] == "ready_for_reading", (
            f"diarization fallback success must remain readable, got status={media_row[1]}"
        )
        assert media_row[2] is None, (
            f"readable media must not carry terminal transcript error code, got {media_row[2]}"
        )
        assert job_row is not None
        assert job_row[0] == "completed"
        assert job_row[1] == "E_DIARIZATION_FAILED"

    @pytest.mark.parametrize(
        "terminal_error_code",
        ["E_TRANSCRIPTION_FAILED", "E_TRANSCRIPTION_TIMEOUT"],
    )
    def test_transcription_failures_map_to_explicit_terminal_error_codes(
        self, auth_client, monkeypatch, direct_db, terminal_error_code
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

        provider_podcast_id = f"terminal-error-{terminal_error_code.lower()}-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Terminal Error Podcast")
        episodes = [
            {
                "provider_episode_id": f"ep-{terminal_error_code.lower()}",
                "guid": f"guid-{terminal_error_code.lower()}",
                "title": "Terminal Error Episode",
                "audio_url": "https://cdn.example.com/terminal-error.mp3",
                "published_at": "2026-03-02T08:00:00Z",
                "duration_seconds": 90,
                "transcript_segments": [
                    {
                        "t_start_ms": 0,
                        "t_end_ms": 1000,
                        "text": "payload transcript must be ignored on provider failure",
                    }
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )
        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "failed",
                "error_code": terminal_error_code,
                "error_message": f"simulated {terminal_error_code}",
            },
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        _run_subscription_sync(direct_db, user_id, UUID(subscribe_data["podcast_id"]))

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT m.id, m.processing_status, m.failure_stage, m.last_error_code
                    FROM media m
                    JOIN podcast_episodes pe ON pe.media_id = m.id
                    JOIN podcasts p ON p.id = pe.podcast_id
                    WHERE p.provider_podcast_id = :provider_podcast_id
                    """
                ),
                {"provider_podcast_id": provider_podcast_id},
            ).fetchone()
            assert media_row is not None

            job_row = session.execute(
                text(
                    """
                    SELECT status, error_code
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_row[0]},
            ).fetchone()

        assert media_row[1] == "failed"
        assert media_row[2] == "transcribe"
        assert media_row[3] == terminal_error_code
        assert job_row is not None
        assert job_row[0] == "failed"
        assert job_row[1] == terminal_error_code

    def test_transcript_segments_are_canonicalized_and_invalid_timings_are_rejected(
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

        provider_podcast_id = f"canonicalize-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Canonicalization Podcast")
        raw_segments = [
            {
                "t_start_ms": 1000,
                "t_end_ms": 2000,
                "text": "Cafe\u0301\u00a0 \t  story",
                "speaker_label": " Host ",
            },
            {
                "t_start_ms": 2200,
                "t_end_ms": 2200,
                "text": "zero length segment should be rejected",
                "speaker_label": None,
            },
            {
                "t_start_ms": 2500,
                "t_end_ms": 2400,
                "text": "backwards segment should be rejected",
                "speaker_label": None,
            },
            {
                "t_start_ms": 2600,
                "t_end_ms": 3400,
                "text": "  second\n\nsegment  ",
                "speaker_label": "",
            },
        ]
        episodes = [
            {
                "provider_episode_id": "ep-canonicalize-1",
                "guid": "guid-canonicalize-1",
                "title": "Canonicalization Episode",
                "audio_url": "https://cdn.example.com/canonicalize.mp3",
                "published_at": "2026-03-02T09:00:00Z",
                "duration_seconds": 120,
                "transcript_segments": raw_segments,
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )
        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "completed",
                "segments": raw_segments,
                "diagnostic_error_code": None,
            },
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
        assert media_id is not None

        fragments_response = auth_client.get(
            f"/media/{media_id}/fragments",
            headers=auth_headers(user_id),
        )
        assert fragments_response.status_code == 200, (
            f"expected transcript fragments to be readable, got {fragments_response.status_code}: "
            f"{fragments_response.text}"
        )
        fragments = fragments_response.json()["data"]

        assert len(fragments) == 2, (
            "invalid transcript timings must be rejected instead of coerced into zero-length rows"
        )
        assert [frag["canonical_text"] for frag in fragments] == ["Café story", "second segment"]
        assert [(frag["t_start_ms"], frag["t_end_ms"]) for frag in fragments] == [
            (1000, 2000),
            (2600, 3400),
        ]
        assert fragments[0]["speaker_label"] == "Host"
        assert fragments[1]["speaker_label"] is None


def _run_active_subscription_poll(direct_db: DirectSessionManager, *, limit: int = 100) -> dict:
    from nexus.services.podcasts import poll_active_subscriptions_once

    with direct_db.session() as session:
        result = poll_active_subscriptions_once(session, limit=limit)
        session.commit()
    return result


def _run_scheduled_active_subscription_poll(
    direct_db: DirectSessionManager,
    *,
    limit: int = 100,
    run_lease_seconds: int = 300,
    scheduler_identity: str = "pytest-scheduler",
) -> dict:
    from nexus.tasks.podcast_active_subscription_poll import (
        run_podcast_active_subscription_poll_now,
    )

    with direct_db.session() as session:
        result = run_podcast_active_subscription_poll_now(
            session,
            limit=limit,
            run_lease_seconds=run_lease_seconds,
            scheduler_identity=scheduler_identity,
        )
        session.commit()
    return result


def _create_library(auth_client, user_id: UUID, *, name: str) -> UUID:
    response = auth_client.post(
        "/libraries",
        headers=auth_headers(user_id),
        json={"name": name},
    )
    assert response.status_code == 201, (
        f"expected library create 201, got {response.status_code}: {response.text}"
    )
    return UUID(response.json()["data"]["id"])


class TestPodcastMediaDetailContract:
    def test_media_detail_exposes_typed_playback_source_for_podcast_episode(
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

        provider_podcast_id = f"contract-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Playback Contract Podcast")
        audio_url = "https://cdn.example.com/contract.mp3"
        episodes = [
            {
                "provider_episode_id": "ep-contract-1",
                "guid": "guid-contract-1",
                "title": "Playback Contract Episode",
                "audio_url": audio_url,
                "published_at": "2026-03-02T07:00:00Z",
                "duration_seconds": 90,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1200, "text": "contract segment"}
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

        assert media_id is not None

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200, (
            f"expected media detail 200, got {media_response.status_code}: {media_response.text}"
        )
        media = media_response.json()["data"]

        playback_source = media["playback_source"]
        assert playback_source["kind"] == "external_audio"
        assert playback_source["stream_url"] == audio_url
        assert playback_source["source_url"] == audio_url


class TestPodcastPollingOrchestration:
    def test_scheduled_poll_rejects_non_positive_limit(self, direct_db):
        from nexus.errors import InvalidRequestError

        with pytest.raises(InvalidRequestError) as exc_info:
            _run_scheduled_active_subscription_poll(
                direct_db,
                limit=0,
                scheduler_identity="pytest-invalid-limit",
            )
        assert exc_info.value.code.value == "E_INVALID_REQUEST"

    def test_scheduled_poll_clamps_run_limit_to_service_max(self, direct_db):
        result = _run_scheduled_active_subscription_poll(
            direct_db,
            limit=5_000,
            scheduler_identity="pytest-clamped-limit",
        )
        assert result["status"] == "completed", (
            f"expected completed scheduled run for clamp assertion, got {result}"
        )

        with direct_db.session() as session:
            run_limit = session.execute(
                text(
                    """
                    SELECT run_limit
                    FROM podcast_subscription_poll_runs
                    WHERE id = :run_id
                    """
                ),
                {"run_id": UUID(result["run_id"])},
            ).scalar()
        assert run_limit == 1_000, f"expected persisted run_limit clamp to 1000, got {run_limit}"

    def test_scheduled_poll_persists_durable_run_counters_and_failure_breakdown(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="free",
            daily_transcription_minutes=1,
            initial_episode_window=1,
        )

        provider_podcast_id = f"scheduled-failure-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Scheduled Failure Podcast")
        episodes_by_podcast = {
            provider_podcast_id: [
                {
                    "provider_episode_id": "ep-failure-1",
                    "guid": "guid-failure-1",
                    "title": "Over Quota Episode",
                    "audio_url": "https://cdn.example.com/over-quota.mp3",
                    "published_at": "2026-03-02T10:00:00Z",
                    "duration_seconds": 600,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "quota"}],
                }
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])

        # Keep this assertion deterministic even when this class runs after other
        # podcast tests that may leave active subscriptions behind.
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET status = 'unsubscribed',
                        updated_at = :updated_at
                    WHERE NOT (user_id = :user_id AND podcast_id = :podcast_id)
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "updated_at": datetime.now(UTC),
                },
            )
            session.commit()

        result = _run_scheduled_active_subscription_poll(
            direct_db,
            limit=100,
            scheduler_identity="pytest-scheduled-run",
        )

        assert result["status"] == "completed", f"expected completed run, got {result}"
        assert result["processed_count"] == 0
        assert result["failed_count"] == 1
        assert result["skipped_count"] == 0
        assert result["scanned_count"] == 1
        assert "run_id" in result and result["run_id"], (
            f"expected durable run_id in scheduled poll result, got {result}"
        )

        status_response = auth_client.get(
            f"/podcasts/subscriptions/{podcast_id}",
            headers=auth_headers(user_id),
        )
        assert status_response.status_code == 200, (
            f"expected subscription status 200, got {status_response.status_code}: "
            f"{status_response.text}"
        )
        status_data = status_response.json()["data"]
        assert status_data["sync_status"] == "failed"
        assert status_data["sync_error_code"] == "E_PODCAST_QUOTA_EXCEEDED"

        with direct_db.session() as session:
            run_row = session.execute(
                text(
                    """
                    SELECT
                        status,
                        processed_count,
                        failed_count,
                        skipped_count,
                        scanned_count
                    FROM podcast_subscription_poll_runs
                    WHERE id = :run_id
                    """
                ),
                {"run_id": UUID(result["run_id"])},
            ).fetchone()
            assert run_row is not None, (
                f"expected durable poll run row for run_id={result['run_id']}, found none"
            )

            failure_rows = session.execute(
                text(
                    """
                    SELECT error_code, failure_count
                    FROM podcast_subscription_poll_run_failures
                    WHERE run_id = :run_id
                    ORDER BY error_code ASC
                    """
                ),
                {"run_id": UUID(result["run_id"])},
            ).fetchall()

        assert run_row[0] == "completed"
        assert run_row[1:] == (0, 1, 0, 1), (
            f"durable run counters mismatch: expected (0,1,0,1), got {run_row[1:]}"
        )
        assert failure_rows == [("E_PODCAST_QUOTA_EXCEEDED", 1)], (
            f"expected stable durable failure-code breakdown for poll run, got {failure_rows}"
        )

    def test_scheduled_poll_is_singleton_safe_when_another_run_is_active(self, direct_db):
        now = datetime.now(UTC)
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_poll_runs (
                        id,
                        orchestration_source,
                        scheduler_identity,
                        status,
                        run_limit,
                        started_at,
                        lease_expires_at,
                        processed_count,
                        failed_count,
                        skipped_count,
                        scanned_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :id,
                        'scheduled',
                        'other-scheduler',
                        'running',
                        100,
                        :started_at,
                        :lease_expires_at,
                        0,
                        0,
                        0,
                        0,
                        :now,
                        :now
                    )
                    """
                ),
                {
                    "id": uuid4(),
                    "started_at": now - timedelta(seconds=10),
                    "lease_expires_at": now + timedelta(minutes=10),
                    "now": now,
                },
            )
            session.commit()

        try:
            result = _run_scheduled_active_subscription_poll(
                direct_db,
                limit=10,
                scheduler_identity="pytest-contender",
            )
            assert result["status"] == "skipped_singleton", (
                "expected scheduled poll contender to skip when another active run lease exists, "
                f"got {result}"
            )
        finally:
            with direct_db.session() as session:
                session.execute(
                    text(
                        """
                        UPDATE podcast_subscription_poll_runs
                        SET status = 'expired',
                            completed_at = :now,
                            updated_at = :now
                        WHERE status = 'running'
                        """
                    ),
                    {"now": datetime.now(UTC)},
                )
                session.commit()

    def test_poll_reclaims_expired_running_sync_claim(self, auth_client, monkeypatch, direct_db):
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

        provider_podcast_id = f"stale-running-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Stale Running Claim Podcast")
        episodes_by_podcast = {
            provider_podcast_id: [
                {
                    "provider_episode_id": "ep-stale-1",
                    "guid": "guid-stale-1",
                    "title": "Recovered Episode",
                    "audio_url": "https://cdn.example.com/recovered.mp3",
                    "published_at": "2026-03-02T10:30:00Z",
                    "duration_seconds": 60,
                    "transcript_segments": [
                        {"t_start_ms": 0, "t_end_ms": 900, "text": "recovered"}
                    ],
                }
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )
        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = 'running',
                        sync_started_at = :sync_started_at,
                        sync_completed_at = NULL,
                        updated_at = :updated_at
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "sync_started_at": datetime.now(UTC) - timedelta(hours=2),
                    "updated_at": datetime.now(UTC) - timedelta(hours=2),
                },
            )
            session.commit()

        result = _run_scheduled_active_subscription_poll(
            direct_db,
            limit=100,
            scheduler_identity="pytest-stale-recovery",
        )
        assert result["processed_count"] == 1, (
            f"expected stale running claim to be reclaimed and processed, got {result}"
        )

        status_response = auth_client.get(
            f"/podcasts/subscriptions/{podcast_id}",
            headers=auth_headers(user_id),
        )
        assert status_response.status_code == 200
        status_data = status_response.json()["data"]
        assert status_data["sync_status"] in {"complete", "source_limited"}
        assert status_data["last_synced_at"] is not None

    def test_scheduled_poll_is_bounded_by_explicit_run_limit(
        self, auth_client, monkeypatch, direct_db
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        _bootstrap_user(auth_client, user_a)
        _bootstrap_user(auth_client, user_b)
        _set_plan(
            auth_client,
            user_a,
            user_a,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=1,
        )
        _set_plan(
            auth_client,
            user_b,
            user_b,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=1,
        )

        provider_a = f"bounded-a-{uuid4()}"
        provider_b = f"bounded-b-{uuid4()}"
        payload_a = _podcast_payload(provider_a, "Bounded Podcast A")
        payload_b = _podcast_payload(provider_b, "Bounded Podcast B")

        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload_a, payload_b],
            episodes_by_podcast={
                provider_a: [
                    {
                        "provider_episode_id": "ep-bound-a-1",
                        "guid": "guid-bound-a-1",
                        "title": "Bounded Episode A",
                        "audio_url": "https://cdn.example.com/bounded-a.mp3",
                        "published_at": "2026-03-02T11:00:00Z",
                        "duration_seconds": 60,
                        "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 700, "text": "a"}],
                    }
                ],
                provider_b: [
                    {
                        "provider_episode_id": "ep-bound-b-1",
                        "guid": "guid-bound-b-1",
                        "title": "Bounded Episode B",
                        "audio_url": "https://cdn.example.com/bounded-b.mp3",
                        "published_at": "2026-03-02T11:01:00Z",
                        "duration_seconds": 60,
                        "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 700, "text": "b"}],
                    }
                ],
            },
        )

        _subscribe(auth_client, user_a, payload_a)
        _subscribe(auth_client, user_b, payload_b)

        result = _run_scheduled_active_subscription_poll(
            direct_db,
            limit=1,
            scheduler_identity="pytest-bounded-limit",
        )
        assert result["scanned_count"] == 1, (
            f"expected scanned_count=1 with run limit=1, got {result}"
        )
        assert result["processed_count"] + result["failed_count"] + result["skipped_count"] <= 1, (
            f"bounded run processed more subscriptions than limit permits: {result}"
        )


class TestPodcastSubscriptionLifecycleClosure:
    def _ingest_single_episode_subscription(
        self,
        *,
        auth_client,
        monkeypatch,
        direct_db,
        user_id: UUID,
        provider_podcast_id: str,
        title: str,
        episode_title: str,
        audio_url: str,
    ) -> tuple[UUID, UUID]:
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=3,
        )
        payload = _podcast_payload(provider_podcast_id, title)
        episodes = [
            {
                "provider_episode_id": f"ep-{provider_podcast_id}-1",
                "guid": f"guid-{provider_podcast_id}-1",
                "title": episode_title,
                "audio_url": audio_url,
                "published_at": "2026-03-02T08:00:00Z",
                "duration_seconds": 180,
                "transcript_segments": [
                    {"t_start_ms": 0, "t_end_ms": 1500, "text": "episode transcript"}
                ],
            }
        ]
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast={provider_podcast_id: episodes},
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])
        _run_subscription_sync(direct_db, user_id, podcast_id)

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
        assert media_id is not None
        return podcast_id, media_id

    def test_unsubscribe_defaults_to_mode_1_and_stops_future_poll_ingest(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        provider_podcast_id = f"mode1-{uuid4()}"
        default_library_id = _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=2,
        )
        payload = _podcast_payload(provider_podcast_id, "Mode 1 Podcast")
        episodes_by_podcast = {
            provider_podcast_id: [
                {
                    "provider_episode_id": "ep-m1-1",
                    "guid": "guid-m1-1",
                    "title": "Episode One",
                    "audio_url": "https://cdn.example.com/m1-1.mp3",
                    "published_at": "2026-03-02T09:00:00Z",
                    "duration_seconds": 120,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 1000, "text": "first"}],
                }
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])
        _run_subscription_sync(direct_db, user_id, podcast_id)

        episodes_by_podcast[provider_podcast_id].append(
            {
                "provider_episode_id": "ep-m1-2",
                "guid": "guid-m1-2",
                "title": "Episode Two",
                "audio_url": "https://cdn.example.com/m1-2.mp3",
                "published_at": "2026-03-03T09:00:00Z",
                "duration_seconds": 120,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 900, "text": "second"}],
            }
        )

        unsubscribe = auth_client.delete(
            f"/podcasts/subscriptions/{podcast_id}",
            headers=auth_headers(user_id),
        )
        assert unsubscribe.status_code == 200, (
            f"expected unsubscribe 200, got {unsubscribe.status_code}: {unsubscribe.text}"
        )
        unsubscribed_data = unsubscribe.json()["data"]
        assert unsubscribed_data["status"] == "unsubscribed"
        assert unsubscribed_data["unsubscribe_mode"] == 1

        poll_result = _run_active_subscription_poll(direct_db, limit=100)
        assert poll_result["processed_count"] == 0

        with direct_db.session() as session:
            titles = session.execute(
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
        assert [row[0] for row in titles] == ["Episode One"]

    def test_unsubscribe_mode_2_removes_default_but_never_shared_library_media(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        collaborator_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _bootstrap_user(auth_client, collaborator_id)

        provider_podcast_id = f"mode2-{uuid4()}"
        podcast_id, media_id = self._ingest_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=user_id,
            provider_podcast_id=provider_podcast_id,
            title="Mode 2 Podcast",
            episode_title="Mode 2 Episode",
            audio_url="https://cdn.example.com/m2.mp3",
        )

        shared_library_id = _create_library(
            auth_client, user_id, name=f"shared-{provider_podcast_id}"
        )
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'member')
                    """
                ),
                {"library_id": shared_library_id, "user_id": collaborator_id},
            )
            session.commit()

        add_shared = auth_client.post(
            f"/libraries/{shared_library_id}/media",
            headers=auth_headers(user_id),
            json={"media_id": str(media_id)},
        )
        assert add_shared.status_code == 201

        unsubscribe = auth_client.delete(
            f"/podcasts/subscriptions/{podcast_id}?mode=2",
            headers=auth_headers(user_id),
        )
        assert unsubscribe.status_code == 200
        data = unsubscribe.json()["data"]
        assert data["status"] == "unsubscribed"
        assert data["unsubscribe_mode"] == 2

        with direct_db.session() as session:
            default_intrinsic = session.execute(
                text(
                    """
                    SELECT 1
                    FROM default_library_intrinsics
                    WHERE default_library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": default_library_id, "media_id": media_id},
            ).fetchone()
            shared_row = session.execute(
                text(
                    """
                    SELECT 1
                    FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": shared_library_id, "media_id": media_id},
            ).fetchone()

        assert default_intrinsic is None
        assert shared_row is not None

    def test_unsubscribe_mode_3_removes_single_member_libraries_without_touching_shared(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        collaborator_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _bootstrap_user(auth_client, collaborator_id)

        provider_podcast_id = f"mode3-{uuid4()}"
        podcast_id, media_id = self._ingest_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=user_id,
            provider_podcast_id=provider_podcast_id,
            title="Mode 3 Podcast",
            episode_title="Mode 3 Episode",
            audio_url="https://cdn.example.com/m3.mp3",
        )

        single_member_library_id = _create_library(
            auth_client, user_id, name=f"solo-{provider_podcast_id}"
        )
        shared_library_id = _create_library(
            auth_client, user_id, name=f"shared-{provider_podcast_id}"
        )
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'member')
                    """
                ),
                {"library_id": shared_library_id, "user_id": collaborator_id},
            )
            session.commit()

        add_single = auth_client.post(
            f"/libraries/{single_member_library_id}/media",
            headers=auth_headers(user_id),
            json={"media_id": str(media_id)},
        )
        assert add_single.status_code == 201
        add_shared = auth_client.post(
            f"/libraries/{shared_library_id}/media",
            headers=auth_headers(user_id),
            json={"media_id": str(media_id)},
        )
        assert add_shared.status_code == 201

        unsubscribe = auth_client.delete(
            f"/podcasts/subscriptions/{podcast_id}?mode=3",
            headers=auth_headers(user_id),
        )
        assert unsubscribe.status_code == 200
        data = unsubscribe.json()["data"]
        assert data["status"] == "unsubscribed"
        assert data["unsubscribe_mode"] == 3

        with direct_db.session() as session:
            default_intrinsic = session.execute(
                text(
                    """
                    SELECT 1
                    FROM default_library_intrinsics
                    WHERE default_library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": default_library_id, "media_id": media_id},
            ).fetchone()
            single_member_row = session.execute(
                text(
                    """
                    SELECT 1
                    FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": single_member_library_id, "media_id": media_id},
            ).fetchone()
            shared_row = session.execute(
                text(
                    """
                    SELECT 1
                    FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": shared_library_id, "media_id": media_id},
            ).fetchone()

        assert default_intrinsic is None
        assert single_member_row is None
        assert shared_row is not None

    def test_active_subscription_poll_ingests_newly_published_episode(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=2,
        )

        provider_podcast_id = f"poll-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Polling Podcast")
        episodes_by_podcast = {
            provider_podcast_id: [
                {
                    "provider_episode_id": "ep-poll-1",
                    "guid": "guid-poll-1",
                    "title": "Poll Episode One",
                    "audio_url": "https://cdn.example.com/poll-1.mp3",
                    "published_at": "2026-03-01T09:00:00Z",
                    "duration_seconds": 60,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 800, "text": "one"}],
                }
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])
        _run_subscription_sync(direct_db, user_id, podcast_id)

        episodes_by_podcast[provider_podcast_id].append(
            {
                "provider_episode_id": "ep-poll-2",
                "guid": "guid-poll-2",
                "title": "Poll Episode Two",
                "audio_url": "https://cdn.example.com/poll-2.mp3",
                "published_at": "2026-03-02T09:00:00Z",
                "duration_seconds": 60,
                "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 900, "text": "two"}],
            }
        )

        poll_result = _run_active_subscription_poll(direct_db, limit=100)
        assert poll_result["processed_count"] == 1

        with direct_db.session() as session:
            titles = session.execute(
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

        assert [row[0] for row in titles] == ["Poll Episode One", "Poll Episode Two"]


class TestPodcastApiSurface:
    def _subscribe_and_sync_single_podcast(
        self,
        *,
        auth_client,
        monkeypatch,
        direct_db,
        user_id: UUID,
        provider_podcast_id: str,
        title: str,
    ) -> tuple[UUID, dict[str, list[dict[str, object]]]]:
        _bootstrap_user(auth_client, user_id)
        _set_plan(
            auth_client,
            user_id,
            user_id,
            plan_tier="paid",
            daily_transcription_minutes=None,
            initial_episode_window=5,
        )
        payload = _podcast_payload(provider_podcast_id, title)
        episodes_by_podcast: dict[str, list[dict[str, object]]] = {
            provider_podcast_id: [
                {
                    "provider_episode_id": f"{provider_podcast_id}-ep-1",
                    "guid": f"{provider_podcast_id}-guid-1",
                    "title": "Episode 1",
                    "audio_url": "https://cdn.example.com/podcast-ep-1.mp3",
                    "published_at": "2026-03-03T10:00:00Z",
                    "duration_seconds": 120,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 800, "text": "ep1"}],
                },
                {
                    "provider_episode_id": f"{provider_podcast_id}-ep-2",
                    "guid": f"{provider_podcast_id}-guid-2",
                    "title": "Episode 2",
                    "audio_url": "https://cdn.example.com/podcast-ep-2.mp3",
                    "published_at": "2026-03-02T10:00:00Z",
                    "duration_seconds": 90,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 700, "text": "ep2"}],
                },
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )
        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])
        _run_subscription_sync(direct_db, user_id, podcast_id)
        return podcast_id, episodes_by_podcast

    def test_list_subscriptions_returns_podcast_metadata_and_sync_snapshot(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        provider_podcast_id = f"surface-list-{uuid4()}"
        podcast_id, _ = self._subscribe_and_sync_single_podcast(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=user_id,
            provider_podcast_id=provider_podcast_id,
            title="Surface Podcast",
        )

        response = auth_client.get("/podcasts/subscriptions", headers=auth_headers(user_id))
        assert response.status_code == 200, (
            f"expected 200 from subscriptions list, got {response.status_code}: {response.text}"
        )
        rows = response.json()["data"]
        assert len(rows) == 1, f"expected exactly one subscription row, got: {rows}"
        row = rows[0]
        assert row["podcast_id"] == str(podcast_id)
        assert row["status"] == "active"
        assert row["sync_status"] in {"complete", "source_limited"}
        assert row["podcast"]["provider_podcast_id"] == provider_podcast_id
        assert row["podcast"]["title"] == "Surface Podcast"
        assert row["podcast"]["feed_url"] == f"https://feeds.example.com/{provider_podcast_id}.xml"

    def test_get_podcast_detail_returns_podcast_and_subscription_payload(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        provider_podcast_id = f"surface-detail-{uuid4()}"
        podcast_id, _ = self._subscribe_and_sync_single_podcast(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=user_id,
            provider_podcast_id=provider_podcast_id,
            title="Detail Podcast",
        )

        response = auth_client.get(f"/podcasts/{podcast_id}", headers=auth_headers(user_id))
        assert response.status_code == 200, (
            f"expected 200 from podcast detail, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["podcast"]["id"] == str(podcast_id)
        assert data["podcast"]["provider_podcast_id"] == provider_podcast_id
        assert data["podcast"]["title"] == "Detail Podcast"
        assert data["subscription"]["status"] == "active"
        assert data["subscription"]["podcast_id"] == str(podcast_id)

    def test_get_podcast_episodes_returns_visible_episode_media(
        self, auth_client, monkeypatch, direct_db
    ):
        user_id = create_test_user_id()
        provider_podcast_id = f"surface-episodes-{uuid4()}"
        podcast_id, _ = self._subscribe_and_sync_single_podcast(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=user_id,
            provider_podcast_id=provider_podcast_id,
            title="Episodes Podcast",
        )

        response = auth_client.get(
            f"/podcasts/{podcast_id}/episodes?limit=10",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected 200 from podcast episodes list, got {response.status_code}: {response.text}"
        )
        rows = response.json()["data"]
        assert len(rows) == 2, f"expected two episode media rows, got: {rows}"
        assert rows[0]["kind"] == "podcast_episode"
        assert rows[0]["playback_source"]["kind"] == "external_audio"
        assert rows[0]["title"] == "Episode 1"
        assert rows[1]["title"] == "Episode 2"

    def test_non_subscriber_gets_masked_404_for_podcast_detail_and_episodes(
        self, auth_client, monkeypatch, direct_db
    ):
        subscriber_id = create_test_user_id()
        other_user_id = create_test_user_id()
        provider_podcast_id = f"surface-authz-{uuid4()}"
        podcast_id, _ = self._subscribe_and_sync_single_podcast(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            user_id=subscriber_id,
            provider_podcast_id=provider_podcast_id,
            title="Authz Podcast",
        )
        _bootstrap_user(auth_client, other_user_id)

        detail_response = auth_client.get(
            f"/podcasts/{podcast_id}",
            headers=auth_headers(other_user_id),
        )
        assert detail_response.status_code == 404, (
            "podcast detail should be hidden from non-subscribers to prevent existence leakage, "
            f"got {detail_response.status_code}: {detail_response.text}"
        )

        episodes_response = auth_client.get(
            f"/podcasts/{podcast_id}/episodes",
            headers=auth_headers(other_user_id),
        )
        assert episodes_response.status_code == 404, (
            "podcast episodes should be hidden from non-subscribers to prevent existence leakage, "
            f"got {episodes_response.status_code}: {episodes_response.text}"
        )

    def test_discover_retries_transient_provider_timeout_before_failing(
        self, auth_client, monkeypatch
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        monkeypatch.setenv("PODCAST_INDEX_API_KEY", "test-key")
        monkeypatch.setenv("PODCAST_INDEX_API_SECRET", "test-secret")
        clear_settings_cache()

        call_count = {"value": 0}

        class _FakeResponse:
            status_code = 200

            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict[str, object]:
                return {
                    "feeds": [
                        {
                            "id": "provider-1",
                            "url": "https://feeds.example.com/provider-1.xml",
                            "title": "Retry Podcast",
                            "author": "Retry Author",
                        }
                    ]
                }

        def flaky_get(*args, **kwargs):  # noqa: ANN002, ANN003
            _ = args, kwargs
            call_count["value"] += 1
            if call_count["value"] < 3:
                raise httpx.TimeoutException("timeout")
            return _FakeResponse()

        monkeypatch.setattr("nexus.services.podcasts.httpx.get", flaky_get)
        response = auth_client.get(
            "/podcasts/discover?q=retry&limit=10", headers=auth_headers(user_id)
        )
        assert response.status_code == 200, (
            "discover should survive transient provider timeout via retry/backoff; "
            f"got {response.status_code}: {response.text}"
        )
        assert call_count["value"] == 3, (
            f"expected timeout retries before success (3 attempts), got {call_count['value']}"
        )
        data = response.json()["data"]
        assert data[0]["title"] == "Retry Podcast"


class TestPodcastTranscriptionAsyncLifecycle:
    def _seed_single_episode_subscription(
        self,
        *,
        auth_client,
        monkeypatch,
        direct_db,
        run_transcription_jobs: bool,
    ) -> dict[str, UUID]:
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

        provider_podcast_id = f"tx-lifecycle-{uuid4()}"
        payload = _podcast_payload(provider_podcast_id, "Lifecycle Podcast")
        episodes_by_podcast = {
            provider_podcast_id: [
                {
                    "provider_episode_id": f"{provider_podcast_id}-ep-1",
                    "guid": f"{provider_podcast_id}-guid-1",
                    "title": "Lifecycle Episode",
                    "audio_url": "https://cdn.example.com/lifecycle-1.mp3",
                    "published_at": "2026-03-04T10:00:00Z",
                    "duration_seconds": 180,
                    "transcript_segments": [{"t_start_ms": 0, "t_end_ms": 700, "text": "seed"}],
                }
            ]
        }
        _mock_podcast_index(
            monkeypatch,
            podcasts=[payload],
            episodes_by_podcast=episodes_by_podcast,
        )

        subscribe_data = _subscribe(auth_client, user_id, payload)
        podcast_id = UUID(subscribe_data["podcast_id"])
        _run_subscription_sync(
            direct_db,
            user_id,
            podcast_id,
            run_transcription_jobs=run_transcription_jobs,
            stub_enqueue=True,
        )

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
            assert media_id is not None

        return {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "media_id": media_id,
        }

    def test_sync_creates_pending_transcription_job_without_inline_transcription(
        self, auth_client, monkeypatch, direct_db
    ):
        seeded = self._seed_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            run_transcription_jobs=False,
        )

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT
                        m.processing_status,
                        m.failure_stage,
                        m.last_error_code,
                        j.status,
                        j.attempts,
                        j.started_at,
                        j.completed_at
                    FROM media m
                    JOIN podcast_transcription_jobs j ON j.media_id = m.id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": seeded["media_id"]},
            ).fetchone()

        assert row is not None
        assert row[0] == "extracting"
        assert row[1] is None
        assert row[2] is None
        assert row[3] == "pending"
        assert row[4] == 0
        assert row[5] is None
        assert row[6] is None

    def test_manual_transcription_worker_claims_pending_job_and_marks_completed(
        self, auth_client, monkeypatch, direct_db
    ):
        seeded = self._seed_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            run_transcription_jobs=False,
        )
        media_id = seeded["media_id"]
        user_id = seeded["user_id"]

        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "completed",
                "segments": [
                    {"t_start_ms": 0, "t_end_ms": 800, "text": "first"},
                    {"t_start_ms": 900, "t_end_ms": 1700, "text": "second"},
                ],
            },
        )

        from nexus.tasks.podcast_transcribe_episode import run_podcast_transcribe_now

        with direct_db.session() as session:
            result = run_podcast_transcribe_now(
                session,
                media_id=media_id,
                requested_by_user_id=user_id,
            )
            session.commit()

        assert result["status"] == "completed"
        assert result["segment_count"] == 2

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, failure_stage, last_error_code
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            job_row = session.execute(
                text(
                    """
                    SELECT status, attempts, started_at, completed_at, error_code
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            fragment_count = session.execute(
                text("SELECT COUNT(*) FROM fragments WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar()

        assert media_row is not None
        assert media_row[0] == "ready_for_reading"
        assert media_row[1] is None
        assert media_row[2] is None
        assert job_row is not None
        assert job_row[0] == "completed"
        assert job_row[1] == 1
        assert job_row[2] is not None
        assert job_row[3] is not None
        assert job_row[4] is None
        assert fragment_count == 2

    def test_manual_transcription_worker_is_idempotent_after_completion(
        self, auth_client, monkeypatch, direct_db
    ):
        seeded = self._seed_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            run_transcription_jobs=False,
        )
        media_id = seeded["media_id"]
        user_id = seeded["user_id"]

        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "completed",
                "segments": [{"t_start_ms": 0, "t_end_ms": 600, "text": "single"}],
            },
        )

        from nexus.tasks.podcast_transcribe_episode import run_podcast_transcribe_now

        with direct_db.session() as session:
            first = run_podcast_transcribe_now(
                session,
                media_id=media_id,
                requested_by_user_id=user_id,
            )
            second = run_podcast_transcribe_now(
                session,
                media_id=media_id,
                requested_by_user_id=user_id,
            )
            session.commit()

        assert first["status"] == "completed"
        assert second["status"] == "skipped"
        assert second["reason"] == "not_pending"
        assert second["job_status"] == "completed"

        with direct_db.session() as session:
            attempts = session.execute(
                text(
                    """
                    SELECT attempts
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).scalar()
        assert attempts == 1

    def test_retry_endpoint_requeues_failed_podcast_transcription_and_is_idempotent(
        self, auth_client, monkeypatch, direct_db
    ):
        seeded = self._seed_single_episode_subscription(
            auth_client=auth_client,
            monkeypatch=monkeypatch,
            direct_db=direct_db,
            run_transcription_jobs=False,
        )
        media_id = seeded["media_id"]
        user_id = seeded["user_id"]

        monkeypatch.setattr(
            "nexus.services.podcasts._transcribe_podcast_audio",
            lambda _audio_url: {
                "status": "failed",
                "error_code": "E_TRANSCRIPTION_FAILED",
                "error_message": "simulated terminal failure",
            },
        )

        from nexus.tasks.podcast_transcribe_episode import run_podcast_transcribe_now

        with direct_db.session() as session:
            failed_result = run_podcast_transcribe_now(
                session,
                media_id=media_id,
                requested_by_user_id=user_id,
            )
            session.commit()
        assert failed_result["status"] == "failed"

        from unittest.mock import patch

        with patch(
            "nexus.tasks.podcast_transcribe_episode.podcast_transcribe_episode_job.apply_async"
        ) as mock_dispatch:
            mock_dispatch.return_value = None
            retry_response = auth_client.post(
                f"/media/{media_id}/retry",
                headers=auth_headers(user_id),
            )

        assert retry_response.status_code == 202, (
            f"expected podcast retry endpoint to accept failed transcribe media, got "
            f"{retry_response.status_code}: {retry_response.text}"
        )
        retry_data = retry_response.json()["data"]
        assert retry_data["processing_status"] == "extracting"
        assert retry_data["retry_enqueued"] is True
        mock_dispatch.assert_called_once()

        with direct_db.session() as session:
            job_row = session.execute(
                text(
                    """
                    SELECT status, error_code, started_at, completed_at
                    FROM podcast_transcription_jobs
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, failure_stage, last_error_code
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()

        assert job_row is not None
        assert job_row[0] == "pending"
        assert job_row[1] is None
        assert job_row[2] is None
        assert job_row[3] is None
        assert media_row is not None
        assert media_row[0] == "extracting"
        assert media_row[1] is None
        assert media_row[2] is None

        with patch(
            "nexus.tasks.podcast_transcribe_episode.podcast_transcribe_episode_job.apply_async"
        ) as second_dispatch:
            second_retry = auth_client.post(
                f"/media/{media_id}/retry",
                headers=auth_headers(user_id),
            )
        assert second_retry.status_code == 202
        second_data = second_retry.json()["data"]
        assert second_data["processing_status"] == "extracting"
        assert second_data["retry_enqueued"] is False
        second_dispatch.assert_not_called()

    def test_retry_endpoint_requeues_failed_video_transcription_and_is_idempotent(
        self, auth_client, direct_db
    ):
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, user_id)

        media_id = uuid4()
        now = datetime.now(UTC)
        playback_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        failure_stage,
                        last_error_code,
                        last_error_message,
                        external_playback_url,
                        provider,
                        provider_id,
                        created_by_user_id,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :id,
                        'video',
                        :title,
                        :canonical_source_url,
                        'failed',
                        'transcribe',
                        'E_TRANSCRIPTION_FAILED',
                        'simulated failure',
                        :external_playback_url,
                        'youtube',
                        :provider_id,
                        :created_by_user_id,
                        :created_at,
                        :updated_at
                    )
                    """
                ),
                {
                    "id": media_id,
                    "title": "Failed Video",
                    "canonical_source_url": playback_url,
                    "external_playback_url": playback_url,
                    "provider_id": "dQw4w9WgXcQ",
                    "created_by_user_id": user_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO default_library_intrinsics (default_library_id, media_id, created_at)
                    VALUES (:default_library_id, :media_id, :created_at)
                    """
                ),
                {
                    "default_library_id": default_library_id,
                    "media_id": media_id,
                    "created_at": now,
                },
            )
            session.commit()

        from unittest.mock import patch

        with patch(
            "nexus.tasks.ingest_youtube_video.ingest_youtube_video.apply_async"
        ) as mock_dispatch:
            mock_dispatch.return_value = None
            retry_response = auth_client.post(
                f"/media/{media_id}/retry",
                headers=auth_headers(user_id),
            )

        assert retry_response.status_code == 202, (
            f"expected video retry endpoint to accept failed transcribe media, got "
            f"{retry_response.status_code}: {retry_response.text}"
        )
        retry_data = retry_response.json()["data"]
        assert retry_data["processing_status"] == "extracting"
        assert retry_data["retry_enqueued"] is True
        mock_dispatch.assert_called_once()

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, failure_stage, last_error_code
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
        assert media_row is not None
        assert media_row[0] == "extracting"
        assert media_row[1] is None
        assert media_row[2] is None

        with patch(
            "nexus.tasks.ingest_youtube_video.ingest_youtube_video.apply_async"
        ) as second_dispatch:
            second_retry = auth_client.post(
                f"/media/{media_id}/retry",
                headers=auth_headers(user_id),
            )
        assert second_retry.status_code == 202
        second_data = second_retry.json()["data"]
        assert second_data["processing_status"] == "extracting"
        assert second_data["retry_enqueued"] is False
        second_dispatch.assert_not_called()
