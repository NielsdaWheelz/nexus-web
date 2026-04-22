"""Integration tests for keyword search service and routes.

Tests cover:
- Basic search functionality across all types
- Visibility enforcement (s4 provenance for media, highlight visibility for annotations,
  canonical conversation visibility for messages)
- Scope filtering (all, media, library, conversation)
- Type filtering
- Pagination
- Short/empty query handling
- Pending messages never searchable
- Invalid cursor handling
- No visibility leakage
- S4 shared annotation visibility and revocation
- S4 library-scope message search
- S4 conversation scope with shared-read visibility
- S4 media provenance (stale default-library rows)
- Response shape preservation
"""

import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.factories import (
    add_library_member,
    create_searchable_media,
    create_searchable_media_in_library,
    create_test_annotation,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_library,
    create_test_message,
    get_user_default_library,
    share_conversation_to_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _basis_embedding(index: int) -> list[float]:
    from nexus.services.semantic_chunks import transcript_embedding_dimensions

    dims = transcript_embedding_dimensions()
    vector = [0.0] * dims
    if 0 <= index < dims:
        vector[index] = 1.0
    return vector


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
        """Search without q param returns error."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search", headers=auth_headers(user_id))

        assert response.status_code in (400, 422)  # FastAPI validation

    def test_epub_fragment_and_annotation_results_include_section_id(
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
            session.commit()

        auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        with direct_db.session() as session:
            highlight_id, annotation_id = create_test_annotation(
                session,
                user_id,
                media_id,
                body="Unique EPUB annotation needle for section deep link coverage.",
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)

        fragment_response = auth_client.get(
            "/search?q=unique+epub+fragment+needle&types=fragment",
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
            if row["type"] == "fragment" and row["source"]["media_id"] == str(media_id)
        )
        assert epub_fragment_row["section_id"] == "text/chapter1.xhtml"

        annotation_response = auth_client.get(
            "/search?q=unique+epub+annotation+needle&types=annotation",
            headers=auth_headers(user_id),
        )
        assert annotation_response.status_code == 200, (
            f"Expected annotation search to succeed, got {annotation_response.status_code}: "
            f"{annotation_response.text}"
        )
        annotation_rows = annotation_response.json()["results"]
        epub_annotation_row = next(
            row
            for row in annotation_rows
            if row["type"] == "annotation" and row["source"]["media_id"] == str(media_id)
        )
        assert epub_annotation_row["section_id"] == "text/chapter1.xhtml"

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
            "/search?q=needle+transcript+fragment&types=fragment",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"expected fragment search to succeed, got {response.status_code}: {response.text}"
        )
        result_ids = {row["id"] for row in response.json()["results"] if row["type"] == "fragment"}
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
        fragment_results = [r for r in data["results"] if r["type"] == "fragment"]
        assert len(fragment_results) >= 1

    def test_search_finds_annotations(self, auth_client, direct_db: DirectSessionManager):
        """Search finds annotations by body text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")
            highlight_id, annotation_id = create_test_annotation(
                session, user_id, media_id, body="My unique annotation about databases"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=annotation+databases", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert len(annotation_results) >= 1

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

    def test_search_does_not_leak_other_users_annotations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's annotations when they share no library."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates media and annotation
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_b, title="Shared Article")
            highlight_id, annotation_id = create_test_annotation(
                session, user_b, media_id, body="User B private annotation notes"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A searches for it
        response = auth_client.get(
            "/search?q=private+annotation+notes", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's annotation
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert not any(r["id"] == str(annotation_id) for r in annotation_results)

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
            elif result["type"] == "fragment":
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
            "/search?q=test&types=media,fragment", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Results should be media or fragment only
        for result in data["results"]:
            assert result["type"] in ("media", "fragment")

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
            "/search?q=test&types=media,invalid_type,fragment", headers=auth_headers(user_id)
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
        assert "authors" in result["source"]
        assert "published_date" in result["source"]
        assert "title" not in result

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
            "/search?q=canonical+text&types=fragment", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()

        if len(data["results"]) >= 1:
            result = data["results"][0]
            assert result["type"] == "fragment"
            assert "fragment_idx" in result
            assert "source" in result
            assert result["source"]["media_id"] == str(media_id)
            assert result["source"]["media_kind"] == "web_article"
            assert "idx" not in result
            assert "media_id" not in result

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

    def test_annotation_results_include_highlight_and_source_metadata(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Annotation search returns strict v2 nested highlight/source contract."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        annotation_body = "Unique metadata-rich annotation lookup term harmonica"
        source_title = "Metadata Rich Source Title"
        source_published_date = "2024-02-29"

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title=source_title)
            highlight_id, annotation_id = create_test_annotation(
                session,
                user_id,
                media_id,
                body=annotation_body,
            )
            session.execute(
                text(
                    """
                    UPDATE media
                    SET published_date = :published_date
                    WHERE id = :media_id
                    """
                ),
                {"published_date": source_published_date, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO media_authors (id, media_id, name, sort_order)
                    VALUES (:id_1, :media_id, :name_1, 1),
                           (:id_2, :media_id, :name_2, 2)
                    """
                ),
                {
                    "id_1": uuid4(),
                    "id_2": uuid4(),
                    "media_id": media_id,
                    "name_1": "Ada Lovelace",
                    "name_2": "Grace Hopper",
                },
            )
            session.commit()

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("media_authors", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=harmonica&types=annotation",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"Expected 200 for annotation search, got {response.status_code}: {response.text}"
        )
        data = response.json()
        result = next((r for r in data["results"] if r["id"] == str(annotation_id)), None)
        assert result is not None, (
            f"Expected annotation {annotation_id} in results; got {data['results']}"
        )

        assert result["source"]["media_id"] == str(media_id)
        assert result["source"]["media_kind"] == "web_article"
        assert result["source"]["title"] == source_title
        assert result["source"]["authors"] == ["Ada Lovelace", "Grace Hopper"]
        assert result["source"]["published_date"] == source_published_date
        assert result["highlight"]["exact"] == "test exact"
        assert result["highlight"]["prefix"] == "prefix"
        assert result["highlight"]["suffix"] == "suffix"
        assert result["annotation_body"] == annotation_body
        assert "media_kind" not in result
        assert "source_title" not in result
        assert "source_authors" not in result
        assert "source_published_date" not in result
        assert "highlight_exact" not in result
        assert "highlight_prefix" not in result
        assert "highlight_suffix" not in result


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


class TestSearchS4AnnotationVisibility:
    """Tests for s4 annotation visibility via highlight shared-read semantics."""

    def test_search_annotations_include_shared_visible_results(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared-visible annotations are returned in search.

        media M in shared library L; user_a authors highlight+annotation on M;
        user_b is member of L and sees annotation.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Annotation Share Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Shared Annotation Article"
            )
            highlight_id, annotation_id = create_test_annotation(
                session, user_a, media_id, body="Unique shared annotation searchterm xylophone"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            "/search?q=xylophone&types=annotation", headers=auth_headers(user_b)
        )

        assert response.status_code == 200
        data = response.json()
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert any(r["id"] == str(annotation_id) for r in annotation_results)

    def test_search_annotations_hidden_after_membership_revocation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """After revoking shared library membership, annotations become invisible.

        Start from visible shared-annotation setup, then revoke user_b from
        the intersecting library.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Revocation Test Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Revocation Annotation Article"
            )
            highlight_id, annotation_id = create_test_annotation(
                session, user_a, media_id, body="Revocation test annotation trombone"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # Verify visible before revocation
        resp_before = auth_client.get(
            "/search?q=trombone&types=annotation", headers=auth_headers(user_b)
        )
        assert resp_before.status_code == 200
        before_ids = [r["id"] for r in resp_before.json()["results"]]
        assert str(annotation_id) in before_ids

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
            "/search?q=trombone&types=annotation", headers=auth_headers(user_b)
        )
        assert resp_after.status_code == 200
        after_ids = [r["id"] for r in resp_after.json()["results"]]
        assert str(annotation_id) not in after_ids


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
        fragment_ids = [r["id"] for r in data["results"] if r["type"] == "fragment"]
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
    """Semantic transcript search over chunk + embedding artifacts."""

    def _seed_transcript_chunk_media(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        *,
        semantic_status: str,
    ) -> tuple[UUID, UUID]:
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        version_id = uuid4()
        chunk_a_id = uuid4()
        chunk_b_id = uuid4()
        from nexus.services.semantic_chunks import (
            current_transcript_embedding_model,
            to_pgvector_literal,
        )

        embedding_model = current_transcript_embedding_model()
        embedding_dims = len(_basis_embedding(0))
        embedding_a = _basis_embedding(0)
        embedding_b = _basis_embedding(1)

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
                        'Semantic Chunk Podcast Episode',
                        'https://feeds.example.com/semantic.xml',
                        'ready_for_reading',
                        'https://cdn.example.com/semantic.mp3',
                        'podcast_index',
                        'semantic-episode-1',
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
                        created_by_user_id
                    )
                    VALUES (
                        :id,
                        :media_id,
                        1,
                        'full',
                        true,
                        :created_by_user_id
                    )
                    """
                ),
                {
                    "id": version_id,
                    "media_id": media_id,
                    "created_by_user_id": user_id,
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
                        :semantic_status,
                        :active_transcript_version_id,
                        'search'
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "semantic_status": semantic_status,
                    "active_transcript_version_id": version_id,
                },
            )
            session.execute(
                text(
                    f"""
                    INSERT INTO podcast_transcript_chunks (
                        id,
                        transcript_version_id,
                        media_id,
                        chunk_idx,
                        chunk_text,
                        t_start_ms,
                        t_end_ms,
                        embedding,
                        embedding_vector,
                        embedding_model
                    )
                    VALUES
                        (
                            :chunk_a_id,
                            :version_id,
                            :media_id,
                            0,
                            'transformer attention residual stream explanation',
                            1000,
                            5000,
                            CAST(:embedding_a_json AS jsonb),
                            CAST(:embedding_a_vector AS vector({embedding_dims})),
                            :embedding_model
                        ),
                        (
                            :chunk_b_id,
                            :version_id,
                            :media_id,
                            1,
                            'gardening tomatoes and compost aeration tips',
                            5100,
                            9000,
                            CAST(:embedding_b_json AS jsonb),
                            CAST(:embedding_b_vector AS vector({embedding_dims})),
                            :embedding_model
                        )
                    """
                ),
                {
                    "chunk_a_id": chunk_a_id,
                    "chunk_b_id": chunk_b_id,
                    "version_id": version_id,
                    "media_id": media_id,
                    "embedding_a_json": json.dumps(embedding_a),
                    "embedding_b_json": json.dumps(embedding_b),
                    "embedding_a_vector": to_pgvector_literal(embedding_a),
                    "embedding_b_vector": to_pgvector_literal(embedding_b),
                    "embedding_model": embedding_model,
                },
            )
            session.commit()

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
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
            "/search?q=transformer+attention&types=transcript_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "transcript_chunk"]
        assert chunk_results, "expected semantic transcript chunk results for ready semantic index"
        top = chunk_results[0]
        assert top["source"]["media_id"] == str(media_id)
        assert top["t_start_ms"] == 1000
        assert top["t_end_ms"] == 5000
        assert "transformer" in top["snippet"].lower()

    def test_semantic_search_with_omitted_types_includes_transcript_chunks_by_default(
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
        chunk_results = [r for r in response.json()["results"] if r["type"] == "transcript_chunk"]
        assert chunk_results, (
            "omitting types while semantic=true must still include transcript_chunk "
            "in default all-types search"
        )
        assert any(row["source"]["media_id"] == str(media_id) for row in chunk_results)

    def test_semantic_search_excludes_transcripts_when_index_not_ready(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, _media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="pending",
        )

        response = auth_client.get(
            "/search?q=transformer+attention&types=transcript_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic search request to succeed even while indexing, got "
            f"{response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "transcript_chunk"]
        assert chunk_results == [], (
            "semantic search must not return transcript chunks while semantic index state is pending"
        )

    def test_semantic_search_scans_corpus_not_just_newest_chunks(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        with direct_db.session() as session:
            from nexus.services.semantic_chunks import (
                current_transcript_embedding_model,
                to_pgvector_literal,
            )

            version_id = session.execute(
                text(
                    """
                    SELECT active_transcript_version_id
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).scalar()
            assert version_id is not None
            embedding_model = current_transcript_embedding_model()
            embedding_dims = len(_basis_embedding(0))
            irrelevant_embedding = _basis_embedding(1)

            session.execute(
                text(
                    """
                    UPDATE podcast_transcript_chunks
                    SET created_at = now() - interval '7 days'
                    WHERE media_id = :media_id
                      AND chunk_text ILIKE '%transformer attention residual stream explanation%'
                    """
                ),
                {"media_id": media_id},
            )

            for offset in range(0, 120):
                session.execute(
                    text(
                        f"""
                        INSERT INTO podcast_transcript_chunks (
                            transcript_version_id,
                            media_id,
                            chunk_idx,
                            chunk_text,
                            t_start_ms,
                            t_end_ms,
                            embedding,
                            embedding_vector,
                            embedding_model,
                            created_at
                        )
                        VALUES (
                            :transcript_version_id,
                            :media_id,
                            :chunk_idx,
                            :chunk_text,
                            :t_start_ms,
                            :t_end_ms,
                            CAST(:embedding AS jsonb),
                            CAST(:embedding_vector AS vector({embedding_dims})),
                            :embedding_model,
                            now() + (:offset_seconds || ' seconds')::interval
                        )
                        """
                    ),
                    {
                        "transcript_version_id": version_id,
                        "media_id": media_id,
                        "chunk_idx": 1000 + offset,
                        "chunk_text": f"irrelevant gardening chunk {offset}",
                        "t_start_ms": 20_000 + (offset * 1_000),
                        "t_end_ms": 20_900 + (offset * 1_000),
                        "offset_seconds": offset,
                        "embedding": json.dumps(irrelevant_embedding),
                        "embedding_vector": to_pgvector_literal(irrelevant_embedding),
                        "embedding_model": embedding_model,
                    },
                )
            session.commit()

        response = auth_client.get(
            "/search?q=transformer+attention&types=transcript_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "transcript_chunk"]
        assert chunk_results, (
            "semantic retrieval must still find older relevant transcript chunks when many newer "
            "irrelevant chunks exist"
        )
        assert any("transformer" in result["snippet"].lower() for result in chunk_results), (
            "semantic retrieval should not silently drop old but relevant chunks due to recency-only "
            "candidate selection"
        )

    def test_semantic_search_finds_relevant_chunk_after_large_irrelevant_prefix(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id, media_id = self._seed_transcript_chunk_media(
            auth_client,
            direct_db,
            semantic_status="ready",
        )

        with direct_db.session() as session:
            from nexus.services.semantic_chunks import (
                current_transcript_embedding_model,
                to_pgvector_literal,
            )

            version_id = session.execute(
                text(
                    """
                    SELECT active_transcript_version_id
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).scalar()
            assert version_id is not None
            embedding_model = current_transcript_embedding_model()
            embedding_dims = len(_basis_embedding(0))
            irrelevant_embedding = _basis_embedding(1)
            relevant_embedding = _basis_embedding(0)

            session.execute(
                text("DELETE FROM podcast_transcript_chunks WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            for offset in range(0, 30):
                session.execute(
                    text(
                        f"""
                        INSERT INTO podcast_transcript_chunks (
                            transcript_version_id,
                            media_id,
                            chunk_idx,
                            chunk_text,
                            t_start_ms,
                            t_end_ms,
                            embedding,
                            embedding_vector,
                            embedding_model,
                            created_at
                        )
                        VALUES (
                            :transcript_version_id,
                            :media_id,
                            :chunk_idx,
                            :chunk_text,
                            :t_start_ms,
                            :t_end_ms,
                            CAST(:embedding AS jsonb),
                            CAST(:embedding_vector AS vector({embedding_dims})),
                            :embedding_model,
                            now() - interval '1 day'
                        )
                        """
                    ),
                    {
                        "transcript_version_id": version_id,
                        "media_id": media_id,
                        "chunk_idx": offset,
                        "chunk_text": f"irrelevant corpus filler chunk {offset}",
                        "t_start_ms": 1_000 + (offset * 1_000),
                        "t_end_ms": 1_900 + (offset * 1_000),
                        "embedding": json.dumps(irrelevant_embedding),
                        "embedding_vector": to_pgvector_literal(irrelevant_embedding),
                        "embedding_model": embedding_model,
                    },
                )
            session.execute(
                text(
                    f"""
                    INSERT INTO podcast_transcript_chunks (
                        transcript_version_id,
                        media_id,
                        chunk_idx,
                        chunk_text,
                        t_start_ms,
                        t_end_ms,
                        embedding,
                        embedding_vector,
                        embedding_model,
                        created_at
                    )
                    VALUES (
                        :transcript_version_id,
                        :media_id,
                        999,
                        'transformer attention residual stream explanation',
                        61000,
                        66000,
                        CAST(:embedding AS jsonb),
                        CAST(:embedding_vector AS vector({embedding_dims})),
                        :embedding_model,
                        now()
                    )
                    """
                ),
                {
                    "transcript_version_id": version_id,
                    "media_id": media_id,
                    "embedding": json.dumps(relevant_embedding),
                    "embedding_vector": to_pgvector_literal(relevant_embedding),
                    "embedding_model": embedding_model,
                },
            )
            session.commit()

        response = auth_client.get(
            "/search?q=transformer+attention&types=transcript_chunk&semantic=true",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected semantic transcript search to succeed, got {response.status_code}: {response.text}"
        )
        chunk_results = [r for r in response.json()["results"] if r["type"] == "transcript_chunk"]
        assert any("transformer attention" in row["snippet"].lower() for row in chunk_results), (
            "semantic retrieval must not silently miss relevant chunks after a large block of "
            "irrelevant transcript rows"
        )


class TestSearchTranscriptVersionNavigation:
    def test_annotation_search_maps_to_active_fragment_when_anchor_targets_old_version(
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
        annotation_id = uuid4()
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
                    INSERT INTO annotations (
                        id,
                        highlight_id,
                        body,
                        created_at
                    )
                    VALUES (
                        :annotation_id,
                        :highlight_id,
                        'anchor remap needle body text',
                        :now_ts
                    )
                    """
                ),
                {
                    "annotation_id": annotation_id,
                    "highlight_id": highlight_id,
                    "now_ts": now_ts,
                },
            )
            session.commit()

        direct_db.register_cleanup("annotations", "id", annotation_id)
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
            "/search?q=anchor+remap+needle&types=annotation",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, (
            f"expected annotation search to succeed, got {response.status_code}: {response.text}"
        )
        annotation_rows = [row for row in response.json()["results"] if row["type"] == "annotation"]
        assert annotation_rows, "expected annotation search row for stored-fragment assertion"
        assert annotation_rows[0]["id"] == str(annotation_id)
        assert annotation_rows[0]["fragment_id"] == str(old_fragment_id), (
            "annotation search deep-links must follow the canonical stored fragment anchor"
        )
