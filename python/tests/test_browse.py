"""Integration tests for browse acquisition routes."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.schemas.podcast import PodcastDiscoveryOut
from nexus.services import browse as browse_service
from tests.factories import create_searchable_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id):
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200


def _insert_gutenberg_catalog_row(
    direct_db: DirectSessionManager,
    *,
    ebook_id: int,
    title: str,
    authors: str = "Doe, Jane",
    subjects: str = "Fiction",
    bookshelves: str = "Classics",
    download_count: int = 42,
) -> None:
    direct_db.register_cleanup("project_gutenberg_catalog", "ebook_id", ebook_id)
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO project_gutenberg_catalog (
                    ebook_id,
                    title,
                    authors,
                    subjects,
                    bookshelves,
                    download_count,
                    raw_metadata,
                    synced_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :ebook_id,
                    :title,
                    :authors,
                    :subjects,
                    :bookshelves,
                    :download_count,
                    '{}'::jsonb,
                    now(),
                    now(),
                    now()
                )
                """
            ),
            {
                "ebook_id": ebook_id,
                "title": title,
                "authors": authors,
                "subjects": subjects,
                "bookshelves": bookshelves,
                "download_count": download_count,
            },
        )
        session.commit()


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
            "_search_nexus_document_rows",
            lambda db, viewer_id, query, *, limit, offset: [
                {
                    "type": "documents",
                    "title": "Imported Agents Guide",
                    "description": "Already in Nexus.",
                    "url": "https://nexus.example.com/agents.pdf",
                    "document_kind": "pdf",
                    "site_name": "nexus.example.com",
                    "source_label": "Nexus",
                    "source_type": "nexus",
                    "media_id": "media-1",
                }
            ],
        )
        monkeypatch.setattr(
            browse_service,
            "_search_project_gutenberg_rows",
            lambda db, query, *, limit, offset: [
                {
                    "type": "documents",
                    "title": "Pride and Prejudice",
                    "description": "Austen, Jane",
                    "url": "https://www.gutenberg.org/ebooks/1342.epub.noimages",
                    "document_kind": "epub",
                    "site_name": "gutenberg.org",
                    "source_label": "Project Gutenberg",
                    "source_type": "project_gutenberg",
                    "media_id": None,
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
        assert data["sections"]["documents"]["results"] == [
            {
                "type": "documents",
                "title": "Imported Agents Guide",
                "description": "Already in Nexus.",
                "url": "https://nexus.example.com/agents.pdf",
                "document_kind": "pdf",
                "site_name": "nexus.example.com",
                "source_label": "Nexus",
                "source_type": "nexus",
                "media_id": "media-1",
            },
            {
                "type": "documents",
                "title": "Pride and Prejudice",
                "description": "Austen, Jane",
                "url": "https://www.gutenberg.org/ebooks/1342.epub.noimages",
                "document_kind": "epub",
                "site_name": "gutenberg.org",
                "source_label": "Project Gutenberg",
                "source_type": "project_gutenberg",
                "media_id": None,
            },
        ]
        assert (
            data["sections"]["videos"]["results"][0]["watch_url"]
            == "https://www.youtube.com/watch?v=yt-1"
        )
        assert data["sections"]["podcasts"]["results"][0]["title"] == "AI Systems Weekly"
        assert data["sections"]["podcast_episodes"]["results"][0]["title"] == "Episode one"

    def test_browse_initial_search_queries_all_providers_once(self, auth_client, monkeypatch):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        provider_podcast_id = f"browse-{uuid4()}"
        calls: list[tuple[str, object]] = []

        def fake_nexus_documents(db, viewer_id, query, *, limit, offset):
            calls.append(("nexus_documents", (viewer_id, query, limit, offset)))
            return []

        def fake_gutenberg_documents(db, query, *, limit, offset):
            calls.append(("gutenberg_documents", (query, limit, offset)))
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

        monkeypatch.setattr(browse_service, "_search_nexus_document_rows", fake_nexus_documents)
        monkeypatch.setattr(
            browse_service,
            "_search_project_gutenberg_rows",
            fake_gutenberg_documents,
        )
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
        assert ("nexus_documents", (user_id, "systems", 4, 0)) in calls
        assert ("gutenberg_documents", ("systems", 4, 0)) in calls
        assert ("videos", ("systems", 3, None)) in calls
        assert ("podcasts", ("systems", 10)) in calls

    def test_browse_page_type_paginates_only_requested_section_and_transitions_sources(
        self, auth_client, monkeypatch
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        nexus_calls: list[tuple[str, UUID, int, int]] = []
        gutenberg_calls: list[tuple[str, int, int]] = []
        video_calls: list[tuple[str, int, str | None]] = []
        podcast_calls: list[tuple[str, int]] = []

        def fake_nexus_documents(db, viewer_id, query, *, limit, offset):
            nexus_calls.append((query, viewer_id, limit, offset))
            if offset == 0:
                return [
                    {
                        "type": "documents",
                        "title": "Nexus Handbook",
                        "description": "Visible workspace document.",
                        "url": "https://nexus.example.com/handbook",
                        "document_kind": "web_article",
                        "site_name": "nexus.example.com",
                        "source_label": "Nexus",
                        "source_type": "nexus",
                        "media_id": "media-nexus",
                    }
                ]
            return []

        def fake_gutenberg_documents(db, query, *, limit, offset):
            gutenberg_calls.append((query, limit, offset))
            rows = [
                {
                    "type": "documents",
                    "title": "Gutenberg One",
                    "description": "Author One",
                    "url": "https://www.gutenberg.org/ebooks/1.epub.noimages",
                    "document_kind": "epub",
                    "site_name": "gutenberg.org",
                    "source_label": "Project Gutenberg",
                    "source_type": "project_gutenberg",
                    "media_id": None,
                },
                {
                    "type": "documents",
                    "title": "Gutenberg Two",
                    "description": "Author Two",
                    "url": "https://www.gutenberg.org/ebooks/2.epub.noimages",
                    "document_kind": "epub",
                    "site_name": "gutenberg.org",
                    "source_label": "Project Gutenberg",
                    "source_type": "project_gutenberg",
                    "media_id": None,
                },
                {
                    "type": "documents",
                    "title": "Gutenberg Three",
                    "description": "Author Three",
                    "url": "https://www.gutenberg.org/ebooks/3.epub.noimages",
                    "document_kind": "epub",
                    "site_name": "gutenberg.org",
                    "source_label": "Project Gutenberg",
                    "source_type": "project_gutenberg",
                    "media_id": None,
                },
            ]
            return rows[offset : offset + limit]

        def fake_videos(query, *, limit, page_token):
            video_calls.append((query, limit, page_token))
            return [], None

        def fake_discover_podcasts(db, query, limit):
            podcast_calls.append((query, limit))
            return []

        monkeypatch.setattr(browse_service, "_search_nexus_document_rows", fake_nexus_documents)
        monkeypatch.setattr(
            browse_service,
            "_search_project_gutenberg_rows",
            fake_gutenberg_documents,
        )
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
        assert [row["title"] for row in data["sections"]["documents"]["results"]] == [
            "Gutenberg Two",
            "Gutenberg Three",
        ]
        assert nexus_calls == [("docs", user_id, 3, 0)]
        assert gutenberg_calls == [("docs", 2, 0), ("docs", 3, 1)]
        assert video_calls == [("docs", 2, None)]
        assert podcast_calls == [("docs", 10)]

    def test_browse_documents_include_visible_nexus_docs_and_gutenberg_rows_only(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        other_user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _bootstrap_user(auth_client, other_user_id)

        with direct_db.session() as session:
            visible_media_id = create_searchable_media(
                session,
                user_id,
                title="Agents Handbook Visible",
            )
            hidden_media_id = create_searchable_media(
                session,
                other_user_id,
                title="Agents Handbook Hidden",
            )

        direct_db.register_cleanup("fragments", "media_id", visible_media_id)
        direct_db.register_cleanup("library_entries", "media_id", visible_media_id)
        direct_db.register_cleanup("media", "id", visible_media_id)
        direct_db.register_cleanup("fragments", "media_id", hidden_media_id)
        direct_db.register_cleanup("library_entries", "media_id", hidden_media_id)
        direct_db.register_cleanup("media", "id", hidden_media_id)
        _insert_gutenberg_catalog_row(
            direct_db,
            ebook_id=1342,
            title="Agents in Literature",
            authors="Austen, Jane",
        )

        monkeypatch.setattr(
            browse_service,
            "_search_video_rows",
            lambda query, *, limit, page_token: ([], None),
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

        response = auth_client.get("/browse?q=agents", headers=auth_headers(user_id))

        assert response.status_code == 200, response.text
        document_rows = response.json()["data"]["sections"]["documents"]["results"]
        titles = [row["title"] for row in document_rows]
        assert "Agents Handbook Visible" in titles
        assert "Agents Handbook Hidden" not in titles
        assert "Agents in Literature" in titles

        visible_row = next(
            row for row in document_rows if row["title"] == "Agents Handbook Visible"
        )
        gutenberg_row = next(row for row in document_rows if row["title"] == "Agents in Literature")

        assert visible_row["document_kind"] == "web_article"
        assert visible_row["source_type"] == "nexus"
        assert visible_row["media_id"] == str(visible_media_id)
        assert gutenberg_row["source_type"] == "project_gutenberg"
        assert gutenberg_row["url"] == "https://www.gutenberg.org/ebooks/1342.epub.noimages"
