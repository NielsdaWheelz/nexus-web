"""Integration tests for library service and routes.

Tests cover:
- Library CRUD operations
- Membership enforcement
- Default library protections
- Library-media management
- Default library closure invariants
- Visibility masking
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import MockTokenVerifier
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def auth_client(engine):
    """Create a client with auth middleware for testing."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockTokenVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    return TestClient(app)


def create_test_media(session: Session) -> UUID:
    """Create a test media item directly in the database.

    Returns the media ID.
    """
    media_id = uuid4()
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (:media_id, 'web_article', 'Test Article', 'https://example.com/test', 'ready_for_reading')
        """),
        {"media_id": media_id},
    )
    session.commit()
    return media_id


# =============================================================================
# Library Create Tests
# =============================================================================


class TestCreateLibrary:
    """Tests for POST /libraries endpoint."""

    def test_create_library_success(self, auth_client):
        """Create library returns 201 with library data."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": "My New Library"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["name"] == "My New Library"
        assert data["is_default"] is False
        assert data["role"] == "admin"
        assert data["owner_user_id"] == str(user_id)

    def test_create_library_owner_is_admin(self, auth_client, direct_db: DirectSessionManager):
        """Creator becomes admin of new library."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": "Test Library"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        library_id = response.json()["data"]["id"]

        # Verify membership
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT role FROM memberships
                    WHERE library_id = :library_id AND user_id = :user_id
                """),
                {"library_id": library_id, "user_id": user_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "admin"

    def test_create_library_empty_name(self, auth_client):
        """Empty name returns 400 (validation error)."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": ""},
            headers=auth_headers(user_id),
        )

        # Pydantic validation returns 400 E_INVALID_REQUEST for empty string
        # (Field min_length=1 triggers validation error)
        assert response.status_code == 400
        # Accept either E_INVALID_REQUEST (from Pydantic) or E_NAME_INVALID (from service)
        assert response.json()["error"]["code"] in ("E_INVALID_REQUEST", "E_NAME_INVALID")

    def test_create_library_whitespace_only_name(self, auth_client):
        """Whitespace-only name returns 400 E_NAME_INVALID."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": "   "},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_NAME_INVALID"

    def test_create_library_name_too_long(self, auth_client):
        """Name > 100 chars returns 400."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": "x" * 101},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400

    def test_create_library_name_trimmed(self, auth_client):
        """Name is trimmed of leading/trailing whitespace."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json={"name": "  My Library  "},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        assert response.json()["data"]["name"] == "My Library"


# =============================================================================
# Library List Tests
# =============================================================================


