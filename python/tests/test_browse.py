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
    def test_browse_returns_podcasts_and_episode_rows(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        first_provider_id = f"browse-{uuid4()}"
        second_provider_id = f"browse-{uuid4()}"

        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            lambda db, query, limit: [
                PodcastDiscoveryOut(
                    podcast_id=None,
                    provider_podcast_id=first_provider_id,
                    title="AI Systems Weekly",
                    author="Ada",
                    feed_url="https://example.com/ai.xml",
                    website_url="https://example.com/ai",
                    image_url="https://example.com/ai.png",
                    description="Systems podcast",
                ),
                PodcastDiscoveryOut(
                    podcast_id=None,
                    provider_podcast_id=second_provider_id,
                    title="Reasoning Radio",
                    author="Turing",
                    feed_url="https://example.com/reasoning.xml",
                    website_url="https://example.com/reasoning",
                    image_url="https://example.com/reasoning.png",
                    description="Reasoning podcast",
                ),
            ],
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "get_podcast_index_client",
            lambda: _FakePodcastClient(
                {
                    first_provider_id: [
                        {
                            "provider_episode_id": "ep-1",
                            "title": "Episode one",
                            "audio_url": "https://cdn.example.com/ep-1.mp3",
                            "published_at": "2026-04-18T00:00:00Z",
                            "duration_seconds": 1800,
                        }
                    ],
                    second_provider_id: [
                        {
                            "provider_episode_id": "ep-2",
                            "title": "Episode two",
                            "audio_url": "https://cdn.example.com/ep-2.mp3",
                            "published_at": "2026-04-17T00:00:00Z",
                            "duration_seconds": 2400,
                        }
                    ],
                }
            ),
        )

        response = auth_client.get("/browse?q=ai&type=all&limit=4", headers=auth_headers(user_id))

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["page"]["has_more"] is False
        assert data["page"]["next_cursor"] is None
        assert [row["type"] for row in data["results"]] == [
            "podcasts",
            "podcasts",
            "podcast_episodes",
            "podcast_episodes",
        ]
        assert data["results"][0]["title"] == "AI Systems Weekly"
        assert data["results"][2]["title"] == "Episode one"

    def test_browse_honors_episode_filter(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_id = f"browse-{uuid4()}"
        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            lambda db, query, limit: [
                PodcastDiscoveryOut(
                    podcast_id=None,
                    provider_podcast_id=provider_id,
                    title="Episode Browse Show",
                    author="Host",
                    feed_url="https://example.com/feed.xml",
                    website_url=None,
                    image_url=None,
                    description=None,
                )
            ],
        )
        monkeypatch.setattr(
            browse_service.podcast_service,
            "get_podcast_index_client",
            lambda: _FakePodcastClient(
                {
                    provider_id: [
                        {
                            "provider_episode_id": "ep-episode-only",
                            "title": "Episode Only",
                            "audio_url": "https://cdn.example.com/episode-only.mp3",
                            "published_at": "2026-04-16T00:00:00Z",
                            "duration_seconds": 1200,
                        }
                    ]
                }
            ),
        )

        response = auth_client.get(
            "/browse?q=episode&type=podcast_episodes&limit=5",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert len(data["results"]) == 1
        assert data["results"][0]["type"] == "podcast_episodes"
        assert data["results"][0]["title"] == "Episode Only"

    def test_browse_returns_empty_for_video_and_document_filters_without_provider_support(
        self, auth_client, monkeypatch
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        monkeypatch.setattr(
            browse_service.podcast_service,
            "discover_podcasts",
            lambda db, query, limit: [],
        )

        video_response = auth_client.get(
            "/browse?q=video&type=videos&limit=5",
            headers=auth_headers(user_id),
        )
        document_response = auth_client.get(
            "/browse?q=document&type=documents&limit=5",
            headers=auth_headers(user_id),
        )

        assert video_response.status_code == 200, video_response.text
        assert video_response.json()["data"]["results"] == []
        assert document_response.status_code == 200, document_response.text
        assert document_response.json()["data"]["results"] == []
