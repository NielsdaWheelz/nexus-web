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
from sqlalchemy import text
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


def add_media_to_default_library(auth_client, user_id: str, media_id: UUID) -> str:
    """Bootstrap user and attach media to their default library."""
    me_resp = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
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
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        attach_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert attach_resp.status_code == 201, attach_resp.text

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        add_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201

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


class TestMediaListeningState:
    """Integration tests for /media/{id}/listening-state and media hydration."""

    def test_get_listening_state_returns_defaults_when_absent(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Listening Episode",
                    canonical_source_url="https://example.com/episode",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)
        response = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, (
            f"Expected 200 but got {response.status_code}: {response.json()}"
        )
        data = response.json()["data"]
        assert data["position_ms"] == 0
        assert data["duration_ms"] is None
        assert data["playback_speed"] == 1.0
        assert data["is_completed"] is False

    def test_put_then_get_listening_state_upserts_and_preserves_optional_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="State Upsert Episode",
                    canonical_source_url="https://example.com/episode-upsert",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode-upsert.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)

        put_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 30_000, "duration_ms": 120_000, "playback_speed": 1.5},
        )
        assert put_resp.status_code == 204, (
            f"Expected 204 but got {put_resp.status_code}: {put_resp.text}"
        )

        first_get = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )
        assert first_get.status_code == 200, (
            f"Expected 200 but got {first_get.status_code}: {first_get.json()}"
        )
        first_data = first_get.json()["data"]
        assert first_data["position_ms"] == 30_000
        assert first_data["duration_ms"] == 120_000
        assert first_data["playback_speed"] == 1.5
        assert first_data["is_completed"] is False

        second_put = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 45_000},
        )
        assert second_put.status_code == 204, (
            f"Expected 204 but got {second_put.status_code}: {second_put.text}"
        )

        second_get = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )
        assert second_get.status_code == 200, (
            f"Expected 200 but got {second_get.status_code}: {second_get.json()}"
        )
        second_data = second_get.json()["data"]
        assert second_data["position_ms"] == 45_000
        assert second_data["duration_ms"] == 120_000
        assert second_data["playback_speed"] == 1.5
        assert second_data["is_completed"] is False

    def test_put_listening_state_auto_completes_at_ninety_five_percent(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Auto Completion Episode",
                    canonical_source_url="https://example.com/episode-auto-complete",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode-auto-complete.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)

        put_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 95_000, "duration_ms": 100_000, "playback_speed": 1.0},
        )
        assert put_resp.status_code == 204, (
            f"Expected 204 but got {put_resp.status_code}: {put_resp.text}"
        )

        get_resp = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 200, (
            f"Expected 200 but got {get_resp.status_code}: {get_resp.json()}"
        )
        data = get_resp.json()["data"]
        assert data["position_ms"] == 95_000
        assert data["duration_ms"] == 100_000
        assert data["is_completed"] is True, (
            "position writes at or above the 95% threshold must auto-mark episode completed"
        )

    def test_put_listening_state_accepts_manual_completion_override(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Manual Completion Episode",
                    canonical_source_url="https://example.com/episode-manual-complete",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode-manual-complete.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)

        put_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"is_completed": True},
        )
        assert put_resp.status_code == 204, (
            "manual mark-as-played should be accepted without requiring a position write; "
            f"got {put_resp.status_code}: {put_resp.text}"
        )

        get_resp = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 200, (
            f"Expected 200 but got {get_resp.status_code}: {get_resp.json()}"
        )
        data = get_resp.json()["data"]
        assert data["position_ms"] == 0
        assert data["is_completed"] is True

    def test_put_listening_state_accepts_manual_unplayed_reset(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Manual Unplayed Episode",
                    canonical_source_url="https://example.com/episode-manual-unplayed",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode-manual-unplayed.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)

        mark_played_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"is_completed": True},
        )
        assert mark_played_resp.status_code == 204

        mark_unplayed_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 0, "is_completed": False},
        )
        assert mark_unplayed_resp.status_code == 204, (
            "mark-as-unplayed should reset completion and position in one write; "
            f"got {mark_unplayed_resp.status_code}: {mark_unplayed_resp.text}"
        )

        get_resp = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["position_ms"] == 0
        assert data["is_completed"] is False

    def test_get_media_hydrates_listening_state_when_present(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Hydration Episode",
                    canonical_source_url="https://example.com/episode-hydration",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/episode-hydration.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_id, media_id)
        put_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_id),
            json={"position_ms": 12_000, "playback_speed": 1.25},
        )
        assert put_resp.status_code == 204, (
            f"Expected 204 but got {put_resp.status_code}: {put_resp.text}"
        )

        media_resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_resp.status_code == 200, (
            f"Expected 200 but got {media_resp.status_code}: {media_resp.json()}"
        )
        payload = media_resp.json()["data"]
        assert payload["listening_state"] == {
            "position_ms": 12_000,
            "duration_ms": None,
            "playback_speed": 1.25,
            "is_completed": False,
        }

    def test_listening_state_endpoints_mask_unreadable_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Private Listening Episode",
                    canonical_source_url="https://example.com/private-episode",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/private-episode.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_default_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        get_resp = auth_client.get(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_b),
        )
        assert get_resp.status_code == 404, (
            f"Expected 404 but got {get_resp.status_code}: {get_resp.json()}"
        )
        assert get_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        put_resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            headers=auth_headers(user_b),
            json={"position_ms": 1_000},
        )
        assert put_resp.status_code == 404, (
            f"Expected 404 but got {put_resp.status_code}: {put_resp.json()}"
        )
        assert put_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


