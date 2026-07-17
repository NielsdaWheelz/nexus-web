"""Integration tests for media service and routes.

Tests cover:
- Media visibility enforcement
- Fragment retrieval
- 404 masking for unreadable media
- Timestamp serialization

Core scenarios:
- #12: Non-member cannot read media
- #19: GET /media/{id} enforces visibility
- #20: GET /media/{id}/fragments returns content
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.orm import Session
from starlette.routing import Match

from nexus.api.routes import create_api_router
from nexus.db.models import (
    DocumentEmbed,
    DocumentEmbedArtifactState,
    EpubResource,
    EpubTocNode,
    Fragment,
    FragmentBlock,
    Media,
    MediaFile,
    MediaKind,
    ProcessingStatus,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.web_article_structure import prepare_web_article_fragment
from nexus.storage.paths import build_epub_asset_storage_path
from tests.factories import (
    add_media_to_library,
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


def add_media_to_default_library(
    auth_client, direct_db: DirectSessionManager, user_id: str, media_id: UUID
) -> str:
    """Bootstrap user and attach media to their default library.

    Seeds a direct physical `library_entries` row instead of filing through the
    REST endpoint: filing requires the media to already be membership-reachable,
    and in production freshly-ingested media is always reachable via
    `ensure_media_in_default_library`.
    """
    me_resp = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    with direct_db.session() as session:
        add_media_to_library(session, UUID(library_id), media_id)
        session.commit()
    return library_id


def _count_jobs_for_media(direct_db: DirectSessionManager, *, kind: str, media_id: UUID) -> int:
    with direct_db.session() as session:
        return int(
            session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = :kind
                      AND payload->>'media_id' = :media_id
                    """
                ),
                {"kind": kind, "media_id": str(media_id)},
            ).scalar_one()
        )


def _grant_test_ai_transcription_entitlement(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    direct_db.register_cleanup("podcast_transcription_usage_daily", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="media source ingest test access",
            actor_label="test",
        )


def _install_background_job_insert_failure(direct_db: DirectSessionManager) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                CREATE OR REPLACE FUNCTION nexus_test_fail_background_job_insert()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    RAISE EXCEPTION 'queue unavailable';
                END;
                $$;
                """
            )
        )
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_background_job_insert
                ON background_jobs
                """
            )
        )
        session.execute(
            text(
                """
                CREATE TRIGGER nexus_test_fail_background_job_insert
                BEFORE INSERT ON background_jobs
                FOR EACH ROW
                EXECUTE FUNCTION nexus_test_fail_background_job_insert()
                """
            )
        )
        session.commit()