class TestListLibraries:
    """Tests for GET /libraries endpoint."""

    def test_list_libraries_returns_default(self, auth_client):
        """List libraries returns at least the default library."""
        user_id = create_test_user_id()

        response = auth_client.get("/libraries", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) >= 1

        # Find default library
        default_libs = [lib for lib in data if lib["is_default"]]
        assert len(default_libs) == 1
        assert default_libs[0]["name"] == "My Library"

    def test_list_libraries_ordering(self, auth_client):
        """Libraries are ordered by created_at ASC, id ASC."""
        user_id = create_test_user_id()

        # Create some libraries
        auth_client.post("/libraries", json={"name": "Lib A"}, headers=auth_headers(user_id))
        auth_client.post("/libraries", json={"name": "Lib B"}, headers=auth_headers(user_id))
        auth_client.post("/libraries", json={"name": "Lib C"}, headers=auth_headers(user_id))

        response = auth_client.get("/libraries", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # First should be default (created first), then A, B, C in order
        assert data[0]["is_default"] is True
        # Verify ascending order by checking created_at
        for i in range(len(data) - 1):
            assert data[i]["created_at"] <= data[i + 1]["created_at"]

    def test_list_libraries_limit(self, auth_client):
        """Limit parameter works correctly."""
        user_id = create_test_user_id()

        # Create 5 libraries
        for i in range(5):
            auth_client.post("/libraries", json={"name": f"Lib {i}"}, headers=auth_headers(user_id))

        response = auth_client.get("/libraries?limit=3", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3

    def test_list_libraries_limit_clamped(self, auth_client):
        """Limit > 200 is clamped to 200 (accepted, not rejected)."""
        user_id = create_test_user_id()

        response = auth_client.get("/libraries?limit=500", headers=auth_headers(user_id))

        # Should succeed (clamped internally to 200)
        assert response.status_code == 200

    def test_list_libraries_invalid_limit(self, auth_client):
        """Limit <= 0 returns 422 (FastAPI validation error)."""
        user_id = create_test_user_id()

        response = auth_client.get("/libraries?limit=0", headers=auth_headers(user_id))

        # FastAPI Query validation (ge=1) returns 422 which we convert to 400
        assert response.status_code in (400, 422)


# =============================================================================
# Library Rename Tests
# =============================================================================


class TestRenameLibrary:
    """Tests for PATCH /libraries/{id} endpoint."""

    def test_rename_library_success(self, auth_client):
        """Admin can rename non-default library."""
        user_id = create_test_user_id()

        # Create library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Original Name"}, headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Rename
        response = auth_client.patch(
            f"/libraries/{library_id}",
            json={"name": "New Name"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        assert response.json()["data"]["name"] == "New Name"

    def test_rename_default_library_forbidden(self, auth_client):
        """Cannot rename default library."""
        user_id = create_test_user_id()

        # Get default library ID
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Try to rename
        response = auth_client.patch(
            f"/libraries/{default_library_id}",
            json={"name": "Not My Library"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_rename_library_not_found(self, auth_client):
        """Rename non-existent library returns 404."""
        user_id = create_test_user_id()

        # Bootstrap user first
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.patch(
            f"/libraries/{uuid4()}",
            json={"name": "Whatever"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_rename_library_empty_name(self, auth_client):
        """Empty name returns 400."""
        user_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Test"}, headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.patch(
            f"/libraries/{library_id}",
            json={"name": ""},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400


# =============================================================================
# Library Delete Tests
# =============================================================================


class TestDeleteLibrary:
    """Tests for DELETE /libraries/{id} endpoint."""

    def test_delete_library_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can delete non-default library."""
        user_id = create_test_user_id()

        # Create library
        create_resp = auth_client.post(
            "/libraries", json={"name": "To Delete"}, headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Delete
        response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))

        assert response.status_code == 204

        # Verify deleted
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM libraries WHERE id = :id"),
                {"id": library_id},
            )
            assert result.fetchone() is None

    def test_delete_default_library_forbidden(self, auth_client):
        """Cannot delete default library."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.delete(
            f"/libraries/{default_library_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_delete_library_not_found(self, auth_client):
        """Delete non-existent library returns 404."""
        user_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.delete(f"/libraries/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_delete_library_cascades_library_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deleting library cascades to library_media."""
        user_id = create_test_user_id()

        # Create media first using direct_db
        with direct_db.session() as session:
            media_id = create_test_media(session)

        # Register cleanup
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Create library and add media
        create_resp = auth_client.post(
            "/libraries", json={"name": "To Delete"}, headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Verify library_media exists
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM library_media WHERE library_id = :id AND media_id = :media_id"),
                {"id": library_id, "media_id": media_id},
            )
            assert result.fetchone() is not None

        # Delete library
        auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))

        # Verify library_media deleted (cascade)
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM library_media WHERE library_id = :id"),
                {"id": library_id},
            )
            assert result.fetchone() is None


# =============================================================================
# Library Media Tests
# =============================================================================


class TestAddMediaToLibrary:
    """Tests for POST /libraries/{id}/media endpoint."""

    def test_add_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can add media to library."""
        user_id = create_test_user_id()

        # Create media using direct_db (committed, visible to auth_client)
        with direct_db.session() as session:
            media_id = create_test_media(session)

        # Register cleanup
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["library_id"] == library_id
        assert data["media_id"] == str(media_id)

    def test_add_media_library_not_found(self, auth_client, direct_db: DirectSessionManager):
        """Add media to non-existent library returns 404."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("media", "id", media_id)

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            f"/libraries/{uuid4()}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_add_media_not_found(self, auth_client):
        """Add non-existent media returns 404."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(uuid4())},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_add_media_idempotent(self, auth_client, direct_db: DirectSessionManager):
        """Adding same media twice is idempotent."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        # Add first time
        resp1 = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert resp1.status_code == 201

        # Add second time
        resp2 = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert resp2.status_code == 201
        assert resp2.json()["data"]["media_id"] == str(media_id)


class TestRemoveMediaFromLibrary:
    """Tests for DELETE /libraries/{id}/media/{media_id} endpoint."""

    def test_remove_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can remove media from library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        # Add media
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Remove media
        response = auth_client.delete(
            f"/libraries/{library_id}/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 204

    def test_remove_media_not_in_library(self, auth_client, direct_db: DirectSessionManager):
        """Remove media not in library returns 404."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        # Don't add media, just try to remove
        response = auth_client.delete(
            f"/libraries/{library_id}/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_remove_media_library_not_found(self, auth_client, direct_db: DirectSessionManager):
        """Remove media from non-existent library returns 404."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("media", "id", media_id)

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.delete(
            f"/libraries/{uuid4()}/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"


class TestListLibraryMedia:
    """Tests for GET /libraries/{id}/media endpoint."""

    def test_list_media_empty(self, auth_client):
        """List media in empty library returns empty list."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.get(f"/libraries/{library_id}/media", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_list_media_success(self, auth_client, direct_db: DirectSessionManager):
        """List media returns media in library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        # Add media
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # List media
        response = auth_client.get(f"/libraries/{library_id}/media", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1
        assert data[0]["id"] == str(media_id)
        assert data[0]["kind"] == "web_article"

    def test_list_media_library_not_found(self, auth_client):
        """List media in non-existent library returns 404."""
        user_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(f"/libraries/{uuid4()}/media", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_list_media_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Media is ordered by library_media.created_at DESC, media.id DESC."""
        user_id = create_test_user_id()

        # Create multiple media items
        media_ids = []
        for i in range(3):
            with direct_db.session() as session:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'web_article', :title, 'ready_for_reading')
                    """),
                    {"id": media_id, "title": f"Article {i}"},
                )
                session.commit()
                media_ids.append(media_id)
                direct_db.register_cleanup("library_media", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        # Add media in order
        for media_id in media_ids:
            auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )

        # List media (should be reverse order - DESC)
        response = auth_client.get(f"/libraries/{library_id}/media", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3
        # Last added should be first
        assert data[0]["id"] == str(media_ids[2])


# =============================================================================
# Default Library Closure Tests
# =============================================================================


class TestDefaultLibraryClosure:
    """Tests for default library closure invariants."""

    def test_add_media_closure_to_default(self, auth_client, direct_db: DirectSessionManager):
        """Adding media to any library adds it to user's default library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Create a non-default library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other Library"}, headers=auth_headers(user_id)
        )
        other_library_id = create_resp.json()["data"]["id"]

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Add media to non-default library
        auth_client.post(
            f"/libraries/{other_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Verify media is in default library too
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            assert result.fetchone() is not None

    def test_remove_from_default_cascades_to_single_member_libs(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing media from default library cascades to single-member libraries."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Get default library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Create a non-default library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other Library"}, headers=auth_headers(user_id)
        )
        other_library_id = create_resp.json()["data"]["id"]

        # Add media to other library (also goes to default via closure)
        auth_client.post(
            f"/libraries/{other_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Verify in both
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_media WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            before_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library_id) in before_ids
            assert UUID(other_library_id) in before_ids

        # Remove from default
        auth_client.delete(
            f"/libraries/{default_library_id}/media/{media_id}",
            headers=auth_headers(user_id),
        )

        # Verify removed from both
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_media WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            after_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library_id) not in after_ids
            assert UUID(other_library_id) not in after_ids

    def test_remove_from_non_default_does_not_affect_default(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing media from non-default library does not affect default library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Create non-default library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other Library"}, headers=auth_headers(user_id)
        )
        other_library_id = create_resp.json()["data"]["id"]

        # Add media to non-default library (which also adds to default via closure)
        auth_client.post(
            f"/libraries/{other_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Remove from non-default library
        auth_client.delete(
            f"/libraries/{other_library_id}/media/{media_id}",
            headers=auth_headers(user_id),
        )

        # Verify media is STILL in default library
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            assert result.fetchone() is not None


# =============================================================================
# Visibility Tests
# =============================================================================


class TestVisibility:
    """Tests for visibility and access control."""

    def test_non_member_cannot_read_library(self, auth_client):
        """Non-member cannot read another user's library."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates a library
        create_resp = auth_client.post(
            "/libraries", json={"name": "User A's Library"}, headers=auth_headers(user_a)
        )
        library_id = create_resp.json()["data"]["id"]

        # User B tries to access it
        response = auth_client.get(f"/libraries/{library_id}/media", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_non_member_cannot_see_library_in_list(self, auth_client):
        """Non-member cannot see another user's library in list."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates a library
        create_resp = auth_client.post(
            "/libraries", json={"name": "User A's Library"}, headers=auth_headers(user_a)
        )
        library_id = create_resp.json()["data"]["id"]

        # User B lists their libraries
        list_resp = auth_client.get("/libraries", headers=auth_headers(user_b))

        library_ids = [lib["id"] for lib in list_resp.json()["data"]]
        assert library_id not in library_ids


# =============================================================================
# V1-V6 Visibility Closure Tests (from spec)
# =============================================================================


class TestVisibilityClosureScenarios:
    """Tests for spec-defined visibility closure scenarios (V1-V6)."""

    def test_v1_user_adds_media_can_read(self, auth_client, direct_db: DirectSessionManager):
        """V1: User A adds media M to library LA → A can read M."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp.json()["data"]["default_library_id"]

        # Add media
        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User A can list media
        response = auth_client.get(f"/libraries/{library_a}/media", headers=auth_headers(user_a))

        assert response.status_code == 200
        media_ids = [m["id"] for m in response.json()["data"]]
        assert str(media_id) in media_ids

    def test_v2_non_member_cannot_read_media(self, auth_client, direct_db: DirectSessionManager):
        """V2: User B (no membership in LA) cannot read M."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp.json()["data"]["default_library_id"]

        # User A adds media
        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User B bootstraps
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B cannot access A's library
        response = auth_client.get(f"/libraries/{library_a}/media", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_v3_media_accessible_via_closure(self, auth_client, direct_db: DirectSessionManager):
        """V3: User A creates new library LB, does NOT add M → A can still read M (closure)."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp.json()["data"]["default_library_id"]

        # Add media to default library
        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # Create new library (don't add media to it)
        auth_client.post("/libraries", json={"name": "Library B"}, headers=auth_headers(user_a))

        # User A can still read media via default library
        response = auth_client.get(f"/libraries/{library_a}/media", headers=auth_headers(user_a))

        assert response.status_code == 200
        media_ids = [m["id"] for m in response.json()["data"]]
        assert str(media_id) in media_ids

    def test_v4_remove_from_default_cascades(self, auth_client, direct_db: DirectSessionManager):
        """V4: User A removes M from default library → M removed from all A's single-member libs."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        default_library = me_resp.json()["data"]["default_library_id"]

        # Create another library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other"}, headers=auth_headers(user_a)
        )
        other_library = create_resp.json()["data"]["id"]

        # Add media to other library (also goes to default via closure)
        auth_client.post(
            f"/libraries/{other_library}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # Verify in both
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_media WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            before_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library) in before_ids
            assert UUID(other_library) in before_ids

        # Remove from default
        auth_client.delete(
            f"/libraries/{default_library}/media/{media_id}",
            headers=auth_headers(user_a),
        )

        # Verify removed from both
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_media WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            after_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library) not in after_ids
            assert UUID(other_library) not in after_ids

    def test_v5_after_removal_cannot_read(self, auth_client, direct_db: DirectSessionManager):
        """V5: After V4, User A tries to read M → 404 (media not in any of A's libraries)."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        default_library = me_resp.json()["data"]["default_library_id"]

        # Add then remove
        auth_client.post(
            f"/libraries/{default_library}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )
        auth_client.delete(
            f"/libraries/{default_library}/media/{media_id}",
            headers=auth_headers(user_a),
        )

        # Now media list should be empty
        response = auth_client.get(
            f"/libraries/{default_library}/media", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_v6_different_users_independent(self, auth_client, direct_db: DirectSessionManager):
        """V6: User B adds same media M to their library → B can read; A still cannot."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media then removes it
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )
        auth_client.delete(
            f"/libraries/{library_a}/media/{media_id}",
            headers=auth_headers(user_a),
        )

        # User B adds media to their library
        me_resp_b = auth_client.get("/me", headers=auth_headers(user_b))
        library_b = me_resp_b.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_b}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_b),
        )

        # User B can read
        response_b = auth_client.get(f"/libraries/{library_b}/media", headers=auth_headers(user_b))
        assert response_b.status_code == 200
        media_ids_b = [m["id"] for m in response_b.json()["data"]]
        assert str(media_id) in media_ids_b

        # User A cannot read (their library is empty)
        response_a = auth_client.get(f"/libraries/{library_a}/media", headers=auth_headers(user_a))
        assert response_a.status_code == 200
        assert response_a.json()["data"] == []
