"""Integration tests for keyword search service and routes.

Tests cover:
- Basic search functionality across all types
- Visibility enforcement (s4 provenance for media, note ownership,
  canonical conversation visibility for messages)
- Scope filtering (all, media, library, conversation)
- Type filtering
- Pagination
- Short/empty query handling
- Pending messages never searchable
- Invalid cursor handling
- No visibility leakage
- Note-block ownership and library revocation behavior
- S4 library-scope message search
- S4 conversation scope with shared-read visibility
- S4 media provenance (stale default-library rows)
- Response shape preservation
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text

from nexus.db.models import Fragment, ObjectSearchDocument, Page
from nexus.schemas.notes import CreatePageRequest
from nexus.services import notes, object_search
from nexus.services.content_indexing import (
    mark_content_index_failed,
    rebuild_fragment_content_index,
    rebuild_transcript_content_index,
)
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.semantic_chunks import build_text_embedding, to_pgvector_literal
from tests.factories import (
    add_library_member,
    create_searchable_media,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_highlight_note,
    create_test_library,
    create_test_message,
    get_user_default_library,
    share_conversation_to_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


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
                artifact_ref="test://epub-search-contract",
                fragments=[fragment],
                reason="test",
            )
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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)

        fragment_response = auth_client.get(
            "/search?q=unique+epub+fragment+needle&types=content_chunk",
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
        assert epub_fragment_row["deep_link"].startswith(f"/media/{media_id}")

        note_block_response = auth_client.get(
            "/search?q=unique+epub+note+needle&types=note_block",
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
        assert epub_note_block_row["deep_link"] == f"/notes/{note_block_id}"

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

        direct_db.register_cleanup("default_library_intrinsics", "media_id", unavailable_video_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", unavailable_podcast_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", ready_video_id)
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
                session.execute(
                    text("""
                        INSERT INTO library_entries (library_id, media_id)
                        VALUES (:library_id, :media_id)
                    """),
                    {"library_id": default_library_id, "media_id": media_id},
                )
                session.execute(
                    text("""
                        INSERT INTO default_library_intrinsics (default_library_id, media_id)
                        VALUES (:default_library_id, :media_id)
                    """),
                    {"default_library_id": default_library_id, "media_id": media_id},
                )

            session.commit()

        response = auth_client.get(
            "/search?q=needle+transcript&types=media", headers=auth_headers(user_id)
        )
        assert response.status_code == 200, (
            f"expected media search to succeed, got {response.status_code}: {response.text}"
        )
        result_ids = {row["id"] for row in response.json()["results"] if row["type"] == "media"}

        assert str(ready_video_id) in result_ids
        assert str(unavailable_video_id) in result_ids
        assert str(unavailable_podcast_id) in result_ids

    def test_fragment_search_excludes_transcript_media_marked_unavailable(
        self, auth_client, direct_db
    ):
        """Transcript fragment search respects canonical transcript state, not media failure residue."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        fragment_id = uuid4()

        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
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
            session.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id)
                    VALUES (:library_id, :media_id)
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:default_library_id, :media_id)
                """),
                {"default_library_id": default_library_id, "media_id": media_id},
            )
            session.commit()

        response = auth_client.get(
            "/search?q=needle+transcript+fragment&types=content_chunk",
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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=note+databases", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        note_block_results = [r for r in data["results"] if r["type"] == "note_block"]
        assert len(note_block_results) >= 1

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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
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
            session.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id)
                    VALUES (:library_id, :media_id)
                    ON CONFLICT DO NOTHING
                """),
                {"library_id": library_id, "media_id": media_id},
            )
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


# =============================================================================
# Type Filtering Tests
# =============================================================================


