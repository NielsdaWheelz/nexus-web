"""Integration tests for browse acquisition routes."""

from uuid import uuid4

import pytest

from nexus.schemas.podcast import PodcastDiscoveryOut
from nexus.services import browse as browse_service
from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id):
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200


class _FakePodcastClient:
    def __init__(self, episode_rows):
        self._episode_rows = episode_rows

    def fetch_recent_episodes(self, provider_podcast_id: str, limit: int):
        return self._episode_rows.get(provider_podcast_id, [])[:limit]


class TestBrowse:
    def test_browse_initial_search_returns_grouped_sections_for_all_types(
        self, auth_client, monkeypatch
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_podcast_id = f"browse-{uuid4()}"
        monkeypatch.setattr(
            browse_service,
            "_search_document_rows",
            lambda query, *, limit, page_index: [
                {
                    "type": "documents",
                    "title": "Agents PDF",
                    "description": "PDF manual",
                    "url": "https://example.com/agents.pdf",
                    "document_kind": "pdf",
                    "site_name": "example.com",
                }
            ],
        )
        monkeypatch.setattr(
            browse_service,
            "_search_video_rows",
            lambda query, *, limit, page_token: (
                [
                    {
                        "type": "videos",
                        "provider_video_id": "yt-1",
                        "title": "Agent Systems",
                        "description": "Video summary",
                        "watch_url": "https://www.youtube.com/watch?v=yt-1",
                        "channel_title": "Nexus",
                        "published_at": "2026-04-18T00:00:00Z",
                        "thumbnail_url": "https://img.youtube.com/vi/yt-1/hqdefault.jpg",
                    }
                ],
                "video-page-2",
            ),
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            lambda db, query, limit: [
                PodcastDiscoveryOut(
                    podcast_id=None,
                    provider_podcast_id=provider_podcast_id,
                    title="AI Systems Weekly",
                    author="Ada",
                    feed_url="https://example.com/ai.xml",
                    website_url="https://example.com/ai",
                    image_url="https://example.com/ai.png",
                    description="Systems podcast",
                )
            ],
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "get_podcast_index_client",
            lambda: _FakePodcastClient(
                {
                    provider_podcast_id: [
                        {
                            "provider_episode_id": "ep-1",
                            "title": "Episode one",
                            "audio_url": "https://cdn.example.com/ep-1.mp3",
                            "published_at": "2026-04-18T00:00:00Z",
                            "duration_seconds": 1800,
                        }
                    ]
                }
            ),
        )

        response = auth_client.get("/browse?q=agents&limit=2", headers=auth_headers(user_id))

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["query"] == "agents"
        assert set(data["sections"]) == {"documents", "videos", "podcasts", "podcast_episodes"}
        assert (
            data["sections"]["documents"]["results"][0]["url"] == "https://example.com/agents.pdf"
        )
        assert (
            data["sections"]["videos"]["results"][0]["watch_url"]
            == "https://www.youtube.com/watch?v=yt-1"
        )
        assert data["sections"]["videos"]["page"]["has_more"] is True
        assert data["sections"]["videos"]["page"]["next_cursor"] is not None
        assert data["sections"]["podcasts"]["results"][0]["title"] == "AI Systems Weekly"
        assert data["sections"]["podcast_episodes"]["results"][0]["title"] == "Episode one"

    def test_browse_initial_search_queries_all_providers_once(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_podcast_id = f"browse-{uuid4()}"
        calls: list[tuple[str, object]] = []

        def fake_documents(query, *, limit, page_index):
            calls.append(("documents", (query, limit, page_index)))
            return []

        def fake_videos(query, *, limit, page_token):
            calls.append(("videos", (query, limit, page_token)))
            return [], None

        def fake_discover_podcasts(db, query, limit):
            calls.append(("podcasts", (query, limit)))
            return [
                PodcastDiscoveryOut(
                    podcast_id=None,
                    provider_podcast_id=provider_podcast_id,
                    title="AI Systems Weekly",
                    author="Ada",
                    feed_url="https://example.com/ai.xml",
                    website_url="https://example.com/ai",
                    image_url="https://example.com/ai.png",
                    description="Systems podcast",
                )
            ]

        monkeypatch.setattr(browse_service, "_search_document_rows", fake_documents)
        monkeypatch.setattr(browse_service, "_search_video_rows", fake_videos)
        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            fake_discover_podcasts,
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "get_podcast_index_client",
            lambda: _FakePodcastClient({provider_podcast_id: []}),
        )

        response = auth_client.get("/browse?q=systems&limit=3", headers=auth_headers(user_id))

        assert response.status_code == 200, response.text
        assert len(calls) == 3
        assert ("documents", ("systems", 3, 0)) in calls
        assert ("videos", ("systems", 3, None)) in calls
        assert ("podcasts", ("systems", 10)) in calls

    def test_browse_page_type_paginates_only_requested_section(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        document_calls: list[tuple[str, int, int]] = []

        def fake_documents(query, *, limit, page_index):
            document_calls.append((query, limit, page_index))
            if page_index == 0:
                return [
                    {
                        "type": "documents",
                        "title": "First PDF",
                        "description": "First doc",
                        "url": "https://example.com/first.pdf",
                        "document_kind": "pdf",
                        "site_name": "example.com",
                    },
                    {
                        "type": "documents",
                        "title": "Second PDF",
                        "description": "Second doc",
                        "url": "https://example.com/second.pdf",
                        "document_kind": "pdf",
                        "site_name": "example.com",
                    },
                ]
            return [
                {
                    "type": "documents",
                    "title": "Third PDF",
                    "description": "Third doc",
                    "url": "https://example.com/third.pdf",
                    "document_kind": "pdf",
                    "site_name": "example.com",
                }
            ]

        monkeypatch.setattr(browse_service, "_search_document_rows", fake_documents)
        video_calls: list[tuple[str, int, str | None]] = []
        podcast_calls: list[tuple[str, int]] = []

        def fake_videos(query, *, limit, page_token):
            video_calls.append((query, limit, page_token))
            return [], None

        def fake_discover_podcasts(db, query, limit):
            podcast_calls.append((query, limit))
            return []

        monkeypatch.setattr(browse_service, "_search_video_rows", fake_videos)
        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            fake_discover_podcasts,
        )

        first_response = auth_client.get("/browse?q=docs&limit=2", headers=auth_headers(user_id))
        first_cursor = first_response.json()["data"]["sections"]["documents"]["page"]["next_cursor"]

        page_response = auth_client.get(
            f"/browse?q=docs&limit=2&page_type=documents&cursor={first_cursor}",
            headers=auth_headers(user_id),
        )

        assert page_response.status_code == 200, page_response.text
        data = page_response.json()["data"]
        assert set(data["sections"]) == {"documents"}
        assert data["sections"]["documents"]["results"][0]["title"] == "Third PDF"
        assert document_calls == [("docs", 2, 0), ("docs", 2, 1)]
        assert video_calls == [("docs", 2, None)]
        assert podcast_calls == [("docs", 10)]

    def test_browse_initial_search_includes_provider_backed_video_and_document_results(
        self, auth_client, monkeypatch
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        monkeypatch.setattr(
            browse_service,
            "_search_document_rows",
            lambda query, *, limit, page_index: [
                {
                    "type": "documents",
                    "title": "Protocol EPUB",
                    "description": "EPUB guide",
                    "url": "https://example.com/protocol.epub",
                    "document_kind": "epub",
                    "site_name": "example.com",
                }
            ],
        )
        monkeypatch.setattr(
            browse_service,
            "_search_video_rows",
            lambda query, *, limit, page_token: (
                [
                    {
                        "type": "videos",
                        "provider_video_id": "yt-99",
                        "title": "Protocol Video",
                        "description": "Video guide",
                        "watch_url": "https://www.youtube.com/watch?v=yt-99",
                        "channel_title": "Nexus",
                        "published_at": None,
                        "thumbnail_url": None,
                    }
                ],
                None,
            ),
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            lambda db, query, limit: [],
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "get_podcast_index_client",
            lambda: _FakePodcastClient({}),
        )

        response = auth_client.get("/browse?q=protocol&limit=2", headers=auth_headers(user_id))

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["sections"]["documents"]["results"] == [
            {
                "type": "documents",
                "title": "Protocol EPUB",
                "description": "EPUB guide",
                "url": "https://example.com/protocol.epub",
                "document_kind": "epub",
                "site_name": "example.com",
            }
        ]
        assert data["sections"]["videos"]["results"] == [
            {
                "type": "videos",
                "provider_video_id": "yt-99",
                "title": "Protocol Video",
                "description": "Video guide",
                "watch_url": "https://www.youtube.com/watch?v=yt-99",
                "channel_title": "Nexus",
                "published_at": None,
                "thumbnail_url": None,
            }
        ]