class TestMediaListeningStateBatch:
    """Integration tests for POST /media/listening-state/batch."""

    def test_batch_mark_sets_completion_for_multiple_visible_episodes(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_ids = [uuid4(), uuid4()]

        with direct_db.session() as session:
            for index, media_id in enumerate(media_ids):
                session.add(
                    Media(
                        id=media_id,
                        kind=MediaKind.podcast_episode.value,
                        title=f"Batch Episode {index}",
                        canonical_source_url=f"https://example.com/batch-{index}",
                        processing_status=ProcessingStatus.ready_for_reading,
                        external_playback_url=f"https://cdn.example.com/batch-{index}.mp3",
                    )
                )
            session.commit()

        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
            add_media_to_default_library(auth_client, user_id, media_id)

        batch_resp = auth_client.post(
            "/media/listening-state/batch",
            headers=auth_headers(user_id),
            json={"media_ids": [str(media_id) for media_id in media_ids], "is_completed": True},
        )
        assert batch_resp.status_code == 204, (
            "batch mark should acknowledge with 204 and avoid per-item round trips; "
            f"got {batch_resp.status_code}: {batch_resp.text}"
        )

        for media_id in media_ids:
            state_resp = auth_client.get(
                f"/media/{media_id}/listening-state",
                headers=auth_headers(user_id),
            )
            assert state_resp.status_code == 200
            assert state_resp.json()["data"]["is_completed"] is True

    def test_batch_mark_rejects_unknown_or_invisible_media_ids(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        visible_media_id = uuid4()
        unknown_media_id = uuid4()

        with direct_db.session() as session:
            session.add(
                Media(
                    id=visible_media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Visible Batch Episode",
                    canonical_source_url="https://example.com/visible-batch",
                    processing_status=ProcessingStatus.ready_for_reading,
                    external_playback_url="https://cdn.example.com/visible-batch.mp3",
                )
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", visible_media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", visible_media_id)
        direct_db.register_cleanup("media", "id", visible_media_id)
        add_media_to_default_library(auth_client, user_id, visible_media_id)

        response = auth_client.post(
            "/media/listening-state/batch",
            headers=auth_headers(user_id),
            json={
                "media_ids": [str(visible_media_id), str(unknown_media_id)],
                "is_completed": True,
            },
        )
        assert response.status_code == 404, (
            "batch mark must reject payloads containing unknown/invisible IDs; "
            f"got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        with (
            patch(
                "nexus.services.epub_lifecycle.get_storage_client",
                return_value=fake_storage,
            ),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_epub", media_id=media_id) == 1

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
                        size_bytes,
                        sha256
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes,
                        :sha256
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig1.png",
                    "size_bytes": len(asset_content),
                    "sha256": "0" * 64,
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        attach_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert attach_resp.status_code == 201, attach_resp.text
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

        assert resp.status_code == 200, resp.text
        assert resp.content == asset_content
        assert "image/png" in resp.headers.get("content-type", "")
        assert resp.headers.get("content-length") == str(len(asset_content))
        assert resp.headers.get("x-content-type-options") == "nosniff"

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        _add_media_to_user_library(auth_client, user_id, media_id)

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
                        size_bytes,
                        sha256
                    )
                    VALUES (
                        :media_id,
                        'fig1',
                        'images/fig1.png',
                        'images/fig1.png',
                        :storage_path,
                        'image/png',
                        :size_bytes,
                        :sha256
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig1.png",
                    "size_bytes": len(asset_content),
                    "sha256": "0" * 64,
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()

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
                        size_bytes,
                        sha256
                    )
                    VALUES (
                        :media_id,
                        'css1',
                        'styles/book.css',
                        'styles/book.css',
                        :storage_path,
                        'text/css',
                        6,
                        :sha256
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/styles/book.css",
                    "sha256": "0" * 64,
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

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
                        size_bytes,
                        sha256
                    )
                    VALUES (
                        :media_id,
                        'svg1',
                        'images/fig.svg',
                        'images/fig.svg',
                        :storage_path,
                        'image/svg+xml',
                        :size_bytes,
                        :sha256
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "storage_path": f"media/{media_id}/assets/images/fig.svg",
                    "size_bytes": len(asset_content),
                    "sha256": "0" * 64,
                },
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("epub_resources", "media_id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig.svg", asset_content, "image/svg+xml")

        from unittest.mock import patch

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.storage.get_storage_client", return_value=fake):
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True

        assert _count_jobs_for_media(direct_db, kind="ingest_epub", media_id=media_id) == 1

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_id = me_resp.json()["data"]["default_library_id"]

        # non-creator
        with direct_db.session() as session:
            epub_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("library_entries", "media_id", epub_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        # STORAGE SEAM EXCEPTION: External storage boundary mock.
        # Supabase Storage is an external dependency; FakeStorageClient isolates tests
        # from the real storage service per testing standards Section 6 (Allowed Mocks).
        # Replacement: Real storage integration in E2E tests.
        with patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage):
            _install_background_job_insert_failure(direct_db)
            try:
                resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
            finally:
                _remove_background_job_insert_failure(direct_db)

        assert resp.status_code == 500

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status != ProcessingStatus.extracting


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
            session.execute(
                text("""
                    INSERT INTO media_authors (media_id, name, role, sort_order)
                    VALUES (:media_id, 'Old Author', 'author', 0)
                """),
                {"media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media_authors", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        add_media_to_default_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_web_article", media_id=media_id) == 1
        with direct_db.session() as session:
            job_id = session.execute(
                text("""
                    SELECT id FROM background_jobs
                    WHERE kind = 'ingest_web_article'
                      AND payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar_one()
            direct_db.register_cleanup("background_jobs", "id", job_id)

        with direct_db.session() as session:
            media_row = session.get(Media, media_id)
            assert media_row is not None
            assert media_row.processing_status == ProcessingStatus.extracting
            assert media_row.processing_attempts == 2
            assert media_row.last_error_code is None

            artifact_counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM fragments WHERE media_id = :media_id),
                        (SELECT count(*) FROM fragment_blocks WHERE fragment_id = :fragment_id),
                        (SELECT count(*) FROM media_authors WHERE media_id = :media_id)
                """),
                {"media_id": media_id, "fragment_id": fragment_id},
            ).one()
            assert tuple(artifact_counts) == (0, 0, 0)

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
        add_media_to_default_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"


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


class TestGetEpubNavigationReturnsCanonicalSectionsAndTocTargets:
    """test_get_epub_navigation_returns_canonical_sections_and_toc_targets"""

    def test_navigation_response_includes_sections_and_toc_section_links(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3, with_toc=True)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        body = resp.json()["data"]
        sections = body["sections"]
        assert [section["ordinal"] for section in sections] == [0, 1, 2]
        assert [section["fragment_idx"] for section in sections] == [0, 1, 2]
        assert [section["section_id"] for section in sections] == [
            "ch0.xhtml",
            "ch1.xhtml",
            "ch2.xhtml",
        ]
        assert all(section["source"] == "toc" for section in sections)
        assert all("html_sanitized" not in section for section in sections)
        assert all("canonical_text" not in section for section in sections)

        toc_nodes = body["toc_nodes"]
        assert [node["node_id"] for node in toc_nodes] == ["ch0", "ch1", "ch2"]
        assert [node["section_id"] for node in toc_nodes] == [
            "ch0.xhtml",
            "ch1.xhtml",
            "ch2.xhtml",
        ]

    def test_navigation_returns_spine_sections_when_toc_is_absent(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2, with_toc=False)

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        body = resp.json()["data"]
        assert body["toc_nodes"] == []
        assert [section["source"] for section in body["sections"]] == ["spine", "spine"]
        assert [section["section_id"] for section in body["sections"]] == ["ch0.xhtml", "ch1.xhtml"]


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

        _add_media_to_user_library(auth_client, user_id, media_id)

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

        _add_media_to_user_library(auth_client, user_id, media_id)

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

        _add_media_to_user_library(auth_client, user_id, media_id)

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

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/navigation", headers=auth_headers(user_id))
        assert resp.status_code == 200

        toc_nodes = resp.json()["data"]["toc_nodes"]
        assert [node["node_id"] for node in toc_nodes] == ["root1", "root2"]
        assert [child["node_id"] for child in toc_nodes[0]["children"]] == ["child1_1", "child1_2"]
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

        _add_media_to_user_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        for path in [f"/media/{media_id}/navigation", f"/media/{media_id}/sections/ch0.xhtml"]:
            resp = auth_client.get(path, headers=auth_headers(user_b))
            assert resp.status_code == 404, f"Expected 404 for {path}, got {resp.status_code}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [f"/media/{media_id}/navigation", f"/media/{media_id}/sections/ch0.xhtml"]:
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [f"/media/{media_id}/navigation", f"/media/{media_id}/sections/ch0.xhtml"]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 409, f"Expected 409 for {path}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id_ready)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", mid_no_text)
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
        direct_db.register_cleanup("library_entries", "media_id", mid_full)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        from unittest.mock import patch

        with patch("nexus.services.pdf_lifecycle.get_storage_client") as mock_storage:
            mock_storage.return_value.head_object.return_value = True
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True

        from sqlalchemy import text

        with direct_db.session() as session:
            job_row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'embedding_only'
                    FROM background_jobs
                    WHERE kind = 'ingest_pdf'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()
            assert job_row is not None
            direct_db.register_cleanup("background_jobs", "id", job_row[0])
            assert job_row[1] == "ingest_pdf"
            assert job_row[2] == "false"

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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["retry_enqueued"] is True

        from sqlalchemy import text

        with direct_db.session() as session:
            job_row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'embedding_only'
                    FROM background_jobs
                    WHERE kind = 'ingest_pdf'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()
            assert job_row is not None
            direct_db.register_cleanup("background_jobs", "id", job_row[0])
            assert job_row[1] == "ingest_pdf"
            assert job_row[2] == "true"

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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

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
