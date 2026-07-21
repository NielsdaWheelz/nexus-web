"""Integration tests for keyword search service and routes.

Tests cover:
- Basic search functionality across all types
- Visibility enforcement (canonical media provenance, note ownership,
  canonical conversation visibility for messages)
- Scope filtering (all, media, library, conversation)
- Type filtering
- Pagination
- Short/empty query handling
- Pending messages never searchable
- Invalid cursor handling
- No visibility leakage
- Note-block ownership and library revocation behavior
- Library-scope message search
- Conversation scope with shared-read visibility
- Canonical media provenance (stale default-library rows)
- Response shape preservation
"""

import base64
import json
from datetime import date
from uuid import UUID, uuid4

import pytest
import respx
from fastapi.testclient import TestClient
from provider_runtime import RuntimeDefect
from pydantic import ValidationError
from sqlalchemy import text

from nexus.config import clear_settings_cache
from nexus.db.models import Fragment
from nexus.errors import InvalidRequestError, NotFoundError
from nexus.services import contributors
from nexus.services.content_indexing import (
    IndexOwner,
    mark_content_index_failed,
    rebuild_fragment_content_index,
    rebuild_transcript_content_index,
)
from nexus.services.contributor_taxonomy import ContributorObservation, ObservedRoleSlices
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.notes import get_daily_note
from nexus.services.search import get_search_result
from nexus.services.search.projection import _snippet_around_query, _truncate_snippet
from nexus.services.semantic_chunks import build_text_embedding, to_pgvector_literal
from nexus.services.transcript_segments import TranscriptSegmentInput
from tests.factories import (
    add_context_edge,
    add_library_member,
    add_media_to_library,
    create_normalized_fragment_highlight,
    create_searchable_media,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight_note,
    create_test_library,
    create_test_media,
    create_test_message,
    get_user_default_library,
    share_conversation_to_library,
)
from tests.factories import (
    add_media_to_library as seed_media_in_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"


# =============================================================================
# Basic Search Tests
# =============================================================================


class TestBasicSearch:
    """Tests for basic search functionality."""

    def test_search_returns_empty_for_short_query(self, auth_client):
        """Search with < 2 chars returns empty results."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search?q=a", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []
        assert data["page"]["has_more"] is False

    def test_search_requires_query(self, auth_client):
        """Search without q param returns an empty result set."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []
        assert data["page"]["has_more"] is False

    def test_epub_fragment_and_note_block_results_include_section_id(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """EPUB search hits expose canonical section ids for reader deep links."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        fragment_id = uuid4()

        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', :title, 'ready_for_reading', :user_id)
                """),
                {
                    "id": media_id,
                    "title": "EPUB Search Contract",
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, :canonical_text, :html_sanitized)
                """),
                {
                    "id": fragment_id,
                    "media_id": media_id,
                    "canonical_text": "Unique EPUB fragment needle for section deep link coverage.",
                    "html_sanitized": "<h1>Chapter 1</h1><p>Unique EPUB fragment needle.</p>",
                },
            )
            session.execute(
                text("""
                    INSERT INTO epub_nav_locations (
                        media_id, location_id, ordinal, source_node_id, label,
                        fragment_idx, href_path, href_fragment, source
                    )
                    VALUES (
                        :media_id, :location_id, 0, NULL, :label,
                        0, :href_path, NULL, 'spine'
                    )
                """),
                {
                    "media_id": media_id,
                    "location_id": "text/chapter1.xhtml",
                    "label": "Chapter 1",
                    "href_path": "text/chapter1.xhtml",
                },
            )
            fragment = session.get(Fragment, fragment_id)
            assert fragment is not None
            insert_fragment_blocks(
                session, fragment.id, parse_fragment_blocks(fragment.canonical_text)
            )
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="epub",
                fragments=[fragment],
                reason="test",
            )
            # The generic filing endpoint below only re-files media already
            # reachable through a membership (readable-or-restorable, spec
            # S4.3 rule 1) — establish the direct entry first.
            seed_media_in_library(session, default_library_id, media_id)
            session.commit()

        auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        with direct_db.session() as session:
            highlight_id, note_block_id = create_test_highlight_note(
                session,
                user_id,
                media_id,
                body="Unique EPUB note needle for section deep link coverage.",
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)

        fragment_response = auth_client.get(
            "/search?q=unique+epub+fragment+needle&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert fragment_response.status_code == 200, (
            f"Expected fragment search to succeed, got {fragment_response.status_code}: "
            f"{fragment_response.text}"
        )
        fragment_rows = fragment_response.json()["results"]
        epub_fragment_row = next(
            row
            for row in fragment_rows
            if row["type"] == "content_chunk" and row["source"]["media_id"] == str(media_id)
        )
        assert epub_fragment_row["source"]["media_id"] == str(media_id)
        assert epub_fragment_row["activation"]["href"].startswith(f"/media/{media_id}")
        assert "deep_link" not in epub_fragment_row

        note_block_response = auth_client.get(
            "/search?q=unique+epub+note+needle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert note_block_response.status_code == 200, (
            f"Expected note search to succeed, got {note_block_response.status_code}: "
            f"{note_block_response.text}"
        )
        note_block_rows = note_block_response.json()["results"]
        epub_note_block_row = next(
            row
            for row in note_block_rows
            if row["type"] == "note_block" and row["id"] == str(note_block_id)
        )
        assert (
            epub_note_block_row["body_text"]
            == "Unique EPUB note needle for section deep link coverage."
        )
        assert epub_note_block_row["activation"]["href"] == f"/notes/{note_block_id}"
        assert "deep_link" not in epub_note_block_row

    def test_search_finds_media_by_title(self, auth_client, direct_db: DirectSessionManager):
        """Search finds media by matching title."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Python Programming Guide")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=python+programming", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        # Should find the media
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert len(media_results) >= 1
        assert any(r["id"] == str(media_id) for r in media_results)

    def test_search_includes_transcript_unavailable_video_and_podcast_media_in_metadata_results(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Metadata search includes transcript-unavailable transcript media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        unavailable_video_id = uuid4()
        unavailable_podcast_id = uuid4()
        ready_video_id = uuid4()

        direct_db.register_cleanup("library_entries", "media_id", unavailable_video_id)
        direct_db.register_cleanup("library_entries", "media_id", unavailable_podcast_id)
        direct_db.register_cleanup("library_entries", "media_id", ready_video_id)
        direct_db.register_cleanup("media", "id", unavailable_video_id)
        direct_db.register_cleanup("media", "id", unavailable_podcast_id)
        direct_db.register_cleanup("media", "id", ready_video_id)

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status, failure_stage,
                        last_error_code, external_playback_url, provider, provider_id, created_by_user_id
                    )
                    VALUES (
                        :id, 'video', :title, :source_url, 'failed', 'transcribe',
                        'E_TRANSCRIPT_UNAVAILABLE', :playback_url, 'youtube', :provider_id, :user_id
                    )
                """),
                {
                    "id": unavailable_video_id,
                    "title": "needle transcript unavailable video",
                    "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "playback_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "provider_id": "dQw4w9WgXcQ",
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status, failure_stage,
                        last_error_code, external_playback_url, provider, provider_id, created_by_user_id
                    )
                    VALUES (
                        :id, 'podcast_episode', :title, :source_url, 'failed', 'transcribe',
                        'E_TRANSCRIPT_UNAVAILABLE', :playback_url, 'podcast_index', :provider_id, :user_id
                    )
                """),
                {
                    "id": unavailable_podcast_id,
                    "title": "needle transcript unavailable podcast",
                    "source_url": "https://podcasts.example.com/feed.xml",
                    "playback_url": "https://cdn.example.com/episode.mp3",
                    "provider_id": "episode-needle",
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        external_playback_url, provider, provider_id, created_by_user_id
                    )
                    VALUES (
                        :id, 'video', :title, :source_url, 'ready_for_reading',
                        :playback_url, 'youtube', :provider_id, :user_id
                    )
                """),
                {
                    "id": ready_video_id,
                    "title": "needle transcript ready video",
                    "source_url": "https://www.youtube.com/watch?v=oHg5SJYRHA0",
                    "playback_url": "https://www.youtube.com/watch?v=oHg5SJYRHA0",
                    "provider_id": "oHg5SJYRHA0",
                    "user_id": user_id,
                },
            )

            for media_id in (unavailable_video_id, unavailable_podcast_id, ready_video_id):
                seed_media_in_library(session, default_library_id, media_id)

            session.commit()

        response = auth_client.get(
            "/search?q=needle+transcript&kinds=documents", headers=auth_headers(user_id)
        )
        assert response.status_code == 200, (
            f"expected media search to succeed, got {response.status_code}: {response.text}"
        )
        result_ids = {
            row["id"] for row in response.json()["results"] if row["type"] in {"episode", "video"}
        }

        assert str(ready_video_id) in result_ids
        assert str(unavailable_video_id) in result_ids
        assert str(unavailable_podcast_id) in result_ids

        episode_row = next(row for row in response.json()["results"] if row["type"] == "episode")
        with direct_db.session() as session:
            resolved_episode = get_search_result(
                db=session,
                viewer_id=user_id,
                result_type="episode",
                result_id=episode_row["id"],
            )
        assert resolved_episode.type == "episode"
        assert str(resolved_episode.id) == episode_row["id"]

    def test_fragment_search_excludes_transcript_media_marked_unavailable(
        self, auth_client, direct_db
    ):
        """Transcript fragment search respects canonical transcript state, not media failure residue."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        fragment_id = uuid4()

        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        last_error_code, external_playback_url, provider, provider_id, created_by_user_id
                    )
                    VALUES (
                        :id, 'podcast_episode', :title, :source_url, 'failed',
                        'E_TRANSCRIPT_UNAVAILABLE', :playback_url, 'podcast_index', :provider_id, :user_id
                    )
                """),
                {
                    "id": media_id,
                    "title": "Unavailable transcript fragment search contract",
                    "source_url": "https://podcasts.example.com/feed.xml",
                    "playback_url": "https://cdn.example.com/unavailable.mp3",
                    "provider_id": "unavailable-fragment-contract",
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, :canonical_text, :html_sanitized)
                """),
                {
                    "id": fragment_id,
                    "media_id": media_id,
                    "canonical_text": "Needle transcript fragment should stay out of search results.",
                    "html_sanitized": "<p>Needle transcript fragment should stay out of search results.</p>",
                },
            )
            session.execute(
                text("""
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status,
                        last_request_reason
                    )
                    VALUES (
                        :media_id,
                        'unavailable',
                        'none',
                        'none',
                        'search'
                    )
                """),
                {"media_id": media_id},
            )
            seed_media_in_library(session, default_library_id, media_id)
            session.commit()

        response = auth_client.get(
            "/search?q=needle+transcript+fragment&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"expected fragment search to succeed, got {response.status_code}: {response.text}"
        )
        result_ids = {
            row["id"] for row in response.json()["results"] if row["type"] == "content_chunk"
        }
        assert str(fragment_id) not in result_ids

    def test_search_finds_fragments(self, auth_client, direct_db: DirectSessionManager):
        """Search finds fragments by canonical_text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Search for content in fragment's canonical_text
        response = auth_client.get("/search?q=searchable+content", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        fragment_results = [r for r in data["results"] if r["type"] == "content_chunk"]
        assert len(fragment_results) >= 1

        direct_response = auth_client.get(
            "/search?q=searchable+content&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert direct_response.status_code == 200
        direct_results = [r for r in direct_response.json()["results"] if r["type"] == "fragment"]
        assert len(direct_results) >= 1
        direct_row = direct_results[0]
        assert "source_version" not in direct_row
        assert direct_row["citation_label"]
        assert direct_row["locator"]["type"] == "web_text_offsets"
        assert direct_row["locator"]["media_id"] == str(media_id)

    def test_search_finds_note_blocks(self, auth_client, direct_db: DirectSessionManager):
        """Search finds note blocks by body text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")
            highlight_id, note_block_id = create_test_highlight_note(
                session, user_id, media_id, body="My unique note about databases"
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=note+databases", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        note_block_results = [r for r in data["results"] if r["type"] == "note_block"]
        assert len(note_block_results) >= 1
        note_row = next(r for r in note_block_results if r["id"] == str(note_block_id))
        assert "source_version" not in note_row
        assert note_row["locator"] == {
            "type": "note_block_offsets",
            "block_id": str(note_block_id),
            "start_offset": 0,
            "end_offset": len("My unique note about databases"),
        }

        # D5/AC-10: pages match on title/daily-date, not block body, so a
        # body-only query returns the matching note_block (above) but no page result.
        notes_response = auth_client.get(
            "/search?q=note+databases&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert notes_response.status_code == 200
        notes_rows = notes_response.json()["results"]
        assert any(r["type"] == "note_block" and r["id"] == str(note_block_id) for r in notes_rows)
        assert all(r["type"] != "page" for r in notes_rows)
        assert "source_version" not in next(r for r in notes_rows if r["type"] == "note_block")

        highlight_response = auth_client.get(
            "/search?q=test+exact&kinds=highlights",
            headers=auth_headers(user_id),
        )
        assert highlight_response.status_code == 200
        highlight_row = next(
            r for r in highlight_response.json()["results"] if r["id"] == str(highlight_id)
        )
        assert "source_version" not in highlight_row
        assert highlight_row["citation_label"]
        assert highlight_row["locator"]["type"] == "web_text_offsets"
        assert highlight_row["locator"]["media_id"] == str(media_id)

    def test_highlight_search_requires_active_index_run(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Highlight search omits citable results without an active current index run."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Unindexed Highlight Article")
            fragment_id = create_test_fragment(
                session,
                media_id,
                "unindexed highlight quote around context",
            )
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None
            add_media_to_library(session, library_id, media_id)
            highlight_id = create_normalized_fragment_highlight(
                session,
                user_id,
                fragment_id,
                media_id,
                start_offset=0,
                end_offset=len("unindexed"),
                exact="unindexed",
            )

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)

        response = auth_client.get(
            "/search?q=unindexed&kinds=highlights",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200
        result_ids = {row["id"] for row in response.json()["results"]}
        assert str(highlight_id) not in result_ids

        with direct_db.session() as session:
            with pytest.raises(NotFoundError):
                get_search_result(
                    db=session,
                    viewer_id=user_id,
                    result_type="highlight",
                    result_id=str(highlight_id),
                )

    def test_search_finds_messages(self, auth_client, direct_db: DirectSessionManager):
        """Search finds messages in conversations."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_id, content="Important discussion about machine learning"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get("/search?q=machine+learning", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert len(message_results) >= 1
        message_row = next(r for r in message_results if r["id"] == str(message_id))
        assert "source_version" not in message_row
        assert message_row["locator"] == {
            "type": "message_offsets",
            "conversation_id": str(conversation_id),
            "message_id": str(message_id),
            "start_offset": 0,
            "end_offset": len("Important discussion about machine learning"),
            "message_seq": 1,
        }


# =============================================================================
# Visibility Tests
# =============================================================================


class TestSearchVisibility:
    """Tests for search visibility enforcement."""

    def test_search_does_not_leak_other_users_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's media via search."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates media
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_b, title="Secret Private Document")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A searches for it
        response = auth_client.get(
            "/search?q=secret+private+document", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's media
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert not any(r["id"] == str(media_id) for r in media_results)

    def test_search_does_not_leak_other_users_note_blocks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's note blocks when they share no library."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates media and note block
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_b, title="Shared Article")
            highlight_id, note_block_id = create_test_highlight_note(
                session, user_b, media_id, body="User B private note text"
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A searches for it
        response = auth_client.get("/search?q=private+note+text", headers=auth_headers(user_a))

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's note block
        note_block_results = [r for r in data["results"] if r["type"] == "note_block"]
        assert not any(r["id"] == str(note_block_id) for r in note_block_results)

    def test_search_does_not_leak_other_users_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's messages via search."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates conversation with message
        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_b, content="Secret conversation about project alpha"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # User A searches for it
        response = auth_client.get("/search?q=secret+project+alpha", headers=auth_headers(user_a))

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's message
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert not any(r["id"] == str(message_id) for r in message_results)

    def test_pending_messages_never_searchable(self, auth_client, direct_db: DirectSessionManager):
        """Pending messages are never returned in search results."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create conversation with pending message (only assistant messages can be pending)
        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session,
                user_id,
                content="Pending message about quantum computing",
                status="pending",
                role="assistant",
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Search for it
        response = auth_client.get("/search?q=quantum+computing", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        # Should not find pending message
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert not any(r["id"] == str(message_id) for r in message_results)


# =============================================================================
# Scope Tests
# =============================================================================


class TestSearchScopes:
    """Tests for search scope filtering."""

    def test_scope_media_filters_results(self, auth_client, direct_db: DirectSessionManager):
        """Media scope only returns content from that media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media1 = create_searchable_media(session, user_id, title="Programming Python Basics")
            media2 = create_searchable_media(session, user_id, title="Advanced Python Topics")

        direct_db.register_cleanup("fragments", "media_id", media1)
        direct_db.register_cleanup("fragments", "media_id", media2)
        direct_db.register_cleanup("library_entries", "media_id", media1)
        direct_db.register_cleanup("library_entries", "media_id", media2)
        direct_db.register_cleanup("media", "id", media1)
        direct_db.register_cleanup("media", "id", media2)

        # Search with media scope
        response = auth_client.get(
            f"/search?q=python&scope=media:{media1}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Should only find content from media1
        for result in data["results"]:
            if result["type"] == "media":
                assert result["id"] == str(media1)
            elif result["type"] == "content_chunk":
                assert result["source"]["media_id"] == str(media1)

    def test_scope_media_not_found(self, auth_client):
        """Non-visible media scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=media:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_library_filters_results(self, auth_client, direct_db: DirectSessionManager):
        """Library scope only returns content from media in that library."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            # Create a non-default library
            library_id = create_test_library(session, user_id, "Research Library")

            # Create media and add to library
            media_id = create_searchable_media(session, user_id, title="Research Paper on AI")

            # Also add to the non-default library
            seed_media_in_library(session, library_id, media_id)
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # Search with library scope
        response = auth_client.get(
            f"/search?q=research&scope=library:{library_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200

    def test_scope_library_not_found(self, auth_client):
        """Non-member library scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=library:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_conversation_filters_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation scope only returns messages from that conversation."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv1, msg1 = create_test_conversation_with_message(
                session, user_id, content="Discussion about testing patterns"
            )
            conv2, msg2 = create_test_conversation_with_message(
                session, user_id, content="Different conversation about testing"
            )

        direct_db.register_cleanup("messages", "conversation_id", conv1)
        direct_db.register_cleanup("messages", "conversation_id", conv2)
        direct_db.register_cleanup("conversations", "id", conv1)
        direct_db.register_cleanup("conversations", "id", conv2)

        # Search with conversation scope
        response = auth_client.get(
            f"/search?q=testing&scope=conversation:{conv1}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Should only find messages from conv1
        for result in data["results"]:
            if result["type"] == "message":
                assert result["conversation_id"] == str(conv1)

    def test_scope_conversation_not_found(self, auth_client):
        """Non-visible conversation scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_scope_invalid_format(self, auth_client):
        """Invalid scope format returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/search?q=test&scope=invalid:scope", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    # ------------------------------------------------------------------
    # AC-6: note-scope behavioral parity (§4.6 note cells, not just SQL shape).
    # For each of media:/library:/conversation: we seed an IN-scope note and an
    # OUT-of-scope note (both indexed as note resources) and assert
    # the scoped &kinds=notes search returns only the in-scope note_block.
    # ------------------------------------------------------------------

    def _seed_scope_note_block(
        self,
        session,
        *,
        user_id: UUID,
        page_id: UUID,
        note_block_id: UUID,
        page_title: str,
        body_text: str,
    ) -> None:
        """Insert a page + single note_block and index the note body."""
        session.execute(
            text("INSERT INTO pages (id, user_id, title) VALUES (:page_id, :user_id, :title)"),
            {"page_id": page_id, "user_id": user_id, "title": page_title},
        )
        session.execute(
            text(
                """
                INSERT INTO note_blocks (
                    id, user_id, body_pm_json, body_text
                )
                VALUES (
                    :note_block_id, :user_id,
                    jsonb_build_object(
                        'type', 'paragraph',
                        'content', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                        )
                    ),
                    :body_text
                )
                """
            ),
            {
                "note_block_id": note_block_id,
                "user_id": user_id,
                "body_text": body_text,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id,
                    kind,
                    origin,
                    source_scheme,
                    source_id,
                    target_scheme,
                    target_id,
                    source_order_key
                )
                VALUES (
                    :user_id,
                    'context',
                    'user',
                    'page',
                    :page_id,
                    'note_block',
                    :note_block_id,
                    '0000000001'
                )
                """
            ),
            {
                "user_id": user_id,
                "page_id": page_id,
                "note_block_id": note_block_id,
            },
        )
        rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")

    def _link_note_block_to_media(
        self,
        session,
        *,
        user_id: UUID,
        note_block_id: UUID,
        media_id: UUID,
        origin: str = "user",
        kind: str = "context",
    ) -> None:
        """resource_edges note_block -> media (the §4.6 note `media:` scope cell)."""
        if origin == "synapse":
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, snapshot
                    )
                    VALUES (
                        :user_id, :kind, :origin, 'note_block', :note_block_id,
                        'media', :media_id, '{"excerpt":"test rationale"}'::jsonb
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "note_block_id": note_block_id,
                    "media_id": media_id,
                    "origin": origin,
                    "kind": kind,
                },
            )
            return
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :user_id, :kind, :origin, 'note_block', :note_block_id,
                    'media', :media_id
                )
                """
            ),
            {
                "user_id": user_id,
                "note_block_id": note_block_id,
                "media_id": media_id,
                "origin": origin,
                "kind": kind,
            },
        )

    def test_scope_media_filters_notes(self, auth_client, direct_db: DirectSessionManager):
        """media: scope returns only note_blocks with an edge to that media."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        in_page_id, in_block_id = uuid4(), uuid4()
        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Scoped Media Doc")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=in_page_id,
                note_block_id=in_block_id,
                page_title="In Scope Media Page",
                body_text="mediascopeprobe in-scope note content",
            )
            self._link_note_block_to_media(
                session, user_id=user_id, note_block_id=in_block_id, media_id=scoped_media
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="Out Of Scope Media Page",
                body_text="mediascopeprobe out-of-scope note content",
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", in_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_block_id)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=mediascopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(in_block_id) in ids, f"expected in-scope note; got {response.json()['results']}"
        assert str(out_block_id) not in ids

    def test_scope_media_filters_pages_via_context_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        in_page_id, in_block_id = uuid4(), uuid4()
        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Page Scope Media")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=in_page_id,
                note_block_id=in_block_id,
                page_title="pagemediascopeprobe in-scope page",
                body_text="plain in-scope body",
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'page', :page_id,
                        'media', :media_id
                    )
                    """
                ),
                {"user_id": user_id, "page_id": in_page_id, "media_id": scoped_media},
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="pagemediascopeprobe containment-only page",
                body_text="plain out-of-scope body",
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", in_page_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_page_id)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=pagemediascopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "page"}
        assert str(in_page_id) in ids, f"expected in-scope page; got {response.json()['results']}"
        assert str(out_page_id) not in ids

    def test_scope_media_ignores_note_body_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id, block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Citation Scope Media")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=block_id,
                page_title="Citation Edge Page",
                body_text="citationedgescopeprobe note content",
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id, target_scheme,
                        target_id
                    )
                    VALUES (
                        :user_id, 'context', 'note_body', 'note_block', :note_block_id,
                        'media', :media_id
                    )
                    """
                ),
                {"user_id": user_id, "note_block_id": block_id, "media_id": scoped_media},
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", block_id)
        direct_db.register_cleanup("resource_edges", "target_id", block_id)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=citationedgescopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(block_id) not in ids

    def test_scope_media_ignores_synapse_origin_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """media: scope admits via a user edge but never via a machine (synapse) guess."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        user_page_id, user_block_id = uuid4(), uuid4()
        synapse_page_id, synapse_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Origin Scope Doc")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=user_page_id,
                note_block_id=user_block_id,
                page_title="User Edge Page",
                body_text="originscopeprobe user-edge note content",
            )
            self._link_note_block_to_media(
                session, user_id=user_id, note_block_id=user_block_id, media_id=scoped_media
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=synapse_page_id,
                note_block_id=synapse_block_id,
                page_title="Synapse Edge Page",
                body_text="originscopeprobe synapse-edge note content",
            )
            self._link_note_block_to_media(
                session,
                user_id=user_id,
                note_block_id=synapse_block_id,
                media_id=scoped_media,
                origin="synapse",
            )
            session.commit()

        for block_id in (user_block_id, synapse_block_id):
            direct_db.register_cleanup("resource_edges", "source_id", block_id)
            direct_db.register_cleanup("resource_edges", "target_id", block_id)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=originscopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(user_block_id) in ids, (
            f"a user-origin edge must admit the note; got {response.json()['results']}"
        )
        assert str(synapse_block_id) not in ids, (
            "a synapse-origin edge must not admit the note into media scope"
        )

    def test_scope_media_ignores_non_context_note_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id, block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Kind Scope Media")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=block_id,
                page_title="Supports Edge Page",
                body_text="noncontextedgescopeprobe note content",
            )
            self._link_note_block_to_media(
                session,
                user_id=user_id,
                note_block_id=block_id,
                media_id=scoped_media,
                kind="supports",
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", block_id)
        direct_db.register_cleanup("resource_edges", "target_id", block_id)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=noncontextedgescopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(block_id) not in ids

    def test_scope_media_filters_notes_via_highlight_anchor(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """media: scope also honors an attached highlight whose anchor_media_id == scope."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            scoped_media = create_searchable_media(session, user_id, title="Highlight Anchor Media")
            # In-scope note: an attached highlight anchored to the scoped media.
            _highlight_id, in_block_id = create_test_highlight_note(
                session, user_id, scoped_media, body="anchorscopeprobe in-scope highlight note"
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="Out Of Scope Anchor Page",
                body_text="anchorscopeprobe out-of-scope note content",
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", in_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_block_id)
        direct_db.register_cleanup("highlights", "anchor_media_id", scoped_media)
        direct_db.register_cleanup("fragments", "media_id", scoped_media)
        direct_db.register_cleanup("library_entries", "media_id", scoped_media)
        direct_db.register_cleanup("media", "id", scoped_media)

        response = auth_client.get(
            f"/search?q=anchorscopeprobe&kinds=notes&scope=media:{scoped_media}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(in_block_id) in ids, f"expected anchored note; got {response.json()['results']}"
        assert str(out_block_id) not in ids

    def test_scope_library_filters_notes(self, auth_client, direct_db: DirectSessionManager):
        """library: scope returns notes whose linked media is an entry in that library."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        in_page_id, in_block_id = uuid4(), uuid4()
        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Note Scope Library")
            in_media = create_searchable_media(session, user_id, title="Library Scoped Media")
            out_media = create_searchable_media(session, user_id, title="Library Out Media")
            seed_media_in_library(session, library_id, in_media)
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=in_page_id,
                note_block_id=in_block_id,
                page_title="In Scope Library Page",
                body_text="libraryscopeprobe in-scope note content",
            )
            self._link_note_block_to_media(
                session, user_id=user_id, note_block_id=in_block_id, media_id=in_media
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="Out Of Scope Library Page",
                body_text="libraryscopeprobe out-of-scope note content",
            )
            # The out-of-scope note links to a media NOT in the scoped library.
            self._link_note_block_to_media(
                session, user_id=user_id, note_block_id=out_block_id, media_id=out_media
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", in_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", out_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", out_block_id)
        direct_db.register_cleanup("fragments", "media_id", in_media)
        direct_db.register_cleanup("fragments", "media_id", out_media)
        direct_db.register_cleanup("library_entries", "media_id", in_media)
        direct_db.register_cleanup("library_entries", "media_id", out_media)
        direct_db.register_cleanup("media", "id", in_media)
        direct_db.register_cleanup("media", "id", out_media)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            f"/search?q=libraryscopeprobe&kinds=notes&scope=library:{library_id}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(in_block_id) in ids, f"expected in-scope note; got {response.json()['results']}"
        assert str(out_block_id) not in ids

    def test_scope_conversation_filters_notes(self, auth_client, direct_db: DirectSessionManager):
        """conversation: scope admits a note via a conversation context edge (graph §2.5).

        Only a user context edge whose source is the conversation and whose
        target is the note_block admits it. An edge between the note and one of
        the conversation's messages does not."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        in_page_id, in_block_id = uuid4(), uuid4()
        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            conv_id, msg_id = create_test_conversation_with_message(
                session, user_id, content="conversation scope anchor message"
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=in_page_id,
                note_block_id=in_block_id,
                page_title="In Scope Conversation Page",
                body_text="conversationscopeprobe in-scope note content",
            )
            # In scope: a context edge FROM the conversation TO the note_block.
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'conversation', :conversation_id,
                        'note_block', :note_block_id
                    )
                    """
                ),
                {"user_id": user_id, "conversation_id": conv_id, "note_block_id": in_block_id},
            )
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="Out Of Scope Conversation Page",
                body_text="conversationscopeprobe out-of-scope note content",
            )
            # Out of scope: an edge to one of the conversation's messages is not
            # a conversation context edge, so it must not admit the note.
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'note_block', :note_block_id,
                        'message', :message_id
                    )
                    """
                ),
                {"user_id": user_id, "note_block_id": out_block_id, "message_id": msg_id},
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", conv_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", out_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", out_block_id)
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)

        response = auth_client.get(
            f"/search?q=conversationscopeprobe&kinds=notes&scope=conversation:{conv_id}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(in_block_id) in ids, f"expected in-scope note; got {response.json()['results']}"
        assert str(out_block_id) not in ids

    def test_scope_conversation_filters_pages_via_context_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        in_page_id, in_block_id = uuid4(), uuid4()
        out_page_id, out_block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            conv_id = create_test_conversation(session, user_id)
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=in_page_id,
                note_block_id=in_block_id,
                page_title="pageconversationscopeprobe in-scope page",
                body_text="plain in-scope body",
            )
            add_context_edge(session, conv_id, f"page:{in_page_id}")
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=out_page_id,
                note_block_id=out_block_id,
                page_title="pageconversationscopeprobe containment-only page",
                body_text="plain out-of-scope body",
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", conv_id)
        direct_db.register_cleanup("resource_edges", "target_id", in_page_id)
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)

        response = auth_client.get(
            f"/search?q=pageconversationscopeprobe&kinds=notes&scope=conversation:{conv_id}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "page"}
        assert str(in_page_id) in ids, f"expected in-scope page; got {response.json()['results']}"
        assert str(out_page_id) not in ids

    def test_scope_conversation_ignores_note_citation_edges(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id, block_id = uuid4(), uuid4()
        with direct_db.session() as session:
            conv_id, message_id = create_test_conversation_with_message(session, user_id)
            self._seed_scope_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=block_id,
                page_title="Conversation Citation Page",
                body_text="conversationcitationprobe note content",
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id, target_scheme,
                        target_id, ordinal, snapshot
                    )
                    VALUES (
                        :user_id, 'context', 'citation', 'message', :message_id,
                        'note_block', :note_block_id, 1, '{"excerpt":"cited note"}'::jsonb
                    )
                    """
                ),
                {"user_id": user_id, "message_id": message_id, "note_block_id": block_id},
            )
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", message_id)
        direct_db.register_cleanup("resource_edges", "target_id", block_id)
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)

        response = auth_client.get(
            f"/search?q=conversationcitationprobe&kinds=notes&scope=conversation:{conv_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        ids = {r["id"] for r in response.json()["results"] if r["type"] == "note_block"}
        assert str(block_id) not in ids


# =============================================================================
# Type Filtering Tests
# =============================================================================


class TestSearchTypeFiltering:
    """Tests for search type filtering."""

    def test_kind_filter_documents_includes_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Documents kind returns document-family results including media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session, user_id, title="Python Programming Tutorial"
            )

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=python&kinds=documents", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Documents kind folds in the document family (media, content_chunk, ...).
        document_types = {
            "media",
            "episode",
            "video",
            "podcast",
            "content_chunk",
            "fragment",
            "evidence_span",
        }
        for result in data["results"]:
            assert result["type"] in document_types
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert any(r["id"] == str(media_id) for r in media_results)

    def test_kind_filter_documents_family(self, auth_client, direct_db: DirectSessionManager):
        """Documents kind constrains results to the document family."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Content Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=test&kinds=documents", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        # Results should be within the document family (media, content_chunk, ...).
        document_types = {
            "media",
            "episode",
            "video",
            "podcast",
            "content_chunk",
            "fragment",
            "evidence_span",
        }
        for result in data["results"]:
            assert result["type"] in document_types

    def test_invalid_kinds_return_invalid_request(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Unknown kind values fail fast instead of being ignored."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=test&kinds=documents,invalid_kind,notes", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    @pytest.mark.parametrize(
        "deleted_param",
        [
            "types=media",
            "content_kinds=pdf",
            "contributor_handles=le-guin",
            "semantic=true",
            "result_types=media",
            "storage_kinds=pdf",
            "planned_types=media",
            "planned_filters=documents",
        ],
    )
    def test_deleted_filter_params_are_rejected(self, auth_client, deleted_param):
        """AC-5/D-13: every param the cutover removed fails loud (400) rather than being
        ignored (which would silently broaden a stale link to an all-kinds search). The
        rejection is at the route edge, before any search runs."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=removed+param+control&{deleted_param}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_only_invalid_kinds_return_invalid_request(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Reject a kind filter made only of unsupported values."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Unknown Kind Control")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=unknown+kind+control&kinds=totally_invalid",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_kind_filter_empty_returns_no_results(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Explicit empty kind filter should return no results (not fallback-to-all)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session, user_id, title="Empty Kind Filter Needle Title"
            )

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=empty+kind+filter+needle&kinds=",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected 200 for explicit empty kinds filter, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["results"] == [], (
            "Expected no results when explicit empty kinds filter is provided; "
            f"got {len(data['results'])} results: {data['results']}"
        )

    def test_format_filter_makes_notes_unrepresentable(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC-4/D-6: a media-format filter collapses effective kinds to Documents
        server-side, so ``kinds=notes&formats=pdf`` ("Notes + PDFs") yields nothing even
        though the note matches the query under ``kinds=notes`` alone."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Implied Kind Article")
            highlight_id, note_block_id = create_test_highlight_note(
                session, user_id, media_id, body="Implied kind needle about manuscripts"
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        notes_only = auth_client.get(
            "/search?q=implied+kind+needle&kinds=notes", headers=auth_headers(user_id)
        )
        assert notes_only.status_code == 200, notes_only.text
        assert any(r["type"] == "note_block" for r in notes_only.json()["results"]), (
            "the seeded note must be found under kinds=notes"
        )

        notes_pdf = auth_client.get(
            "/search?q=implied+kind+needle&kinds=notes&formats=pdf",
            headers=auth_headers(user_id),
        )
        assert notes_pdf.status_code == 200, notes_pdf.text
        assert notes_pdf.json()["results"] == [], (
            "a media-format filter must collapse Notes to no results (notes ∩ documents = ∅)"
        )

    @pytest.mark.parametrize("bad_filter", ["formats=not_a_format", "roles=not_a_role"])
    def test_out_of_vocab_filters_are_rejected(self, auth_client, bad_filter):
        """D-11: query-time format/role validation is strict — out-of-vocab values 400
        (unlike ingestion's lenient normalize-to-unknown)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=anything&{bad_filter}", headers=auth_headers(user_id)
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


# =============================================================================
# Pagination Tests
# =============================================================================


class TestSearchPagination:
    """Tests for search pagination."""

    def test_pagination_limit_default(self, auth_client, direct_db: DirectSessionManager):
        """Default limit is 20."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create many media items
        media_ids = []
        with direct_db.session() as session:
            for i in range(25):
                media_id = create_searchable_media(session, user_id, title=f"Test Article {i}")
                media_ids.append(media_id)

        for mid in media_ids:
            direct_db.register_cleanup("fragments", "media_id", mid)
            direct_db.register_cleanup("library_entries", "media_id", mid)
            direct_db.register_cleanup("media", "id", mid)

        response = auth_client.get("/search?q=test+article", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) <= 20
        # Should have more results
        assert data["page"]["has_more"] is True
        assert data["page"]["next_cursor"] is not None

    def test_pagination_with_cursor(self, auth_client, direct_db: DirectSessionManager):
        """Pagination with cursor returns next page."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create enough media for pagination
        media_ids = []
        with direct_db.session() as session:
            for i in range(10):
                media_id = create_searchable_media(session, user_id, title=f"Searchable Item {i}")
                media_ids.append(media_id)

        for mid in media_ids:
            direct_db.register_cleanup("fragments", "media_id", mid)
            direct_db.register_cleanup("library_entries", "media_id", mid)
            direct_db.register_cleanup("media", "id", mid)

        # First page
        response1 = auth_client.get(
            "/search?q=searchable+item&limit=3", headers=auth_headers(user_id)
        )
        assert response1.status_code == 200
        data1 = response1.json()
        assert len(data1["results"]) == 3
        assert data1["page"]["next_cursor"] is not None

        # Second page
        cursor = data1["page"]["next_cursor"]
        response2 = auth_client.get(
            f"/search?q=searchable+item&limit=3&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert len(data2["results"]) >= 1

        # Results should not overlap
        ids1 = {r["id"] for r in data1["results"]}
        ids2 = {r["id"] for r in data2["results"]}
        assert ids1.isdisjoint(ids2)

    def test_pagination_limit_clamped(self, auth_client):
        """Limit > 50 returns 422."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search?q=test&limit=100", headers=auth_headers(user_id))

        assert response.status_code in (400, 422)

    def test_invalid_cursor(self, auth_client):
        """Invalid cursor returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/search?q=test&cursor=invalid!!!cursor", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    @pytest.mark.parametrize("offset", ["1", 1.2, True])
    def test_invalid_cursor_offset_type(self, auth_client, offset):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        cursor = (
            base64.urlsafe_b64encode(json.dumps({"offset": offset}).encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )

        response = auth_client.get(
            f"/search?q=the+and&cursor={cursor}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    @respx.mock
    def test_invalid_cursor_does_not_call_embedding_provider(
        self,
        auth_client,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        monkeypatch.setenv("NEXUS_ENV", "local")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        monkeypatch.setenv("ENABLE_OPENAI", "true")
        clear_settings_cache()
        try:
            route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
                200,
                json={"data": [{"index": 0, "embedding": [0.1] * 256}]},
            )

            response = auth_client.get(
                "/search?q=cursor+check&kinds=documents&cursor=invalid!!!cursor",
                headers=auth_headers(user_id),
            )

            assert response.status_code == 400
            assert response.json()["error"]["code"] == "E_INVALID_CURSOR"
            assert route.call_count == 0
        finally:
            clear_settings_cache()

    @respx.mock
    def test_all_stopword_query_does_not_call_embedding_provider(
        self,
        auth_client,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        monkeypatch.setenv("NEXUS_ENV", "local")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        monkeypatch.setenv("ENABLE_OPENAI", "true")
        clear_settings_cache()
        try:
            route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
                200,
                json={"data": [{"index": 0, "embedding": [0.1] * 256}]},
            )

            response = auth_client.get(
                "/search?q=the+and&kinds=documents",
                headers=auth_headers(user_id),
            )

            assert response.status_code == 200
            assert response.json()["results"] == []
            assert route.call_count == 0
        finally:
            clear_settings_cache()


# =============================================================================
# Result Format Tests
# =============================================================================


class TestSearchResultFormat:
    """Tests for search result format."""

    def test_media_result_has_required_fields(self, auth_client, direct_db: DirectSessionManager):
        """Media results include v2 required source metadata fields."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Unique Title For Test")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=unique+title&kinds=documents", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = next(
            r for r in data["results"] if r["type"] == "media" and r["id"] == str(media_id)
        )
        assert "id" in result
        assert "type" in result
        assert "score" in result
        assert "snippet" in result
        assert result["type"] == "media"
        assert "source" in result
        assert result["source"]["media_id"] == str(media_id)
        assert result["source"]["media_kind"] == "web_article"
        assert result["source"]["title"] == "Unique Title For Test"
        assert "contributors" in result["source"]
        assert "published_date" in result["source"]
        assert result["title"] == "Unique Title For Test"
        assert result["media_id"] == str(media_id)
        assert result["media_kind"] == "web_article"
        assert result["activation"]["href"] == f"/media/{media_id}"
        assert "deep_link" not in result
        assert result["context_ref"] == {"type": "media", "id": str(media_id)}

    def test_media_result_contributors_use_frontend_wire_keys(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Search responses keep contributor fields in snake_case for the web adapter."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session,
                user_id,
                title=f"Contributor Wire Contract {uuid4()}",
            )
            session.commit()

        # The author facade opens its own fresh session and commits, so it runs
        # after the media is committed (not on the direct_db session).
        contributors.replace_observed_role_slices(
            target=contributors.MediaTarget(media_id),
            observation=ObservedRoleSlices(
                managed_roles=frozenset({"author"}),
                credits=(
                    ContributorObservation(
                        credited_name="Wire Contract Author",
                        role="author",
                        raw_role=None,
                        identity_key=None,
                    ),
                ),
            ),
            source="web_article_byline",
        )

        with direct_db.session() as session:
            contributor_id = session.execute(
                text("SELECT contributor_id FROM contributor_credits WHERE media_id = :m LIMIT 1"),
                {"m": media_id},
            ).scalar_one()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("contributor_credits", "media_id", media_id)
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=contributor+wire+contract&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected search to succeed, got {response.status_code}: {response.text}"
        )
        rows = response.json()["results"]
        media_row = next(row for row in rows if row["id"] == str(media_id))
        credit = media_row["source"]["contributors"][0]
        assert credit["contributor_handle"]
        assert credit["contributor_display_name"] == "Wire Contract Author"
        assert credit["credited_name"] == "Wire Contract Author"
        assert "contributorHandle" not in credit
        assert "creditedName" not in credit

    def test_fragment_result_has_required_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Fragment results include v2 required fields + source metadata."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=canonical+text&kinds=documents", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()

        content_chunk_results = [r for r in data["results"] if r["type"] == "content_chunk"]
        if len(content_chunk_results) >= 1:
            result = content_chunk_results[0]
            assert result["type"] == "content_chunk"
            assert "source" in result
            assert result["source"]["media_id"] == str(media_id)
            assert result["source"]["media_kind"] == "web_article"
            assert result["media_id"] == str(media_id)
            assert result["media_kind"] == "web_article"
            assert result["activation"]["href"].startswith(f"/media/{media_id}#evidence-")
            assert "deep_link" not in result
            assert result["citation_label"] == "Source"
            assert result["locator"]["type"] == "web_text_offsets"
            assert result["locator"]["media_id"] == str(media_id)
            assert result["locator"]["fragment_id"]
            assert result["locator"]["start_offset"] >= 0
            assert result["locator"]["end_offset"] > result["locator"]["start_offset"]
            assert result["context_ref"] == {
                "type": "content_chunk",
                "id": result["id"],
                "evidence_span_ids": result["evidence_span_ids"],
            }
            assert "idx" not in result

    def test_media_content_index_results_require_ready_index(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Pending Index Source")
            session.execute(
                text(
                    """
                    UPDATE content_index_states
                    SET status = 'pending',
                        active_embedding_provider = NULL,
                        active_embedding_model = NULL
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=canonical+text&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        stale_rows = [
            row
            for row in response.json()["results"]
            if row["type"] in {"content_chunk", "fragment", "evidence_span"}
            and row.get("source", {}).get("media_id") == str(media_id)
        ]
        assert stale_rows == []

    def test_content_chunk_search_drops_prior_span_after_current_rebuild(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Stale Run Search Source")
            old_span_id = session.execute(
                text(
                    """
                    SELECT cc.primary_evidence_span_id
                    FROM content_chunks cc
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()
            fragment = session.query(Fragment).filter(Fragment.media_id == media_id).one()
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                fragments=[fragment],
                reason="test_stale_search",
            )
            active_chunk_id = session.execute(
                text(
                    """
                    SELECT cc.id
                    FROM content_chunks cc
                    JOIN content_index_states mcis
                      ON mcis.owner_kind = cc.owner_kind AND mcis.owner_id = cc.owner_id
                     AND mcis.status = 'ready'
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                """
                ),
                {"media_id": media_id},
            ).scalar_one()
            old_span_exists = session.execute(
                text(
                    """
                    SELECT 1
                    FROM evidence_spans
                    WHERE id = :old_span_id
                    """
                ),
                {"old_span_id": old_span_id},
            ).scalar()
            session.commit()
        assert old_span_exists is None

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=stale+run+search&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected current rebuilt chunks to be searchable, got "
            f"{response.status_code}: {response.text}"
        )
        content_chunk_rows = [
            row for row in response.json()["results"] if row["type"] == "content_chunk"
        ]
        assert any(row["id"] == str(active_chunk_id) for row in content_chunk_rows)
        assert all(str(old_span_id) not in row["evidence_span_ids"] for row in content_chunk_rows)

    def test_content_chunk_search_skips_stale_snapshot_text(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Stale Snapshot Source")
            chunk_id = session.execute(
                text(
                    """
                    SELECT cc.id
                    FROM content_chunks cc
                    JOIN content_index_states mcis
                      ON mcis.owner_kind = cc.owner_kind AND mcis.owner_id = cc.owner_id
                     AND mcis.status = 'ready'
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()
            fragment = session.query(Fragment).filter(Fragment.media_id == media_id).one()
            fragment.canonical_text = "Replacement text no longer matches the indexed span."
            session.execute(
                text(
                    """
                    UPDATE content_blocks
                    SET canonical_text = 'Replacement text no longer matches the indexed span.'
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=canonical+text&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        result_ids = {row["id"] for row in response.json()["results"]}
        assert str(chunk_id) not in result_ids

    def test_media_evidence_resolver_returns_reader_payload(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Resolver Source")
            row = session.execute(
                text("""
                    SELECT cc.primary_evidence_span_id, cc.summary_locator
                    FROM content_chunks cc
                    WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).first()
            assert row is not None
            evidence_span_id = row[0]
            locator = row[1]

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            f"/media/{media_id}/evidence/{evidence_span_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["evidence_span_id"] == str(evidence_span_id)
        assert data["media_id"] == str(media_id)
        assert data["citation_label"] == "Source"
        assert data["resolver"]["kind"] == "web"
        assert data["resolver"]["route"] == f"/media/{media_id}"
        assert data["resolver"]["params"] == {
            "evidence": str(evidence_span_id),
            "fragment": locator["fragment_id"],
        }
        assert data["resolver"]["status"] == "resolved"
        assert data["resolver"]["highlight"]["kind"] == "web_text"
        assert data["resolver"]["highlight"]["fragment_id"] == locator["fragment_id"]

    def test_message_result_has_required_fields(self, auth_client, direct_db: DirectSessionManager):
        """Message results include id, conversation_id, seq."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_id, content="Unique searchable message content here"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            "/search?q=unique+searchable+message&kinds=conversations",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = next(
            r for r in data["results"] if r["type"] == "message" and r["id"] == str(message_id)
        )
        assert result["type"] == "message"
        assert "conversation_id" in result
        assert "seq" in result
        assert result["activation"]["href"] == f"/conversations/{conversation_id}"
        assert "deep_link" not in result
        assert result["context_ref"] == {"type": "message", "id": str(message_id)}

    def test_web_result_search_and_service_resolution(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Persisted web retrievals are searchable only through visible conversations."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        tool_call_id = uuid4()
        retrieval_id = uuid4()
        snapshot_id = uuid4()
        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(
                session,
                conversation_id,
                1,
                role="user",
                content="Find web evidence about the calypso archive.",
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                2,
                role="assistant",
                content="The calypso archive has a public source.",
            )
            session.execute(
                text("""
                    INSERT INTO resource_external_snapshots (
                        id, user_id, provider, url, title, snippet, source_snapshot
                    )
                    VALUES (
                        :snapshot_id, :user_id, 'test', 'https://example.com/calypso',
                        'Calypso Archive Source',
                        'Calypso archive public evidence snippet',
                        jsonb_build_object(
                            'type', 'web_result',
                            'id', CAST(:snapshot_id_text AS text),
                            'result_type', 'web_result',
                            'result_ref', 'web:calypso',
                            'source_id', CAST(:snapshot_id_text AS text),
                            'title', 'Calypso Archive Source',
                            'url', 'https://example.com/calypso',
                            'display_url', 'example.com/calypso',
                            'deep_link', 'https://example.com/calypso',
                            'snippet', 'Calypso archive public evidence snippet',
                            'provider', 'test',
                            'provider_request_id', 'provider-request-1',
                            'locator', jsonb_build_object(
                                'type', 'external_url',
                                'url', 'https://example.com/calypso',
                                'title', 'Calypso Archive Source',
                                'display_url', 'example.com/calypso'
                            ),
                            'context_ref', jsonb_build_object(
                                'type', 'web_result',
                                'id', CAST(:snapshot_id_text AS text)
                            ),
                            'media_id', NULL,
                            'media_kind', NULL,
                            'score', 0.5,
                            'selected', true
                        )
                    )
                """),
                {
                    "snapshot_id": snapshot_id,
                    "snapshot_id_text": str(snapshot_id),
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_tool_calls (
                        id, conversation_id, user_message_id, assistant_message_id,
                        tool_name, tool_call_index, scope, requested_types,
                        result_refs, selected_context_refs, provider_request_ids,
                        status
                    )
                    VALUES (
                        :tool_call_id, :conversation_id, :user_message_id,
                        :assistant_message_id, 'web_search', 1, 'public_web',
                        '["web_result"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                        '["provider-request-1"]'::jsonb, 'complete'
                    )
                """),
                {
                    "tool_call_id": tool_call_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_retrievals (
                        id, tool_call_id, ordinal, result_type, source_id,
                        context_ref, result_ref, deep_link, score, selected,
                        source_title, exact_snippet, locator, retrieval_status,
                        included_in_prompt
                    )
                    VALUES (
                        :retrieval_id, :tool_call_id, 0, 'web_result', :snapshot_id_text,
                        jsonb_build_object(
                            'type', 'web_result', 'id', CAST(:snapshot_id_text AS text)
                        ),
                        jsonb_build_object(
                            'type', 'web_result',
                            'id', CAST(:snapshot_id_text AS text),
                            'result_type', 'web_result',
                            'result_ref', 'web:calypso',
                            'source_id', CAST(:snapshot_id_text AS text),
                            'title', 'Calypso Archive Source',
                            'url', 'https://example.com/calypso',
                            'display_url', 'example.com/calypso',
                            'deep_link', 'https://example.com/calypso',
                            'snippet', 'Calypso archive public evidence snippet',
                            'provider', 'test',
                            'provider_request_id', 'provider-request-1',
                            'locator', jsonb_build_object(
                                'type', 'external_url',
                                'url', 'https://example.com/calypso',
                                'title', 'Calypso Archive Source',
                                'display_url', 'example.com/calypso'
                            ),
                            'context_ref', jsonb_build_object(
                                'type', 'web_result',
                                'id', CAST(:snapshot_id_text AS text)
                            ),
                            'media_id', NULL,
                            'media_kind', NULL,
                            'score', 0.5,
                            'selected', true
                        ),
                        'https://example.com/calypso',
                        0.5,
                        true,
                        'Calypso Archive Source',
                        'Calypso archive public evidence snippet',
                        jsonb_build_object(
                            'type', 'external_url',
                            'url', 'https://example.com/calypso',
                            'title', 'Calypso Archive Source',
                            'display_url', 'example.com/calypso'
                        ),
                        'web_result',
                        true
                    )
                """),
                {
                    "retrieval_id": retrieval_id,
                    "tool_call_id": tool_call_id,
                    "snapshot_id_text": str(snapshot_id),
                },
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("message_retrievals", "id", retrieval_id)
        direct_db.register_cleanup("resource_external_snapshots", "id", snapshot_id)

        with direct_db.session() as session:
            resolved = get_search_result(
                db=session,
                viewer_id=user_id,
                result_type="web_result",
                result_id=str(retrieval_id),
            )
            result = resolved.model_dump(mode="json")

            with pytest.raises(InvalidRequestError):
                get_search_result(
                    db=session,
                    viewer_id=user_id,
                    result_type="web_result",
                    result_id="web:calypso",
                )

        assert result["type"] == "web_result"
        assert result["id"] == str(retrieval_id)
        assert result["source_id"] == str(snapshot_id)
        assert result["result_ref"] == "web:calypso"
        assert result["resource_ref"] == f"external_snapshot:{snapshot_id}"
        assert result["citation_target"] == f"external_snapshot:{snapshot_id}"
        assert result["activation"] == {
            "resource_ref": f"external_snapshot:{snapshot_id}",
            "kind": "external",
            "href": "https://example.com/calypso",
            "unresolved_reason": None,
        }
        assert result["url"] == "https://example.com/calypso"
        assert "deep_link" not in result
        assert "source_version" not in result
        assert result["locator"] == {
            "type": "external_url",
            "url": "https://example.com/calypso",
            "title": "Calypso Archive Source",
            "display_url": "example.com/calypso",
            "accessed_at": None,
        }
        assert result["context_ref"] == {"type": "web_result", "id": str(snapshot_id)}

        with direct_db.session() as session:
            session.execute(
                text("""
                    UPDATE message_retrievals
                    SET result_ref = result_ref - 'result_ref'
                    WHERE id = :retrieval_id
                """),
                {"retrieval_id": retrieval_id},
            )
            session.commit()

        with direct_db.session() as session:
            with pytest.raises(ValidationError):
                get_search_result(
                    db=session,
                    viewer_id=user_id,
                    result_type="web_result",
                    result_id=str(retrieval_id),
                )

    def test_snippet_max_length(self, auth_client, direct_db: DirectSessionManager):
        """Snippets are truncated to max 300 chars."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=test", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        for result in data["results"]:
            # Snippet should be <= 303 (300 + "...")
            assert len(result["snippet"]) <= 303

    def test_truncated_snippet_keeps_highlighted_match_visible(self):
        prefix = " ".join(f"filler {idx:03d}" for idx in range(40))
        suffix = " ".join(f"tail {idx:03d}" for idx in range(40))
        snippet = _truncate_snippet(f"{prefix} <b>target match</b> {suffix}")

        assert snippet.startswith("...")
        assert "<b>target match</b>" in snippet
        assert len(snippet) <= 306

    def test_query_centered_snippet_recovers_when_headline_misses_match(self):
        prefix = " ".join(f"filler {idx:03d}" for idx in range(40))
        suffix = " ".join(f"tail {idx:03d}" for idx in range(40))
        snippet = _snippet_around_query(
            f"{prefix} target phrase for evidence navigation {suffix}",
            "target phrase for evidence navigation",
        )

        assert snippet is not None
        assert snippet.startswith("...")
        assert "<b>target phrase for evidence navigation</b>" in snippet
        assert len(snippet) <= 300

    def test_note_block_results_use_note_contract(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Note-block search returns the note result contract."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        note_body = "Unique metadata-rich note lookup term harmonica"
        source_title = "Metadata Rich Source Title"

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title=source_title)
            highlight_id, note_block_id = create_test_highlight_note(
                session,
                user_id,
                media_id,
                body=note_body,
            )
            session.commit()

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=harmonica&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"Expected 200 for note search, got {response.status_code}: {response.text}"
        )
        data = response.json()
        result = next((r for r in data["results"] if r["id"] == str(note_block_id)), None)
        assert result is not None, (
            f"Expected note block {note_block_id} in results; got {data['results']}"
        )

        assert result["type"] == "note_block"
        assert result["source_label"] == "note"
        assert result["highlight_excerpt"] == "test exact"
        assert result["body_text"] == note_body
        assert result["activation"]["href"] == f"/notes/{note_block_id}"
        assert "deep_link" not in result
        assert result["media_id"] is None
        assert result["media_kind"] is None
        assert result["context_ref"] == {"type": "note_block", "id": str(note_block_id)}
        assert "source" not in result
        assert "highlight" not in result
        assert "note_body" not in result

    def test_page_results_use_page_contract(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        page_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO pages (id, user_id, title)
                    VALUES (:page_id, :user_id, 'Garden Planning')
                """),
                {"page_id": page_id, "user_id": user_id},
            )
            session.commit()

        direct_db.register_cleanup("pages", "id", page_id)

        response = auth_client.get(
            "/search?q=garden&kinds=notes",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected 200 for page search, got {response.status_code}: {response.text}"
        )
        data = response.json()
        result = next((row for row in data["results"] if row["id"] == str(page_id)), None)
        assert result is not None, f"Expected page {page_id} in results; got {data['results']}"
        assert result["type"] == "page"
        assert result["title"] == "Garden Planning"
        assert "description" not in result
        assert result["activation"]["href"] == f"/pages/{page_id}"
        assert "deep_link" not in result
        assert result["context_ref"] == {"type": "page", "id": str(page_id)}
        assert "body_text" not in result

    def _seed_note_block(
        self,
        session,
        *,
        user_id: UUID,
        page_id: UUID,
        note_block_id: UUID,
        page_title: str,
        body_text: str,
    ) -> None:
        """Insert a page + single note_block, then index the note body."""
        session.execute(
            text("INSERT INTO pages (id, user_id, title) VALUES (:page_id, :user_id, :title)"),
            {"page_id": page_id, "user_id": user_id, "title": page_title},
        )
        session.execute(
            text(
                """
                INSERT INTO note_blocks (
                    id, user_id, body_pm_json, body_text
                )
                VALUES (
                    :note_block_id, :user_id,
                    jsonb_build_object(
                        'type', 'paragraph',
                        'content', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                        )
                    ),
                    :body_text
                )
                """
            ),
            {
                "note_block_id": note_block_id,
                "user_id": user_id,
                "body_text": body_text,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id,
                    kind,
                    origin,
                    source_scheme,
                    source_id,
                    target_scheme,
                    target_id,
                    source_order_key
                )
                VALUES (
                    :user_id,
                    'context',
                    'user',
                    'page',
                    :page_id,
                    'note_block',
                    :note_block_id,
                    '0000000001'
                )
                """
            ),
            {
                "user_id": user_id,
                "page_id": page_id,
                "note_block_id": note_block_id,
            },
        )
        rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")

    def test_note_block_searchable_via_unified_content_pipeline(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        """A note_block indexed via rebuild_note_content_index is searchable; an
        unrelated query does not return it (hybrid lexical ∪ semantic over content
        chunks, with deterministic test embeddings)."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id = uuid4()
        note_block_id = uuid4()
        with direct_db.session() as session:
            self._seed_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=note_block_id,
                page_title="Unified Pipeline Page",
                body_text="semanticneedle harmonica trellis concept body text",
            )
            session.commit()

        response = auth_client.get(
            "/search?q=semanticneedle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected note search to succeed, got {response.status_code}: {response.text}"
        )
        note_rows = [r for r in response.json()["results"] if r["type"] == "note_block"]
        assert any(r["id"] == str(note_block_id) for r in note_rows), (
            f"expected note_block {note_block_id} in results; got {response.json()['results']}"
        )

        unrelated = auth_client.get(
            "/search?q=unrelatedobjectmiss&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert unrelated.status_code == 200
        unrelated_ids = {r["id"] for r in unrelated.json()["results"]}
        assert str(note_block_id) not in unrelated_ids

    def test_note_reindex_deletes_stale_note_content(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        """Re-running rebuild_note_content_index after editing a note body makes the new
        text searchable and removes the stale chunks (old text no longer matches)."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id = uuid4()
        note_block_id = uuid4()
        with direct_db.session() as session:
            self._seed_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=note_block_id,
                page_title="Reindex Page",
                body_text="staleprojectionneedle original note content",
            )
            session.commit()

        initial = auth_client.get(
            "/search?q=staleprojectionneedle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert initial.status_code == 200
        assert any(r["id"] == str(note_block_id) for r in initial.json()["results"]), (
            "expected the note_block to be searchable by its original text"
        )

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE note_blocks
                    SET body_text = :body_text,
                        body_pm_json = jsonb_build_object(
                            'type', 'paragraph',
                            'content', jsonb_build_array(
                                jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                            )
                        )
                    WHERE id = :note_block_id
                    """
                ),
                {
                    "note_block_id": note_block_id,
                    "body_text": "freshreindexneedle replacement note content",
                },
            )
            rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")
            session.commit()

        fresh = auth_client.get(
            "/search?q=freshreindexneedle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert fresh.status_code == 200
        assert any(r["id"] == str(note_block_id) for r in fresh.json()["results"]), (
            "expected the edited note text to become searchable after reindex"
        )

        stale = auth_client.get(
            "/search?q=staleprojectionneedle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert stale.status_code == 200
        stale_ids = {r["id"] for r in stale.json()["results"]}
        assert str(note_block_id) not in stale_ids, (
            "stale note content must be deleted on reindex (old text no longer searchable)"
        )

    def test_note_block_searchable_via_semantic_axis_only(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        """AC-1: a note_block whose body does NOT contain the probe token is still found by
        the semantic arm after its content embedding is overwritten with the probe's vector,
        while a lexical-only query for a concept absent from the body returns nothing. This
        isolates the vector path (the lexical-token-overlap masking from the existing
        unified-pipeline test cannot explain the hit)."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id = uuid4()
        note_block_id = uuid4()
        with direct_db.session() as session:
            self._seed_note_block(
                session,
                user_id=user_id,
                page_id=page_id,
                note_block_id=note_block_id,
                page_title="Semantic Axis Page",
                body_text="ordinary garden notes",
            )
            session.commit()

        # Overwrite the note-owned chunk embedding with the probe token's vector.
        _model, vector = build_text_embedding("vectoronlyprobe")
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE content_embeddings ce
                    SET embedding_vector = CAST(:embedding AS vector(256))
                    FROM content_chunks cc
                    WHERE cc.id = ce.chunk_id
                      AND cc.owner_kind = 'note_block' AND cc.owner_id = :note_block_id
                    """
                ),
                {"note_block_id": note_block_id, "embedding": to_pgvector_literal(vector)},
            )
            session.commit()

        # (a) Vector arm: the probe token is absent from the body but the chunk vector is it.
        semantic = auth_client.get(
            "/search?q=vectoronlyprobe&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert semantic.status_code == 200, semantic.text
        semantic_ids = {r["id"] for r in semantic.json()["results"] if r["type"] == "note_block"}
        assert str(note_block_id) in semantic_ids, (
            "single-token semantic note search should match via vector relevance when the "
            f"body has no token overlap; got {semantic.json()['results']}"
        )

        # (b) Lexical-only control: a concept absent from the body must not return the note
        # (its vector was overwritten to the probe, not this term), proving (a) was vector-only.
        lexical = auth_client.get(
            "/search?q=lexicalmissconcept&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert lexical.status_code == 200, lexical.text
        lexical_ids = {r["id"] for r in lexical.json()["results"]}
        assert str(note_block_id) not in lexical_ids

    def test_page_searchable_by_title_token(self, auth_client, direct_db: DirectSessionManager):
        """AC-2: a page is returned when a unique token lives only in its title."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        page_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO pages (id, user_id, title)
                    VALUES (:page_id, :user_id, 'Zylotrope Planning')
                    """
                ),
                {"page_id": page_id, "user_id": user_id},
            )
            session.commit()

        direct_db.register_cleanup("pages", "id", page_id)

        response = auth_client.get(
            "/search?q=zylotrope&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        result = next(
            (row for row in response.json()["results"] if row["id"] == str(page_id)), None
        )
        assert result is not None, (
            f"expected page {page_id} matched by title token; got {response.json()['results']}"
        )
        assert result["type"] == "page"
        assert result["id"] == str(page_id)

    def test_daily_page_searchable_by_title(self, auth_client, direct_db: DirectSessionManager):
        """A daily note page is returned when querying its title."""
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("daily_note_pages", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        local_date = date(2026, 5, 6)
        with direct_db.session() as session:
            daily = get_daily_note(session, user_id, local_date)
            page_id = daily.page.id
            session.commit()

        human = auth_client.get(
            "/search?q=May+6,+2026&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert human.status_code == 200, human.text
        human_result = next(
            (row for row in human.json()["results"] if row["id"] == str(page_id)), None
        )
        assert human_result is not None, (
            f"expected daily page {page_id} by human date; got {human.json()['results']}"
        )
        assert human_result["type"] == "page"
        assert human_result["id"] == str(page_id)


# =============================================================================
# Search Visibility Alignment Tests
# =============================================================================


class TestSearchConversationScope:
    """Tests for conversation scope using shared-read visibility."""

    def test_scope_conversation_shared_reader_allowed_by_read_visibility(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader can search messages within a conversation via scope.

        Conversation owned by user_a, shared to library L.
        user_b is member of L. user_b can scope-search the conversation.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Shared Convo Lib")
            add_library_member(session, library_id, user_b)

            conversation_id = create_test_conversation(session, user_a, sharing="private")
            msg_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="Searchable conversation scope alignment content",
            )
            share_conversation_to_library(session, conversation_id, library_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            f"/search?q=scope+alignment+content&scope=conversation:{conversation_id}&kinds=conversations",
            headers=auth_headers(user_b),
        )

        assert response.status_code == 200
        data = response.json()
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert len(message_results) >= 1
        assert any(r["id"] == str(msg_id) for r in message_results)

    def test_scope_conversation_not_found_for_non_visible(self, auth_client):
        """Non-visible conversation scope still returns masked 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_scope_conversation_searches_associated_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation scope includes media attached by a graph context ref."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            media_id = create_searchable_media(
                session,
                user_id,
                title="Conversation Scoped Media Needle",
            )
            add_context_edge(session, conversation_id, f"media:{media_id}")
            session.commit()

        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/search?q=scoped+media+needle&scope=conversation:{conversation_id}&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert any(r["id"] == str(media_id) for r in media_results)


class TestSearchNoteBlockOwnership:
    """Tests for note-block search under user-owned note visibility."""

    def test_search_note_blocks_exclude_other_users_shared_media_notes(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared media visibility does not expose another user's note blocks."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Note Share Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Shared Note Article"
            )
            highlight_id, note_block_id = create_test_highlight_note(
                session, user_a, media_id, body="Unique shared note searchterm xylophone"
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get("/search?q=xylophone&kinds=notes", headers=auth_headers(user_b))

        assert response.status_code == 200
        data = response.json()
        note_block_results = [r for r in data["results"] if r["type"] == "note_block"]
        assert not any(r["id"] == str(note_block_id) for r in note_block_results)

    def test_search_note_blocks_remain_hidden_after_membership_revocation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Revocation keeps another user's note blocks hidden."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Revocation Test Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Revocation Note Article"
            )
            highlight_id, note_block_id = create_test_highlight_note(
                session, user_a, media_id, body="Revocation test note trombone"
            )

        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # The note is not visible even before revocation because notes are user-owned.
        resp_before = auth_client.get(
            "/search?q=trombone&kinds=notes", headers=auth_headers(user_b)
        )
        assert resp_before.status_code == 200
        before_ids = [r["id"] for r in resp_before.json()["results"]]
        assert str(note_block_id) not in before_ids

        # Revoke membership
        with direct_db.session() as session:
            session.execute(
                text("""
                    DELETE FROM memberships
                    WHERE library_id = :library_id AND user_id = :user_id
                """),
                {"library_id": library_id, "user_id": user_b},
            )
            session.commit()

        # Verify invisible after revocation
        resp_after = auth_client.get("/search?q=trombone&kinds=notes", headers=auth_headers(user_b))
        assert resp_after.status_code == 200
        after_ids = [r["id"] for r in resp_after.json()["results"]]
        assert str(note_block_id) not in after_ids


class TestSearchLibraryScopeMessages:
    """Tests for library-scope message search."""

    def test_scope_library_message_search_includes_only_target_shared_conversations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Library-scope message search returns only conversations shared to that library.

        c1 shared to l1, c2 shared to l2; viewer_b member of l1 only.
        scope=library:l1 returns messages from c1 only.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Library Scope L1")
            l2 = create_test_library(session, user_a, "Library Scope L2")
            add_library_member(session, l1, user_b)

            c1 = create_test_conversation(session, user_a)
            create_test_message(
                session, c1, seq=1, content="Library scope target message xylophonist"
            )
            share_conversation_to_library(session, c1, l1)

            c2 = create_test_conversation(session, user_a)
            msg2_id = create_test_message(
                session, c2, seq=1, content="Library scope excluded message xylophonist"
            )
            share_conversation_to_library(session, c2, l2)

        direct_db.register_cleanup("conversation_shares", "conversation_id", c1)
        direct_db.register_cleanup("conversation_shares", "conversation_id", c2)
        direct_db.register_cleanup("messages", "conversation_id", c1)
        direct_db.register_cleanup("messages", "conversation_id", c2)
        direct_db.register_cleanup("conversations", "id", c1)
        direct_db.register_cleanup("conversations", "id", c2)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("memberships", "library_id", l2)
        direct_db.register_cleanup("libraries", "id", l1)
        direct_db.register_cleanup("libraries", "id", l2)

        response = auth_client.get(
            f"/search?q=xylophonist&scope=library:{l1}&kinds=conversations",
            headers=auth_headers(user_b),
        )

        assert response.status_code == 200
        data = response.json()
        msg_results = [r for r in data["results"] if r["type"] == "message"]
        msg_ids = [r["id"] for r in msg_results]

        # c1 messages may appear
        # c2 messages must not appear (not shared to l1)
        assert str(msg2_id) not in msg_ids

    def test_scope_library_message_search_excludes_visible_but_unshared_conversations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Visible conversations not shared to target library are excluded from library-scope.

        viewer owns a private conversation. It's visible to viewer but not shared
        to target library. Library-scope search must exclude it.
        """
        user_a = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Lib Scope Exclusion Test")

            # Private conversation owned by user_a (visible to user_a, not shared to l1)
            c_private, msg_private_id = create_test_conversation_with_message(
                session, user_a, content="Private unshared library scope xylophone"
            )

        direct_db.register_cleanup("messages", "conversation_id", c_private)
        direct_db.register_cleanup("conversations", "id", c_private)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("libraries", "id", l1)

        response = auth_client.get(
            f"/search?q=xylophone&scope=library:{l1}&kinds=conversations",
            headers=auth_headers(user_a),
        )

        assert response.status_code == 200
        data = response.json()
        msg_ids = [r["id"] for r in data["results"] if r["type"] == "message"]
        assert str(msg_private_id) not in msg_ids

    def test_scope_library_message_search_requires_library_sharing_state(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation with share row but sharing != 'library' is excluded.

        A conversation that is 'public' but has a stale share row to the
        target library should not appear in library-scope message results.
        """
        user_a = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Lib Share State Test")

            c_public = create_test_conversation(session, user_a, sharing="public")
            msg_id = create_test_message(
                session, c_public, seq=1, content="Public stale share row xylophone"
            )
            # Insert a stale share row without setting sharing='library'
            session.execute(
                text("""
                    INSERT INTO conversation_shares (conversation_id, library_id)
                    VALUES (:cid, :lid)
                    ON CONFLICT DO NOTHING
                """),
                {"cid": c_public, "lid": l1},
            )
            session.commit()

        direct_db.register_cleanup("conversation_shares", "conversation_id", c_public)
        direct_db.register_cleanup("messages", "conversation_id", c_public)
        direct_db.register_cleanup("conversations", "id", c_public)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("libraries", "id", l1)

        response = auth_client.get(
            f"/search?q=xylophone&scope=library:{l1}&kinds=conversations",
            headers=auth_headers(user_a),
        )

        assert response.status_code == 200
        data = response.json()
        msg_ids = [r["id"] for r in data["results"] if r["type"] == "message"]
        assert str(msg_id) not in msg_ids


class TestSearchResponseShape:
    """Tests for response shape preservation."""

    def test_search_response_shape_remains_results_page(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Response has top-level 'results' and 'page', no data envelope."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Shape Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=shape+test", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "page" in data
        assert isinstance(data["results"], list)
        assert isinstance(data["page"], dict)
        assert "has_more" in data["page"]
        assert "next_cursor" in data["page"]
        # No envelope wrapper like {"data": ...}
        assert "data" not in data
        assert "error" not in data


class TestReaderApparatusSearch:
    def test_reader_apparatus_item_is_searchable_citable_and_activatable(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        state_id = uuid4()
        item_id = uuid4()

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Apparatus Search Source")
            session.execute(
                text("""
                    INSERT INTO reader_apparatus_states (
                        id, media_id, media_kind, source_fingerprint, extractor_version,
                        status, item_count, edge_count, diagnostics
                    )
                    VALUES (
                        :state_id, :media_id, 'web_article', 'sha256:test',
                        'reader_apparatus_v1', 'ready', 1, 0, '{}'::jsonb
                    )
                """),
                {"state_id": state_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO reader_apparatus_items (
                        id, media_id, state_id, stable_key, kind, label, body_text,
                        body_html_sanitized, locator, locator_status, confidence,
                        extraction_method, source_ref, sort_key
                    )
                    VALUES (
                        :item_id, :media_id, :state_id, 'apparatus-note-1',
                        'footnote', '1', 'source-authored apparatus needle text',
                        NULL, CAST(:locator AS jsonb), 'exact', 'exact',
                        'test', '{}'::jsonb, '000001.target'
                    )
                """),
                {
                    "item_id": item_id,
                    "media_id": media_id,
                    "state_id": state_id,
                    "locator": json.dumps(
                        {
                            "type": "web_text_offsets",
                            "media_id": str(media_id),
                            "fragment_id": str(uuid4()),
                            "start_offset": 0,
                            "end_offset": 37,
                            "media_kind": "web_article",
                            "text_quote_selector": {
                                "exact": "source-authored apparatus needle text"
                            },
                        }
                    ),
                },
            )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("reader_apparatus_states", "id", state_id)
        direct_db.register_cleanup("reader_apparatus_items", "id", item_id)

        response = auth_client.get(
            "/search?q=apparatus+needle&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected apparatus search to succeed, got {response.status_code}: {response.text}"
        )
        result = next(
            row for row in response.json()["results"] if row["type"] == "reader_apparatus_item"
        )
        assert result["id"] == str(item_id)
        assert result["resource_ref"] == f"reader_apparatus_item:{item_id}"
        assert result["citation_target"] == f"reader_apparatus_item:{item_id}"
        assert result["activation"] == {
            "resource_ref": f"reader_apparatus_item:{item_id}",
            "kind": "route",
            "href": f"/media/{media_id}?apparatus=apparatus-note-1&apparatus_id={item_id}",
            "unresolved_reason": None,
        }
        assert result["context_ref"] == {"type": "reader_apparatus_item", "id": str(item_id)}
        assert result["source"]["media_id"] == str(media_id)
        assert result["locator"]["type"] == "web_text_offsets"
        assert "deep_link" not in result


class TestSearchProvenance:
    """Tests for media provenance in search visibility."""

    def test_search_returns_direct_default_library_entry_without_other_provenance(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A direct physical default library_entries row is search-visible on its own.

        Post-cutover there is no separate intrinsic/closure provenance table — a
        direct physical entry in the user's default library is both necessary and
        sufficient for visibility (the direct-entry contract). Create such an
        entry with no other provenance and confirm search returns it.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            default_lib_id = get_user_default_library(session, user_id)
            assert default_lib_id is not None

            media_id = uuid4()
            fragment_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'web_article', :title, 'ready_for_reading')
                """),
                {"id": media_id, "title": "Direct provenance glockenspiel article"},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:id, :media_id, 0, '<p>Content</p>', :text)
                """),
                {
                    "id": fragment_id,
                    "media_id": media_id,
                    "text": "Direct provenance glockenspiel fragment content",
                },
            )
            # A direct physical entry with no other provenance is the whole contract.
            seed_media_in_library(session, default_lib_id, media_id)
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=glockenspiel", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        all_ids = [r["id"] for r in data["results"]]
        assert str(media_id) in all_ids


class TestSearchScopeMasking:
    """Tests for scope authorization masking with typed 404s."""

    def test_scope_media_unauthorized_returns_not_found(self, auth_client):
        """Unauthorized media scope returns 404 E_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=media:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_library_unauthorized_returns_not_found(self, auth_client):
        """Unauthorized library scope returns 404 E_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=library:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_conversation_unauthorized_returns_conversation_not_found(self, auth_client):
        """Unauthorized conversation scope returns 404 E_CONVERSATION_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"


class TestSemanticTranscriptChunkSearch:
    """Semantic transcript search over shared content chunks."""

    def _use_openai_embedding_provider(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NEXUS_ENV", "local")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
        monkeypatch.setenv("ENABLE_OPENAI", "true")
        clear_settings_cache()

    def _seed_transcript_chunk_media(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        *,
        semantic_status: str,
        segments: list[TranscriptSegmentInput] | None = None,
    ) -> tuple[UUID, UUID]:
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        transcript_segments = segments or [
            TranscriptSegmentInput(
                segment_idx=0,
                t_start_ms=1000,
                t_end_ms=5000,
                canonical_text="transformer attention residual stream explanation",
                speaker_label=None,
            ),
            TranscriptSegmentInput(
                segment_idx=1,
                t_start_ms=5100,
                t_end_ms=9000,
                canonical_text="gardening tomatoes and compost aeration tips",
                speaker_label=None,
            ),
        ]

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        external_playback_url, provider, provider_id, created_by_user_id
                    )
                    VALUES (
                        :id, 'podcast_episode', 'Semantic Chunk Podcast Episode',
                        'https://feeds.example.com/semantic.xml', 'ready_for_reading',
                        'https://cdn.example.com/semantic.mp3', 'podcast_index',
                        'semantic-episode-1', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            seed_media_in_library(session, default_library_id, media_id)
            for segment_idx, segment in enumerate(transcript_segments):
                session.execute(
                    text(
                        """
                        INSERT INTO podcast_transcript_segments (
                            media_id,
                            segment_idx,
                            canonical_text,
                            t_start_ms,
                            t_end_ms,
                            speaker_label
                        )
                        VALUES (
                            :media_id,
                            :segment_idx,
                            :canonical_text,
                            :t_start_ms,
                            :t_end_ms,
                            :speaker_label
                        )
                        """
                    ),
                    {
                        "media_id": media_id,
                        "segment_idx": segment_idx,
                        "canonical_text": segment.canonical_text,
                        "t_start_ms": segment.t_start_ms,
                        "t_end_ms": segment.t_end_ms,
                        "speaker_label": segment.speaker_label,
                    },
                )
            session.execute(
                text(
                    """
                    INSERT INTO media_transcript_states (
                        media_id, transcript_state, transcript_coverage, semantic_status,
                        last_request_reason
                    )
                    VALUES (
                        :media_id, 'ready', 'full', :semantic_status,
                        'search'
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "semantic_status": semantic_status,
                },
            )
            rebuild_transcript_content_index(
                session,
                media_id=media_id,
                transcript_segments=transcript_segments,
                reason="test",
            )
            if semantic_status != "ready":
                session.execute(
                    text(
                        """
                        UPDATE content_index_states
                        SET active_embedding_provider = NULL,
                            active_embedding_model = NULL,
                            status = :semantic_status
                        WHERE owner_kind = 'media' AND owner_id = :media_id
                        """
                    ),
                    {"media_id": media_id, "semantic_status": semantic_status},
                )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        return user_id, media_id

    def test_semantic_search_returns_timestamped_transcript_chunks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results, "expected semantic content chunk results for ready semantic index"
        top = chunk_results[0]
        assert top["source"]["media_id"] == str(media_id)
        assert top["locator"]["type"] == "transcript_time_range"
        assert "transcript_version_id" not in top["locator"]
        assert top["locator"]["t_start_ms"] == 1000
        assert top["locator"]["t_end_ms"] == 5000
        assert "transformer" in top["snippet"].lower()

    def test_semantic_search_with_omitted_types_includes_content_chunks_by_default(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        response = auth_client.get(
            "/search?q=transformer+attention",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic search with omitted types to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results, "omitted types must include content chunks in all-types search"
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results)

    def test_semantic_search_excludes_content_chunks_when_index_not_ready(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="pending",
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic search request to succeed even while indexing, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results == [], "search must not return chunks while content index is pending"

    def test_lexical_search_excludes_content_chunks_when_index_not_ready(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="pending",
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected lexical search request to succeed even while indexing, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results == [], "lexical search must not return chunks while index is pending"

    def test_lexical_search_excludes_content_chunks_when_current_index_failed(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        with direct_db.session() as session:
            mark_content_index_failed(
                session,
                owner=IndexOwner("media", media_id),
                failure_code="E_INGEST_FAILED",
                failure_message="replacement indexing failed",
            )
            state = session.execute(
                text(
                    """
                    SELECT
                        status,
                        active_embedding_provider,
                        active_embedding_model
                    FROM content_index_states
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
            session.commit()
        assert state[0] == "failed"
        assert state[1] is None
        assert state[2] is None

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected lexical search to succeed while current index is failed, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert all(row["source"]["media_id"] != str(media_id) for row in chunk_results)

    @respx.mock
    def test_semantic_search_transient_embedding_provider_failure_falls_back_to_lexical(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """A transient provider failure (exhausted retries) is operational
        resilience, not a search error (spec §5.5, search-intent-model hard
        cutover): it degrades to lexical-only, typed and logged, and the
        request still succeeds."""
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        self._use_openai_embedding_provider(monkeypatch)
        respx.post(OPENAI_EMBEDDINGS_URL).respond(
            500,
            json={"error": {"message": "provider unavailable"}},
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results), (
            "a transient query-embedding provider failure should fall back to lexical search"
        )

    @respx.mock
    def test_semantic_search_malformed_embedding_response_reports_search_failure(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """A malformed (wrong-dimension) embedding response is a hard provider
        error, distinct from provider-unavailable: it is not operationally
        resilient to silently retry or downgrade, so it surfaces as a search
        failure."""
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        self._use_openai_embedding_provider(monkeypatch)
        respx.post(OPENAI_EMBEDDINGS_URL).respond(
            200,
            json={"data": [{"index": 0, "embedding": [0.1]}]},
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 500, (
            f"expected malformed embedding response to surface as a search failure, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_APP_SEARCH_FAILED"

    def test_semantic_search_missing_embedding_credential_is_a_defect_not_a_product_failure(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """A missing platform embedding key is an operator misconfiguration,
        not a user-facing state (platform keys are validated at startup in
        staging/prod): it raises ``RuntimeDefect`` unwrapped rather than
        degrading to lexical search, and the request fails loudly with
        E_INTERNAL instead of silently downgrading result quality."""
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        def missing_key(_text: str) -> tuple[str, list[float]]:
            raise RuntimeDefect(
                origin="provider_http",
                code="credential_missing",
                message="No platform API key configured for provider=openai",
            )

        monkeypatch.setattr("nexus.services.search.embedding.build_text_embedding", missing_key)
        no_raise_client = TestClient(auth_client.app, raise_server_exceptions=False)
        response = no_raise_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 500, response.text
        assert response.json()["error"]["code"] == "E_INTERNAL"

    @respx.mock
    def test_default_semantic_search_builds_one_query_embedding(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        self._use_openai_embedding_provider(monkeypatch)
        route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
            200,
            json={"data": [{"index": 0, "embedding": [0.1] * 256}]},
        )

        response = auth_client.get(
            "/search?q=transformer+attention",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"expected default semantic search to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        assert route.call_count == 1

    @respx.mock
    def test_structured_filter_does_not_bypass_query_embedding(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """AC-6/G4/D-5: hybrid is an invariant — a structured filter never downgrades a
        semantic-capable kind to lexical-only. The query embedding (the ANN arm) is built
        for the identical query both with and without a filter."""
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        self._use_openai_embedding_provider(monkeypatch)
        route = respx.post(OPENAI_EMBEDDINGS_URL).respond(
            200,
            json={"data": [{"index": 0, "embedding": [0.1] * 256}]},
        )

        bare = auth_client.get("/search?q=transformer+attention", headers=auth_headers(user_id))
        assert bare.status_code == 200, bare.text
        assert route.call_count == 1

        # A media-format filter keeps Documents (content_chunk) in scope, so the embedding
        # must still be built — proving the filter did not bypass the ANN arm.
        filtered = auth_client.get(
            "/search?q=transformer+attention&formats=pdf", headers=auth_headers(user_id)
        )
        assert filtered.status_code == 200, filtered.text
        assert route.call_count == 2

    def test_default_semantic_search_filters_unrelated_content_chunks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        response = auth_client.get(
            "/search?q=astronomy+nebula&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"expected default semantic search to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["results"] == []

    def test_semantic_search_supports_single_token_content_chunk_queries(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        _model, vector = build_text_embedding("xyznonexistent12345")
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE content_embeddings ce
                    SET embedding_vector = CAST(:embedding AS vector(256))
                    FROM content_chunks cc
                    WHERE cc.id = ce.chunk_id
                      AND cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    """
                ),
                {"media_id": media_id, "embedding": to_pgvector_literal(vector)},
            )
            session.commit()

        response = auth_client.get(
            "/search?q=xyznonexistent12345&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"expected single-token semantic search to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        assert any(
            row["source"]["media_id"] == str(media_id) for row in response.json()["results"]
        ), "single-token semantic search should use vector relevance when lexical search has no hit"

    def test_semantic_search_ignores_embeddings_from_different_active_model(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )
        _model, vector = build_text_embedding("xyznonexistent12345")
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE content_index_states
                    SET active_embedding_model = 'other_model'
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            session.execute(
                text(
                    """
                    UPDATE content_embeddings ce
                    SET embedding_model = 'other_model',
                        embedding_vector = CAST(:embedding AS vector)
                    FROM content_chunks cc
                    WHERE ce.chunk_id = cc.id
                      AND cc.owner_kind = 'media' AND cc.owner_id = :media_id
                    """
                ),
                {"media_id": media_id, "embedding": to_pgvector_literal(vector)},
            )
            session.commit()

        response = auth_client.get(
            "/search?q=xyznonexistent12345&kinds=documents",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        assert response.json()["results"] == []

    def test_semantic_search_scans_corpus_not_just_newest_chunks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
            segments=[
                TranscriptSegmentInput(
                    segment_idx=0,
                    t_start_ms=1000,
                    t_end_ms=5000,
                    canonical_text="transformer attention residual stream explanation",
                    speaker_label=None,
                ),
                *[
                    TranscriptSegmentInput(
                        segment_idx=offset + 1,
                        t_start_ms=20_000 + (offset * 1000),
                        t_end_ms=20_900 + (offset * 1000),
                        canonical_text=f"irrelevant gardening chunk {offset}",
                        speaker_label=None,
                    )
                    for offset in range(120)
                ],
            ],
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results, "semantic retrieval must find relevant chunks in a larger corpus"
        assert any("transformer" in result["snippet"].lower() for result in chunk_results)
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results)

    def test_semantic_search_finds_relevant_chunk_after_large_irrelevant_prefix(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
            segments=[
                *[
                    TranscriptSegmentInput(
                        segment_idx=offset,
                        t_start_ms=1000 + (offset * 1000),
                        t_end_ms=1900 + (offset * 1000),
                        canonical_text=f"irrelevant corpus filler chunk {offset}",
                        speaker_label=None,
                    )
                    for offset in range(30)
                ],
                TranscriptSegmentInput(
                    segment_idx=999,
                    t_start_ms=61000,
                    t_end_ms=66000,
                    canonical_text="transformer attention residual stream explanation",
                    speaker_label=None,
                ),
            ],
        )

        response = auth_client.get(
            "/search?q=transformer+attention&kinds=documents",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert any(
            "transformer" in row["snippet"].lower() and "attention" in row["snippet"].lower()
            for row in chunk_results
        ), "semantic retrieval must not miss relevant chunks after irrelevant transcript rows"


class TestSearchTranscriptNavigation:
    def test_note_block_search_uses_note_activation_when_linked_highlight_targets_transcript(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        old_fragment_id = uuid4()
        active_fragment_id = uuid4()
        highlight_id = uuid4()
        page_id = uuid4()
        note_block_id = uuid4()
        now_ts = "2026-03-10T10:00:00Z"

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        external_playback_url,
                        provider,
                        provider_id,
                        created_by_user_id
                    )
                    VALUES (
                        :id,
                        'podcast_episode',
                        'Transcript Navigation Episode',
                        'https://feeds.example.com/transcript-nav.xml',
                        'ready_for_reading',
                        'https://cdn.example.com/transcript-nav.mp3',
                        'podcast_index',
                        'transcript-nav-episode-1',
                        :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            seed_media_in_library(session, default_library_id, media_id)
            session.execute(
                text(
                    """
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status,
                        last_request_reason
                    )
                    VALUES (
                        :media_id,
                        'ready',
                        'full',
                        'ready',
                        'operator_requeue'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text,
                        t_start_ms,
                        t_end_ms,
                        created_at
                    )
                    VALUES
                        (
                            :old_fragment_id,
                            :media_id,
                            1000000,
                            '<p>old transcript segment</p>',
                            'old transcript segment',
                            0,
                            1000,
                            :now_ts
                        ),
                        (
                            :active_fragment_id,
                            :media_id,
                            0,
                            '<p>active transcript segment</p>',
                            'active transcript segment',
                            80,
                            1080,
                            :now_ts
                        )
                    """
                ),
                {
                    "old_fragment_id": old_fragment_id,
                    "active_fragment_id": active_fragment_id,
                    "media_id": media_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO highlights (
                        id,
                        user_id,
                        anchor_kind,
                        anchor_media_id,
                        color,
                        exact,
                        prefix,
                        suffix,
                        created_at
                    )
                    VALUES (
                        :highlight_id,
                        :user_id,
                        'fragment_offsets',
                        :media_id,
                        'yellow',
                        'active',
                        'before',
                        'after',
                        :now_ts
                    )
                    """
                ),
                {
                    "highlight_id": highlight_id,
                    "user_id": user_id,
                    "media_id": media_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO highlight_fragment_anchors (
                        highlight_id,
                        fragment_id,
                        start_offset,
                        end_offset
                    )
                    VALUES (
                        :highlight_id,
                        :fragment_id,
                        0,
                        6
                    )
                    """
                ),
                {
                    "highlight_id": highlight_id,
                    "fragment_id": old_fragment_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO pages (id, user_id, title)
                    VALUES (:page_id, :user_id, 'Transcript Navigation Notes')
                    """
                ),
                {"page_id": page_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO note_blocks (
                        id,
                        user_id,
                        body_pm_json,
                        body_text,
                        created_at
                    )
                    VALUES (
                        :note_block_id,
                        :user_id,
                        jsonb_build_object(
                            'type',
                            'paragraph',
                            'content',
                            jsonb_build_array(
                                jsonb_build_object(
                                    'type',
                                    'text',
                                    'text',
                                    'anchor remap needle body text'
                                )
                            )
                        ),
                        'anchor remap needle body text',
                        :now_ts
                    )
                    """
                ),
                {
                    "note_block_id": note_block_id,
                    "user_id": user_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id,
                        kind,
                        origin,
                        source_scheme,
                        source_id,
                        target_scheme,
                        target_id,
                        source_order_key,
                        created_at
                    )
                    VALUES (
                        :user_id,
                        'context',
                        'user',
                        'page',
                        :page_id,
                        'note_block',
                        :note_block_id,
                        '0000000001',
                        :now_ts
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "page_id": page_id,
                    "note_block_id": note_block_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id,
                        kind,
                        origin,
                        source_scheme,
                        source_id,
                        target_scheme,
                        target_id,
                        created_at
                    )
                    VALUES (
                        :user_id,
                        'context',
                        'highlight_note',
                        'highlight',
                        :highlight_id,
                        'note_block',
                        :note_block_id,
                        :now_ts
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "note_block_id": note_block_id,
                    "highlight_id": highlight_id,
                    "now_ts": now_ts,
                },
            )
            rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")
            session.commit()

        direct_db.register_cleanup("pages", "id", page_id)
        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("resource_edges", "source_id", note_block_id)
        direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "id", old_fragment_id)
        direct_db.register_cleanup("fragments", "id", active_fragment_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=anchor+remap+needle&kinds=notes",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected note search to succeed, got {response.status_code}: {response.text}"
        )
        note_block_rows = [row for row in response.json()["results"] if row["type"] == "note_block"]
        assert note_block_rows, "expected note-block search row"
        assert note_block_rows[0]["id"] == str(note_block_id)
        assert note_block_rows[0]["activation"]["href"] == f"/notes/{note_block_id}"
        assert "deep_link" not in note_block_rows[0]