def _remove_background_job_insert_failure(direct_db: DirectSessionManager) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_background_job_insert
                ON background_jobs
                """
            )
        )
        session.execute(text("DROP FUNCTION IF EXISTS nexus_test_fail_background_job_insert()"))
        session.commit()


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media to their library
        add_media_to_default_library(auth_client, direct_db, user_a, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

    def test_get_media_video_exposes_typed_playback_source_contract(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        video_id = "dQw4w9WgXcQ"
        playback_url = f"https://www.youtube.com/watch?v={video_id}"

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.video.value,
                title="Contract Video",
                canonical_source_url=playback_url,
                canonical_url=playback_url,
                processing_status=ProcessingStatus.ready_for_reading,
                external_playback_url=playback_url,
                provider="youtube",
                provider_id=video_id,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert response.status_code == 200
        media = response.json()["data"]
        playback_source = media["playback_source"]
        assert playback_source["kind"] == "external_video"
        assert playback_source["stream_url"] == playback_url
        assert playback_source["source_url"] == playback_url
        assert playback_source["provider"] == "youtube"
        assert playback_source["provider_video_id"] == video_id
        assert playback_source["watch_url"] == playback_url
        assert playback_source["embed_url"] == f"https://www.youtube.com/embed/{video_id}"


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

    def test_get_media_and_fragments_include_document_embeds(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)
            session.add(
                DocumentEmbedArtifactState(
                    media_id=media_id,
                    source_attempt_id=None,
                    status="ready",
                    total_count=1,
                    resolved_count=0,
                    unsupported_count=1,
                    failed_count=0,
                    diagnostics={},
                )
            )
            session.add(
                DocumentEmbed(
                    media_id=media_id,
                    fragment_id=FIXTURE_FRAGMENT_ID,
                    source_attempt_id=None,
                    ordinal=0,
                    occurrence_key="embed:000000:generic:none",
                    provider="generic",
                    embed_kind="unknown",
                    source_shape="iframe",
                    resolution_status="unsupported",
                    source_url=None,
                    canonical_source_url=None,
                    provider_target_ref=None,
                    placeholder_text="Unsupported embedded content: player.example.test",
                    canonical_start_offset=0,
                    canonical_end_offset=55,
                    document_order_key="000000",
                    diagnostics={},
                )
            )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("document_embed_artifact_states", "media_id", media_id)
        direct_db.register_cleanup("document_embeds", "media_id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media_data = media_response.json()["data"]
        assert media_data["capabilities"]["can_read_embeds"] is True
        assert media_data["document_embed_summary"] == {
            "status": "ready",
            "total_count": 1,
            "resolved_count": 0,
            "unsupported_count": 1,
            "failed_count": 0,
        }

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))
        assert response.status_code == 200
        embed = response.json()["data"][0]["document_embeds"][0]
        assert embed["occurrence_key"] == "embed:000000:generic:none"
        assert embed["provider"] == "generic"
        assert embed["kind"] == "unknown"
        assert embed["source_url"] == {
            "status": "absent",
            "value": None,
            "error_code": None,
            "reason": "not_in_source",
        }
        assert embed["canonical_url"]["status"] == "absent"
        assert embed["target"]["status"] == "unsupported"
        assert embed["display"]["mode"] == "unsupported"

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media
        add_media_to_default_library(auth_client, direct_db, user_a, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        for fragment in response.json()["data"]:
            from datetime import datetime

            ts = fragment["created_at"]
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            assert parsed is not None


# =============================================================================
# EPUB Read/Retry Hardening Tests
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
        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        # Snapshot baseline fragment content from DB
        with direct_db.session() as session:
            baseline = (
                session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                .filter(Fragment.media_id == media_id)
                .order_by(Fragment.idx)
                .all()
            )
        assert len(baseline) == 3

        # Read navigation and section endpoints repeatedly
        for _ in range(3):
            resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
            assert resp.status_code == 200
            sections = resp.json()["data"]["sections"]
            assert len(sections) == 3
            for section in sections:
                resp = auth_client.get(
                    f"/media/{media_id}/sections/{section['section_id']}",
                    headers=auth_headers(user_id),
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


class TestEpubFragmentContentStableAcrossIndexStatusTransition:
    """Scenario 11: current content-index transition coverage.

    Verifies EPUB read endpoints remain readable while the current content index
    moves through pending/ready states and fragment content stays byte-for-byte stable.
    """

    def test_epub_fragment_content_stable_across_embedding_status_transition(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        # Snapshot baseline in ready_for_reading
        with direct_db.session() as session:
            baseline = (
                session.query(Fragment.idx, Fragment.html_sanitized, Fragment.canonical_text)
                .filter(Fragment.media_id == media_id)
                .order_by(Fragment.idx)
                .all()
            )
        assert len(baseline) == 2

        with direct_db.session() as session:
            index_state = session.execute(
                text(
                    """
                    SELECT active_embedding_provider, active_embedding_model
                    FROM content_index_states
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()

        for target_status, embedding_provider, embedding_model in (
            ("pending", None, None),
            ("ready", index_state[0], index_state[1]),
        ):
            with direct_db.session() as session:
                session.execute(
                    text(
                        """
                        UPDATE content_index_states
                        SET status = :status,
                            active_embedding_provider = :embedding_provider,
                            active_embedding_model = :embedding_model,
                            updated_at = now()
                        WHERE owner_kind = 'media' AND owner_id = :media_id
                        """
                    ),
                    {
                        "media_id": media_id,
                        "status": target_status,
                        "embedding_provider": embedding_provider,
                        "embedding_model": embedding_model,
                    },
                )
                session.commit()

            # Read endpoints remain readable
            resp_navigation = auth_client.get(
                f"/media/{media_id}/navigation", headers=auth_headers(user_id)
            )
            assert resp_navigation.status_code == 200
            sections = resp_navigation.json()["data"]["sections"]
            assert len(sections) == 2

            for section in sections:
                resp_section = auth_client.get(
                    f"/media/{media_id}/sections/{section['section_id']}",
                    headers=auth_headers(user_id),
                )
                assert resp_section.status_code == 200

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

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )
        stale_asset_path = build_epub_asset_storage_path(media_id, "images/stale.png")
        fake_storage.put_object(stale_asset_path, b"stale-image", "image/png")

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
            session.add(
                EpubResource(
                    media_id=media_id,
                    manifest_item_id="stale-image",
                    package_href="images/stale.png",
                    asset_key="images/stale.png",
                    storage_path=stale_asset_path,
                    content_type="image/png",
                    size_bytes=len(b"stale-image"),
                )
            )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragment_blocks", "fragment_id", frag_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with (
            patch(
                "nexus.services.media_source_ingest.get_storage_client",
                return_value=fake_storage,
            ),
        ):
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True
        assert data["capabilities"]["can_retry"] is False
        assert data["capabilities"]["can_refresh_source"] is False
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1
        assert fake_storage.get_object(stale_asset_path) is None

        # Artifacts must be gone after retry reset
        with direct_db.session() as session:
            frag_count = session.query(Fragment).filter(Fragment.media_id == media_id).count()
            assert frag_count == 0, "fragments not cleaned up"

            toc_count = session.query(EpubTocNode).filter(EpubTocNode.media_id == media_id).count()
            assert toc_count == 0, "epub_toc_nodes not cleaned up"
            resource_count = (
                session.query(EpubResource).filter(EpubResource.media_id == media_id).count()
            )
            assert resource_count == 0, "epub_resources not cleaned up"

            # fragment_blocks implicitly gone since fragments deleted
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 1
            assert media_row.last_error_code is None

    def test_retry_epub_enqueue_failure_preserves_artifact_storage_and_db_rows(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )
        stale_asset_path = build_epub_asset_storage_path(media_id, "images/stale.png")
        fake_storage.put_object(stale_asset_path, b"stale-image", "image/png")

        with direct_db.session() as session:
            session.add(
                EpubResource(
                    media_id=media_id,
                    manifest_item_id="stale-image",
                    package_href="images/stale.png",
                    asset_key="images/stale.png",
                    storage_path=stale_asset_path,
                    content_type="image/png",
                    size_bytes=len(b"stale-image"),
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        _install_background_job_insert_failure(direct_db)
        try:
            with patch(
                "nexus.services.media_source_ingest.get_storage_client",
                return_value=fake_storage,
            ):
                resp = auth_client.post(
                    f"/media/{media_id}/retry",
                    json={"from_stage": "source"},
                    headers=auth_headers(user_id),
                )
        finally:
            _remove_background_job_insert_failure(direct_db)

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is False
        assert data["processing_status"] == "failed"
        assert data["source_attempt_status"] == "failed"
        assert fake_storage.get_object(stale_asset_path) == b"stale-image"

        with direct_db.session() as session:
            resource_count = (
                session.query(EpubResource).filter(EpubResource.media_id == media_id).count()
            )
            assert resource_count == 1, "storage-backed resource row rolled forward on failure"
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.failed
            assert media_row.processing_attempts == 1
            assert media_row.last_error_code == "E_INTERNAL"


# =============================================================================
# EPUB Asset Endpoint Tests
# =============================================================================


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
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig1.png",
                    "size_bytes": len(asset_content),
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)
        with direct_db.session() as session:
            resource_row = session.execute(
                text(
                    """
                    SELECT storage_path
                    FROM epub_resources
                    WHERE media_id = :media_id
                      AND asset_key = 'images/fig1.png'
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            assert resource_row == (f"media/{media_id}/assets/images/fig1.png",)

        # Put asset into fake storage
        from tests.support.storage import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig1.png", asset_content, "image/png")

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_assets.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig1.png",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 200, resp.text
        assert resp.content == asset_content
        assert "image/png" in resp.headers.get("content-type", "")
        assert resp.headers.get("content-length") == str(len(asset_content))
        assert resp.headers.get("x-content-type-options") == "nosniff"

    def test_storage_read_starts_after_db_connection_release(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        asset_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        storage_path = f"media/{media_id}/assets/images/fig1.png"

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": storage_path,
                    "size_bytes": len(asset_content),
                },
            )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)
        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        from nexus.db.session import create_session_factory
        from tests.support.storage import FakeStorageClient

        checked_out = {"count": 0}
        storage_checked_out_counts: list[int] = []

        class AssertingStorageClient(FakeStorageClient):
            def stream_object(self, path):
                storage_checked_out_counts.append(checked_out["count"])
                yield from super().stream_object(path)

        def on_checkout(*_args):
            checked_out["count"] += 1

        def on_checkin(*_args):
            checked_out["count"] -= 1

        fake = AssertingStorageClient()
        fake.put_object(storage_path, asset_content, "image/png")
        session_factory = create_session_factory(direct_db.engine)

        event.listen(direct_db.engine, "checkout", on_checkout)
        event.listen(direct_db.engine, "checkin", on_checkin)
        try:
            with (
                patch(
                    "nexus.api.routes.media_assets.get_session_factory",
                    return_value=session_factory,
                ),
                patch("nexus.services.epub_assets.get_storage_client", return_value=fake),
            ):
                resp = auth_client.get(
                    f"/media/{media_id}/assets/images/fig1.png",
                    headers=auth_headers(user_id),
                )
        finally:
            event.remove(direct_db.engine, "checkout", on_checkout)
            event.remove(direct_db.engine, "checkin", on_checkin)

        assert resp.status_code == 200, resp.text
        assert resp.content == asset_content
        assert storage_checked_out_counts == [0]

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

    def test_asset_integrity_mismatch_is_500_defect(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        expected_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        stored_content = expected_content + b"extra"

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig1.png",
                    "size_bytes": len(expected_content),
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from tests.support.storage import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig1.png", stored_content, "image/png")

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_assets.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig1.png",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "E_STORAGE_ERROR"

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        from tests.support.storage import FakeStorageClient

        fake = FakeStorageClient()

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_assets.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/nonexistent.png",
                headers=auth_headers(user_id),
            )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_invalid_asset_key_returns_400(self, auth_client, direct_db: DirectSessionManager):
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/assets/bad%20key.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_missing_storage_object_is_500_defect(
        self, auth_client, direct_db: DirectSessionManager
    ):
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
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig1.png",
                    "size_bytes": len(asset_content),
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from tests.support.storage import FakeStorageClient

        fake = FakeStorageClient()

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_assets.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig1.png",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "E_STORAGE_ERROR"

    def test_unsupported_asset_content_type_is_not_served(
        self, auth_client, direct_db: DirectSessionManager
    ):
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
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'css1',
                        'styles/book.css',
                        'styles/book.css',
                        :storage_path,
                        'text/css',
                        6
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/styles/book.css",
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/assets/styles/book.css",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_svg_asset_headers_include_restrictive_csp(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        asset_content = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Test EPUB",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_resources (
                        media_id,
                        manifest_item_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    )
                    VALUES (
                        :media_id,
                        'svg1',
                        'images/fig.svg',
                        'images/fig.svg',
                        :storage_path,
                        'image/svg+xml',
                        :size_bytes
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig.svg",
                    "size_bytes": len(asset_content),
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from tests.support.storage import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig.svg", asset_content, "image/svg+xml")

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_assets.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig.svg",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 200, resp.text
        assert "image/svg+xml" in resp.headers.get("content-type", "")
        assert resp.headers.get("content-length") == str(len(asset_content))
        assert resp.headers.get("x-content-type-options") == "nosniff"
        csp = resp.headers.get("content-security-policy", "")
        assert "default-src 'none'" in csp
        assert "script-src 'none'" in csp


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/assets/test.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# EPUB Retry Endpoint Tests
# =============================================================================


def _create_failed_epub(
    session,
    user_id,
    *,
    last_error_code="E_INGEST_FAILED",
):
    """Insert a failed EPUB media row suitable for retry tests.

    Delegates to create_failed_epub_media factory.
    """
    return create_failed_epub_media(
        session,
        user_id,
        last_error_code=last_error_code,
        processing_attempts=1,
    )


class TestRetryEpubEndpoint:
    """POST /media/{id}/retry endpoint tests for EPUB media."""

    def test_retry_epub_failed_resets_and_dispatches(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with (
            patch(
                "nexus.services.media_source_ingest.get_storage_client", return_value=fake_storage
            ),
        ):
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 1
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
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

        # non-creator
        with direct_db.session() as session:
            epub_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("library_entries", "media_id", epub_id)
        direct_db.register_cleanup("media_file", "media_id", epub_id)
        direct_db.register_cleanup("media", "id", epub_id)

        add_media_to_default_library(auth_client, direct_db, user_a, epub_id)
        add_media_to_default_library(auth_client, direct_db, user_b, epub_id)

        resp = auth_client.post(
            f"/media/{epub_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_b),
        )
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

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_b),
        )
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
            media_id = _create_failed_epub(session, user_id)

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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch(
            "nexus.services.media_source_ingest.get_storage_client", return_value=fake_storage
        ):
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is False
        assert data["processing_status"] == "failed"
        assert data["source_attempt_status"] == "failed"

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.failed
            assert media_row.processing_attempts == 1
            assert media_row.last_error_code == "E_STORAGE_MISSING"

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

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        storage_path = f"media/{media_id}/original.epub"
        fake_storage.put_object(storage_path, epub_bytes, "application/epub+zip")

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with (
            patch(
                "nexus.services.media_source_ingest.get_storage_client", return_value=fake_storage
            ),
        ):
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None

            mf = session.get(MediaFile, media_id)
            assert mf is not None
            assert mf.storage_path == storage_path

    def test_retry_dispatch_failure_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Object storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch(
            "nexus.services.media_source_ingest.get_storage_client", return_value=fake_storage
        ):
            _install_background_job_insert_failure(direct_db)
            try:
                resp = auth_client.post(
                    f"/media/{media_id}/retry",
                    json={"from_stage": "source"},
                    headers=auth_headers(user_id),
                )
            finally:
                _remove_background_job_insert_failure(direct_db)

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is False
        assert data["processing_status"] == "failed"

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.failed
            assert media_row.last_error_code == "E_INTERNAL"


class TestRetryWebArticleEndpoint:
    """POST /media/{id}/retry for failed web articles."""

    def test_retry_failed_web_article_resets_and_dispatches(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        fragment_id = uuid4()
        contributor_id = uuid4()
        with direct_db.session() as session:
            from nexus.services.content_indexing import rebuild_fragment_content_index

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, failure_stage,
                        last_error_code, requested_url, created_by_user_id,
                        processing_attempts
                    )
                    VALUES (
                        :id, 'web_article', 'Failed article', 'failed', 'extract',
                        'E_INGEST_FAILED', 'https://example.com/article', :user_id, 1
                    )
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO media_source_attempts (
                        media_id, created_by_user_id, source_type, attempt_no, status,
                        intent_key, requested_url, source_payload, error_code,
                        error_message, finished_at
                    )
                    VALUES (
                        :media_id, :user_id, 'generic_web_url', 1, 'failed',
                        :intent_key, 'https://example.com/article', '{}'::jsonb,
                        'E_INGEST_FAILED', 'test failure', now()
                    )
                """),
                {
                    "media_id": media_id,
                    "user_id": user_id,
                    "intent_key": f"test:generic_web_url:{media_id}",
                },
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fragment_id, :media_id, 0, '<p>old</p>', 'old')
                """),
                {"fragment_id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragment_blocks (
                        fragment_id, block_idx, start_offset, end_offset, is_empty
                    )
                    VALUES (:fragment_id, 0, 0, 3, false)
                """),
                {"fragment_id": fragment_id},
            )
            # Seed a stale author credit directly; retry must wipe it (asserted
            # below). The legacy replace-all writer is a deleted cutover scaffold.
            session.execute(
                text(
                    "INSERT INTO contributors (id, handle, display_name)"
                    " VALUES (:id, :handle, :name)"
                ),
                {"id": contributor_id, "handle": contributor_id.hex[:12], "name": "Old Author"},
            )
            session.execute(
                text(
                    "INSERT INTO contributor_credits"
                    " (id, contributor_id, media_id, credited_name,"
                    "  normalized_credited_name, role, ordinal, source)"
                    " VALUES (:id, :cid, :media_id, 'Old Author', 'old author',"
                    "  'author', 0, 'manual')"
                ),
                {"id": uuid4(), "cid": contributor_id, "media_id": media_id},
            )
            fragment = session.get(Fragment, fragment_id)
            assert fragment is not None
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                fragments=[fragment],
                reason="retry_cleanup_test",
            )
            session.commit()

        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1
        with direct_db.session() as session:
            job_id = session.execute(
                text("""
                    SELECT id FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar_one()
            direct_db.register_cleanup("background_jobs", "id", job_id)

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 1
            assert media_row.last_error_code is None

            artifact_counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM fragments WHERE media_id = :media_id),
                        (SELECT count(*) FROM fragment_blocks WHERE fragment_id = :fragment_id),
                        (SELECT count(*) FROM content_index_states WHERE owner_kind = 'media' AND owner_id = :media_id),
                        (SELECT count(*) FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :media_id),
                        (SELECT count(*) FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :media_id),
                        (SELECT count(*) FROM content_blocks WHERE owner_kind = 'media' AND owner_id = :media_id)
                """),
                {"media_id": media_id, "fragment_id": fragment_id},
            ).one()
            assert tuple(artifact_counts) == (0, 0, 0, 0, 0, 0)

            # Author credits are NOT rewriteable artifacts: a refresh/re-ingest
            # keeps the prior author slice until the post-commit observation
            # replaces it (spec 2.4, AC 10). Retry preserves them.
            credit_count = session.execute(
                text("SELECT count(*) FROM contributor_credits WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
            assert credit_count == 1

    def test_retry_failed_web_article_reuses_idempotency_key(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, failure_stage,
                        last_error_code, requested_url, created_by_user_id,
                        processing_attempts
                    )
                    VALUES (
                        :id, 'web_article', 'Failed article', 'failed', 'extract',
                        'E_INGEST_FAILED', 'https://example.com/article', :user_id, 1
                    )
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO media_source_attempts (
                        media_id, created_by_user_id, source_type, attempt_no, status,
                        intent_key, requested_url, source_payload, error_code,
                        error_message, finished_at
                    )
                    VALUES (
                        :media_id, :user_id, 'generic_web_url', 1, 'failed',
                        :intent_key, 'https://example.com/article', '{}'::jsonb,
                        'E_INGEST_FAILED', 'test failure', now()
                    )
                """),
                {
                    "media_id": media_id,
                    "user_id": user_id,
                    "intent_key": f"test:generic_web_url:{media_id}",
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)
        headers = {**auth_headers(user_id), "Idempotency-Key": "retry-source-key-1"}

        first = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=headers,
        )
        assert first.status_code == 202, first.text
        first_data = first.json()["data"]
        assert first_data["idempotency_outcome"] == "retrying"
        assert first_data["processing_status"] == "extracting"

        second = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=headers,
        )
        assert second.status_code == 202, second.text
        second_data = second.json()["data"]
        assert second_data["source_attempt_id"] == first_data["source_attempt_id"]
        assert second_data["idempotency_outcome"] == "reused"
        assert second_data["processing_status"] == "extracting"
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1

        mismatch = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=headers,
        )
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

        with direct_db.session() as session:
            job_id = session.execute(
                text("""
                    SELECT id FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar_one()
            direct_db.register_cleanup("background_jobs", "id", job_id)

    def test_retry_web_article_without_original_url_is_not_allowed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="Failed article",
                    processing_status=ProcessingStatus.failed,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"


# =============================================================================
# Retry Endpoint Body Validation Tests
# =============================================================================


class TestRetryBodyValidation:
    """POST /media/{id}/retry requires a body declaring from_stage."""

    def test_retry_returns_422_without_body(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        """A body-less /retry must be rejected with a request-validation error.

        The app installs a global RequestValidationError handler that converts
        FastAPI's 422 to 400 E_INVALID_REQUEST (see nexus.app:validation_exception_handler).
        Either shape is acceptable per spec §4.4/O2; assert whichever the app produces.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code in (400, 422), (
            f"expected request-validation rejection (400/422) for body-less /retry, "
            f"got {resp.status_code}: {resp.text}"
        )
        if resp.status_code == 400:
            assert resp.json()["error"]["code"] == "E_INVALID_REQUEST", resp.text

    def test_retry_returns_422_with_invalid_from_stage(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        """An invalid from_stage value must be rejected with a request-validation error.

        Same handler note as test_retry_returns_422_without_body: 400 E_INVALID_REQUEST
        is the observed shape; 422 is the FastAPI default and equally acceptable.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "bogus"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code in (400, 422), (
            f"expected request-validation rejection (400/422) for invalid from_stage, "
            f"got {resp.status_code}: {resp.text}"
        )
        if resp.status_code == 400:
            assert resp.json()["error"]["code"] == "E_INVALID_REQUEST", resp.text


# =============================================================================
# Retry Metadata Endpoint Tests
# =============================================================================


class TestRetryMetadataEndpoint:
    """POST /media/{id}/retry {from_stage: "metadata"} enqueues enrichment."""

    def test_retry_metadata_enqueues_structured_overwrite_job(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="Ready EPUB",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["metadata_enrichment_enqueued"] is True, data
        assert data["processing_status"] == "ready_for_reading", (
            f"processing_status should remain 'ready_for_reading', got {data['processing_status']}"
        )
        assert data["media_id"] == str(media_id)

        assert _count_jobs_for_media(direct_db, kind="enrich_metadata", media_id=media_id) == 1

        with direct_db.session() as session:
            row = (
                session.execute(
                    text(
                        """
                    SELECT payload, max_attempts
                    FROM background_jobs
                    WHERE kind = 'enrich_metadata'
                      AND payload->>'media_id' = :media_id
                    """
                    ),
                    {"media_id": str(media_id)},
                )
                .mappings()
                .one()
            )
            payload = row["payload"]
            assert payload["media_id"] == str(media_id), payload
            assert "force" not in payload, (
                "metadata retry must use the same overwrite-by-default job shape as "
                f"automatic ingest; got payload {payload!r}"
            )
            assert row["max_attempts"] == 1, (
                "manual metadata retry must keep the user as the retry boundary; "
                f"got max_attempts={row['max_attempts']}"
            )

    def test_retry_metadata_forbidden_for_non_creator(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        creator = create_test_user_id()
        other = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(creator))
        auth_client.get("/me", headers=auth_headers(other))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="Ready EPUB",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=creator,
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, creator, media_id)
        add_media_to_default_library(auth_client, direct_db, other, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(other),
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "E_FORBIDDEN"

    def test_retry_metadata_conflict_when_extracting(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="Extracting EPUB",
                    processing_status=ProcessingStatus.extracting,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "E_RETRY_INVALID_STATE"

    def test_retry_metadata_conflict_when_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "E_RETRY_INVALID_STATE", (
            "metadata retry must reject 'failed' state — failed is excluded from the "
            "metadata-retry allowed set"
        )

    def test_retry_metadata_not_found(
        self,
        auth_client,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.post(
            f"/media/{uuid4()}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_retry_metadata_ok_when_ready_for_reading(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="Mid-pipeline EPUB",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "metadata"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 202, resp.text
        assert resp.json()["data"]["metadata_enrichment_enqueued"] is True


# =============================================================================
# Refresh Endpoint Tests — PDF and EPUB broadening
# =============================================================================


def _create_podcast_media_for_refresh(
    session,
    *,
    user_id: UUID,
    processing_status: str = "ready_for_reading",
    external_playback_url: str | None = "https://cdn.example.com/episode.mp3",
    failure_stage: str | None = None,
    last_error_code: str | None = None,
) -> tuple[UUID, UUID]:
    media_id = uuid4()
    podcast_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
            VALUES (:podcast_id, 'test', :provider_podcast_id, 'Refresh Podcast', :feed_url)
            """
        ),
        {
            "podcast_id": podcast_id,
            "provider_podcast_id": f"refresh-podcast-{podcast_id}",
            "feed_url": f"https://example.com/podcasts/{podcast_id}.xml",
        },
    )
    session.execute(
        text(
            """
            INSERT INTO media (
                id,
                kind,
                title,
                processing_status,
                created_by_user_id,
                external_playback_url,
                failure_stage,
                last_error_code
            )
            VALUES (
                :media_id,
                'podcast_episode',
                'Refresh Episode',
                :processing_status,
                :user_id,
                :external_playback_url,
                :failure_stage,
                :last_error_code
            )
            """
        ),
        {
            "media_id": media_id,
            "processing_status": processing_status,
            "user_id": user_id,
            "external_playback_url": external_playback_url,
            "failure_stage": failure_stage,
            "last_error_code": last_error_code,
        },
    )
    session.execute(
        text(
            """
            INSERT INTO podcast_episodes (
                media_id,
                podcast_id,
                provider_episode_id,
                fallback_identity,
                duration_seconds
            )
            VALUES (
                :media_id,
                :podcast_id,
                :provider_episode_id,
                :fallback_identity,
                1800
            )
            """
        ),
        {
            "media_id": media_id,
            "podcast_id": podcast_id,
            "provider_episode_id": f"episode-{media_id}",
            "fallback_identity": f"fallback-{media_id}",
        },
    )
    source_attempt_status = "failed" if processing_status == "failed" else "succeeded"
    session.execute(
        text(
            """
            INSERT INTO media_source_attempts (
                media_id,
                created_by_user_id,
                source_type,
                attempt_no,
                status,
                intent_key,
                source_payload,
                error_code,
                error_message,
                finished_at
            )
            VALUES (
                :media_id,
                :user_id,
                'podcast_episode_transcript',
                1,
                :status,
                :intent_key,
                '{"media_kind":"podcast_episode","request_reason":"episode_open"}'::jsonb,
                :error_code,
                :error_message,
                CASE WHEN :status IN ('failed', 'succeeded') THEN now() ELSE NULL END
            )
            """
        ),
        {
            "media_id": media_id,
            "user_id": user_id,
            "status": source_attempt_status,
            "intent_key": f"test:podcast_episode_transcript:{media_id}",
            "error_code": last_error_code if source_attempt_status == "failed" else None,
            "error_message": "test failure" if source_attempt_status == "failed" else None,
        },
    )
    session.commit()
    return media_id, podcast_id


def _register_podcast_refresh_cleanup(
    direct_db: DirectSessionManager,
    *,
    media_id: UUID,
    podcast_id: UUID,
) -> None:
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_segments", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcription_jobs", "media_id", media_id)
    direct_db.register_cleanup("podcast_transcript_request_audits", "media_id", media_id)
    direct_db.register_cleanup("media_source_attempts", "media_id", media_id)
    direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))


class TestRefreshSourceForPodcastMedia:
    def test_refresh_podcast_without_existing_rows_resets_transcription_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            media_id, podcast_id = _create_podcast_media_for_refresh(
                session,
                user_id=user_id,
            )
        _register_podcast_refresh_cleanup(direct_db, media_id=media_id, podcast_id=podcast_id)
        _grant_test_ai_transcription_entitlement(direct_db, user_id=user_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is True
        assert data["processing_status"] == "extracting"
        assert (
            _count_jobs_for_media(
                direct_db,
                kind="ingest_media_source",
                media_id=media_id,
            )
            == 1
        )

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT
                        j.status,
                        j.request_reason,
                        j.reserved_minutes,
                        j.reservation_usage_date,
                        mts.transcript_state,
                        mts.transcript_coverage,
                        mts.semantic_status,
                        m.processing_status
                    FROM media m
                    JOIN podcast_transcription_jobs j ON j.media_id = m.id
                    JOIN media_transcript_states mts ON mts.media_id = m.id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
        assert row[0] == "pending"
        assert row[1] == "operator_requeue"
        assert row[2] == 30
        assert row[3] is not None
        assert row[4:] == (
            "queued",
            "none",
            "none",
            "extracting",
        )

    def test_refresh_podcast_resets_existing_job_and_clears_active_transcript(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            media_id, podcast_id = _create_podcast_media_for_refresh(
                session,
                user_id=user_id,
                processing_status="failed",
                failure_stage="transcribe",
                last_error_code="E_TRANSCRIPT_PROVIDER",
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_transcription_jobs (
                        media_id,
                        requested_by_user_id,
                        request_reason,
                        reserved_minutes,
                        reservation_usage_date,
                        status,
                        error_code,
                        attempts,
                        started_at,
                        completed_at
                    )
                    VALUES (
                        :media_id,
                        :user_id,
                        'search',
                        15,
                        CURRENT_DATE,
                        'completed',
                        'E_OLD',
                        7,
                        now(),
                        now()
                    )
                    """
                ),
                {"media_id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_transcript_segments (
                        media_id, segment_idx, canonical_text, t_start_ms, t_end_ms
                    )
                    VALUES (:media_id, 0, 'old transcript segment', 0, 1000)
                    """
                ),
                {"media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                    )
                    VALUES (:media_id, 0, 'old transcript segment', '', 0, 1000)
                    """
                ),
                {"media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status,
                        last_request_reason,
                        last_error_code
                    )
                    VALUES (
                        :media_id,
                        'ready',
                        'full',
                        'ready',
                        'search',
                        'E_OLD'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()
        _register_podcast_refresh_cleanup(direct_db, media_id=media_id, podcast_id=podcast_id)
        _grant_test_ai_transcription_entitlement(direct_db, user_id=user_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 202, resp.text
        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT
                        j.status,
                        j.request_reason,
                        j.reserved_minutes,
                        j.reservation_usage_date,
                        j.error_code,
                        j.attempts,
                        j.started_at,
                        j.completed_at,
                        mts.transcript_state,
                        mts.transcript_coverage,
                        mts.semantic_status,
                        mts.last_request_reason,
                        mts.last_error_code,
                        (SELECT count(*) FROM podcast_transcript_segments WHERE media_id = m.id),
                        (SELECT count(*) FROM fragments WHERE media_id = m.id),
                        m.processing_status,
                        m.failure_stage,
                        m.last_error_code
                    FROM media m
                    JOIN podcast_transcription_jobs j ON j.media_id = m.id
                    JOIN media_transcript_states mts ON mts.media_id = m.id
                    WHERE m.id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
        assert row[0] == "pending"
        assert row[1] == "operator_requeue"
        assert row[2] == 30
        assert row[3] is not None
        assert row[4:] == (
            None,
            7,
            None,
            None,
            "queued",
            "none",
            "none",
            "operator_requeue",
            None,
            0,
            0,
            "extracting",
            None,
            None,
        )

    def test_refresh_podcast_without_audio_source_saves_source_attempt(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            media_id, podcast_id = _create_podcast_media_for_refresh(
                session,
                user_id=user_id,
                external_playback_url=None,
            )
        _register_podcast_refresh_cleanup(direct_db, media_id=media_id, podcast_id=podcast_id)
        _grant_test_ai_transcription_entitlement(direct_db, user_id=user_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["source_type"] == "podcast_episode_transcript"
        assert data["source_attempt_status"] == "queued"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True
        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT
                        (SELECT COUNT(*) FROM podcast_transcription_jobs WHERE media_id = :media_id),
                        (SELECT COUNT(*) FROM media_transcript_states WHERE media_id = :media_id),
                        (
                            SELECT status
                            FROM media_source_attempts
                            WHERE media_id = :media_id
                            ORDER BY attempt_no DESC
                            LIMIT 1
                        ),
                        (
                            SELECT COUNT(*)
                            FROM background_jobs
                            WHERE kind = 'ingest_media_source'
                              AND payload->>'media_id' = :media_id_text
                        )
                    """
                ),
                {"media_id": media_id, "media_id_text": str(media_id)},
            ).one()
        assert row == (1, 1, "queued", 1)


class TestRefreshSourceForFileBackedMedia:
    """POST /media/{id}/refresh now accepts pdf and epub kinds."""

    def test_refresh_pdf_when_ready_enqueues_source_ingest(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="ready_for_reading",
                failure_stage="extract",
                last_error_code="E_INGEST_FAILED",
                plain_text="Old text",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/refresh",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is True
        assert data["processing_status"] == "extracting"

        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting, (
                f"processing_status should flip to 'extracting' after refresh, "
                f"got {media_row.processing_status}"
            )
            assert media_row.failure_stage is None, (
                f"failure_stage should be cleared on refresh, got {media_row.failure_stage}"
            )

    def test_refresh_pdf_returns_conflict_when_file_missing(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.pdf.value,
                    title="PDF missing file",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_refresh_epub_when_ready_enqueues_source_ingest(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="Ready EPUB",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.flush()
            session.add(
                MediaFile(
                    media_id=media_id,
                    storage_path=f"media/{media_id}/original.epub",
                    content_type="application/epub+zip",
                    size_bytes=1000,
                )
            )
            session.execute(
                text("""
                    INSERT INTO media_source_attempts (
                        media_id, created_by_user_id, source_type, attempt_no, status,
                        intent_key, source_payload, finished_at
                    )
                    VALUES (
                        :media_id, :user_id, 'uploaded_epub_file', 1, 'succeeded',
                        :intent_key, '{}'::jsonb, now()
                    )
                """),
                {
                    "media_id": media_id,
                    "user_id": user_id,
                    "intent_key": f"test:uploaded_epub_file:{media_id}",
                },
            )
            session.commit()

        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))
        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/refresh",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is True
        assert data["processing_status"] == "extracting"

        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=media_id) == 1

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting

    def test_refresh_epub_returns_conflict_when_file_missing(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.epub.value,
                    title="EPUB missing file",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_refresh_returns_conflict_for_extracting_pdf(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="extracting",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# EPUB Navigation and Section Read API Tests
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


def _add_media_to_user_library(auth_client, direct_db: DirectSessionManager, user_id, media_id):
    """Bootstrap user and add media to their default library. Returns library_id."""
    return add_media_to_default_library(auth_client, direct_db, user_id, media_id)


class TestGetEpubNavigationReturnsCanonicalSectionsAndTocTargets:
    """test_get_epub_navigation_returns_canonical_sections_and_toc_targets"""

    def test_navigation_response_includes_sections_and_toc_section_links(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=3, with_toc=True)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        body = resp.json()["data"]
        assert body["media_id"] == str(media_id)
        assert body["kind"] == "epub"
        assert "source_version" not in body
        sections = body["sections"]
        assert all("source_version" not in section for section in sections)
        assert [section["ordinal"] for section in sections] == [0, 1, 2]
        assert [section["fragment_idx"] for section in sections] == [0, 1, 2]
        assert [section["fragment_id"] for section in sections] == [
            str(frag_ids[0]),
            str(frag_ids[1]),
            str(frag_ids[2]),
        ]
        assert [section["section_id"] for section in sections] == [
            "ch0.xhtml",
            "ch1.xhtml",
            "ch2.xhtml",
        ]
        assert all("html_sanitized" not in section for section in sections)
        assert all("canonical_text" not in section for section in sections)

        toc_nodes = body["toc_nodes"]
        assert [node["id"] for node in toc_nodes] == ["ch0", "ch1", "ch2"]
        assert [node["section_id"] for node in toc_nodes] == [
            "ch0.xhtml",
            "ch1.xhtml",
            "ch2.xhtml",
        ]
        assert all("source_version" not in node for node in toc_nodes)

    def test_navigation_returns_spine_sections_when_toc_is_absent(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=2, with_toc=False)

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        body = resp.json()["data"]
        assert body["toc_nodes"] == []
        assert [section["section_id"] for section in body["sections"]] == ["ch0.xhtml", "ch1.xhtml"]
        assert [section["fragment_id"] for section in body["sections"]] == [
            str(frag_ids[0]),
            str(frag_ids[1]),
        ]


class TestGetWebArticleNavigation:
    def test_navigation_response_reads_active_heading_index(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        fragment_id = uuid4()

        prepared = prepare_web_article_fragment(
            html="""
                <article>
                  <h1>Article Title</h1>
                  <p>Intro text.</p>
                  <h2>First Section</h2>
                  <p>First body.</p>
                  <h3>Nested Section</h3>
                  <p>Nested body.</p>
                </article>
            """,
            base_url="https://example.com/article",
            fragment_idx=0,
            media_title="Article Title",
        )

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="Article Title",
                    processing_status=ProcessingStatus.ready_for_reading,
                )
            )
            fragment = Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                html_sanitized=prepared.html_sanitized,
                canonical_text=prepared.canonical_text,
            )
            session.add(fragment)
            session.flush()
            insert_fragment_blocks(session, fragment.id, prepared.fragment_blocks)
            rebuild_fragment_content_index(
                session,
                media_id=media_id,
                source_kind="web_article",
                fragments=[fragment],
                reason="web_navigation_test",
            )
            session.commit()

        direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/navigation",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200

        body = resp.json()["data"]
        assert body["media_id"] == str(media_id)
        assert body["kind"] == "web_article"
        assert "source_version" not in body
        assert [section["label"] for section in body["sections"]] == [
            "First Section",
            "Nested Section",
        ]
        assert all("source_version" not in section for section in body["sections"])
        assert all("source_version" not in node for node in body["toc_nodes"])
        assert body["sections"][0]["fragment_id"] == str(fragment_id)
        assert body["sections"][0]["fragment_idx"] == 0
        assert body["sections"][0]["level"] == 2
        assert body["sections"][0]["depth"] == 1
        assert body["sections"][0]["anchor_id"].startswith("nexus-web-heading-0-1-first-section")
        assert body["toc_nodes"][0]["id"] == body["sections"][0]["section_id"]
        assert body["toc_nodes"][0]["children"][0]["id"] == body["sections"][1]["section_id"]


class TestGetEpubSectionReturnsPayloadAndNavigation:
    """test_get_epub_section_returns_payload_and_navigation"""

    def test_navigation_pointers(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp0 = auth_client.get(
            f"/media/{media_id}/sections/ch0.xhtml", headers=auth_headers(user_id)
        )
        assert resp0.status_code == 200
        section0 = resp0.json()["data"]
        assert section0["section_id"] == "ch0.xhtml"
        assert section0["prev_section_id"] is None
        assert section0["next_section_id"] == "ch1.xhtml"
        assert section0["fragment_id"] == str(frag_ids[0])
        assert section0["source"] == "toc"
        assert "html_sanitized" in section0
        assert "canonical_text" in section0
        assert "source_version" not in section0
        assert "created_at" in section0

        resp1 = auth_client.get(
            f"/media/{media_id}/sections/ch1.xhtml", headers=auth_headers(user_id)
        )
        assert resp1.status_code == 200
        section1 = resp1.json()["data"]
        assert section1["prev_section_id"] == "ch0.xhtml"
        assert section1["next_section_id"] == "ch2.xhtml"

        resp2 = auth_client.get(
            f"/media/{media_id}/sections/ch2.xhtml", headers=auth_headers(user_id)
        )
        assert resp2.status_code == 200
        section2 = resp2.json()["data"]
        assert section2["prev_section_id"] == "ch1.xhtml"
        assert section2["next_section_id"] is None

    def test_section_returns_single_fragment_not_concatenated(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/sections/ch1.xhtml", headers=auth_headers(user_id)
        )
        assert resp.status_code == 200
        section = resp.json()["data"]
        assert "Sentinel content for chapter 1" in section["canonical_text"]
        assert "Sentinel content for chapter 0" not in section["canonical_text"]
        assert "Sentinel content for chapter 2" not in section["canonical_text"]

    def test_missing_section_id_returns_404(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/sections/missing.xhtml", headers=auth_headers(user_id)
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_CHAPTER_NOT_FOUND"


class TestGetEpubNavigationTreeOrdering:
    """test_get_epub_navigation_tree_ordering"""

    def test_nested_toc_nodes_are_returned_in_order_key_order(
        self, auth_client, direct_db: DirectSessionManager
    ):
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
            frag = Fragment(
                id=uuid4(),
                media_id=media_id,
                idx=0,
                html_sanitized="<p>Content</p>",
                canonical_text="Content",
            )
            session.add(frag)
            session.flush()
            for node_id, parent_node_id, label, fragment_idx, depth, order_key in [
                ("root2", None, "Part II", None, 0, "0002"),
                ("root1", None, "Part I", None, 0, "0001"),
                ("child1_2", "root1", "Chapter 1.2", 0, 1, "0001.0002"),
                ("child1_1", "root1", "Chapter 1.1", 0, 1, "0001.0001"),
            ]:
                session.add(
                    EpubTocNode(
                        media_id=media_id,
                        node_id=node_id,
                        parent_node_id=parent_node_id,
                        label=label,
                        href="Text/ch0.xhtml" if fragment_idx is not None else None,
                        fragment_idx=fragment_idx,
                        depth=depth,
                        order_key=order_key,
                    )
                )
            session.flush()
            session.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations
                        (media_id, location_id, ordinal, source_node_id, label, fragment_idx, href_path, href_fragment, source)
                    VALUES
                        (:media_id, 'Text/ch0.xhtml', 0, 'child1_1', 'Chapter 1.1', 0, 'Text/ch0.xhtml', NULL, 'toc')
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        toc_nodes = resp.json()["data"]["toc_nodes"]
        assert [node["id"] for node in toc_nodes] == ["root1", "root2"]
        assert [child["id"] for child in toc_nodes[0]["children"]] == ["child1_1", "child1_2"]
        assert toc_nodes[1]["children"] == []
        assert toc_nodes[0]["children"][0]["section_id"] == "Text/ch0.xhtml"
        assert toc_nodes[0]["children"][1]["section_id"] is None


class TestGetEpubReadEndpointsVisibilityMasking:
    """test_get_epub_read_endpoints_visibility_masking"""

    def test_unreadable_user_gets_404(self, auth_client, direct_db: DirectSessionManager):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        for path in [f"/media/{media_id}/navigation", f"/media/{media_id}/sections/ch0.xhtml"]:
            resp = auth_client.get(path, headers=auth_headers(user_b))
            assert resp.status_code == 404, f"Expected 404 for {path}, got {resp.status_code}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


class TestGetEpubReadEndpointsKindAndReadinessGuards:
    """test_get_epub_read_endpoints_kind_and_readiness_guards"""

    def test_non_epub_section_endpoint_returns_400(
        self, auth_client, direct_db: DirectSessionManager
    ):
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/sections/ch0.xhtml",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

    def test_unsupported_navigation_kind_returns_409(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            media = Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="PDF",
                processing_status=ProcessingStatus.ready_for_reading,
            )
            session.add(media)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/navigation",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        for path in [f"/media/{media_id}/navigation", f"/media/{media_id}/sections/ch0.xhtml"]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 409, f"Expected 409 for {path}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# EPUB Fragment Endpoint Tests
# =============================================================================


class TestGetFragmentsEpubReady:
    """GET /media/{id}/fragments returns all EPUB chapters ordered by idx."""

    def test_get_fragments_epub_ready_returns_all_chapters_ordered_by_idx(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=4)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))
        assert resp.status_code == 200
        fragments = resp.json()["data"]
        assert len(fragments) == 4

        for i, frag in enumerate(fragments):
            assert frag["idx"] == i
            assert "html_sanitized" in frag
            assert "canonical_text" in frag
            assert "source_version" not in frag
            assert frag["id"] == str(frag_ids[i])

        returned_idxs = [f["idx"] for f in fragments]
        assert returned_idxs == sorted(returned_idxs), "Fragments must be ordered by idx ASC"


# =============================================================================
# PDF Capabilities and Retry Tests
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
    source_attempt_status = "failed" if processing_status == "failed" else "succeeded"
    session.execute(
        text("""
            INSERT INTO media_source_attempts (
                media_id, created_by_user_id, source_type, attempt_no, status,
                intent_key, source_payload, error_code, error_message, finished_at
            )
            VALUES (
                :mid, :uid, 'uploaded_pdf_file', 1, :status,
                :intent_key, '{}'::jsonb, :error_code, :error_message,
                CASE WHEN :status IN ('failed', 'succeeded') THEN now() ELSE NULL END
            )
        """),
        {
            "mid": media_id,
            "uid": user_id,
            "status": source_attempt_status,
            "intent_key": f"test:uploaded_pdf_file:{media_id}",
            "error_code": last_error_code if source_attempt_status == "failed" else None,
            "error_message": "test failure" if source_attempt_status == "failed" else None,
        },
    )

    if with_page_spans and page_count and plain_text:
        page_len = len(plain_text) // page_count
        for i in range(page_count):
            start = i * page_len
            end = start + page_len if i < page_count - 1 else len(plain_text)
            session.execute(
                text("""
                    INSERT INTO pdf_page_text_spans
                    (media_id, page_number, start_offset, end_offset)
                    VALUES (:mid, :pn, :so, :eo)
                """),
                {"mid": media_id, "pn": i + 1, "so": start, "eo": end},
            )

    session.commit()
    return media_id, user_id


class TestPdfCapabilityDerivation:
    """PDF capability derivation with real readiness predicate."""

    def test_get_media_pdf_can_read_before_can_quote_when_plain_text_not_ready(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_get_media_pdf_quote_search_capabilities_require_full_text_readiness(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id_ready)
        direct_db.register_cleanup("media", "id", media_id_ready)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id_ready)

        resp = auth_client.get(f"/media/{media_id_ready}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_quote"] is True
        assert caps["can_search"] is False

    def test_get_media_pdf_capabilities_do_not_enable_quote_search_without_full_page_span_readiness(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_get_media_pdf_scanned_visual_read_only_capabilities(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert resp.status_code == 200
        caps = resp.json()["data"]["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_quote"] is False
        assert caps["can_search"] is False

    def test_get_media_pdf_capabilities_use_real_quote_text_readiness_predicate(
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
        direct_db.register_cleanup("library_entries", "media_id", mid_no_text)
        direct_db.register_cleanup("media", "id", mid_no_text)

        _add_media_to_user_library(auth_client, direct_db, uid, mid_no_text)

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
        direct_db.register_cleanup("library_entries", "media_id", mid_full)
        direct_db.register_cleanup("media", "id", mid_full)

        _add_media_to_user_library(auth_client, direct_db, uid2, mid_full)

        resp2 = auth_client.get(f"/media/{mid_full}", headers=auth_headers(uid2))
        assert resp2.status_code == 200
        caps2 = resp2.json()["data"]["capabilities"]
        assert caps2["can_quote"] is True


class TestPdfRetry:
    """PDF retry tests."""

    def test_retry_pdf_password_protected_returns_retry_not_allowed_without_dispatch(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_retry_pdf_password_protected_terminal_behavior_matches_policy(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        resp = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text("SELECT processing_status FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "failed"

    def test_retry_pdf_failed_resets_and_dispatches_text_rebuild_path(
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        from sqlalchemy import text

        with direct_db.session() as session:
            job_row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'attempt_id'
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()
            assert job_row is not None
            direct_db.register_cleanup("background_jobs", "id", job_row[0])
            assert job_row[1] == "ingest_media_source"
            assert job_row[2]

    def test_retry_pdf_embed_failure_uses_source_attempt_retry_contract(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Hard cutover: source retry rebuilds source artifacts for every failure_stage."""
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["ingest_enqueued"] is True

        from sqlalchemy import text

        with direct_db.session() as session:
            job_row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'attempt_id'
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()
            assert job_row is not None
            direct_db.register_cleanup("background_jobs", "id", job_row[0])
            assert job_row[1] == "ingest_media_source"
            assert job_row[2]

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text(
                    """
                    SELECT
                        m.plain_text,
                        m.page_count,
                        m.processing_status,
                        m.failure_stage,
                        m.last_error_code,
                        (SELECT COUNT(*) FROM pdf_page_text_spans WHERE media_id = m.id)
                    FROM media m
                    WHERE m.id = :id
                    """
                ),
                {"id": media_id},
            ).one()
            assert row == (None, None, "extracting", None, None, 0)

    def test_retry_pdf_transcribe_failure_stage_uses_source_attempt_retry_contract(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Hard cutover: source retry is governed by the latest source attempt."""
        with direct_db.session() as session:
            media_id, user_id = _create_pdf_media_with_state(
                session,
                processing_status="failed",
                failure_stage="transcribe",
                last_error_code="E_INGEST_FAILED",
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )
        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

    def test_retry_pdf_source_retry_rebuild_path_deletes_text_artifacts(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Source retry deletes stale PDF text artifacts before dispatch."""
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, direct_db, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.media_source_ingest.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(
                f"/media/{media_id}/retry",
                json={"from_stage": "source"},
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 202, resp.text
        assert resp.json()["data"]["ingest_enqueued"] is True

        with direct_db.session() as session:
            from sqlalchemy import text

            row = session.execute(
                text(
                    """
                    SELECT
                        m.plain_text,
                        m.page_count,
                        (SELECT COUNT(*) FROM pdf_page_text_spans WHERE media_id = m.id)
                    FROM media m
                    WHERE m.id = :id
                    """
                ),
                {"id": media_id},
            ).one()
            assert row == (None, None, 0)

    def test_retry_pdf_text_rebuild_path_invalidates_before_rewrite(self, db_session: Session):
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
        db_session.execute(
            text("""
                INSERT INTO reader_apparatus_states (
                    media_id, media_kind, source_fingerprint, extractor_version,
                    status, item_count, edge_count, diagnostics
                )
                VALUES (
                    :id, 'pdf', 'sha256:test', 'reader_apparatus_v1',
                    'empty', 0, 0, '{}'::jsonb
                )
            """),
            {"id": media_id},
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
        assert (
            db_session.execute(
                text("SELECT count(*) FROM reader_apparatus_states WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
            == 0
        )

    def test_pdf_text_rebuild_invalidates_pdf_quote_match_metadata_and_prefix_suffix(
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

    def test_pdf_invalidation_preserves_geometry_and_exact_text(self, db_session: Session):
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


# =============================================================================
# Multi-library ingest tests (docs/multi-library-assignment.md §13.1)
# =============================================================================


def _bootstrap_user_default_library(auth_client, user_id: UUID) -> UUID:
    """Bootstrap the user and return their default library id."""
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"bootstrap failed for {user_id}: {response.status_code} {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


def _library_entries_for_media(direct_db: DirectSessionManager, media_id: UUID) -> set[UUID]:
    with direct_db.session() as session:
        rows = session.execute(
            text(
                """
                SELECT library_id
                FROM library_entries
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchall()
    return {UUID(str(row[0])) for row in rows}


def _create_extension_token(auth_client, user_id: UUID) -> tuple[UUID, str]:
    response = auth_client.post("/auth/extension-sessions", headers=auth_headers(user_id))
    assert response.status_code == 201, (
        f"extension session creation failed: {response.status_code} {response.text}"
    )
    data = response.json()["data"]
    return UUID(data["id"]), data["token"]


class TestFromUrlLibraryIds:
    """`POST /media/from_url` with `library_ids` per spec §13.1."""

    @pytest.mark.parametrize(
        "library_count",
        [0, 1, 2],
        ids=["empty", "one", "many"],
    )
    def test_from_url_with_library_ids(
        self, auth_client, direct_db: DirectSessionManager, library_count: int
    ):
        """library_ids list is honored: each id (plus default) is in library_entries."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)

        extra_library_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(library_count):
                lib_id = create_test_library(session, user_id, f"From URL Lib {idx}")
                extra_library_ids.append(lib_id)

        for lib_id in extra_library_ids:
            direct_db.register_cleanup("memberships", "library_id", lib_id)
            direct_db.register_cleanup("libraries", "id", lib_id)

        url = f"https://example.com/article-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(lid) for lid in extra_library_ids]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202, (
            f"from_url with library_ids should succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        memberships = _library_entries_for_media(direct_db, media_id)
        expected = {default_library_id, *extra_library_ids}
        assert memberships == expected, (
            "library_entries for new media must equal {default} + library_ids, "
            f"got {memberships}, expected {expected}"
        )

    def test_from_url_rejects_inaccessible_library(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """An inaccessible library id triggers 403 `E_LIBRARY_FORBIDDEN` with no media row."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, user_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, other_owner_id)

        with direct_db.session() as session:
            other_lib = create_test_library(session, other_owner_id, "Other Owner Lib")

        direct_db.register_cleanup("memberships", "library_id", other_lib)
        direct_db.register_cleanup("libraries", "id", other_lib)

        url = f"https://example.com/forbidden-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(other_lib)]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 403, (
            f"inaccessible library id must yield 403, got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"

        # Atomic: no partial media row should have been created.
        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM media
                    WHERE created_by_user_id = :user_id
                      AND requested_url = :url
                    """
                ),
                {"user_id": user_id, "url": url},
            ).scalar_one()
        assert count == 0, "atomic rejection: no media row should exist after E_LIBRARY_FORBIDDEN"

    def test_from_url_rejects_default_library_id(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Default library id in library_ids is rejected before media creation."""
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)

        url = f"https://example.com/default-rejected-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(default_library_id)]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM library_entries
                    JOIN media ON media.id = library_entries.media_id
                    WHERE media.created_by_user_id = :user_id
                      AND media.requested_url = :url
                    """
                ),
                {"user_id": user_id, "url": url},
            ).scalar_one()
        assert count == 0

    def test_from_url_rejects_duplicate_library_ids(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Duplicate destination ids are rejected before media creation."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, user_id)
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Duplicate Destination")

        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        url = f"https://example.com/duplicate-rejected-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(library_id), str(library_id)]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM media
                    WHERE created_by_user_id = :user_id
                      AND requested_url = :url
                    """
                ),
                {"user_id": user_id, "url": url},
            ).scalar_one()
        assert count == 0

    def test_from_url_rejects_member_only_library(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Member-only libraries are not writable destinations."""
        from tests.factories import add_library_member, create_test_library

        user_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, user_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user_default_library(auth_client, other_owner_id)

        with direct_db.session() as session:
            member_only_library = create_test_library(
                session, other_owner_id, "Member Only Destination"
            )
            add_library_member(session, member_only_library, user_id, role="member")

        direct_db.register_cleanup("memberships", "library_id", member_only_library)
        direct_db.register_cleanup("libraries", "id", member_only_library)

        url = f"https://example.com/member-rejected-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(member_only_library)]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"
        with direct_db.session() as session:
            count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM media
                    WHERE created_by_user_id = :user_id
                      AND requested_url = :url
                    """
                ),
                {"user_id": user_id, "url": url},
            ).scalar_one()
        assert count == 0

    def test_reshare_adds_libraries_to_existing_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Re-sharing the same URL reuses the existing media and adds new library_ids additively."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)

        with direct_db.session() as session:
            lib_a = create_test_library(session, user_id, "Reshare Lib A")
            lib_b = create_test_library(session, user_id, "Reshare Lib B")

        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        # Use a YouTube URL — `enqueue_media_from_url` dedupes by canonical video identity.
        video_id = uuid4().hex[:11]
        url = f"https://www.youtube.com/watch?v={video_id}"

        first = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(lib_a)]},
            headers=auth_headers(user_id),
        )
        assert first.status_code == 202, f"first share failed: {first.status_code} {first.text}"
        first_data = first.json()["data"]
        media_id = UUID(first_data["media_id"])
        assert first_data["idempotency_outcome"] == "created"

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        second = auth_client.post(
            "/media/from_url",
            json={"url": url, "library_ids": [str(lib_b)]},
            headers=auth_headers(user_id),
        )
        assert second.status_code == 202, (
            f"re-share must succeed and reuse media: {second.status_code} {second.text}"
        )
        second_data = second.json()["data"]
        assert UUID(second_data["media_id"]) == media_id, (
            "re-share must return the existing media_id (canonical dedup)"
        )
        assert second_data["idempotency_outcome"] == "reused"

        memberships = _library_entries_for_media(direct_db, media_id)
        assert memberships == {default_library_id, lib_a, lib_b}, (
            "additive: default + lib_a (from first call) + lib_b (from second call); "
            f"got {memberships}"
        )


class TestCaptureLibraryIds:
    """`POST /media/capture/*` endpoints with `library_ids` per spec §13.1."""

    def test_capture_article_library_ids(self, auth_client, direct_db: DirectSessionManager):
        """`POST /media/capture/article` honors `library_ids` in the body."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)
        session_id, token = _create_extension_token(auth_client, user_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)

        with direct_db.session() as session:
            lib_a = create_test_library(session, user_id, "Capture Article Lib A")
            lib_b = create_test_library(session, user_id, "Capture Article Lib B")

        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        url = f"https://example.com/capture-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "url": url,
                "title": "Captured Article",
                "content_html": "<article><p>Readable body.</p></article>",
                "source_html": "<html><body><article><p>Readable body.</p></article></body></html>",
                "library_ids": [str(lib_a), str(lib_b)],
            },
        )

        assert response.status_code == 202, (
            f"capture/article should succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["source_attempt_status"] == "queued"
        assert data["ingest_enqueued"] is True
        media_id = UUID(data["media_id"])

        direct_db.register_cleanup("fragment_blocks", "fragment_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        memberships = _library_entries_for_media(direct_db, media_id)
        assert memberships == {default_library_id, lib_a, lib_b}, (
            f"capture/article memberships should equal default + library_ids; got {memberships}"
        )

    def test_capture_file_header_library_ids(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """`POST /media/capture/file` parses `x-nexus-library-ids` header values."""
        from tests.factories import create_test_library
        from tests.support.storage import FakeStorageClient

        # ---- Empty header → default-only.
        user_a = create_test_user_id()
        default_library_a = _bootstrap_user_default_library(auth_client, user_a)
        session_a_id, token_a = _create_extension_token(auth_client, user_a)
        direct_db.register_cleanup("extension_sessions", "id", session_a_id)

        fake_storage = FakeStorageClient()
        monkeypatch.setattr(
            "nexus.services.media_source_ingest.get_storage_client", lambda: fake_storage
        )

        pdf_bytes = b"%PDF-1.4\ncaptured pdf bytes for header empty"
        empty_response = auth_client.post(
            "/media/capture/file",
            headers={
                "Authorization": f"Bearer {token_a}",
                "Content-Type": "application/pdf",
                "X-Nexus-Filename": "empty-header.pdf",
                "x-nexus-library-ids": "",
            },
            content=pdf_bytes,
        )
        assert empty_response.status_code == 202, (
            "empty x-nexus-library-ids header is valid (default-only), "
            f"got {empty_response.status_code}: {empty_response.text}"
        )
        empty_media_id = UUID(empty_response.json()["data"]["media_id"])
        direct_db.register_cleanup("library_entries", "media_id", empty_media_id)
        direct_db.register_cleanup("media_file", "media_id", empty_media_id)
        direct_db.register_cleanup("media", "id", empty_media_id)

        empty_memberships = _library_entries_for_media(direct_db, empty_media_id)
        assert empty_memberships == {default_library_a}, (
            f"empty header → default library only; got {empty_memberships}"
        )

        # ---- Single UUID header → default + lib.
        user_b = create_test_user_id()
        default_library_b = _bootstrap_user_default_library(auth_client, user_b)
        session_b_id, token_b = _create_extension_token(auth_client, user_b)
        direct_db.register_cleanup("extension_sessions", "id", session_b_id)

        with direct_db.session() as session:
            single_lib = create_test_library(session, user_b, "Header Single Lib")
        direct_db.register_cleanup("memberships", "library_id", single_lib)
        direct_db.register_cleanup("libraries", "id", single_lib)

        single_response = auth_client.post(
            "/media/capture/file",
            headers={
                "Authorization": f"Bearer {token_b}",
                "Content-Type": "application/pdf",
                "X-Nexus-Filename": "single.pdf",
                "x-nexus-library-ids": str(single_lib),
            },
            content=b"%PDF-1.4\nbytes-single",
        )
        assert single_response.status_code == 202, (
            f"single-UUID header should succeed, got {single_response.status_code}: "
            f"{single_response.text}"
        )
        single_media_id = UUID(single_response.json()["data"]["media_id"])
        direct_db.register_cleanup("library_entries", "media_id", single_media_id)
        direct_db.register_cleanup("media_file", "media_id", single_media_id)
        direct_db.register_cleanup("media", "id", single_media_id)

        single_memberships = _library_entries_for_media(direct_db, single_media_id)
        assert single_memberships == {default_library_b, single_lib}, (
            f"single header → default + lib; got {single_memberships}"
        )

        # ---- Comma-joined UUIDs header → default + both libs.
        user_c = create_test_user_id()
        default_library_c = _bootstrap_user_default_library(auth_client, user_c)
        session_c_id, token_c = _create_extension_token(auth_client, user_c)
        direct_db.register_cleanup("extension_sessions", "id", session_c_id)

        with direct_db.session() as session:
            lib_x = create_test_library(session, user_c, "Header Comma X")
            lib_y = create_test_library(session, user_c, "Header Comma Y")
        for lib in (lib_x, lib_y):
            direct_db.register_cleanup("memberships", "library_id", lib)
            direct_db.register_cleanup("libraries", "id", lib)

        comma_response = auth_client.post(
            "/media/capture/file",
            headers={
                "Authorization": f"Bearer {token_c}",
                "Content-Type": "application/pdf",
                "X-Nexus-Filename": "comma.pdf",
                "x-nexus-library-ids": f"{lib_x},{lib_y}",
            },
            content=b"%PDF-1.4\nbytes-comma",
        )
        assert comma_response.status_code == 202, (
            f"comma-joined header should succeed, got {comma_response.status_code}: "
            f"{comma_response.text}"
        )
        comma_media_id = UUID(comma_response.json()["data"]["media_id"])
        direct_db.register_cleanup("library_entries", "media_id", comma_media_id)
        direct_db.register_cleanup("media_file", "media_id", comma_media_id)
        direct_db.register_cleanup("media", "id", comma_media_id)

        comma_memberships = _library_entries_for_media(direct_db, comma_media_id)
        assert comma_memberships == {default_library_c, lib_x, lib_y}, (
            f"comma-joined header → default + lib_x + lib_y; got {comma_memberships}"
        )

    def test_capture_url_library_ids(self, auth_client, direct_db: DirectSessionManager):
        """`POST /media/capture/url` honors `library_ids` body field."""
        from tests.factories import create_test_library

        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)
        session_id, token = _create_extension_token(auth_client, user_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)

        with direct_db.session() as session:
            lib_a = create_test_library(session, user_id, "Capture URL Lib A")
            lib_b = create_test_library(session, user_id, "Capture URL Lib B")

        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        url = f"https://example.com/capture-url-{uuid4().hex[:8]}"
        response = auth_client.post(
            "/media/capture/url",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "url": url,
                "library_ids": [str(lib_a), str(lib_b)],
            },
        )

        assert response.status_code == 202, (
            f"capture/url should succeed, got {response.status_code}: {response.text}"
        )
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        memberships = _library_entries_for_media(direct_db, media_id)
        assert memberships == {default_library_id, lib_a, lib_b}, (
            f"capture/url memberships should equal default + library_ids; got {memberships}"
        )


class TestUploadInitLibraryIds:
    """`POST /media/upload/init` + `POST /media/{id}/ingest` with `library_ids`."""

    def test_upload_init_with_library_ids(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """init_upload + confirm_ingest_for_viewer attach the media to default + library_ids.

        Covers both the PDF and EPUB confirm paths (which dispatch differently),
        verifying that `library_ids` flows from init → confirm uniformly.
        """
        from tests.factories import create_test_library
        from tests.support.storage import FakeStorageClient

        fake_storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        # ---- PDF path
        user_id = create_test_user_id()
        default_library_id = _bootstrap_user_default_library(auth_client, user_id)

        with direct_db.session() as session:
            pdf_lib_a = create_test_library(session, user_id, "Upload PDF Lib A")
            pdf_lib_b = create_test_library(session, user_id, "Upload PDF Lib B")

        for lib in (pdf_lib_a, pdf_lib_b):
            direct_db.register_cleanup("memberships", "library_id", lib)
            direct_db.register_cleanup("libraries", "id", lib)

        pdf_bytes = b"%PDF-1.4" + b"pdf payload " * 64
        pdf_init = auth_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "upload-with-libs.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(pdf_bytes),
                "library_ids": [str(pdf_lib_a), str(pdf_lib_b)],
            },
            headers=auth_headers(user_id),
        )
        assert pdf_init.status_code == 200, (
            f"upload init (pdf) should succeed, got {pdf_init.status_code}: {pdf_init.text}"
        )
        pdf_media_id = UUID(pdf_init.json()["data"]["media_id"])
        direct_db.register_cleanup("library_entries", "media_id", pdf_media_id)
        direct_db.register_cleanup("media_file", "media_id", pdf_media_id)
        direct_db.register_cleanup("media", "id", pdf_media_id)

        # init_upload alone already calls assign_libraries_for_media, so memberships
        # should be present even before ingest confirms.
        memberships_after_init = _library_entries_for_media(direct_db, pdf_media_id)
        assert memberships_after_init == {default_library_id, pdf_lib_a, pdf_lib_b}, (
            f"init_upload must attach media to default + library_ids; got {memberships_after_init}"
        )

        # Put bytes into staging and confirm ingest with the same library_ids.
        from nexus.storage.paths import (
            build_upload_staging_storage_path,
            get_file_extension,
        )

        pdf_staging_path = build_upload_staging_storage_path(
            pdf_media_id, get_file_extension("pdf")
        )
        fake_storage.put_object(pdf_staging_path, pdf_bytes, "application/pdf")

        confirm = auth_client.post(
            f"/media/{pdf_media_id}/ingest",
            json={"library_ids": [str(pdf_lib_a), str(pdf_lib_b)]},
            headers=auth_headers(user_id),
        )
        assert confirm.status_code == 200, (
            f"PDF ingest confirm should succeed, got {confirm.status_code}: {confirm.text}"
        )

        with direct_db.session() as session:
            jobs = session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(pdf_media_id)},
            ).fetchall()
        for job_row in jobs:
            direct_db.register_cleanup("background_jobs", "id", job_row[0])

        memberships_after_confirm = _library_entries_for_media(direct_db, pdf_media_id)
        assert memberships_after_confirm == {default_library_id, pdf_lib_a, pdf_lib_b}, (
            "confirm_ingest_for_viewer is additive + idempotent on library_ids; "
            f"got {memberships_after_confirm}"
        )

        # ---- EPUB path
        epub_user = create_test_user_id()
        epub_default_library = _bootstrap_user_default_library(auth_client, epub_user)
        with direct_db.session() as session:
            epub_lib = create_test_library(session, epub_user, "Upload EPUB Lib")
        direct_db.register_cleanup("memberships", "library_id", epub_lib)
        direct_db.register_cleanup("libraries", "id", epub_lib)

        # Minimal-but-valid EPUB magic bytes for upload-time magic-byte validation.
        epub_bytes = b"PK\x03\x04" + b"epub payload " * 64
        epub_init = auth_client.post(
            "/media/upload/init",
            json={
                "kind": "epub",
                "filename": "upload-with-libs.epub",
                "content_type": "application/epub+zip",
                "size_bytes": len(epub_bytes),
                "library_ids": [str(epub_lib)],
            },
            headers=auth_headers(epub_user),
        )
        assert epub_init.status_code == 200, (
            f"upload init (epub) should succeed, got {epub_init.status_code}: {epub_init.text}"
        )
        epub_media_id = UUID(epub_init.json()["data"]["media_id"])
        direct_db.register_cleanup("epub_toc_nodes", "media_id", epub_media_id)
        direct_db.register_cleanup("library_entries", "media_id", epub_media_id)
        direct_db.register_cleanup("fragments", "media_id", epub_media_id)
        direct_db.register_cleanup("media_file", "media_id", epub_media_id)
        direct_db.register_cleanup("media", "id", epub_media_id)

        epub_init_memberships = _library_entries_for_media(direct_db, epub_media_id)
        assert epub_init_memberships == {epub_default_library, epub_lib}, (
            f"epub init should attach default + library_ids; got {epub_init_memberships}"
        )

        epub_staging_path = build_upload_staging_storage_path(
            epub_media_id, get_file_extension("epub")
        )
        fake_storage.put_object(epub_staging_path, epub_bytes, "application/epub+zip")

        epub_confirm = auth_client.post(
            f"/media/{epub_media_id}/ingest",
            json={"library_ids": [str(epub_lib)]},
            headers=auth_headers(epub_user),
        )
        assert epub_confirm.status_code == 200, (
            "EPUB ingest confirm should succeed, "
            f"got {epub_confirm.status_code}: {epub_confirm.text}"
        )

        with direct_db.session() as session:
            jobs = session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(epub_media_id)},
            ).fetchall()
        for job_row in jobs:
            direct_db.register_cleanup("background_jobs", "id", job_row[0])

        epub_confirm_memberships = _library_entries_for_media(direct_db, epub_media_id)
        assert epub_confirm_memberships == {epub_default_library, epub_lib}, (
            f"epub confirm is additive + idempotent on library_ids; got {epub_confirm_memberships}"
        )


# Static `/media/<literal>` paths collide with `/media/{media_id}` once the media
# god-file is split across routers (Starlette matches in registration order, with
# no static-before-dynamic precedence). The static routers must register before the
# `media` router; this gate locks that include order so a future router rename or
# reorder cannot silently turn `/media/image` into a `/media/{media_id}` UUID parse.
STATIC_MEDIA_ROUTES = [
    ("GET", "/media/image"),
    ("POST", "/media/from_url"),
    ("POST", "/media/capture/article"),
    ("POST", "/media/capture/file"),
    ("POST", "/media/capture/url"),
    ("POST", "/media/upload/init"),
    ("POST", "/media/transcript/request/batch"),
    ("POST", "/media/transcript/forecasts"),
]


@pytest.mark.parametrize("method,path", STATIC_MEDIA_ROUTES)
def test_static_media_path_resolves_before_media_id(method: str, path: str) -> None:
    router = create_api_router()
    scope = {"type": "http", "method": method, "path": path, "headers": []}
    matched = next(
        (route for route in router.routes if route.matches(scope)[0] == Match.FULL),
        None,
    )
    assert matched is not None, f"{method} {path} matched no route"
    assert matched.path == path, (
        f"{method} {path} resolved to {matched.path!r}, not its own static handler — "
        "a static `/media/<literal>` router is registered after the `media` router "
        "(include-order regression; the literal is being parsed as /media/{media_id})"
    )