class TestSearchTypeFiltering:
    """Tests for search type filtering."""

    def test_type_filter_media_only(self, auth_client, direct_db: DirectSessionManager):
        """Type filter returns only specified types."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session, user_id, title="Python Programming Tutorial"
            )

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=python&types=media", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        # All results should be media type
        for result in data["results"]:
            assert result["type"] == "media"

    def test_type_filter_multiple_types(self, auth_client, direct_db: DirectSessionManager):
        """Multiple types filter works correctly."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Content Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=test&types=media,content_chunk", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Results should be media or fragment only
        for result in data["results"]:
            assert result["type"] in ("media", "content_chunk")

    def test_invalid_types_return_invalid_request(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Unknown type values fail fast instead of being ignored."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=test&types=media,invalid_type,content_chunk", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_only_invalid_types_return_invalid_request(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Reject a type filter made only of unsupported values."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Unknown Type Control")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=unknown+type+control&types=totally_invalid",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_type_filter_empty_returns_no_results(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Explicit empty type filter should return no results (not fallback-to-all)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session, user_id, title="Empty Type Filter Needle Title"
            )

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=empty+type+filter+needle&types=",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected 200 for explicit empty types filter, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["results"] == [], (
            "Expected no results when explicit empty types filter is provided; "
            f"got {len(data['results'])} results: {data['results']}"
        )


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
            "/search?q=unique+title&types=media", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = data["results"][0]
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
        assert result["deep_link"] == f"/media/{media_id}"
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
            replace_media_contributor_credits(
                session,
                media_id=media_id,
                credits=[{"name": "Wire Contract Author", "role": "author", "source": "test"}],
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("contributor_credits", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=contributor+wire+contract&types=media",
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
            "/search?q=canonical+text&types=content_chunk", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()

        if len(data["results"]) >= 1:
            result = data["results"][0]
            assert result["type"] == "content_chunk"
            assert "source" in result
            assert result["source"]["media_id"] == str(media_id)
            assert result["source"]["media_kind"] == "web_article"
            assert result["media_id"] == str(media_id)
            assert result["media_kind"] == "web_article"
            assert result["deep_link"].startswith(f"/media/{media_id}?")
            assert result["citation_label"] == "Source"
            assert result["resolver"]["kind"] == "web"
            assert result["resolver"]["route"] == f"/media/{media_id}"
            assert result["resolver"]["params"]["evidence"] == result["evidence_span_ids"][0]
            assert result["resolver"]["params"]["fragment"]
            assert result["resolver"]["highlight"]["kind"] == "web_text"
            assert result["context_ref"] == {
                "type": "content_chunk",
                "id": result["id"],
                "evidence_span_ids": result["evidence_span_ids"],
            }
            assert "idx" not in result

    def test_content_chunk_search_skips_primary_span_from_other_index_run(
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
                    WHERE cc.media_id = :media_id
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
                artifact_ref=f"fragments:{fragment.id}:stale-search",
                fragments=[fragment],
                reason="test_stale_search",
            )
            active_chunk_id = session.execute(
                text(
                    """
                    SELECT cc.id
                    FROM content_chunks cc
                    JOIN media_content_index_states mcis
                      ON mcis.media_id = cc.media_id
                     AND mcis.active_run_id = cc.index_run_id
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()
            session.execute(
                text(
                    """
                    UPDATE content_chunks
                    SET primary_evidence_span_id = :old_span_id
                    WHERE id = :active_chunk_id
                    """
                ),
                {"active_chunk_id": active_chunk_id, "old_span_id": old_span_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=stale+run+search&types=content_chunk",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected stale primary span to be skipped, got "
            f"{response.status_code}: {response.text}"
        )
        result_ids = {row["id"] for row in response.json()["results"]}
        assert str(active_chunk_id) not in result_ids

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
                    WHERE cc.media_id = :media_id
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
            "/search?q=unique+searchable+message&types=message", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = data["results"][0]
        assert result["type"] == "message"
        assert "conversation_id" in result
        assert "seq" in result
        assert result["deep_link"] == f"/conversations/{conversation_id}"
        assert result["context_ref"] == {"type": "message", "id": str(message_id)}

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

    def test_note_block_results_use_note_contract(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Note-block search returns the hard-cutover note result contract."""
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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=harmonica&types=note_block",
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
        assert result["page_title"] == "Notes"
        assert result["body_text"] == note_body
        assert result["deep_link"] == f"/notes/{note_block_id}"
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
                    INSERT INTO pages (id, user_id, title, description)
                    VALUES (:page_id, :user_id, 'Garden Planning', 'Unique trellis page term')
                """),
                {"page_id": page_id, "user_id": user_id},
            )
            page = session.get(Page, page_id)
            assert page is not None
            object_search.project_page(session, user_id, page)
            session.commit()

        direct_db.register_cleanup("pages", "id", page_id)

        response = auth_client.get(
            "/search?q=trellis&types=page",
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
        assert result["description"] == "Unique trellis page term"
        assert result["deep_link"] == f"/pages/{page_id}"
        assert result["context_ref"] == {"type": "page", "id": str(page_id)}
        assert "body_text" not in result

    def test_page_semantic_search_uses_object_search_embeddings(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("pages", "user_id", user_id)
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            page = notes.create_page(
                session,
                user_id,
                CreatePageRequest(title="Vector Only Page", description="ordinary garden notes"),
            )
            assert object_search.rebuild_missing_embeddings(session, user_id) == 1
            assert object_search.rebuild_missing_embeddings(session, user_id) == 0
            document_id = session.scalar(
                select(ObjectSearchDocument.id).where(
                    ObjectSearchDocument.user_id == user_id,
                    ObjectSearchDocument.object_type == "page",
                    ObjectSearchDocument.object_id == page.id,
                )
            )
            assert document_id is not None
            _model, vector = build_text_embedding("semanticneedle")
            session.execute(
                text(
                    """
                    UPDATE object_search_embeddings
                    SET embedding = CAST(:embedding AS vector(256))
                    WHERE search_document_id = :document_id
                    """
                ),
                {
                    "document_id": document_id,
                    "embedding": to_pgvector_literal(vector),
                },
            )
            session.commit()

        lexical_response = auth_client.get(
            "/search?q=semanticneedle&types=page&semantic=false",
            headers=auth_headers(user_id),
        )
        assert lexical_response.status_code == 200, lexical_response.text
        assert lexical_response.json()["results"] == []

        semantic_response = auth_client.get(
            "/search?q=semanticneedle&types=page&semantic=true",
            headers=auth_headers(user_id),
        )
        assert semantic_response.status_code == 200, semantic_response.text
        result_ids = {row["id"] for row in semantic_response.json()["results"]}
        assert str(page.id) in result_ids

        default_response = auth_client.get(
            "/search?q=semanticneedle&types=page",
            headers=auth_headers(user_id),
        )
        assert default_response.status_code == 200, default_response.text
        default_result_ids = {row["id"] for row in default_response.json()["results"]}
        assert str(page.id) in default_result_ids


# =============================================================================
# S4 Search Alignment Tests
# =============================================================================


class TestSearchS4ConversationScope:
    """Tests for s4 conversation scope using shared-read visibility."""

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
            f"/search?q=scope+alignment+content&scope=conversation:{conversation_id}&types=message",
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
        """Conversation scope includes media linked through conversation_media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            media_id = create_searchable_media(
                session,
                user_id,
                title="Conversation Scoped Media Needle",
            )
            session.execute(
                text(
                    """
                    INSERT INTO conversation_media (conversation_id, media_id)
                    VALUES (:conversation_id, :media_id)
                    """
                ),
                {"conversation_id": conversation_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/search?q=scoped+media+needle&scope=conversation:{conversation_id}&types=media",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert any(r["id"] == str(media_id) for r in media_results)

    def test_scope_conversation_searches_notes_attached_as_message_context(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        page_id = uuid4()
        context_note_id = uuid4()
        link_note_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            message_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="message with attached notes",
            )
            session.execute(
                text("""
                    INSERT INTO pages (id, user_id, title)
                    VALUES (:page_id, :user_id, 'Conversation Context Notes')
                """),
                {"page_id": page_id, "user_id": user_id},
            )
            for note_id, order_key, body_text in (
                (
                    context_note_id,
                    "0000000001",
                    "message context item note block piccolo needle",
                ),
                (
                    link_note_id,
                    "0000000002",
                    "canonical object link note block piccolo needle",
                ),
            ):
                session.execute(
                    text("""
                        INSERT INTO note_blocks (
                            id, user_id, page_id, order_key, block_kind,
                            body_pm_json, body_markdown, body_text, collapsed
                        )
                        VALUES (
                            :note_id, :user_id, :page_id, :order_key, 'bullet',
                            jsonb_build_object('type', 'paragraph'),
                            :body_text, :body_text, false
                        )
                    """),
                    {
                        "note_id": note_id,
                        "user_id": user_id,
                        "page_id": page_id,
                        "order_key": order_key,
                        "body_text": body_text,
                    },
                )
            session.execute(
                text("""
                    INSERT INTO message_context_items (
                        message_id, user_id, object_type, object_id, ordinal, context_snapshot
                    )
                    VALUES (
                        :message_id, :user_id, 'note_block', :note_block_id, 0, '{}'::jsonb
                    )
                """),
                {
                    "message_id": message_id,
                    "user_id": user_id,
                    "note_block_id": context_note_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO object_links (
                        user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                    )
                    VALUES (
                        :user_id, 'used_as_context', 'message', :message_id,
                        'note_block', :note_block_id, '{}'::jsonb
                    )
                """),
                {
                    "user_id": user_id,
                    "message_id": message_id,
                    "note_block_id": link_note_id,
                },
            )
            page = session.get(Page, page_id)
            assert page is not None
            object_search.project_page(session, user_id, page)
            session.commit()

        direct_db.register_cleanup("message_context_items", "message_id", message_id)
        direct_db.register_cleanup("object_links", "a_id", message_id)
        direct_db.register_cleanup("note_blocks", "id", context_note_id)
        direct_db.register_cleanup("note_blocks", "id", link_note_id)
        direct_db.register_cleanup("pages", "id", page_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/search?q=piccolo+needle&scope=conversation:{conversation_id}&types=note_block",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        note_ids = {row["id"] for row in response.json()["results"] if row["type"] == "note_block"}
        assert note_ids == {str(context_note_id), str(link_note_id)}


class TestSearchNoteBlockOwnership:
    """Tests for note-block search ownership after the hard cutover."""

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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            "/search?q=xylophone&types=note_block", headers=auth_headers(user_b)
        )

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
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # The note is not visible even before revocation because notes are user-owned.
        resp_before = auth_client.get(
            "/search?q=trombone&types=note_block", headers=auth_headers(user_b)
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
        resp_after = auth_client.get(
            "/search?q=trombone&types=note_block", headers=auth_headers(user_b)
        )
        assert resp_after.status_code == 200
        after_ids = [r["id"] for r in resp_after.json()["results"]]
        assert str(note_block_id) not in after_ids


class TestSearchS4LibraryScopeMessages:
    """Tests for s4 library-scope message search."""

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
            f"/search?q=xylophonist&scope=library:{l1}&types=message",
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
            f"/search?q=xylophone&scope=library:{l1}&types=message",
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
            f"/search?q=xylophone&scope=library:{l1}&types=message",
            headers=auth_headers(user_a),
        )

        assert response.status_code == 200
        data = response.json()
        msg_ids = [r["id"] for r in data["results"] if r["type"] == "message"]
        assert str(msg_id) not in msg_ids


class TestSearchS4ResponseShape:
    """Tests for response shape preservation."""

    def test_search_response_shape_remains_results_page(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Response has top-level 'results' and 'page', no envelope migration."""
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


class TestSearchS4Provenance:
    """Tests for s4 media provenance in search visibility."""

    def test_search_does_not_return_stale_default_library_rows_without_intrinsic_or_closure(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Stale default library_entries without intrinsic or closure is not searchable.

        Create a library_entries row for the user's default library without any
        intrinsic or closure-edge provenance. Search must not return it.
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
                {"id": media_id, "title": "Stale provenance glockenspiel article"},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:id, :media_id, 0, '<p>Content</p>', :text)
                """),
                {
                    "id": fragment_id,
                    "media_id": media_id,
                    "text": "Stale provenance glockenspiel fragment content",
                },
            )
            # Insert library_entries WITHOUT intrinsic or closure (stale row)
            session.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id)
                    VALUES (:lib_id, :media_id)
                """),
                {"lib_id": default_lib_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=glockenspiel", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        all_ids = [r["id"] for r in data["results"]]
        assert str(media_id) not in all_ids
        fragment_ids = [r["id"] for r in data["results"] if r["type"] == "content_chunk"]
        assert str(fragment_id) not in fragment_ids


class TestSearchS4ScopeMasking:
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

    def _seed_transcript_chunk_media(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        *,
        semantic_status: str,
        segments: list[dict[str, object]] | None = None,
    ) -> tuple[UUID, UUID]:
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        version_id = uuid4()
        transcript_segments = segments or [
            {
                "segment_idx": 0,
                "text": "transformer attention residual stream explanation",
                "t_start_ms": 1000,
                "t_end_ms": 5000,
            },
            {
                "segment_idx": 1,
                "text": "gardening tomatoes and compost aeration tips",
                "t_start_ms": 5100,
                "t_end_ms": 9000,
            },
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
            session.execute(
                text(
                    """
                    INSERT INTO library_entries (library_id, media_id)
                    VALUES (:library_id, :media_id)
                    """
                ),
                {"library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:default_library_id, :media_id)
                    """
                ),
                {"default_library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_transcript_versions (
                        id, media_id, version_no, transcript_coverage,
                        is_active, created_by_user_id
                    )
                    VALUES (:id, :media_id, 1, 'full', true, :created_by_user_id)
                    """
                ),
                {"id": version_id, "media_id": media_id, "created_by_user_id": user_id},
            )
            for segment_idx, segment in enumerate(transcript_segments):
                session.execute(
                    text(
                        """
                        INSERT INTO podcast_transcript_segments (
                            transcript_version_id,
                            media_id,
                            segment_idx,
                            canonical_text,
                            t_start_ms,
                            t_end_ms,
                            speaker_label
                        )
                        VALUES (
                            :transcript_version_id,
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
                        "transcript_version_id": version_id,
                        "media_id": media_id,
                        "segment_idx": segment_idx,
                        "canonical_text": segment["text"],
                        "t_start_ms": segment["t_start_ms"],
                        "t_end_ms": segment["t_end_ms"],
                        "speaker_label": segment.get("speaker_label"),
                    },
                )
            session.execute(
                text(
                    """
                    INSERT INTO media_transcript_states (
                        media_id, transcript_state, transcript_coverage, semantic_status,
                        active_transcript_version_id, last_request_reason
                    )
                    VALUES (
                        :media_id, 'ready', 'full', :semantic_status,
                        :active_transcript_version_id, 'search'
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "semantic_status": semantic_status,
                    "active_transcript_version_id": version_id,
                },
            )
            rebuild_transcript_content_index(
                session,
                media_id=media_id,
                transcript_version_id=version_id,
                transcript_segments=transcript_segments,
                reason="test",
            )
            if semantic_status != "ready":
                session.execute(
                    text(
                        """
                        UPDATE media_content_index_states
                        SET active_run_id = NULL,
                            active_embedding_provider = NULL,
                            active_embedding_model = NULL,
                            active_embedding_version = NULL,
                            active_embedding_config_hash = NULL,
                            status = :semantic_status
                        WHERE media_id = :media_id
                        """
                    ),
                    {"media_id": media_id, "semantic_status": semantic_status},
                )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_transcript_versions", "media_id", media_id)
        direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
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
            "/search?q=transformer+attention&types=content_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results, "expected semantic content chunk results for ready semantic index"
        top = chunk_results[0]
        assert top["source"]["media_id"] == str(media_id)
        assert top["resolver"]["highlight"]["t_start_ms"] == 1000
        assert top["resolver"]["highlight"]["t_end_ms"] == 5000
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
            "/search?q=transformer+attention&semantic=true",
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
            "/search?q=transformer+attention&types=content_chunk&semantic=true",
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
            "/search?q=transformer+attention&types=content_chunk",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected lexical search request to succeed even while indexing, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert chunk_results == [], "lexical search must not return chunks while index is pending"

    def test_lexical_search_uses_prior_active_ready_run_when_latest_index_failed(
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
                media_id=media_id,
                failure_code="E_INGEST_FAILED",
                failure_message="replacement indexing failed",
            )
            state = session.execute(
                text(
                    """
                    SELECT
                        status,
                        active_run_id,
                        active_embedding_provider,
                        active_embedding_model,
                        active_embedding_version,
                        active_embedding_config_hash
                    FROM media_content_index_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
            session.commit()
        assert state[0] == "ready"
        assert state[1] is not None
        assert state[2] is not None
        assert state[3] is not None
        assert state[4] is not None
        assert state[5] is not None

        response = auth_client.get(
            "/search?q=transformer+attention&types=content_chunk",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected lexical search to use active ready run after latest failure, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results), (
            "content chunk search must gate on the active ready run, not the latest state status"
        )

    @pytest.mark.parametrize("embedding_mode", ["raises", "wrong_dimensions"])
    def test_semantic_search_falls_back_to_lexical_when_query_embedding_unusable(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch: pytest.MonkeyPatch,
        embedding_mode: str,
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        def fail_embedding(_text: str) -> tuple[str, list[float]]:
            raise RuntimeError("test embedding failure")

        def wrong_dimension_embedding(_text: str) -> tuple[str, list[float]]:
            return ("test_wrong_dimensions", [0.1])

        monkeypatch.setattr(
            "nexus.services.search.build_text_embedding",
            fail_embedding if embedding_mode == "raises" else wrong_dimension_embedding,
        )

        response = auth_client.get(
            "/search?q=transformer+attention&types=content_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic search to fall back to lexical, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "content_chunk"]
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results)
        assert any("transformer" in row["snippet"].lower() for row in chunk_results)

    def test_semantic_search_scans_corpus_not_just_newest_chunks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
            segments=[
                {
                    "segment_idx": 0,
                    "text": "transformer attention residual stream explanation",
                    "t_start_ms": 1000,
                    "t_end_ms": 5000,
                },
                *[
                    {
                        "segment_idx": offset + 1,
                        "text": f"irrelevant gardening chunk {offset}",
                        "t_start_ms": 20_000 + (offset * 1000),
                        "t_end_ms": 20_900 + (offset * 1000),
                    }
                    for offset in range(120)
                ],
            ],
        )

        response = auth_client.get(
            "/search?q=transformer+attention&types=content_chunk&semantic=true",
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
                    {
                        "segment_idx": offset,
                        "text": f"irrelevant corpus filler chunk {offset}",
                        "t_start_ms": 1000 + (offset * 1000),
                        "t_end_ms": 1900 + (offset * 1000),
                    }
                    for offset in range(30)
                ],
                {
                    "segment_idx": 999,
                    "text": "transformer attention residual stream explanation",
                    "t_start_ms": 61000,
                    "t_end_ms": 66000,
                },
            ],
        )

        response = auth_client.get(
            "/search?q=transformer+attention&types=content_chunk&semantic=true",
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


class TestSearchTranscriptVersionNavigation:
    def test_note_block_search_uses_note_deep_link_when_linked_highlight_targets_old_version(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        version_v1 = uuid4()
        version_v2 = uuid4()
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
                        'Version Navigation Episode',
                        'https://feeds.example.com/version-nav.xml',
                        'ready_for_reading',
                        'https://cdn.example.com/version-nav.mp3',
                        'podcast_index',
                        'version-nav-episode-1',
                        :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO library_entries (library_id, media_id)
                    VALUES (:library_id, :media_id)
                    """
                ),
                {"library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:default_library_id, :media_id)
                    """
                ),
                {"default_library_id": default_library_id, "media_id": media_id},
            )

            session.execute(
                text(
                    """
                    INSERT INTO podcast_transcript_versions (
                        id,
                        media_id,
                        version_no,
                        transcript_coverage,
                        is_active,
                        request_reason,
                        created_by_user_id,
                        created_at,
                        updated_at
                    )
                    VALUES
                        (
                            :version_v1,
                            :media_id,
                            1,
                            'full',
                            false,
                            'episode_open',
                            :user_id,
                            :now_ts,
                            :now_ts
                        ),
                        (
                            :version_v2,
                            :media_id,
                            2,
                            'full',
                            true,
                            'operator_requeue',
                            :user_id,
                            :now_ts,
                            :now_ts
                        )
                    """
                ),
                {
                    "version_v1": version_v1,
                    "version_v2": version_v2,
                    "media_id": media_id,
                    "user_id": user_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status,
                        active_transcript_version_id,
                        last_request_reason
                    )
                    VALUES (
                        :media_id,
                        'ready',
                        'full',
                        'ready',
                        :active_version_id,
                        'operator_requeue'
                    )
                    """
                ),
                {"media_id": media_id, "active_version_id": version_v2},
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
                        transcript_version_id,
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
                            :version_v1,
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
                            :version_v2,
                            :now_ts
                        )
                    """
                ),
                {
                    "old_fragment_id": old_fragment_id,
                    "active_fragment_id": active_fragment_id,
                    "media_id": media_id,
                    "version_v1": version_v1,
                    "version_v2": version_v2,
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
                    VALUES (:page_id, :user_id, 'Version Navigation Notes')
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
                        page_id,
                        order_key,
                        block_kind,
                        body_pm_json,
                        body_markdown,
                        body_text,
                        collapsed,
                        created_at
                    )
                    VALUES (
                        :note_block_id,
                        :user_id,
                        :page_id,
                        '0000000001',
                        'bullet',
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
                        'anchor remap needle body text',
                        false,
                        :now_ts
                    )
                    """
                ),
                {
                    "note_block_id": note_block_id,
                    "user_id": user_id,
                    "page_id": page_id,
                    "now_ts": now_ts,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO object_links (
                        user_id,
                        relation_type,
                        a_type,
                        a_id,
                        b_type,
                        b_id,
                        metadata,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :user_id,
                        'note_about',
                        'note_block',
                        :note_block_id,
                        'highlight',
                        :highlight_id,
                        '{}'::jsonb,
                        :now_ts,
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
            page = session.get(Page, page_id)
            assert page is not None
            object_search.project_page(session, user_id, page)
            session.commit()

        direct_db.register_cleanup("pages", "id", page_id)
        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("object_links", "a_id", note_block_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "id", old_fragment_id)
        direct_db.register_cleanup("fragments", "id", active_fragment_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("podcast_transcript_versions", "id", version_v1)
        direct_db.register_cleanup("podcast_transcript_versions", "id", version_v2)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=anchor+remap+needle&types=note_block",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected note search to succeed, got {response.status_code}: {response.text}"
        )
        note_block_rows = [row for row in response.json()["results"] if row["type"] == "note_block"]
        assert note_block_rows, "expected note-block search row"
        assert note_block_rows[0]["id"] == str(note_block_id)
        assert note_block_rows[0]["deep_link"] == f"/notes/{note_block_id}"
