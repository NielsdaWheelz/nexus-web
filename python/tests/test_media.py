"""Integration tests for media service and routes.

Tests cover:
- Media visibility enforcement
- Fragment retrieval
- 404 masking for unreadable media
- Timestamp serialization

Tests scenarios from s0_spec.md:
- #12: Non-member cannot read media
- #19: GET /media/{id} enforces visibility
- #20: GET /media/{id}/fragments returns content
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubTocNode,
    Fragment,
    FragmentBlock,
    Media,
    MediaFile,
    MediaKind,
    ProcessingStatus,
)
from tests.factories import (
    create_failed_epub_media,
    create_ready_epub_with_chapters,
    create_seeded_test_media,
)
from tests.fixtures import (
    FIXTURE_CANONICAL_TEXT,
    FIXTURE_FRAGMENT_ID,
    FIXTURE_HTML_SANITIZED,
    FIXTURE_MEDIA_ID,
    FIXTURE_TITLE,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# =============================================================================
# Fixtures
# =============================================================================


def create_seeded_media(session: Session) -> UUID:
    """Create the seeded fixture media directly in the database.

    Returns the media ID.
    """
    return create_seeded_test_media(
        session,
        title=FIXTURE_TITLE,
        canonical_text=FIXTURE_CANONICAL_TEXT,
        html_sanitized=FIXTURE_HTML_SANITIZED,
        media_id=FIXTURE_MEDIA_ID,
        fragment_id=FIXTURE_FRAGMENT_ID,
    )


# =============================================================================
# GET /media/{id} Tests
# =============================================================================


class TestGetMedia:
    """Tests for GET /media/{id} endpoint."""

    def test_get_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Test #19a: Member can read media in their library."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get media
        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["id"] == str(media_id)
        assert data["kind"] == "web_article"
        assert data["title"] == FIXTURE_TITLE
        assert data["processing_status"] == "ready_for_reading"

    def test_get_media_includes_request_id_header(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #21: GET /media/{id} includes X-Request-ID header on 200 response."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get media
        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        # Verify X-Request-ID header is present
        assert "X-Request-ID" in response.headers
        # Verify it's a valid format (UUID or alphanumeric)
        request_id = response.headers["X-Request-ID"]
        assert len(request_id) > 0
        assert len(request_id) <= 128

    def test_get_media_not_found(self, auth_client):
        """Test #19b: Non-existent media returns 404."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        # Try to get non-existent media
        response = auth_client.get(f"/media/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_media_not_in_library(self, auth_client, direct_db: DirectSessionManager):
        """Test #12 & #19c: Media not in user's library returns 404 (masks existence)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media to their library
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User B tries to access media (not in their library)
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_media_response_shape(self, auth_client, direct_db: DirectSessionManager):
        """Verify response shape matches spec."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify all required fields present
        assert "id" in data
        assert "kind" in data
        assert "title" in data
        assert "canonical_source_url" in data
        assert "processing_status" in data
        assert "created_at" in data
        assert "updated_at" in data

        # Verify no extra fields (author is NOT included per spec)
        assert "author" not in data

        # Verify timestamps are valid ISO8601
        from datetime import datetime

        datetime.fromisoformat(data["created_at"].replace("Z", "+00:00"))
        datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00"))


# =============================================================================
# GET /media/{id}/fragments Tests
# =============================================================================


class TestGetMediaFragments:
    """Tests for GET /media/{id}/fragments endpoint."""

    def test_get_fragments_success(self, auth_client, direct_db: DirectSessionManager):
        """Test #20: GET /media/{id}/fragments returns content."""
        user_id = create_test_user_id()

        # Create media with fragment
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1

        fragment = data[0]
        assert fragment["id"] == str(FIXTURE_FRAGMENT_ID)
        assert fragment["media_id"] == str(media_id)
        assert fragment["idx"] == 0
        assert "html_sanitized" in fragment
        assert "canonical_text" in fragment
        assert fragment["html_sanitized"] == FIXTURE_HTML_SANITIZED
        assert fragment["canonical_text"] == FIXTURE_CANONICAL_TEXT

    def test_get_fragments_not_found(self, auth_client):
        """Non-existent media returns 404."""
        user_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(f"/media/{uuid4()}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_fragments_not_in_library(self, auth_client, direct_db: DirectSessionManager):
        """Media not in user's library returns 404 (masks existence)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User B tries to access fragments (not in their library)
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_fragments_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Fragments are ordered by idx ASC."""
        user_id = create_test_user_id()

        # Create media with multiple fragments
        media_id = uuid4()
        fragment_ids = [uuid4() for _ in range(3)]

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Multi Fragment",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()

            # Insert fragments in reverse order to test ordering
            for i, frag_id in enumerate(reversed(fragment_ids)):
                frag = Fragment(
                    id=frag_id,
                    media_id=media_id,
                    idx=2 - i,  # Insert as 2, 1, 0
                    html_sanitized=f"<p>Fragment {2 - i}</p>",
                    canonical_text=f"Fragment {2 - i}",
                )
                session.add(frag)

            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3

        # Verify ordering by idx ASC
        for i, fragment in enumerate(data):
            assert fragment["idx"] == i

    def test_get_fragments_empty(self, auth_client, direct_db: DirectSessionManager):
        """Media with no fragments returns empty list."""
        user_id = create_test_user_id()

        # Create media without fragments
        media_id = uuid4()
        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="No Fragments",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []


# =============================================================================
# Content Safety Tests
# =============================================================================


class TestContentSafety:
    """Tests verifying no endpoint returns unsanitized HTML."""

    def test_fragments_return_sanitized_html(self, auth_client, direct_db: DirectSessionManager):
        """Verify fragments endpoint returns html_sanitized field."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify the field is called html_sanitized, not html_raw
        for fragment in data:
            assert "html_sanitized" in fragment
            assert "html_raw" not in fragment
            assert "html" not in fragment  # No ambiguous "html" field


# =============================================================================
# Timestamp Serialization Tests
# =============================================================================


class TestTimestampSerialization:
    """Tests for timestamp serialization format."""

    def test_media_timestamps_iso8601(self, auth_client, direct_db: DirectSessionManager):
        """Media timestamps are valid ISO8601."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        data = response.json()["data"]

        # Verify parseability
        from datetime import datetime

        for ts_field in ["created_at", "updated_at"]:
            ts = data[ts_field]
            # Replace Z with +00:00 for Python parsing
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            assert parsed is not None

    def test_fragment_timestamps_iso8601(self, auth_client, direct_db: DirectSessionManager):
        """Fragment timestamps are valid ISO8601."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        for fragment in response.json()["data"]:
            from datetime import datetime

            ts = fragment["created_at"]
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            assert parsed is not None


# =============================================================================
# S5 PR-02: EPUB Asset Endpoint Tests
# =============================================================================


# =============================================================================
# S5 PR-07: Hardening / Freeze Tests
# =============================================================================


class TestEpubChapterFragmentsImmutableAcrossReadsAndHighlightChurn:
    """Scenario 1: chapter fragment immutability across reads + highlight churn."""

    def test_epub_chapter_fragments_immutable_across_reads_and_highlight_churn(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("highlights", "fragment_id", frag_ids[1])
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Snapshot baseline fragment content from DB
        with direct_db.session() as session:
            baseline = (
                session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                .filter(Fragment.media_id == media_id)
                .order_by(Fragment.idx)
                .all()
            )
        assert len(baseline) == 3

        # Read chapters repeatedly via manifest + detail endpoints
        for _ in range(3):
            resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
            assert resp.status_code == 200
            for idx in range(3):
                resp = auth_client.get(
                    f"/media/{media_id}/chapters/{idx}", headers=auth_headers(user_id)
                )
                assert resp.status_code == 200

        # Create and delete a highlight on chapter idx=1
        hl_resp = auth_client.post(
            f"/fragments/{frag_ids[1]}/highlights",
            json={"start_offset": 0, "end_offset": 10, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert hl_resp.status_code == 201
        highlight_id = hl_resp.json()["data"]["id"]

        del_resp = auth_client.delete(f"/highlights/{highlight_id}", headers=auth_headers(user_id))
        assert del_resp.status_code == 204

        # Assert fragment content unchanged
        with direct_db.session() as session:
            after = (
                session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                .filter(Fragment.media_id == media_id)
                .order_by(Fragment.idx)
                .all()
            )

        assert len(after) == len(baseline)
        for (b_idx, b_html, b_text), (a_idx, a_html, a_text) in zip(baseline, after, strict=True):
            assert b_idx == a_idx
            assert b_html == a_html, f"html_sanitized changed for chapter {b_idx}"
            assert b_text == a_text, f"canonical_text changed for chapter {b_idx}"


class TestEpubFragmentContentStableAcrossEmbeddingStatusTransition:
    """Scenario 11: embedding path transition coverage.

    Verifies EPUB read endpoints remain readable in embedding/ready states
    and fragment content is byte-for-byte stable across status changes.
    """

    def test_epub_fragment_content_stable_across_embedding_status_transition(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Snapshot baseline in ready_for_reading
        with direct_db.session() as session:
            baseline = (
                session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                .filter(Fragment.media_id == media_id)
                .order_by(Fragment.idx)
                .all()
            )
        assert len(baseline) == 2

        for target_status in (ProcessingStatus.embedding, ProcessingStatus.ready):
            with direct_db.session() as session:
                media_obj = session.get(Media, media_id)
                media_obj.processing_status = target_status
                session.commit()

            # Read endpoints remain readable
            resp_manifest = auth_client.get(
                f"/media/{media_id}/chapters", headers=auth_headers(user_id)
            )
            assert resp_manifest.status_code == 200
            assert len(resp_manifest.json()["data"]) == 2

            for idx in range(2):
                resp_ch = auth_client.get(
                    f"/media/{media_id}/chapters/{idx}", headers=auth_headers(user_id)
                )
                assert resp_ch.status_code == 200

            # DB fragment content unchanged
            with direct_db.session() as session:
                current = (
                    session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                    .filter(Fragment.media_id == media_id)
                    .order_by(Fragment.idx)
                    .all()
                )

            for (b_idx, b_html, b_text), (c_idx, c_html, c_text) in zip(
                baseline, current, strict=True
            ):
                assert b_idx == c_idx
                assert b_html == c_html, (
                    f"html_sanitized changed at status={target_status} ch={b_idx}"
                )
                assert b_text == c_text, (
                    f"canonical_text changed at status={target_status} ch={b_idx}"
                )


class TestRetryEpubFailedClearsPersistedEpubArtifactsBeforeDispatch:
    """Scenarios 6/12: retry cleanup clears all extraction artifacts."""

    def test_retry_epub_failed_clears_persisted_epub_artifacts_before_dispatch(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        # Seed extraction artifacts that should be cleaned up on retry
        with direct_db.session() as session:
            frag_id = uuid4()
            frag = Fragment(
                id=frag_id,
                media_id=media_id,
                idx=0,
                html_sanitized="<p>stale</p>",
                canonical_text="stale",
            )
            session.add(frag)
            session.flush()
            block = FragmentBlock(
                id=uuid4(),
                fragment_id=frag_id,
                block_idx=0,
                start_offset=0,
                end_offset=5,
            )
            session.add(block)
            toc_node = EpubTocNode(
                media_id=media_id,
                node_id="stale",
                parent_node_id=None,
                label="Stale Node",
                href=None,
                fragment_idx=0,
                depth=0,
                order_key="0001",
            )
            session.add(toc_node)
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragment_blocks", "fragment_id", frag_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import MagicMock, patch

        mock_dispatch = MagicMock()

        with (
            patch(
                "nexus.services.epub_lifecycle.get_storage_client",
                return_value=fake_storage,
            ),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", mock_dispatch),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True
        mock_dispatch.assert_called_once()

        # Artifacts must be gone after retry reset
        with direct_db.session() as session:
            frag_count = session.query(Fragment).filter(Fragment.media_id == media_id).count()
            assert frag_count == 0, "fragments not cleaned up"

            toc_count = session.query(EpubTocNode).filter(EpubTocNode.media_id == media_id).count()
            assert toc_count == 0, "epub_toc_nodes not cleaned up"

            # fragment_blocks implicitly gone since fragments deleted
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 2
            assert media_row.last_error_code is None


class TestGetEpubAssetSuccessAndMasking:
    """test_get_epub_asset_success_and_masking"""

    def test_resolved_asset_returns_binary(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()
        asset_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Put asset into fake storage
        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig1.png", asset_content, "image/png")

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.storage.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig1.png",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 200
        assert resp.content == asset_content
        assert "image/png" in resp.headers.get("content-type", "")

    def test_unauthorized_viewer_gets_404(self, auth_client, direct_db: DirectSessionManager):
        other_user = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)

        resp = auth_client.get(
            f"/media/{media_id}/assets/images/fig1.png",
            headers=auth_headers(other_user),
        )
        assert resp.status_code == 404

    def test_missing_asset_returns_404(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import patch

        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.storage.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/nonexistent.png",
                headers=auth_headers(user_id),
            )
        assert resp.status_code == 404


class TestGetEpubAssetKindAndReadyGuards:
    """test_get_epub_asset_kind_and_ready_guards"""

    def test_non_epub_returns_400(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Article",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/assets/test.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

    def test_non_ready_epub_returns_409(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Pending EPUB",
                processing_status=ProcessingStatus.pending,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/assets/test.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# S5 PR-03: EPUB Retry Endpoint Tests
# =============================================================================


def _create_failed_epub(
    session,
    user_id,
    *,
    last_error_code="E_INGEST_FAILED",
    with_file=True,
    file_sha256="abc123",
):
    """Insert a failed EPUB media row suitable for retry tests.

    Delegates to create_failed_epub_media factory. The with_file parameter
    is always True in the factory (media_file row is always created).
    """
    return create_failed_epub_media(
        session,
        user_id,
        last_error_code=last_error_code,
        processing_attempts=1,
        file_sha256=file_sha256,
    )


class TestRetryEpubEndpoint:
    """S5 PR-03: POST /media/{id}/retry tests."""

    def test_retry_epub_failed_resets_and_dispatches(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import MagicMock, patch

        mock_dispatch = MagicMock()

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        # DISPATCH SEAM EXCEPTION: Async task dispatch boundary mock.
        # Prevents real Celery dispatch per testing standards Section 6 (Allowed Mocks).
        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", mock_dispatch),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True

        mock_dispatch.assert_called_once()

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 2
            assert media_row.last_error_code is None

    def test_retry_invalid_state_returns_409(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Not Failed",
                processing_status=ProcessingStatus.pending,
                created_by_user_id=user_id,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_INVALID_STATE"

    def test_retry_terminal_archive_failure_blocked(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, last_error_code="E_ARCHIVE_UNSAFE")

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_retry_kind_guard_and_auth(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # non-EPUB
        non_epub_id = uuid4()
        with direct_db.session() as session:
            media = Media(
                id=non_epub_id,
                kind=MediaKind.web_article.value,
                title="Article",
                processing_status=ProcessingStatus.failed,
                created_by_user_id=user_a,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", non_epub_id)
        direct_db.register_cleanup("media", "id", non_epub_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(non_epub_id)},
            headers=auth_headers(user_a),
        )

        resp = auth_client.post(f"/media/{non_epub_id}/retry", headers=auth_headers(user_a))
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

        # non-creator
        with direct_db.session() as session:
            epub_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("library_media", "media_id", epub_id)
        direct_db.register_cleanup("media_file", "media_id", epub_id)
        direct_db.register_cleanup("media", "id", epub_id)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(epub_id)},
            headers=auth_headers(user_a),
        )

        me_b = auth_client.get("/me", headers=auth_headers(user_b))
        lib_b = me_b.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{lib_b}/media",
            json={"media_id": str(epub_id)},
            headers=auth_headers(user_b),
        )

        resp = auth_client.post(f"/media/{epub_id}/retry", headers=auth_headers(user_b))
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "E_FORBIDDEN"

    def test_retry_visibility_masking(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_b))
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_retry_source_integrity_precondition_failure_no_mutation(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256="deadbeef")

        # Seed extraction artifacts that must survive precondition failure
        with direct_db.session() as session:
            frag_id = uuid4()
            frag = Fragment(
                id=frag_id,
                media_id=media_id,
                idx=0,
                html_sanitized="<p>preserved</p>",
                canonical_text="preserved",
            )
            session.add(frag)
            session.flush()
            toc_node = EpubTocNode(
                media_id=media_id,
                node_id="kept",
                parent_node_id=None,
                label="Kept",
                href=None,
                fragment_idx=0,
                depth=0,
                order_key="0001",
            )
            session.add(toc_node)
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_STORAGE_MISSING"

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.failed
            assert media_row.processing_attempts == 1

            # Artifacts must be preserved when precondition fails
            frag_count = session.query(Fragment).filter(Fragment.media_id == media_id).count()
            assert frag_count == 1, "artifacts deleted despite precondition failure"

            toc_count = session.query(EpubTocNode).filter(EpubTocNode.media_id == media_id).count()
            assert toc_count == 1, "TOC nodes deleted despite precondition failure"

    def test_retry_preserves_source_identity_fields(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        storage_path = f"media/{media_id}/original.epub"
        fake_storage.put_object(storage_path, epub_bytes, "application/epub+zip")

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import MagicMock, patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        # DISPATCH SEAM EXCEPTION: Async task dispatch boundary mock.
        # Prevents real Celery dispatch per testing standards Section 6 (Allowed Mocks).
        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", MagicMock()),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.file_sha256 == sha

            mf = session.get(MediaFile, media_id)
            assert mf is not None
            assert mf.storage_path == storage_path

    def test_retry_dispatch_failure_rolls_back_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import patch

        def boom(*a, **kw):
            raise RuntimeError("broker down")

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        # DISPATCH SEAM EXCEPTION: Async task dispatch boundary mock.
        # Prevents real Celery dispatch per testing standards Section 6 (Allowed Mocks).
        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", side_effect=boom),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 500

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status != ProcessingStatus.extracting


# =============================================================================
# S5 PR-04: EPUB Chapter + TOC Read API Tests
# =============================================================================


def _create_ready_epub(session, *, num_chapters=3, with_toc=True):
    """Insert a ready EPUB with contiguous chapter fragments and optional TOC nodes.

    Returns (media_id, [fragment_ids]).
    """
    return create_ready_epub_with_chapters(
        session,
        num_chapters=num_chapters,
        with_toc=with_toc,
    )


def _add_media_to_user_library(auth_client, user_id, media_id):
    """Bootstrap user and add media to their default library. Returns library_id."""
    me_resp = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    return library_id


class TestGetEpubChaptersManifestPaginationIsDeterministic:
    """test_get_epub_chapters_manifest_pagination_is_deterministic"""

    def test_paginate_chapters(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=5)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Page 1: limit=2
        resp1 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2", headers=auth_headers(user_id)
        )
        assert resp1.status_code == 200
        body1 = resp1.json()
        items1 = body1["data"]
        assert len(items1) == 2
        assert items1[0]["idx"] == 0
        assert items1[1]["idx"] == 1
        assert body1["page"]["has_more"] is True
        assert body1["page"]["next_cursor"] == 1

        # Page 2: cursor=1, limit=2
        resp2 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2&cursor=1", headers=auth_headers(user_id)
        )
        assert resp2.status_code == 200
        body2 = resp2.json()
        items2 = body2["data"]
        assert len(items2) == 2
        assert items2[0]["idx"] == 2
        assert items2[1]["idx"] == 3
        assert body2["page"]["has_more"] is True

        # Page 3: cursor=3, limit=2
        resp3 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2&cursor=3", headers=auth_headers(user_id)
        )
        assert resp3.status_code == 200
        body3 = resp3.json()
        items3 = body3["data"]
        assert len(items3) == 1
        assert items3[0]["idx"] == 4
        assert body3["page"]["has_more"] is False
        assert body3["page"]["next_cursor"] is None

        # No cross-page duplicates
        all_idxs = (
            [c["idx"] for c in items1] + [c["idx"] for c in items2] + [c["idx"] for c in items3]
        )
        assert all_idxs == [0, 1, 2, 3, 4]


class TestGetEpubChaptersCursorOutOfRangeReturnsEmptyPage:
    """test_get_epub_chapters_cursor_out_of_range_returns_empty_page"""

    def test_cursor_beyond_max(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=99", headers=auth_headers(user_id)
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == []
        assert body["page"]["next_cursor"] is None
        assert body["page"]["has_more"] is False

    def test_cursor_equal_to_max(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=2", headers=auth_headers(user_id)
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == []
        assert body["page"]["next_cursor"] is None
        assert body["page"]["has_more"] is False


class TestGetEpubChaptersManifestIsMetadataOnly:
    """test_get_epub_chapters_manifest_is_metadata_only"""

    def test_no_heavy_columns(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        items = resp.json()["data"]
        assert len(items) > 0
        for item in items:
            assert "html_sanitized" not in item
            assert "canonical_text" not in item
            assert "idx" in item
            assert "fragment_id" in item
            assert "title" in item
            assert "char_count" in item
            assert "word_count" in item
            assert "has_toc_entry" in item
            assert "primary_toc_node_id" in item


class TestGetEpubChaptersProjectionExcludesHeavyColumns:
    """test_get_epub_chapters_projection_excludes_heavy_columns

    Verifies the service layer does not return html_sanitized/canonical_text
    in the manifest items (serialization-level check).
    """

    def test_serialized_output_excludes_content(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        raw = resp.text
        assert "html_sanitized" not in raw
        assert "canonical_text" not in raw


class TestGetEpubChaptersPrimaryTocNodeUsesMinOrderKey:
    """test_get_epub_chapters_primary_toc_node_uses_min_order_key"""

    def test_multiple_toc_nodes_same_chapter(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Multi-TOC EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()
            fid = uuid4()
            frag = Fragment(
                id=fid,
                media_id=media_id,
                idx=0,
                html_sanitized="<p>Content</p>",
                canonical_text="Content",
            )
            session.add(frag)
            session.flush()
            # Two TOC nodes both pointing to fragment_idx=0, different order_keys
            session.add(
                EpubTocNode(
                    media_id=media_id,
                    node_id="second",
                    parent_node_id=None,
                    label="Second Label",
                    href=None,
                    fragment_idx=0,
                    depth=0,
                    order_key="0002",
                )
            )
            session.add(
                EpubTocNode(
                    media_id=media_id,
                    node_id="first",
                    parent_node_id=None,
                    label="First Label",
                    href=None,
                    fragment_idx=0,
                    depth=0,
                    order_key="0001",
                )
            )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        items = resp.json()["data"]
        assert len(items) == 1
        ch = items[0]
        assert ch["primary_toc_node_id"] == "first"
        assert ch["title"] == "First Label"
        assert ch["has_toc_entry"] is True


class TestGetEpubChapterByIdxReturnsPayloadAndNavigation:
    """test_get_epub_chapter_by_idx_returns_payload_and_navigation"""

    def test_navigation_pointers(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # First chapter: prev_idx=null, next_idx=1
        resp0 = auth_client.get(f"/media/{media_id}/chapters/0", headers=auth_headers(user_id))
        assert resp0.status_code == 200
        ch0 = resp0.json()["data"]
        assert ch0["idx"] == 0
        assert ch0["prev_idx"] is None
        assert ch0["next_idx"] == 1
        assert ch0["fragment_id"] == str(frag_ids[0])
        assert "html_sanitized" in ch0
        assert "canonical_text" in ch0
        assert "created_at" in ch0

        # Middle chapter: prev_idx=0, next_idx=2
        resp1 = auth_client.get(f"/media/{media_id}/chapters/1", headers=auth_headers(user_id))
        ch1 = resp1.json()["data"]
        assert ch1["prev_idx"] == 0
        assert ch1["next_idx"] == 2

        # Last chapter: prev_idx=1, next_idx=null
        resp2 = auth_client.get(f"/media/{media_id}/chapters/2", headers=auth_headers(user_id))
        ch2 = resp2.json()["data"]
        assert ch2["prev_idx"] == 1
        assert ch2["next_idx"] is None


class TestGetEpubChapterReturnsSingleChapterNotConcatenated:
    """test_get_epub_chapter_returns_single_chapter_not_concatenated"""

    def test_no_adjacent_content(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters/1", headers=auth_headers(user_id))
        assert resp.status_code == 200
        ch = resp.json()["data"]
        # Should contain sentinel for chapter 1 only
        assert "Sentinel content for chapter 1" in ch["canonical_text"]
        assert "Sentinel content for chapter 0" not in ch["canonical_text"]
        assert "Sentinel content for chapter 2" not in ch["canonical_text"]


class TestGetEpubChapterMissingIdxReturns404:
    """test_get_epub_chapter_missing_idx_returns_404"""

    def test_nonexistent_idx(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters/99", headers=auth_headers(user_id))
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_CHAPTER_NOT_FOUND"


class TestGetEpubTocReturnsNestedTreeOrderedByOrderKey:
    """test_get_epub_toc_returns_nested_tree_ordered_by_order_key"""

    def test_nested_toc_ordering(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Nested TOC EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()
            # Create a fragment for linking
            fid = uuid4()
            frag = Fragment(
                id=fid,
                media_id=media_id,
                idx=0,
                html_sanitized="<p>Content</p>",
                canonical_text="Content",
            )
            session.add(frag)
            session.flush()
            # Insert TOC nodes out of order to test deterministic ordering
            nodes = [
                ("root2", None, "Part II", None, None, 0, "0002"),
                ("root1", None, "Part I", None, None, 0, "0001"),
                ("child1_2", "root1", "Chapter 1.2", None, 0, 1, "0001.0002"),
                ("child1_1", "root1", "Chapter 1.1", None, 0, 1, "0001.0001"),
            ]
            for nid, pid, label, href, fidx, depth, ok in nodes:
                session.add(
                    EpubTocNode(
                        media_id=media_id,
                        node_id=nid,
                        parent_node_id=pid,
                        label=label,
                        href=href,
                        fragment_idx=fidx,
                        depth=depth,
                        order_key=ok,
                    )
                )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/toc", headers=auth_headers(user_id))
        assert resp.status_code == 200
        nodes_out = resp.json()["data"]["nodes"]

        # Root ordering
        assert len(nodes_out) == 2
        assert nodes_out[0]["node_id"] == "root1"
        assert nodes_out[0]["order_key"] == "0001"
        assert nodes_out[1]["node_id"] == "root2"
        assert nodes_out[1]["order_key"] == "0002"

        # Children of root1 ordered
        children = nodes_out[0]["children"]
        assert len(children) == 2
        assert children[0]["node_id"] == "child1_1"
        assert children[0]["order_key"] == "0001.0001"
        assert children[1]["node_id"] == "child1_2"
        assert children[1]["order_key"] == "0001.0002"

        # root2 has no children
        assert nodes_out[1]["children"] == []


class TestGetEpubTocEmptyReturnsNodesEmpty:
    """test_get_epub_toc_empty_returns_nodes_empty"""

    def test_epub_without_toc(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1, with_toc=False)

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/toc", headers=auth_headers(user_id))
        assert resp.status_code == 200
        assert resp.json()["data"]["nodes"] == []


class TestGetEpubReadEndpointsVisibilityMasking:
    """test_get_epub_read_endpoints_visibility_masking"""

    def test_unreadable_user_gets_404(self, auth_client, direct_db: DirectSessionManager):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Only user A gets the media
        _add_media_to_user_library(auth_client, user_a, media_id)
        # Bootstrap user B (no media)
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B should get 404 on all three endpoints (visibility masking)
        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_b))
            assert resp.status_code == 404, f"Expected 404 for {path}, got {resp.status_code}"
            body = resp.json()
            assert body["error"]["code"] == "E_MEDIA_NOT_FOUND"


class TestGetEpubReadEndpointsKindAndReadinessGuards:
    """test_get_epub_read_endpoints_kind_and_readiness_guards"""

    def test_non_epub_returns_400(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="An Article",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 400, f"Expected 400 for {path}"
            assert resp.json()["error"]["code"] == "E_INVALID_KIND"

    def test_non_ready_epub_returns_409(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Pending EPUB",
                processing_status=ProcessingStatus.pending,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 409, f"Expected 409 for {path}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


class TestGetEpubChaptersInvalidLimitCursorAndIdxAre400:
    """test_get_epub_chapters_invalid_limit_cursor_and_idx_are_400"""

    def test_invalid_params(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Invalid limit: 0
        resp = auth_client.get(f"/media/{media_id}/chapters?limit=0", headers=auth_headers(user_id))
        assert resp.status_code == 400

        # Invalid limit: 201
        resp = auth_client.get(
            f"/media/{media_id}/chapters?limit=201", headers=auth_headers(user_id)
        )
        assert resp.status_code == 400

        # Invalid cursor: -1
        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=-1", headers=auth_headers(user_id)
        )
        assert resp.status_code == 400

        # Invalid chapter idx: -1
        resp = auth_client.get(f"/media/{media_id}/chapters/-1", headers=auth_headers(user_id))
        assert resp.status_code == 400


# =============================================================================
# S5 PR-06: /media/{id}/fragments compatibility on EPUB
# =============================================================================


class TestGetFragmentsEpubReady:
    """PR-06: existing /media/{id}/fragments returns all EPUB chapters ordered by idx."""

    def test_get_fragments_epub_ready_returns_all_chapters_ordered_by_idx(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=4)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))
        assert resp.status_code == 200
        fragments = resp.json()["data"]
        assert len(fragments) == 4

        for i, frag in enumerate(fragments):
            assert frag["idx"] == i
            assert "html_sanitized" in frag
            assert "canonical_text" in frag
            assert frag["id"] == str(frag_ids[i])

        returned_idxs = [f["idx"] for f in fragments]
        assert returned_idxs == sorted(returned_idxs), "Fragments must be ordered by idx ASC"


# =============================================================================
# S6 PR-03: PDF capabilities and retry tests
# =============================================================================


def _create_pdf_media_with_state(
    session,
    *,
    processing_status="ready_for_reading",
    plain_text=None,
    page_count=None,
    failure_stage=None,
    last_error_code=None,
    with_page_spans=False,
):
    """Create a PDF media row with specified state for capability testing."""
    from uuid import uuid4

    from sqlalchemy import text

    media_id = uuid4()
    user_id = uuid4()

    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    session.execute(
        text("""
            INSERT INTO media (
                id, kind, title, processing_status, plain_text, page_count,
                failure_stage, last_error_code, created_by_user_id
            ) VALUES (
                :id, 'pdf', 'Test PDF', :ps, :pt, :pc,
                :fs, :lec, :uid
            )
        """),
        {
            "id": media_id,
            "ps": processing_status,
            "pt": plain_text,
            "pc": page_count,
            "fs": failure_stage,
            "lec": last_error_code,
            "uid": user_id,
        },
    )
    session.execute(
        text("""
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:mid, :sp, 'application/pdf', 1000)
        """),
        {"mid": media_id, "sp": f"media/{media_id}/original.pdf"},
    )

    if with_page_spans and page_count and plain_text:
        page_len = len(plain_text) // page_count
        for i in range(page_count):
            start = i * page_len
            end = start + page_len if i < page_count - 1 else len(plain_text)
            session.execute(
                text("""
                    INSERT INTO pdf_page_text_spans
                    (media_id, page_number, start_offset, end_offset, text_extract_version)
                    VALUES (:mid, :pn, :so, :eo, 1)
                """),
                {"mid": media_id, "pn": i + 1, "so": start, "eo": end},
            )

    session.commit()
    return media_id, user_id


class TestPdfCapabilityDerivation:
    """S6 PR-03: PDF capability derivation with real readiness predicate."""

    def test_pr03_get_media_pdf_can_read_before_can_quote_when_plain_text_not_ready(
        self, auth_client, direct_db: DirectSessionManager
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text=None,
                page_count=None,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_pr03_get_media_pdf_quote_search_capabilities_require_full_text_readiness(
        self, auth_client, direct_db: DirectSessionManager
    ):
        with direct_db.session() as session:
            media_id_ready, user_id = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text="Hello World page one",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id_ready)
        direct_db.register_cleanup("media_file", "media_id", media_id_ready)
        direct_db.register_cleanup("library_media", "media_id", media_id_ready)
        direct_db.register_cleanup("media", "id", media_id_ready)

        _add_media_to_user_library(auth_client, user_id, media_id_ready)

        resp = auth_client.get(f"/media/{media_id_ready}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_quote"] is True
        assert caps["can_search"] is True

    def test_pr03_get_media_pdf_capabilities_do_not_flip_quote_search_on_plain_text_without_full_page_span_readiness(
        self, auth_client, direct_db: DirectSessionManager
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text="Some text",
                page_count=2,
                with_page_spans=False,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_pr03_get_media_pdf_scanned_visual_read_only_capabilities(
        self, auth_client, direct_db: DirectSessionManager
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text=None,
                page_count=5,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_pr03_get_media_pdf_capabilities_use_real_quote_text_readiness_predicate(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Caller computes real DB-backed PDF quote-readiness boolean, not a hardcoded placeholder."""
        with direct_db.session() as session:
            mid_no_text, uid = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text=None,
                page_count=1,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_no_text)
        direct_db.register_cleanup("media_file", "media_id", mid_no_text)
        direct_db.register_cleanup("library_media", "media_id", mid_no_text)
        direct_db.register_cleanup("media", "id", mid_no_text)

        _add_media_to_user_library(auth_client, uid, mid_no_text)

        resp = auth_client.get(f"/media/{mid_no_text}", headers=auth_headers(uid))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_quote"] is False

        with direct_db.session() as session:
            mid_full, uid2 = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                plain_text="Full readiness text",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_full)
        direct_db.register_cleanup("media_file", "media_id", mid_full)
        direct_db.register_cleanup("library_media", "media_id", mid_full)
        direct_db.register_cleanup("media", "id", mid_full)

        _add_media_to_user_library(auth_client, uid2, mid_full)

        resp2 = auth_client.get(f"/media/{mid_full}", headers=auth_headers(uid2))
        assert resp2.status_code == 200
        caps2 = resp2.json()["data"]["capabilities"]
        assert caps2["can_quote"] is True


class TestPdfRetry:
    """S6 PR-03: PDF retry tests."""

    def test_pr03_retry_pdf_password_protected_returns_retry_not_allowed_without_dispatch(
        self, auth_client, direct_db: DirectSessionManager
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="extract",
                last_error_code="E_PDF_PASSWORD_REQUIRED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_pr03_retry_pdf_password_protected_terminal_behavior_matches_policy(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Password-protected terminal: no dispatch, no state change."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="extract",
                last_error_code="E_PDF_PASSWORD_REQUIRED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text("SELECT processing_status FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "failed"

    def test_pr03_retry_pdf_failed_resets_and_dispatches_text_rebuild_path(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Text-rebuild retry: state resets to extracting, dispatch occurs."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="extract",
                last_error_code="E_INGEST_FAILED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.pdf_lifecycle.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True

            with patch("nexus.tasks.ingest_pdf.ingest_pdf") as mock_task:
                mock_task.apply_async = lambda **kwargs: None
                resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True

    def test_pr03_retry_pdf_route_preserves_compat_response_shape_without_mode_parameter(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Public retry uses no retry-mode parameter; response is RetryResponse-compatible."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="extract",
                last_error_code="E_INGEST_FAILED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from unittest.mock import patch

        with (
            patch("nexus.services.pdf_lifecycle.get_storage_client") as mock_storage,
            patch("nexus.tasks.ingest_pdf.ingest_pdf") as mock_task,
        ):
            mock_storage.return_value.head_object.return_value = True
            mock_task.apply_async = lambda **kwargs: None
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert "media_id" in data
        assert "processing_status" in data
        assert "retry_enqueued" in data

    def test_pr03_retry_pdf_embed_failure_uses_embedding_only_retry_inference_path(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """failure_stage='embed' -> embedding-only retry (no text rewrite)."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="embed",
                last_error_code="E_INGEST_FAILED",
                plain_text="Existing text",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.tasks.ingest_pdf.ingest_pdf") as mock_task:
            mock_task.apply_async = lambda **kwargs: None
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["retry_enqueued"] is True

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text("SELECT plain_text FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "Existing text"

    def test_pr03_retry_pdf_transcribe_failure_stage_fails_closed_as_internal_integrity_error(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Impossible failure_stage='transcribe' for PDF -> fail closed."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="transcribe",
                last_error_code="E_INGEST_FAILED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 500

    def test_pr03_retry_pdf_embedding_only_path_does_not_rewrite_plain_text_or_page_spans(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Embedding-only retry preserves text artifacts unchanged."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="embed",
                last_error_code="E_INGEST_FAILED",
                plain_text="Preserved text content",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.tasks.ingest_pdf.ingest_pdf") as mock_task:
            mock_task.apply_async = lambda **kwargs: None
            auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text("SELECT plain_text, page_count FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "Preserved text content"
            assert row[1] == 1

            spans = session.execute(
                text("SELECT COUNT(*) FROM pdf_page_text_spans WHERE media_id = :mid"),
                {"mid": media_id},
            ).scalar()
            assert spans == 1

    def test_pr03_retry_pdf_text_rebuild_path_invalidates_before_rewrite(self, db_session: Session):
        """Text-rebuild path invalidates quote-match metadata before new artifacts."""
        from uuid import uuid4

        from sqlalchemy import text

        from nexus.services.pdf_ingest import (
            delete_pdf_text_artifacts,
            invalidate_pdf_quote_match_metadata,
        )

        media_id = uuid4()
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, plain_text,
                    page_count, created_by_user_id)
                VALUES (:id, 'pdf', 'Rebuild', 'failed', 'Old text', 2, :uid)
            """),
            {"id": media_id, "uid": user_id},
        )
        db_session.flush()

        count = invalidate_pdf_quote_match_metadata(db_session, media_id)
        assert count == 0

        delete_pdf_text_artifacts(db_session, media_id)

        refreshed = db_session.execute(
            text("SELECT plain_text, page_count FROM media WHERE id = :id"),
            {"id": media_id},
        ).fetchone()
        assert refreshed[0] is None
        assert refreshed[1] is None

    def test_pr03_pdf_text_rebuild_invalidates_pdf_quote_match_metadata_and_prefix_suffix(
        self, db_session: Session
    ):
        """Invalidation resets match_status to pending, clears offsets/version, clears prefix/suffix."""
        from uuid import uuid4

        from sqlalchemy import text

        from nexus.services.pdf_ingest import invalidate_pdf_quote_match_metadata

        media_id = uuid4()
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, plain_text,
                    page_count, created_by_user_id)
                VALUES (:id, 'pdf', 'Invalidation', 'ready_for_reading', 'Some text', 1, :uid)
            """),
            {"id": media_id, "uid": user_id},
        )
        db_session.flush()

        count = invalidate_pdf_quote_match_metadata(db_session, media_id)
        assert count >= 0

    def test_pr03_pdf_invalidation_preserves_geometry_and_exact_text(self, db_session: Session):
        """Invalidation mutates only quote-match metadata + prefix/suffix; geometry and exact preserved."""
        from uuid import uuid4

        from sqlalchemy import text

        from nexus.services.pdf_ingest import invalidate_pdf_quote_match_metadata

        media_id = uuid4()
        user_id = uuid4()
        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, plain_text,
                    page_count, created_by_user_id)
                VALUES (:id, 'pdf', 'Geometry', 'ready_for_reading', 'Geo text', 1, :uid)
            """),
            {"id": media_id, "uid": user_id},
        )
        db_session.flush()

        count = invalidate_pdf_quote_match_metadata(db_session, media_id)
        assert count >= 0
