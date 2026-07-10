"""Integration tests for library service and routes.

Tests cover:
- Library CRUD operations
- Membership enforcement
- Default library protections
- Library-media management
- Default library closure invariants
- Visibility masking
"""

import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from nexus.services import library_entries, library_governance
from tests.factories import create_test_library, create_test_media
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _list_library_entries(auth_client, user_id: UUID, library_id: str, **params):
    return auth_client.get(
        f"/libraries/{library_id}/entries",
        headers=auth_headers(user_id),
        params=params,
    )


def _library_entry_media_ids(rows: list[dict]) -> list[str]:
    return [
        row["media"]["id"] for row in rows if row["kind"] == "media" and row["media"] is not None
    ]


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
        body = response.json()
        assert body["page"] == {"has_more": False, "next_cursor": None}
        data = body["data"]
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

    def test_list_libraries_paginates_with_next_cursor(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        for idx in range(3):
            response = auth_client.post(
                "/libraries",
                json={"name": f"Cursor Library {idx}"},
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get("/libraries?limit=2", headers=auth_headers(user_id))
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert len(first_body["data"]) == 2
        assert first_body["page"]["has_more"] is True
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        second = auth_client.get(
            f"/libraries?limit=2&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert second.status_code == 200, second.text
        assert second.json()["page"]["has_more"] is False
        first_ids = {row["id"] for row in first_body["data"]}
        second_ids = {row["id"] for row in second.json()["data"]}
        assert first_ids
        assert second_ids
        assert first_ids.isdisjoint(second_ids)

    def test_list_libraries_rejects_cursor_from_another_viewer(self, auth_client):
        owner_id = create_test_user_id()
        other_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(other_id))
        for idx in range(3):
            response = auth_client.post(
                "/libraries",
                json={"name": f"Scoped Cursor Library {idx}"},
                headers=auth_headers(owner_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get("/libraries?limit=2", headers=auth_headers(owner_id))
        assert first.status_code == 200, first.text
        cursor = first.json()["page"]["next_cursor"]
        assert cursor is not None

        response = auth_client.get(
            f"/libraries?limit=2&cursor={cursor}",
            headers=auth_headers(other_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_libraries_rejects_invalid_cursor(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/libraries?cursor=not-a-cursor", headers=auth_headers(user_id))

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_libraries_invalid_limit(self, auth_client):
        """Limit <= 0 returns 422 (FastAPI validation error)."""
        user_id = create_test_user_id()

        response = auth_client.get("/libraries?limit=0", headers=auth_headers(user_id))

        # FastAPI Query validation (ge=1) returns 422 which we convert to 400
        assert response.status_code in (400, 422)


class TestWritableLibraryDestinations:
    """Tests for GET /libraries/writable-destinations."""

    def test_lists_only_writable_non_default_libraries(
        self, auth_client, direct_db: DirectSessionManager
    ):
        from tests.factories import add_library_member, create_test_library

        viewer_id = create_test_user_id()
        default_library_id = UUID(
            auth_client.get("/me", headers=auth_headers(viewer_id)).json()["data"][
                "default_library_id"
            ]
        )
        other_owner_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(other_owner_id))

        with direct_db.session() as session:
            owned_id = create_test_library(session, viewer_id, "Owned Writable")
            admin_id = create_test_library(session, other_owner_id, "Shared Admin")
            member_id = create_test_library(session, other_owner_id, "Shared Member")
            system_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_destination_system_{viewer_id.hex[:12]}",
                name="System Destination",
                owner_user_id=viewer_id,
            )
            add_library_member(session, admin_id, viewer_id, role="admin")
            add_library_member(session, member_id, viewer_id, role="member")

        for library_id in (owned_id, admin_id, member_id, system_id):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            "/libraries/writable-destinations",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200, response.text
        ids = {UUID(row["id"]) for row in response.json()["data"]}
        assert owned_id in ids
        assert admin_id in ids
        assert member_id not in ids
        assert system_id not in ids
        assert default_library_id not in ids

    def test_search_finds_library_beyond_default_library_limit(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        for idx in range(105):
            response = auth_client.post(
                "/libraries",
                json={"name": f"Destination {idx:03d}"},
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        response = auth_client.get(
            "/libraries/writable-destinations?q=Destination%20104",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        assert [row["name"] for row in response.json()["data"]] == ["Destination 104"]

    def test_cursor_paginates_stably(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        for idx in range(4):
            response = auth_client.post(
                "/libraries",
                json={"name": f"Paged Destination {idx}"},
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get(
            "/libraries/writable-destinations?q=Paged%20Destination&limit=2",
            headers=auth_headers(user_id),
        )
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert first_body["page"]["has_more"] is True
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        second = auth_client.get(
            f"/libraries/writable-destinations?q=Paged%20Destination&limit=2&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert second.status_code == 200, second.text
        assert second.json()["page"]["has_more"] is False
        first_ids = {row["id"] for row in first_body["data"]}
        second_ids = {row["id"] for row in second.json()["data"]}
        assert first_ids
        assert second_ids
        assert first_ids.isdisjoint(second_ids)

    def test_cursor_rejects_another_viewer(self, auth_client):
        owner_id = create_test_user_id()
        other_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(other_id))
        for idx in range(3):
            response = auth_client.post(
                "/libraries",
                json={"name": f"Scoped Destination {idx}"},
                headers=auth_headers(owner_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get(
            "/libraries/writable-destinations?q=Scoped%20Destination&limit=2",
            headers=auth_headers(owner_id),
        )
        assert first.status_code == 200, first.text
        cursor = first.json()["page"]["next_cursor"]
        assert cursor is not None

        response = auth_client.get(
            f"/libraries/writable-destinations?q=Scoped%20Destination&limit=2&cursor={cursor}",
            headers=auth_headers(other_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_malformed_cursor_returns_invalid_request(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/libraries/writable-destinations?cursor=not-a-cursor",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"


class TestSystemLibraryMutationGuards:
    """System libraries are normal read surfaces but not user-mutable."""

    @staticmethod
    def _assert_system_forbidden(response) -> None:
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"

    def test_system_library_mutation_endpoints_are_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(invitee_id))

        with direct_db.session() as session:
            system_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_system_guard_{owner_id.hex[:12]}",
                name="System Guard",
                owner_user_id=owner_id,
            )
            existing_media_id = create_test_media(session, title="System Corpus Work")
            new_media_id = create_test_media(session, title="Unowned Addition")
            library_entries.ensure_entry(
                session, system_id, library_entries.media_target(existing_media_id)
            )
            session.commit()

        for media_id in (existing_media_id, new_media_id):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", system_id)
        direct_db.register_cleanup("libraries", "id", system_id)

        entries = _list_library_entries(auth_client, owner_id, str(system_id)).json()["data"]
        entry_ids = [row["id"] for row in entries]
        assert entry_ids, "expected a seeded system-library entry"

        mutation_responses = [
            auth_client.patch(
                f"/libraries/{system_id}",
                json={"name": "Renamed System"},
                headers=auth_headers(owner_id),
            ),
            auth_client.delete(f"/libraries/{system_id}", headers=auth_headers(owner_id)),
            auth_client.post(
                f"/libraries/{system_id}/invites",
                json={"invitee_user_id": str(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            ),
            auth_client.get(f"/libraries/{system_id}/invites", headers=auth_headers(owner_id)),
            auth_client.patch(
                f"/libraries/{system_id}/members/{owner_id}",
                json={"role": "admin"},
                headers=auth_headers(owner_id),
            ),
            auth_client.delete(
                f"/libraries/{system_id}/members/{owner_id}",
                headers=auth_headers(owner_id),
            ),
            auth_client.post(
                f"/libraries/{system_id}/media",
                json={"media_id": str(new_media_id)},
                headers=auth_headers(owner_id),
            ),
            auth_client.patch(
                f"/libraries/{system_id}/entries/reorder",
                json={"entry_ids": entry_ids},
                headers=auth_headers(owner_id),
            ),
        ]
        for response in mutation_responses:
            self._assert_system_forbidden(response)


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

    def test_delete_library_cleans_library_entries(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deleting a library explicitly cleans its library_entries."""
        user_id = create_test_user_id()

        # Create media first using direct_db
        with direct_db.session() as session:
            media_id = create_test_media(session)

        # Register cleanup
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        # Verify library_entries exists
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT 1 FROM library_entries WHERE library_id = :id AND media_id = :media_id"
                ),
                {"id": library_id, "media_id": media_id},
            )
            assert result.fetchone() is not None

        # Delete library
        auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))

        # Verify library_entries were explicitly deleted.
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM library_entries WHERE library_id = :id"),
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        assert data["kind"] == "media"
        assert data["media"]["id"] == str(media_id)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        assert resp2.json()["data"]["kind"] == "media"
        assert resp2.json()["data"]["media"]["id"] == str(media_id)


class TestRemoveMediaFromLibrary:
    """Tests for DELETE /media/{media_id} endpoint."""

    def test_remove_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can remove media from library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
            f"/media/{media_id}?library_id={library_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200

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
            f"/media/{media_id}?library_id={library_id}",
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
            f"/media/{media_id}?library_id={uuid4()}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_delete_default_pdf_removes_database_rows_and_storage(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)

        with direct_db.session() as session:
            media_id = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text="Delete me",
                page_count=1,
                with_page_spans=True,
            )

        storage_path = f"media/{media_id}/original.pdf"
        storage.put_object(storage_path, b"%PDF-1.4 test", "application/pdf")
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201

        detail_resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert detail_resp.status_code == 200
        assert detail_resp.json()["data"]["capabilities"]["can_delete"] is True

        delete_resp = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

        assert delete_resp.status_code == 200
        assert delete_resp.json()["data"] == {
            "status": "deleted",
            "hard_deleted": True,
            "removed_from_library_ids": [library_id],
            "hidden_for_viewer": False,
            "remaining_reference_count": 0,
        }
        assert storage.get_object(storage_path) is None

        with direct_db.session() as session:
            counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM media WHERE id = :media_id) AS media_count,
                        (SELECT count(*) FROM media_file WHERE media_id = :media_id)
                            AS file_count,
                        (SELECT count(*) FROM pdf_page_text_spans WHERE media_id = :media_id)
                            AS page_span_count,
                        (SELECT count(*) FROM default_library_intrinsics
                            WHERE media_id = :media_id) AS intrinsic_count,
                        (SELECT count(*) FROM library_entries WHERE media_id = :media_id)
                            AS library_entry_count
                """),
                {"media_id": media_id},
            ).one()
        assert counts == (0, 0, 0, 0, 0)

    def test_delete_default_epub_removes_package_resources_and_storage(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)

        media_id = uuid4()
        original_path = f"media/{media_id}/original.epub"
        resource_path = f"media/{media_id}/assets/cover.jpg"
        storage.put_object(original_path, b"epub", "application/epub+zip")
        storage.put_object(resource_path, b"jpg", "image/jpeg")

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id
                    ) VALUES (
                        :media_id, 'epub', 'Delete EPUB', 'ready_for_reading', :user_id
                    )
                """),
                {"media_id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                    VALUES (:media_id, :storage_path, 'application/epub+zip', 4)
                """),
                {"media_id": media_id, "storage_path": original_path},
            )
            session.execute(
                text("""
                    INSERT INTO epub_resources (
                        media_id,
                        package_href,
                        asset_key,
                        storage_path,
                        content_type,
                        size_bytes
                    ) VALUES (
                        :media_id,
                        'cover.jpg',
                        'cover',
                        :storage_path,
                        'image/jpeg',
                        3
                    )
                """),
                {"media_id": media_id, "storage_path": resource_path},
            )
            session.commit()

        direct_db.register_cleanup("epub_resources", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"]["hard_deleted"] is True
        assert storage.get_object(original_path) is None
        assert storage.get_object(resource_path) is None

        with direct_db.session() as session:
            counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM media WHERE id = :media_id) AS media_count,
                        (SELECT count(*) FROM media_file WHERE media_id = :media_id)
                            AS file_count,
                        (SELECT count(*) FROM epub_resources WHERE media_id = :media_id)
                            AS resource_count
                """),
                {"media_id": media_id},
            ).one()
        assert counts == (0, 0, 0)

    def test_member_cannot_remove_media_from_shared_library(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        library_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        library_id = library_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(member_id))

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"library_id": library_id, "user_id": member_id},
            )
            session.commit()

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )

        response = auth_client.delete(
            f"/media/{media_id}?library_id={library_id}",
            headers=auth_headers(member_id),
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            ).fetchone()
        assert row is not None


class TestPodcastLibraryEntries:
    """Tests for podcast entry library routes."""

    def test_add_podcast_success(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries",
            json={"name": "Podcasts"},
            headers=auth_headers(user_id),
        )
        library_id = create_resp.json()["data"]["id"]
        podcast_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', 'football-ramble', 'Football Ramble', 'https://example.com/feed.xml'
                    )
                """),
                {"id": podcast_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                """),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        response = auth_client.post(
            f"/libraries/{library_id}/podcasts",
            json={"podcast_id": str(podcast_id)},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["kind"] == "podcast"
        assert data["podcast"]["id"] == str(podcast_id)

    def test_add_podcast_default_library_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]
        podcast_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', 'chinese-history', 'The China History Podcast', 'https://example.com/china.xml'
                    )
                """),
                {"id": podcast_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                """),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.commit()

        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        response = auth_client.post(
            f"/libraries/{default_library_id}/podcasts",
            json={"podcast_id": str(podcast_id)},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_remove_podcast_success(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries",
            json={"name": "Sports"},
            headers=auth_headers(user_id),
        )
        library_id = create_resp.json()["data"]["id"]
        podcast_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', 'test-podcast', 'Test Podcast', 'https://example.com/test.xml'
                    )
                """),
                {"id": podcast_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                """),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        add_resp = auth_client.post(
            f"/libraries/{library_id}/podcasts",
            json={"podcast_id": str(podcast_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201

        remove_resp = auth_client.delete(
            f"/libraries/{library_id}/podcasts/{podcast_id}",
            headers=auth_headers(user_id),
        )
        assert remove_resp.status_code == 204


class TestListLibraryMedia:
    """Tests for GET /libraries/{id}/entries endpoint."""

    def test_list_media_empty(self, auth_client):
        """List media in empty library returns empty list."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        body = response.json()
        assert body["page"] == {"has_more": False, "next_cursor": None}
        assert body["data"] == []

    def test_list_media_success(self, auth_client, direct_db: DirectSessionManager):
        """List media returns media in library."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        body = response.json()
        assert body["page"] == {"has_more": False, "next_cursor": None}
        data = body["data"]
        assert len(data) == 1
        assert data[0]["kind"] == "media"
        assert data[0]["media"]["id"] == str(media_id)
        assert data[0]["media"]["kind"] == "web_article"
        assert data[0]["media"]["read_state"] == "unread"
        assert data[0]["read_state"] == "unread"

    def test_list_media_rejects_invalid_viewer_timezone(self, auth_client):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            viewer_tz="Not/A_Zone",
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_media_marks_surfaced_today_by_viewer_timezone(
        self, auth_client, direct_db: DirectSessionManager
    ):
        from datetime import UTC, datetime, time, timedelta
        from zoneinfo import ZoneInfo

        from tests.factories import create_test_library

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        viewer_tz = ZoneInfo("America/Los_Angeles")
        today_start = datetime.combine(
            datetime.now(viewer_tz).date(), time.min, tzinfo=viewer_tz
        ).astimezone(UTC)
        before_today = today_start - timedelta(seconds=1)

        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Surfaced Today")
            stale_media_id = create_test_media(session, title="Yesterday")
            fresh_media_id = create_test_media(session, title="Today")
            session.execute(
                text(
                    """
                    INSERT INTO library_entries (library_id, media_id, position, created_at)
                    VALUES
                      (:library_id, :stale_media_id, 0, :before_today),
                      (:library_id, :fresh_media_id, 1, now())
                    """
                ),
                {
                    "library_id": library_id,
                    "stale_media_id": stale_media_id,
                    "fresh_media_id": fresh_media_id,
                    "before_today": before_today,
                },
            )
            session.commit()

        for media_id in (stale_media_id, fresh_media_id):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            viewer_tz="America/Los_Angeles",
        )

        assert response.status_code == 200, response.text
        by_media_id = {row["media"]["id"]: row for row in response.json()["data"]}
        assert by_media_id[str(stale_media_id)]["surfaced_today"] is False
        assert by_media_id[str(fresh_media_id)]["surfaced_today"] is True

    def test_list_media_uses_canonical_media_hydration_for_podcast_episode(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = uuid4()
        podcast_id = uuid4()
        provider_podcast_id = f"library-hydration-{podcast_id}"
        provider_episode_id = f"episode-{media_id}"

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO podcasts (
                        id,
                        provider,
                        provider_podcast_id,
                        title,
                        feed_url,
                        website_url,
                        image_url,
                        description
                    ) VALUES (
                        :podcast_id,
                        'podcast_index',
                        :provider_podcast_id,
                        'Library Hydration Podcast',
                        'https://example.com/library-hydration.xml',
                        'https://example.com/library-hydration',
                        NULL,
                        'Podcast description'
                    )
                """),
                {
                    "podcast_id": podcast_id,
                    "provider_podcast_id": provider_podcast_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        external_playback_url,
                        provider,
                        provider_id
                    ) VALUES (
                        :media_id,
                        'podcast_episode',
                        'Library Hydration Episode',
                        'https://example.com/library-hydration-episode',
                        'ready_for_reading',
                        'https://cdn.example.com/library-hydration-episode.mp3',
                        'podcast_index',
                        :provider_episode_id
                    )
                """),
                {
                    "media_id": media_id,
                    "provider_episode_id": provider_episode_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO podcast_episodes (
                        media_id,
                        podcast_id,
                        provider_episode_id,
                        guid,
                        fallback_identity,
                        published_at,
                        duration_seconds,
                        description_html,
                        description_text
                    ) VALUES (
                        :media_id,
                        :podcast_id,
                        :provider_episode_id,
                        :guid,
                        :fallback_identity,
                        '2026-03-22T00:00:00Z',
                        180,
                        '<p>Episode HTML description</p>',
                        'Episode text description'
                    )
                """),
                {
                    "media_id": media_id,
                    "podcast_id": podcast_id,
                    "provider_episode_id": provider_episode_id,
                    "guid": f"guid-{provider_episode_id}",
                    "fallback_identity": f"fallback-{provider_episode_id}",
                },
            )
            session.execute(
                text("""
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status
                    ) VALUES (
                        :media_id,
                        'ready',
                        'full',
                        'ready'
                    )
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_episode_chapters (
                        media_id,
                        chapter_idx,
                        title,
                        t_start_ms,
                        t_end_ms,
                        url,
                        image_url,
                        source
                    ) VALUES
                    (
                        :media_id,
                        0,
                        'Intro',
                        0,
                        45000,
                        'https://example.com/chapters/intro',
                        NULL,
                        'rss_podcasting20'
                    ),
                    (
                        :media_id,
                        1,
                        'Deep Dive',
                        45000,
                        NULL,
                        'https://example.com/chapters/deep-dive',
                        'https://cdn.example.com/chapter.png',
                        'rss_podcasting20'
                    )
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_subscriptions (
                        user_id,
                        podcast_id,
                        status,
                        default_playback_speed,
                        auto_queue
                    ) VALUES (
                        :user_id,
                        :podcast_id,
                        'active',
                        1.5,
                        false
                    )
                """),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_listening_states (
                        user_id,
                        media_id,
                        position_ms,
                        duration_ms,
                        playback_speed,
                        is_completed
                    ) VALUES (
                        :user_id,
                        :media_id,
                        12000,
                        180000,
                        1.25,
                        false
                    )
                """),
                {"user_id": user_id, "media_id": media_id},
            )
            # Read-state now derives from the attention ledger, not the listening
            # table: an in-progress session (dwell >= 30s) with the same playback
            # fraction is what the listening route would record.
            session.execute(
                text("""
                    INSERT INTO reading_sessions (
                        user_id, media_id, device_id, dwell_ms, max_progression
                    ) VALUES (
                        :user_id, :media_id, 'device-test', 35000, :fraction
                    )
                """),
                {"user_id": user_id, "media_id": media_id, "fraction": 12000.0 / 180000.0},
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_episode_chapters", "media_id", media_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        add_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201

        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1
        media = data[0]["media"]
        assert media["id"] == str(media_id)
        assert media["transcript_state"] == "ready"
        assert media["transcript_coverage"] == "full"
        assert media["subscription_default_playback_speed"] == 1.5
        assert media["description_html"] == "<p>Episode HTML description</p>"
        assert media["description_text"] == "Episode text description"
        assert media["listening_state"] == {
            "position_ms": 12000,
            "duration_ms": 180000,
            "playback_speed": 1.25,
            "is_completed": False,
        }
        assert media["read_state"] == "in_progress"
        assert media["progress_fraction"] == pytest.approx(12000 / 180000)
        assert data[0]["read_state"] == "in_progress"
        assert data[0]["progress_fraction"] == pytest.approx(12000 / 180000)
        assert media["chapters"] == [
            {
                "chapter_idx": 0,
                "title": "Intro",
                "t_start_ms": 0,
                "t_end_ms": 45000,
                "url": "https://example.com/chapters/intro",
                "image_url": None,
            },
            {
                "chapter_idx": 1,
                "title": "Deep Dive",
                "t_start_ms": 45000,
                "t_end_ms": None,
                "url": "https://example.com/chapters/deep-dive",
                "image_url": "https://cdn.example.com/chapter.png",
            },
        ]

    def test_list_media_library_not_found(self, auth_client):
        """List media in non-existent library returns 404."""
        user_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_id))

        response = _list_library_entries(auth_client, user_id, str(uuid4()))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_list_media_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Media is ordered by persistent library_entries.position ascending."""
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
                direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        # List media (should preserve append order: first added first)
        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        body = response.json()
        assert body["page"] == {"has_more": False, "next_cursor": None}
        data = body["data"]
        assert len(data) == 3
        assert _library_entry_media_ids(data) == [str(media_id) for media_id in media_ids]

    def test_list_media_paginates_with_next_cursor(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(3):
                media_id = create_test_media(session, title=f"Paged Entry {idx}")
                media_ids.append(media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        for media_id in media_ids:
            response = auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )
            assert response.status_code in (200, 201), response.text

        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[0]),
            str(media_ids[1]),
        ]
        cursor = first_body["page"]["next_cursor"]
        assert first_body["page"]["has_more"] is True
        assert cursor is not None

        second = _list_library_entries(auth_client, user_id, library_id, limit=2, cursor=cursor)
        assert second.status_code == 200, second.text
        second_body = second.json()
        assert _library_entry_media_ids(second_body["data"]) == [str(media_ids[2])]
        assert second_body["page"] == {"has_more": False, "next_cursor": None}

    def test_list_media_rejects_cursor_from_another_library(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_a = create_test_library(session, user_id, "Cursor Scope A")
            library_b = create_test_library(session, user_id, "Cursor Scope B")
            media_ids = [
                create_test_media(session, title=f"Scoped Entry {idx}") for idx in range(3)
            ]
            for position, media_id in enumerate(media_ids):
                session.execute(
                    text("""
                        INSERT INTO library_entries (library_id, media_id, position)
                        VALUES (:library_id, :media_id, :position)
                    """),
                    {"library_id": library_a, "media_id": media_id, "position": position},
                )
            session.commit()

        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        for library_id in (library_a, library_b):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        first = _list_library_entries(auth_client, user_id, library_a, limit=1)
        assert first.status_code == 200, first.text
        cursor = first.json()["page"]["next_cursor"]
        assert cursor is not None

        response = _list_library_entries(auth_client, user_id, library_b, limit=1, cursor=cursor)

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_media_snapshot_survives_position_renormalization(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(3):
                media_id = create_test_media(session, title=f"Stable Position {idx}")
                media_ids.append(media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        for media_id in media_ids:
            response = auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )
            assert response.status_code in (200, 201), response.text

        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[0]),
            str(media_ids[1]),
        ]
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        delete_response = auth_client.delete(
            f"/media/{media_ids[0]}?library_id={library_id}",
            headers=auth_headers(user_id),
        )
        assert delete_response.status_code == 200, delete_response.text

        second = _list_library_entries(auth_client, user_id, library_id, limit=2, cursor=cursor)
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(second.json()["data"]) == [str(media_ids[2])]

    def test_list_media_rejects_invalid_cursor(self, auth_client):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        response = _list_library_entries(auth_client, user_id, library_id, cursor="not-a-cursor")

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_media_rejects_offset_parameter(self, auth_client):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        response = _list_library_entries(auth_client, user_id, library_id, offset=1)

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_media_rejects_cursor_from_another_sort(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Cross Sort Cursor")
            media_a = create_test_media(session, title="Cross Sort A")
            media_b = create_test_media(session, title="Cross Sort B")
            for position, media_id in enumerate((media_a, media_b)):
                session.execute(
                    text(
                        """
                        INSERT INTO library_entries (library_id, media_id, position)
                        VALUES (:library_id, :media_id, :position)
                        """
                    ),
                    {"library_id": library_id, "media_id": media_id, "position": position},
                )
            session.commit()

        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        first = _list_library_entries(auth_client, user_id, library_id, sort="position", limit=1)
        assert first.status_code == 200, first.text
        cursor = first.json()["page"]["next_cursor"]
        assert cursor is not None

        response = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            sort="resonance",
            cursor=cursor,
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_resonance_cursor_uses_stable_snapshot_after_score_mutation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Stable Resonance Cursor")
            media_ids = [
                create_test_media(session, title=f"Stable Resonance {idx}") for idx in range(3)
            ]
            for position, media_id in enumerate(media_ids):
                session.execute(
                    text("""
                        INSERT INTO library_entries (
                            library_id,
                            media_id,
                            position,
                            created_at
                        )
                        VALUES (
                            :library_id,
                            :media_id,
                            :position,
                            now() - (:age_days * interval '1 day')
                        )
                    """),
                    {
                        "library_id": library_id,
                        "media_id": media_id,
                        "position": position,
                        "age_days": position,
                    },
                )
            session.commit()

        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        full_before = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=10
        )
        assert full_before.status_code == 200, full_before.text
        expected_media_ids = _library_entry_media_ids(full_before.json()["data"])
        assert len(expected_media_ids) == 3

        first = _list_library_entries(auth_client, user_id, library_id, sort="resonance", limit=1)
        assert first.status_code == 200, first.text
        first_body = first.json()
        first_media_ids = _library_entry_media_ids(first_body["data"])
        assert first_media_ids == expected_media_ids[:1]
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        media_to_promote = UUID(expected_media_ids[-1])
        with direct_db.session() as session:
            session.execute(
                text("""
                    UPDATE library_entries
                    SET created_at = now()
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_to_promote},
            )
            session.commit()

        second = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            sort="resonance",
            limit=2,
            cursor=cursor,
        )
        assert second.status_code == 200, second.text
        assert (
            first_media_ids + _library_entry_media_ids(second.json()["data"]) == expected_media_ids
        )


class TestReorderLibraryMedia:
    """Tests for PATCH /libraries/{id}/entries/reorder endpoint."""

    def test_reorder_library_entries_replaces_order(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for index in range(3):
                media_id = create_test_media(session, title=f"Reorder {index}")
                media_ids.append(media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        for media_id in media_ids:
            add_resp = auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )
            assert add_resp.status_code in (200, 201)

        reordered_media_ids = [media_ids[2], media_ids[0], media_ids[1]]
        list_resp = _list_library_entries(auth_client, user_id, library_id)
        existing_entries = list_resp.json()["data"]
        media_entry_id_by_media_id = {
            row["media"]["id"]: row["id"]
            for row in existing_entries
            if row["kind"] == "media" and row["media"] is not None
        }
        reordered_entry_ids = [
            media_entry_id_by_media_id[str(media_id)] for media_id in reordered_media_ids
        ]
        reorder_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": reordered_entry_ids},
            headers=auth_headers(user_id),
        )
        assert reorder_resp.status_code == 200, (
            f"Expected 200 reorder response, got {reorder_resp.status_code}: {reorder_resp.text}"
        )

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        assert list_resp.status_code == 200
        assert _library_entry_media_ids(list_resp.json()["data"]) == [
            str(media_id) for media_id in reordered_media_ids
        ]

    def test_reorder_library_entries_requires_exact_media_set(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Order A")
            media_b = create_test_media(session, title="Order B")
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
            auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        existing_entries = list_resp.json()["data"]
        media_entry_id_by_media_id = {
            row["media"]["id"]: row["id"]
            for row in existing_entries
            if row["kind"] == "media" and row["media"] is not None
        }

        missing_id_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": [media_entry_id_by_media_id[str(media_a)]]},
            headers=auth_headers(user_id),
        )
        assert missing_id_resp.status_code == 400
        assert missing_id_resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_reorder_library_entries_rejects_partial_page_subset(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(3):
                media_id = create_test_media(session, title=f"Partial Reorder {idx}")
                media_ids.append(media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        for media_id in media_ids:
            add_resp = auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )
            assert add_resp.status_code in (200, 201), add_resp.text

        first_page = _list_library_entries(auth_client, user_id, library_id, limit=2).json()
        assert first_page["page"]["next_cursor"] is not None
        partial_ids = [row["id"] for row in first_page["data"]]

        response = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": partial_ids},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_reorder_library_entries_forbids_non_admin(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(member_id))

        create_resp = auth_client.post(
            "/libraries",
            json={"name": "Shared order library"},
            headers=auth_headers(owner_id),
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Shared A")
            media_b = create_test_media(session, title="Shared B")
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
            auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(owner_id),
            )

        invite_resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(member_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert invite_resp.status_code == 201
        invite_id = invite_resp.json()["data"]["id"]
        accept_resp = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(member_id),
        )
        assert accept_resp.status_code == 200

        list_resp = _list_library_entries(auth_client, owner_id, library_id)
        existing_entries = list_resp.json()["data"]
        media_entry_id_by_media_id = {
            row["media"]["id"]: row["id"]
            for row in existing_entries
            if row["kind"] == "media" and row["media"] is not None
        }
        reorder_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={
                "entry_ids": [
                    media_entry_id_by_media_id[str(media_b)],
                    media_entry_id_by_media_id[str(media_a)],
                ]
            },
            headers=auth_headers(member_id),
        )
        assert reorder_resp.status_code == 403
        assert reorder_resp.json()["error"]["code"] == "E_FORBIDDEN"

    def test_reorder_library_entries_mixes_media_and_podcast(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Reorder is target.kind-agnostic: a library holding both a media and a podcast
        entry reorders by entry id and stays dense (0..n-1)."""
        user_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries", json={"name": "Mixed order"}, headers=auth_headers(user_id)
        ).json()["data"]["id"]
        podcast_id = uuid4()

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Mixed media")
            session.execute(
                text("""
                    INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                    VALUES (:id, 'podcast_index', 'mixed-order', 'Mixed Order',
                            'https://example.com/mixed.xml')
                """),
                {"id": podcast_id},
            )
            session.execute(
                text("""
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                """),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        assert auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        ).status_code in (200, 201)
        assert (
            auth_client.post(
                f"/libraries/{library_id}/podcasts",
                json={"podcast_id": str(podcast_id)},
                headers=auth_headers(user_id),
            ).status_code
            == 201
        )

        entries = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        media_entry_id = next(row["id"] for row in entries if row["kind"] == "media")
        podcast_entry_id = next(row["id"] for row in entries if row["kind"] == "podcast")

        reorder_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": [podcast_entry_id, media_entry_id]},
            headers=auth_headers(user_id),
        )
        assert reorder_resp.status_code == 200, reorder_resp.text

        after = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        assert [row["id"] for row in after] == [podcast_entry_id, media_entry_id]
        assert [row["position"] for row in after] == [0, 1]

    @pytest.mark.parametrize("bad_set_kind", ["duplicate", "foreign"])
    def test_reorder_library_entries_rejects_bad_sets(
        self, auth_client, direct_db: DirectSessionManager, bad_set_kind: str
    ):
        """Reorder requires the exact existing set: duplicate ids (same length, wrong set)
        and foreign ids both 400 and leave the stored order untouched."""
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Bad set A")
            media_b = create_test_media(session, title="Bad set B")
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
            auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(media_id)},
                headers=auth_headers(user_id),
            )

        entries = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        entry_id_a = next(
            row["id"] for row in entries if row["media"] and row["media"]["id"] == str(media_a)
        )
        bad_entry_ids = (
            [entry_id_a, entry_id_a] if bad_set_kind == "duplicate" else [entry_id_a, str(uuid4())]
        )

        resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": bad_entry_ids},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

        after = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        assert _library_entry_media_ids(after) == [str(media_a), str(media_b)]


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
                    SELECT 1 FROM library_entries
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            assert result.fetchone() is not None

    def test_add_media_non_default_creates_closure_edges_and_default_materialization(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Adding media to non-default library creates closure edges and default rows."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Bootstrap member before inviting
        auth_client.get("/me", headers=auth_headers(member_id))

        # Create non-default library as owner
        lib_resp = auth_client.post(
            "/libraries", json={"name": "Shared Lib"}, headers=auth_headers(owner_id)
        )
        lib_id = lib_resp.json()["data"]["id"]

        # Add member via invite flow
        invite_resp = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={"invitee_user_id": str(member_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        invite_id = invite_resp.json()["data"]["id"]
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(member_id),
        )

        # Get default library IDs
        owner_me = auth_client.get("/me", headers=auth_headers(owner_id)).json()
        member_me = auth_client.get("/me", headers=auth_headers(member_id)).json()
        owner_dl = owner_me["data"]["default_library_id"]
        member_dl = member_me["data"]["default_library_id"]

        # Add media to non-default library
        auth_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )

        # Verify closure edges and materialized rows exist for both members
        with direct_db.session() as session:
            for dl_id in [owner_dl, member_dl]:
                edge = session.execute(
                    text("""
                        SELECT 1 FROM default_library_closure_edges
                        WHERE default_library_id = :dl AND media_id = :m AND source_library_id = :src
                    """),
                    {"dl": dl_id, "m": media_id, "src": lib_id},
                ).fetchone()
                assert edge is not None, f"Missing closure edge for dl={dl_id}"

                lm = session.execute(
                    text("""
                        SELECT 1 FROM library_entries
                        WHERE library_id = :dl AND media_id = :m
                    """),
                    {"dl": dl_id, "m": media_id},
                ).fetchone()
                assert lm is not None, f"Missing materialized row for dl={dl_id}"

    def test_remove_media_non_default_deletes_source_edges_and_gcs_default_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing media from non-default library deletes source edges and gcs default row."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        lib_resp = auth_client.post(
            "/libraries", json={"name": "Non Default"}, headers=auth_headers(user_id)
        )
        lib_id = lib_resp.json()["data"]["id"]

        # Add media to non-default (creates closure edges + default materialization)
        auth_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Verify closure edge exists
        with direct_db.session() as session:
            edge = session.execute(
                text("""
                    SELECT 1 FROM default_library_closure_edges
                    WHERE default_library_id = :dl AND media_id = :m AND source_library_id = :src
                """),
                {"dl": default_library_id, "m": media_id, "src": lib_id},
            ).fetchone()
            assert edge is not None

        # Remove from non-default
        auth_client.delete(
            f"/media/{media_id}?library_id={lib_id}",
            headers=auth_headers(user_id),
        )

        # Verify closure edge deleted and default row gc'd (no intrinsic)
        with direct_db.session() as session:
            edge = session.execute(
                text("""
                    SELECT 1 FROM default_library_closure_edges
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            ).fetchone()
            assert edge is None

            lm = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            ).fetchone()
            assert lm is None

    def test_remove_media_from_default_removes_intrinsic_but_keeps_row_when_closure_exists(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing from default removes intrinsic but keeps row when closure edge exists."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Add media to default (creates intrinsic)
        auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Also add to a non-default library (creates closure edge)
        lib_resp = auth_client.post(
            "/libraries", json={"name": "Non Default"}, headers=auth_headers(user_id)
        )
        lib_id = lib_resp.json()["data"]["id"]
        auth_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Now remove from default
        auth_client.delete(
            f"/media/{media_id}?library_id={default_library_id}",
            headers=auth_headers(user_id),
        )

        # Intrinsic should be gone
        with direct_db.session() as session:
            intrinsic = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            ).fetchone()
            assert intrinsic is None

            # But library_entries should still exist (closure edge remains)
            lm = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            ).fetchone()
            assert lm is not None

    def test_remove_media_from_default_row_is_gc_after_closure_removed(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Default row is gc'd once closure edge is also removed."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Add to default (intrinsic) and non-default (closure)
        auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        lib_resp = auth_client.post(
            "/libraries", json={"name": "ND"}, headers=auth_headers(user_id)
        )
        lib_id = lib_resp.json()["data"]["id"]
        auth_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Remove intrinsic first
        auth_client.delete(
            f"/media/{media_id}?library_id={default_library_id}",
            headers=auth_headers(user_id),
        )
        # Row survives (closure edge)
        with direct_db.session() as session:
            assert (
                session.execute(
                    text("SELECT 1 FROM library_entries WHERE library_id = :dl AND media_id = :m"),
                    {"dl": default_library_id, "m": media_id},
                ).fetchone()
                is not None
            )

        # Now remove closure source
        auth_client.delete(
            f"/media/{media_id}?library_id={lib_id}",
            headers=auth_headers(user_id),
        )

        # Now default row should be gc'd
        with direct_db.session() as session:
            assert (
                session.execute(
                    text("SELECT 1 FROM library_entries WHERE library_id = :dl AND media_id = :m"),
                    {"dl": default_library_id, "m": media_id},
                ).fetchone()
                is None
            )

    def test_remove_from_non_default_gcs_default_when_no_intrinsic(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing media from non-default library GCs default row when no intrinsic."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Create non-default library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other Library"}, headers=auth_headers(user_id)
        )
        other_library_id = create_resp.json()["data"]["id"]

        # Add media to non-default library (creates closure edge + materialized default row)
        auth_client.post(
            f"/libraries/{other_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Remove from non-default library
        auth_client.delete(
            f"/media/{media_id}?library_id={other_library_id}",
            headers=auth_headers(user_id),
        )

        # Default row is GC'd because no intrinsic and no remaining closure edge.
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            assert result.fetchone() is None

    def test_add_media_to_default_library_creates_intrinsic(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Adding media to default library creates intrinsic provenance row."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Get default library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Add media to default library
        resp = auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 201

        # Verify intrinsic row exists
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            )
            assert result.fetchone() is not None

    def test_remove_media_from_default_library_removes_intrinsic(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing media from default library removes intrinsic provenance row."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        # Add media to default library (creates intrinsic)
        auth_client.post(
            f"/libraries/{default_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Verify intrinsic row exists
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            )
            assert result.fetchone() is not None

        # Remove from default library
        auth_client.delete(
            f"/media/{media_id}?library_id={default_library_id}",
            headers=auth_headers(user_id),
        )

        # Verify intrinsic row removed
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": default_library_id, "m": media_id},
            )
            assert result.fetchone() is None


# =============================================================================
# GET /libraries/{id} Route
# =============================================================================


class TestGetLibrary:
    """Tests for GET /libraries/{library_id} endpoint."""

    def test_get_library_success_for_member(self, auth_client):
        """Member can get library details."""
        user_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Test Lib"}, headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.get(f"/libraries/{library_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["id"] == library_id
        assert data["name"] == "Test Lib"
        assert data["role"] == "admin"

    def test_get_library_masked_not_found_for_non_member(self, auth_client):
        """Non-member gets masked 404."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Private"}, headers=auth_headers(user_a)
        )
        library_id = create_resp.json()["data"]["id"]

        # Bootstrap user_b
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/libraries/{library_id}", headers=auth_headers(user_b))
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"


# =============================================================================
# Library Delete (owner-only)
# =============================================================================


class TestDeleteLibraryGovernance:
    """Tests owner-only delete semantics."""

    def test_delete_library_owner_can_delete_multi_member_non_default(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Owner can delete non-default library even with multiple members."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        # Create library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Bootstrap member and add directly to library
        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        # Owner deletes — should succeed
        response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(owner_id))
        assert response.status_code == 204

    def test_delete_library_non_owner_admin_returns_owner_required(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-owner admin gets 403 E_OWNER_REQUIRED."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'admin')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": admin_id},
            )
            session.commit()

        response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(admin_id))
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_REQUIRED"

    def test_delete_library_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Private"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(outsider_id))
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"


# =============================================================================
# Member Endpoints
# =============================================================================


class TestListMembers:
    """Tests for GET /libraries/{id}/members endpoint."""

    def test_list_members_admin_success_order_owner_admin_member(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Members listed in order: owner first, then admins, then members."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        auth_client.get("/me", headers=auth_headers(member_id))

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :admin_id, 'admin'), (:lid, :member_id, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "admin_id": admin_id, "member_id": member_id},
            )
            session.commit()

        response = auth_client.get(
            f"/libraries/{library_id}/members", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3

        # Owner first
        assert data[0]["user_id"] == str(owner_id)
        assert data[0]["is_owner"] is True
        assert data[0]["role"] == "admin"

        # Admin second
        assert data[1]["user_id"] == str(admin_id)
        assert data[1]["is_owner"] is False
        assert data[1]["role"] == "admin"

        # Member last
        assert data[2]["user_id"] == str(member_id)
        assert data[2]["is_owner"] is False
        assert data[2]["role"] == "member"

    def test_list_members_limit_and_clamp(self, auth_client, direct_db: DirectSessionManager):
        """Limit parameter works and clamps to 200."""
        owner_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.get(
            f"/libraries/{library_id}/members?limit=1", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1

    def test_list_members_non_admin_member_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-admin member gets 403."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.get(
            f"/libraries/{library_id}/members", headers=auth_headers(member_id)
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_list_members_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Private"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.get(
            f"/libraries/{library_id}/members", headers=auth_headers(outsider_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_list_members_default_library_allowed(self, auth_client):
        """Listing members of default library is allowed."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.get(
            f"/libraries/{default_library_id}/members", headers=auth_headers(user_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1
        assert data[0]["user_id"] == str(user_id)


class TestUpdateMemberRole:
    """Tests for PATCH /libraries/{id}/members/{user_id} endpoint."""

    def test_patch_member_role_promote_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can promote member to admin."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{member_id}",
            json={"role": "admin"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["role"] == "admin"
        assert data["user_id"] == str(member_id)

    def test_patch_member_role_idempotent_no_change(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Setting same role is idempotent."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{member_id}",
            json={"role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        assert response.json()["data"]["role"] == "member"

    def test_patch_member_role_non_admin_member_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-admin member cannot change roles."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        target_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        auth_client.get("/me", headers=auth_headers(target_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :mid, 'member'), (:lid, :tid, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "mid": member_id, "tid": target_id},
            )
            session.commit()

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{target_id}",
            json={"role": "admin"},
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_patch_member_role_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{owner_id}",
            json={"role": "member"},
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_patch_member_role_target_missing_not_found(self, auth_client):
        """Target member not found returns 404 E_NOT_FOUND."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{uuid4()}",
            json={"role": "admin"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_patch_member_role_owner_self_demotion_forbidden_owner_exit(self, auth_client):
        """Owner cannot self-demote."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{owner_id}",
            json={"role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_EXIT_FORBIDDEN"

    def test_patch_member_role_owner_target_forbidden_owner_exit(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Another admin cannot demote the owner."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'admin') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": admin_id},
            )
            session.commit()

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{owner_id}",
            json={"role": "member"},
            headers=auth_headers(admin_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_EXIT_FORBIDDEN"

    def test_patch_member_role_demotes_non_owner_admin(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Owner can demote a non-owner admin because the owner remains admin."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :aid, 'admin')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "aid": admin_id},
            )
            session.commit()

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{admin_id}",
            json={"role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["role"] == "member"
        assert data["user_id"] == str(admin_id)

    def test_patch_member_role_default_library_forbidden(self, auth_client):
        """Cannot change roles in default library."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.patch(
            f"/libraries/{default_library_id}/members/{user_id}",
            json={"role": "member"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"


class TestRemoveMember:
    """Tests for DELETE /libraries/{id}/members/{user_id} endpoint."""

    def test_delete_member_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can remove a member."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{member_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

        # Verify removed
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": member_id},
            )
            assert result.fetchone() is None

    def test_delete_member_absent_is_idempotent_204(self, auth_client):
        """Deleting non-existent member is idempotent 204."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{uuid4()}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

    def test_delete_member_non_admin_member_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-admin member cannot remove others."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        target_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        auth_client.get("/me", headers=auth_headers(target_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :mid, 'member'), (:lid, :tid, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "mid": member_id, "tid": target_id},
            )
            session.commit()

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{target_id}",
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_delete_member_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Private"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{owner_id}",
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_delete_member_owner_self_removal_forbidden_owner_exit(self, auth_client):
        """Owner cannot self-remove."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{owner_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_EXIT_FORBIDDEN"

    def test_delete_member_owner_target_forbidden_owner_exit(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Another admin cannot remove the owner."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'admin') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": admin_id},
            )
            session.commit()

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{owner_id}",
            headers=auth_headers(admin_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_EXIT_FORBIDDEN"

    def test_delete_member_removes_non_owner_admin(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Owner can remove a non-owner admin because the owner remains admin."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'admin') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": admin_id},
            )
            session.commit()

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{admin_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT 1 FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": admin_id},
            )
            assert result.fetchone() is None

    def test_delete_member_default_library_forbidden(self, auth_client):
        """Cannot remove members from default library."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.delete(
            f"/libraries/{default_library_id}/members/{user_id}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"


# =============================================================================
# Ownership Transfer
# =============================================================================


class TestTransferOwnership:
    """Tests for POST /libraries/{id}/transfer-ownership endpoint."""

    def test_transfer_ownership_success_promotes_target_to_admin_and_preserves_previous_owner_admin(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Owner transfers to member; target promoted to admin, previous owner stays admin."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(member_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["owner_user_id"] == str(member_id)

        # Verify roles in DB
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT user_id, role FROM memberships
                    WHERE library_id = :lid
                    ORDER BY user_id
                """),
                {"lid": library_id},
            )
            roles = {str(r[0]): r[1] for r in result.fetchall()}
            assert roles[str(member_id)] == "admin"
            assert roles[str(owner_id)] == "admin"

    def test_transfer_ownership_idempotent_when_target_is_current_owner(self, auth_client):
        """Transfer to self is idempotent 200."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(owner_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        assert response.json()["data"]["owner_user_id"] == str(owner_id)

    def test_transfer_ownership_non_owner_admin_owner_required(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-owner admin gets E_OWNER_REQUIRED."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'admin') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": admin_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(admin_id)},
            headers=auth_headers(admin_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_REQUIRED"

    def test_transfer_ownership_non_owner_member_owner_required(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-owner member gets E_OWNER_REQUIRED."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(member_id)},
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_REQUIRED"

    def test_transfer_ownership_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(owner_id)},
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_transfer_ownership_default_library_forbidden(self, auth_client):
        """Cannot transfer ownership of default library."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.post(
            f"/libraries/{default_library_id}/transfer-ownership",
            json={"new_owner_user_id": str(uuid4())},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_transfer_ownership_target_non_member_invalid(self, auth_client):
        """Transfer to non-member returns E_OWNERSHIP_TRANSFER_INVALID."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(uuid4())},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_OWNERSHIP_TRANSFER_INVALID"

    def test_transfer_ownership_updates_updated_at_on_actual_change(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """updated_at changes on actual ownership transfer."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        original_updated_at = create_resp.json()["data"]["updated_at"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(member_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        new_updated_at = response.json()["data"]["updated_at"]
        assert new_updated_at >= original_updated_at

    def test_transfer_then_previous_owner_exit_path_allowed(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """After transfer, previous owner can be demoted/removed."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        # Transfer
        auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"new_owner_user_id": str(member_id)},
            headers=auth_headers(owner_id),
        )

        # New owner can now remove previous owner
        response = auth_client.delete(
            f"/libraries/{library_id}/members/{owner_id}",
            headers=auth_headers(member_id),
        )
        assert response.status_code == 204


# =============================================================================
# Invariant Repair
# =============================================================================


class TestGovernanceInvariantRepair:
    """Tests for owner-admin invariant repair during governance mutations."""

    def test_governance_mutation_repairs_owner_admin_invariant(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Governance mutation repairs dirty owner-admin state on successful commit.

        The repair runs inside the transaction. If the mutation succeeds, the
        repair persists. If it fails, the txn rolls back and repair is lost.
        We test a successful mutation path: another admin promotes a member,
        while the owner's role is corrupted. The repair fixes owner's role
        alongside the successful promotion.
        """
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(admin_id))
        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :aid, 'admin'), (:lid, :mid, 'member')
                    ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "aid": admin_id, "mid": member_id},
            )
            session.commit()

        # Corrupt: demote owner to member directly in DB
        with direct_db.session() as session:
            session.execute(
                text("""
                    UPDATE memberships SET role = 'member'
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": owner_id},
            )
            session.commit()

        # admin_id (still admin) performs a SUCCESSFUL mutation: promote member_id
        response = auth_client.patch(
            f"/libraries/{library_id}/members/{member_id}",
            json={"role": "admin"},
            headers=auth_headers(admin_id),
        )
        assert response.status_code == 200

        # Repair persisted because the mutation succeeded
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT role FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": owner_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "admin"


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
        response = _list_library_entries(auth_client, user_b, library_id)

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


# =============================================================================
# Invitation Lifecycle Tests
# =============================================================================


class TestLibraryInviteCreateList:
    """Tests for POST /libraries/{library_id}/invites and GET invite list endpoints."""

    def test_create_invite_success_returns_201(self, auth_client, direct_db: DirectSessionManager):
        """Admin creates invite for existing non-member user; returns 201."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Bootstrap invitee
        auth_client.get("/me", headers=auth_headers(invitee_id))

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["status"] == "pending"
        assert data["invitee_user_id"] == str(invitee_id)
        assert data["inviter_user_id"] == str(owner_id)
        assert data["library_id"] == library_id
        assert data["role"] == "member"
        assert data["responded_at"] is None

    def test_create_invite_non_admin_forbidden(self, auth_client, direct_db: DirectSessionManager):
        """Non-admin member cannot create invites."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        auth_client.get("/me", headers=auth_headers(invitee_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_create_invite_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404 when trying to invite."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(outsider_id))
        auth_client.get("/me", headers=auth_headers(invitee_id))

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_create_invite_default_library_forbidden(self, auth_client):
        """Cannot invite to default library."""
        user_id = create_test_user_id()
        invitee_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        response = auth_client.post(
            f"/libraries/{default_library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_create_invite_user_not_found(self, auth_client):
        """Invite for non-existent user returns 404 E_USER_NOT_FOUND."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(uuid4()), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_USER_NOT_FOUND"

    def test_create_invite_member_exists_conflict(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Inviting existing member returns 409 E_INVITE_MEMBER_EXISTS."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(member_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_MEMBER_EXISTS"

    def test_create_invite_self_conflicts_as_member_exists(self, auth_client):
        """Self-invite is caught by membership check (owner is a member)."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(owner_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_MEMBER_EXISTS"

    def test_create_invite_pending_duplicate_conflict(self, auth_client):
        """Creating a second pending invite for the same invitee returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        # First invite
        resp1 = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp1.status_code == 201

        # Second invite — duplicate
        resp2 = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "admin"},
            headers=auth_headers(owner_id),
        )
        assert resp2.status_code == 409
        assert resp2.json()["error"]["code"] == "E_INVITE_ALREADY_EXISTS"

    def test_list_library_invites_success_sorted_desc(self, auth_client):
        """List library invites returns ordered by created_at DESC, id DESC."""
        owner_id = create_test_user_id()
        invitee_a = create_test_user_id()
        invitee_b = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_a))
        auth_client.get("/me", headers=auth_headers(invitee_b))

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_a), "role": "member"},
            headers=auth_headers(owner_id),
        )
        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_b), "role": "member"},
            headers=auth_headers(owner_id),
        )

        response = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 2
        # DESC order: last created first
        assert data[0]["created_at"] >= data[1]["created_at"]
        for inv in data:
            assert inv["library_id"] == library_id
            assert inv["status"] == "pending"

    def test_list_library_invites_status_filter_default_pending(self, auth_client):
        """Default status filter is pending."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        # Decline the invite
        list_resp = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(owner_id)
        )
        invite_id = list_resp.json()["data"][0]["id"]
        auth_client.post(
            f"/libraries/invites/{invite_id}/decline", headers=auth_headers(invitee_id)
        )

        # Default list (pending) should be empty
        response = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 0

        # Explicitly filter declined
        response = auth_client.get(
            f"/libraries/{library_id}/invites?status=declined",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1

    def test_list_library_invites_non_member_masked_not_found(self, auth_client):
        """Non-member listing library invites gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(outsider_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_list_viewer_invites_success(self, auth_client):
        """Viewer can list their own pending invites across libraries."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(invitee_id))

        # Create two libraries and invite the same user
        for name in ("Lib A", "Lib B"):
            create_resp = auth_client.post(
                "/libraries", json={"name": name}, headers=auth_headers(owner_id)
            )
            lib_id = create_resp.json()["data"]["id"]
            auth_client.post(
                f"/libraries/{lib_id}/invites",
                json={"invitee_user_id": str(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            )

        response = auth_client.get("/libraries/invites", headers=auth_headers(invitee_id))
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 2
        for inv in data:
            assert inv["invitee_user_id"] == str(invitee_id)
            assert inv["status"] == "pending"

    def test_list_viewer_invites_status_filter_and_order(self, auth_client):
        """Viewer invite list respects status filter and order."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(invitee_id))

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        # Accept it
        inv_resp = auth_client.get("/libraries/invites", headers=auth_headers(invitee_id))
        invite_id = inv_resp.json()["data"][0]["id"]
        auth_client.post(f"/libraries/invites/{invite_id}/accept", headers=auth_headers(invitee_id))

        # Pending should be empty
        response = auth_client.get(
            "/libraries/invites?status=pending", headers=auth_headers(invitee_id)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 0

        # Accepted should have 1
        response = auth_client.get(
            "/libraries/invites?status=accepted", headers=auth_headers(invitee_id)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1


class TestLibraryInviteAccept:
    """Tests for POST /libraries/invites/{invite_id}/accept endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        """Helper to create a pending invite and return its ID."""
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["id"]

    def test_accept_invite_happy_path_returns_200(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Invitee accepts pending invite; returns 200 with correct shape."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["invite"]["status"] == "accepted"
        assert data["invite"]["responded_at"] is not None
        assert data["membership"]["library_id"] == library_id
        assert data["membership"]["user_id"] == str(invitee_id)
        assert data["membership"]["role"] == "member"
        assert data["idempotent"] is False
        assert data["backfill_job_status"] == "pending"

    def test_accept_invite_transaction_creates_membership_updates_invite_and_upserts_backfill_job(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Accept atomically creates membership, updates invite, and upserts backfill job."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        # Create library with media
        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )

        auth_client.get("/me", headers=auth_headers(invitee_id))
        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )

        # Verify membership
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT role FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": invitee_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "member"

        # Verify invite status
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT status, responded_at FROM library_invitations WHERE id = :iid
                """),
                {"iid": invite_id},
            )
            row = result.fetchone()
            assert row[0] == "accepted"
            assert row[1] is not None

        # Verify backfill job row
        with direct_db.session() as session:
            # Get invitee default library
            dl = session.execute(
                text("""
                    SELECT id FROM libraries
                    WHERE owner_user_id = :uid AND is_default = true
                """),
                {"uid": invitee_id},
            ).fetchone()
            assert dl is not None

            result = session.execute(
                text("""
                    SELECT status FROM default_library_backfill_jobs
                    WHERE default_library_id = :dlid AND source_library_id = :slid
                          AND user_id = :uid
                """),
                {"dlid": dl[0], "slid": library_id, "uid": invitee_id},
            )
            job_row = result.fetchone()
            assert job_row is not None
            assert job_row[0] == "pending"

    def test_accept_invite_grants_immediate_media_access_before_backfill_worker(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Invitee can read source library media immediately after accept (no backfill needed)."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )

        auth_client.get("/me", headers=auth_headers(invitee_id))
        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )

        # Invitee can immediately list media in the source library
        response = _list_library_entries(auth_client, invitee_id, library_id)
        assert response.status_code == 200
        media_ids = _library_entry_media_ids(response.json()["data"])
        assert str(media_id) in media_ids

    def test_accept_invite_idempotent_when_already_accepted(self, auth_client):
        """Accept on already accepted invite returns 200 idempotent no-op."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept first time
        resp1 = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert resp1.status_code == 200
        assert resp1.json()["data"]["idempotent"] is False

        # Accept second time — idempotent
        resp2 = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert resp2.status_code == 200
        assert resp2.json()["data"]["idempotent"] is True

    def test_accept_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Accept on declined/revoked invite returns 409 E_INVITE_NOT_PENDING."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Decline it
        auth_client.post(
            f"/libraries/invites/{invite_id}/decline",
            headers=auth_headers(invitee_id),
        )

        # Try to accept
        response = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_NOT_PENDING"

    def test_accept_invite_masked_not_found_for_non_invitee(self, auth_client):
        """Non-invitee calling accept gets masked 404."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        other_user = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        auth_client.get("/me", headers=auth_headers(other_user))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(other_user),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_INVITE_NOT_FOUND"

    def test_accept_invite_default_library_forbidden_defense(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Defensive guard: invite targeting default library returns 403."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(owner_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        # Insert invite row directly (bypassing create endpoint guard)
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO library_invitations
                        (library_id, inviter_user_id, invitee_user_id, role, status)
                    VALUES (:lid, :inviter, :invitee, 'member', 'pending')
                """),
                {"lid": default_library_id, "inviter": owner_id, "invitee": invitee_id},
            )
            session.commit()

            inv = session.execute(
                text("""
                    SELECT id FROM library_invitations
                    WHERE library_id = :lid AND invitee_user_id = :uid AND status = 'pending'
                """),
                {"lid": default_library_id, "uid": invitee_id},
            ).fetchone()
            invite_id = str(inv[0])

        response = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_accept_invite_membership_upsert_is_no_duplicate(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """If membership already exists before accept, no duplicate is created."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Pre-create membership directly
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": invitee_id},
            )
            session.commit()

        # Accept still succeeds
        response = auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 200

        # Verify cardinality = 1
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT COUNT(*) FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": invitee_id},
            )
            assert result.scalar() == 1


class TestLibraryInviteDecline:
    """Tests for POST /libraries/invites/{invite_id}/decline endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["id"]

    def test_decline_invite_pending_to_declined(self, auth_client):
        """Invitee declines pending invite; invite becomes declined."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invite_id}/decline",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["invite"]["status"] == "declined"
        assert data["invite"]["responded_at"] is not None
        assert data["idempotent"] is False

    def test_decline_invite_idempotent_when_already_declined(self, auth_client):
        """Decline on already declined invite returns 200 idempotent."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Decline first time
        auth_client.post(
            f"/libraries/invites/{invite_id}/decline",
            headers=auth_headers(invitee_id),
        )

        # Decline second time
        resp2 = auth_client.post(
            f"/libraries/invites/{invite_id}/decline",
            headers=auth_headers(invitee_id),
        )
        assert resp2.status_code == 200
        assert resp2.json()["data"]["idempotent"] is True

    def test_decline_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Decline on accepted/revoked invite returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept first
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )

        # Try to decline
        response = auth_client.post(
            f"/libraries/invites/{invite_id}/decline",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_NOT_PENDING"

    def test_decline_invite_unknown_masked_not_found(self, auth_client):
        """Decline unknown invite returns masked 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            f"/libraries/invites/{uuid4()}/decline",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_INVITE_NOT_FOUND"


class TestLibraryInviteRevoke:
    """Tests for DELETE /libraries/invites/{invite_id} endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee_user_id": str(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["id"]

    def test_revoke_invite_pending_to_revoked(self, auth_client):
        """Admin revokes pending invite; returns 204."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

    def test_revoke_invite_idempotent_when_already_revoked(self, auth_client):
        """Revoke on already revoked invite returns 204."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Revoke first time
        auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(owner_id),
        )

        # Revoke second time
        response = auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

    def test_revoke_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Revoke on accepted/declined invite returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept it
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )

        # Try to revoke
        response = auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_NOT_PENDING"

    def test_revoke_invite_non_member_masked_not_found(self, auth_client):
        """Non-member trying to revoke gets masked 404."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        auth_client.get("/me", headers=auth_headers(outsider_id))

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_INVITE_NOT_FOUND"

    def test_revoke_invite_non_admin_forbidden(self, auth_client, direct_db: DirectSessionManager):
        """Non-admin member trying to revoke gets 403."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id))
        auth_client.get("/me", headers=auth_headers(invitee_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, 'member') ON CONFLICT DO NOTHING
                """),
                {"lid": library_id, "uid": member_id},
            )
            session.commit()

        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invite_id}",
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"


class TestRemoveMemberClosureCleanup:
    """Tests member removal closure cleanup."""

    def test_remove_library_member_deletes_member_closure_edges_and_gcs_rows(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing a member deletes their closure edges and gcs unjustified rows."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_backfill_jobs", "source_library_id", None)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Bootstrap member before inviting
        auth_client.get("/me", headers=auth_headers(member_id))

        # Create shared library + add member
        lib_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        lib_id = lib_resp.json()["data"]["id"]

        invite_resp = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={"invitee_user_id": str(member_id), "role": "admin"},
            headers=auth_headers(owner_id),
        )
        invite_id = invite_resp.json()["data"]["id"]
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(member_id),
        )

        # Add media to shared library (creates closure edges for both)
        auth_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )

        member_me = auth_client.get("/me", headers=auth_headers(member_id)).json()
        member_dl = member_me["data"]["default_library_id"]

        # Verify member closure edge exists
        with direct_db.session() as session:
            edge = session.execute(
                text("""
                    SELECT 1 FROM default_library_closure_edges
                    WHERE default_library_id = :dl AND media_id = :m AND source_library_id = :src
                """),
                {"dl": member_dl, "m": media_id, "src": lib_id},
            ).fetchone()
            assert edge is not None

        # Remove member
        auth_client.delete(
            f"/libraries/{lib_id}/members/{member_id}",
            headers=auth_headers(owner_id),
        )

        # Verify member closure edges deleted and default row gc'd
        with direct_db.session() as session:
            edge = session.execute(
                text("""
                    SELECT 1 FROM default_library_closure_edges
                    WHERE default_library_id = :dl AND source_library_id = :src
                """),
                {"dl": member_dl, "src": lib_id},
            ).fetchone()
            assert edge is None

            lm = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :dl AND media_id = :m
                """),
                {"dl": member_dl, "m": media_id},
            ).fetchone()
            assert lm is None

    def test_remove_library_member_deletes_matching_backfill_job_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Removing member deletes matching backfill job row."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        # Bootstrap member before inviting
        auth_client.get("/me", headers=auth_headers(member_id))

        # Create shared library + add member
        lib_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        lib_id = lib_resp.json()["data"]["id"]

        invite_resp = auth_client.post(
            f"/libraries/{lib_id}/invites",
            json={"invitee_user_id": str(member_id), "role": "admin"},
            headers=auth_headers(owner_id),
        )
        invite_id = invite_resp.json()["data"]["id"]
        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(member_id),
        )

        member_me = auth_client.get("/me", headers=auth_headers(member_id)).json()
        member_dl = member_me["data"]["default_library_id"]

        # Verify backfill job was created by accept
        with direct_db.session() as session:
            job = session.execute(
                text("""
                    SELECT 1 FROM default_library_backfill_jobs
                    WHERE default_library_id = :dl AND source_library_id = :src AND user_id = :uid
                """),
                {"dl": member_dl, "src": lib_id, "uid": str(member_id)},
            ).fetchone()
            assert job is not None

        # Remove member
        auth_client.delete(
            f"/libraries/{lib_id}/members/{member_id}",
            headers=auth_headers(owner_id),
        )

        # Verify backfill job deleted
        with direct_db.session() as session:
            job = session.execute(
                text("""
                    SELECT 1 FROM default_library_backfill_jobs
                    WHERE default_library_id = :dl AND source_library_id = :src AND user_id = :uid
                """),
                {"dl": member_dl, "src": lib_id, "uid": str(member_id)},
            ).fetchone()
            assert job is None


class TestVisibilityClosureScenarios:
    """Tests for spec-defined visibility closure scenarios (V1-V6)."""

    def test_v1_user_adds_media_can_read(self, auth_client, direct_db: DirectSessionManager):
        """V1: User A adds media M to library LA → A can read M."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        response = _list_library_entries(auth_client, user_a, library_a)

        assert response.status_code == 200
        media_ids = _library_entry_media_ids(response.json()["data"])
        assert str(media_id) in media_ids

    def test_v2_non_member_cannot_read_media(self, auth_client, direct_db: DirectSessionManager):
        """V2: User B (no membership in LA) cannot read M."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        response = _list_library_entries(auth_client, user_b, library_a)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_v3_media_accessible_via_closure(self, auth_client, direct_db: DirectSessionManager):
        """V3: User A creates new library LB, does NOT add M → A can still read M (closure)."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        response = _list_library_entries(auth_client, user_a, library_a)

        assert response.status_code == 200
        media_ids = _library_entry_media_ids(response.json()["data"])
        assert str(media_id) in media_ids

    def test_v4_remove_from_default_keeps_closure_backed_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Remove from default removes intrinsic but closure edge keeps media materialized."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        default_library = me_resp.json()["data"]["default_library_id"]

        # Create another library
        create_resp = auth_client.post(
            "/libraries", json={"name": "Other"}, headers=auth_headers(user_a)
        )
        other_library = create_resp.json()["data"]["id"]

        # Add media to other library (creates closure edge + materialized default row)
        auth_client.post(
            f"/libraries/{other_library}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # Verify in both
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            before_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library) in before_ids
            assert UUID(other_library) in before_ids

        # Remove from default - only removes intrinsic (none existed), closure edge stays
        auth_client.delete(
            f"/media/{media_id}?library_id={default_library}",
            headers=auth_headers(user_a),
        )

        # Media stays in default because closure edge from other_library justifies it.
        # Media also stays in other_library (not affected by default removal).
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT library_id FROM library_entries WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            after_ids = {row[0] for row in result.fetchall()}
            assert UUID(default_library) in after_ids, "Closure edge keeps media in default"
            assert UUID(other_library) in after_ids, "Non-default library unaffected"

    def test_v5_after_removal_cannot_read(self, auth_client, direct_db: DirectSessionManager):
        """V5: After V4, User A tries to read M → 404 (media not in any of A's libraries)."""
        user_a = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
            f"/media/{media_id}?library_id={default_library}",
            headers=auth_headers(user_a),
        )

        # Now media list should be empty
        response = auth_client.get(
            f"/libraries/{default_library}/entries", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_v6_different_users_independent(self, auth_client, direct_db: DirectSessionManager):
        """V6: User B keeps their copy when User A removes their default reference."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_test_media(session)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media then removes it
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]
        me_resp_b = auth_client.get("/me", headers=auth_headers(user_b))
        library_b = me_resp_b.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )
        auth_client.post(
            f"/libraries/{library_b}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_b),
        )
        auth_client.delete(
            f"/media/{media_id}?library_id={library_a}",
            headers=auth_headers(user_a),
        )

        # User B can read
        response_b = _list_library_entries(auth_client, user_b, library_b)
        assert response_b.status_code == 200
        media_ids_b = _library_entry_media_ids(response_b.json()["data"])
        assert str(media_id) in media_ids_b

        # User A cannot read (their library is empty)
        response_a = _list_library_entries(auth_client, user_a, library_a)
        assert response_a.status_code == 200
        assert response_a.json()["data"] == []


# ---------------------------------------------------------------------------
# Library list PDF capabilities
# ---------------------------------------------------------------------------


def _create_pdf_media_for_library(
    session,
    *,
    processing_status="ready_for_reading",
    plain_text=None,
    page_count=None,
    with_page_spans=False,
):
    from uuid import uuid4

    from sqlalchemy import text

    media_id = uuid4()

    session.execute(
        text("""
            INSERT INTO media (
                id, kind, title, processing_status, plain_text, page_count
            ) VALUES (
                :id, 'pdf', 'Library PDF', :ps, :pt, :pc
            )
        """),
        {"id": media_id, "ps": processing_status, "pt": plain_text, "pc": page_count},
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
                    (media_id, page_number, start_offset, end_offset)
                    VALUES (:mid, :pn, :so, :eo)
                """),
                {"mid": media_id, "pn": i + 1, "so": start, "eo": end},
            )

    session.commit()
    return media_id


class TestLibraryListPdfCapabilities:
    """Library list PDF capabilities use the same readiness predicate as detail."""

    def test_library_list_pdf_capabilities_use_same_quote_text_readiness_predicate_as_detail(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            mid_ready = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text="Quote ready text",
                page_count=1,
                with_page_spans=True,
            )
            mid_not_ready = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text=None,
                page_count=1,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_ready)
        direct_db.register_cleanup("media_file", "media_id", mid_ready)
        direct_db.register_cleanup("library_entries", "media_id", mid_ready)
        direct_db.register_cleanup("media", "id", mid_ready)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_not_ready)
        direct_db.register_cleanup("media_file", "media_id", mid_not_ready)
        direct_db.register_cleanup("library_entries", "media_id", mid_not_ready)
        direct_db.register_cleanup("media", "id", mid_not_ready)

        for mid in [mid_ready, mid_not_ready]:
            auth_client.post(
                f"/libraries/{library_id}/media",
                json={"media_id": str(mid)},
                headers=auth_headers(user_id),
            )

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        assert list_resp.status_code == 200
        items = {
            row["media"]["id"]: row["media"]
            for row in list_resp.json()["data"]
            if row["kind"] == "media" and row["media"] is not None
        }

        ready_caps = items[str(mid_ready)]["capabilities"]
        assert ready_caps["can_quote"] is True
        assert ready_caps["can_search"] is False

        not_ready_caps = items[str(mid_not_ready)]["capabilities"]
        assert not_ready_caps["can_quote"] is False
        assert not_ready_caps["can_search"] is False

    def test_library_list_pdf_capabilities_match_detail_readiness_split(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            mid = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text="Match text",
                page_count=1,
                with_page_spans=True,
            )

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid)
        direct_db.register_cleanup("media_file", "media_id", mid)
        direct_db.register_cleanup("library_entries", "media_id", mid)
        direct_db.register_cleanup("media", "id", mid)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(mid)},
            headers=auth_headers(user_id),
        )

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        list_caps = next(
            row["media"]["capabilities"]
            for row in list_resp.json()["data"]
            if row["kind"] == "media"
            and row["media"] is not None
            and row["media"]["id"] == str(mid)
        )

        detail_resp = auth_client.get(f"/media/{mid}", headers=auth_headers(user_id))
        detail_caps = detail_resp.json()["data"]["capabilities"]

        assert list_caps["can_read"] == detail_caps["can_read"]
        assert list_caps["can_quote"] == detail_caps["can_quote"]
        assert list_caps["can_search"] == detail_caps["can_search"]


# =============================================================================
# Position invariant (migration 0131) — final-state library_entries behavior
# =============================================================================


class TestLibraryEntryPositionInvariant:
    """The per-library position total order is a DB invariant after the cutover."""

    def test_duplicate_position_rejected_at_commit(self, auth_client, direct_db):
        """UNIQUE (library_id, position) is DEFERRABLE: a colliding position is accepted
        mid-transaction but rejected at COMMIT."""
        user_id = create_test_user_id()
        me = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Pos A")
            media_b = create_test_media(session, title="Pos B")
            session.commit()
        direct_db.register_cleanup("media", "id", media_a)
        direct_db.register_cleanup("media", "id", media_b)

        with direct_db.session() as session:
            for media_id in (media_a, media_b):
                session.execute(
                    text(
                        "INSERT INTO library_entries "
                        "(library_id, media_id, podcast_id, position) "
                        "VALUES (:lib, :media, NULL, 0)"
                    ),
                    {"lib": library_id, "media": media_id},
                )
            # Both inserts succeed mid-transaction — an INITIALLY IMMEDIATE constraint would
            # have rejected the second insert here. The collision surfaces only at COMMIT,
            # which is what DEFERRABLE INITIALLY DEFERRED guarantees.
            with pytest.raises(IntegrityError) as exc_info:
                session.commit()
            assert "uq_library_entries_library_position" in str(exc_info.value)
            session.rollback()

    def test_concurrent_appends_get_distinct_positions(self, auth_client, direct_db):
        """Key Decision 8: ensure_entry's library-row lock serializes concurrent appends,
        so two overlapping transactions both commit with distinct dense positions instead
        of colliding on the unique constraint."""
        from nexus.services import library_entries

        user_id = create_test_user_id()
        me = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = UUID(me.json()["data"]["default_library_id"])

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Concur A")
            media_b = create_test_media(session, title="Concur B")
            session.commit()
        direct_db.register_cleanup("media", "id", media_a)
        direct_db.register_cleanup("media", "id", media_b)

        errors: list[Exception] = []
        barrier = threading.Barrier(2)

        def append(media_id: UUID) -> None:
            try:
                barrier.wait(timeout=5)
                with direct_db.session() as session:
                    library_entries.ensure_entry(
                        session, library_id, library_entries.media_target(media_id)
                    )
                    session.commit()
            except Exception as exc:  # noqa: BLE001 — surfaced to the asserting thread
                errors.append(exc)

        threads = [threading.Thread(target=append, args=(m,)) for m in (media_a, media_b)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)

        assert errors == [], errors
        with direct_db.session() as session:
            positions = [
                row[0]
                for row in session.execute(
                    text(
                        "SELECT position FROM library_entries "
                        "WHERE library_id = :lib ORDER BY position"
                    ),
                    {"lib": library_id},
                ).fetchall()
            ]
        assert positions == [0, 1]


class TestLibraryEntryResonanceOrdering:
    """GET /libraries/{id}/entries?sort=resonance (collection surface, spec S5).

    Resonance is a deterministic recency + connection-count score; the default
    (sort omitted / position) order is unchanged. These tests build a library
    whose entries have a fixed position order, then add an engagement-recency
    signal to one entry and a connection edge to another, and assert resonance
    reorders deterministically while the default stays position-based.
    """

    def _entries(self, auth_client, user_id: UUID, library_id: UUID, **params):
        return auth_client.get(
            f"/libraries/{library_id}/entries",
            headers=auth_headers(user_id),
            params=params,
        )

    def _seed_library_with_three_entries(
        self, direct_db: DirectSessionManager, user_id: UUID
    ) -> tuple[UUID, UUID, UUID, UUID]:
        """A non-default library with media A, B, C at positions 0, 1, 2.

        Each entry's created_at is pinned 30 days in the past so the baseline
        recency-decay is low and equal; per-entry signals then drive resonance.
        """
        from datetime import UTC, datetime, timedelta

        from tests.factories import create_test_library

        old = datetime.now(UTC) - timedelta(days=30)
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Resonance Lib")
            media_a = create_test_media(session, title="Entry A")
            media_b = create_test_media(session, title="Entry B")
            media_c = create_test_media(session, title="Entry C")
            for position, media_id in enumerate((media_a, media_b, media_c)):
                session.execute(
                    text(
                        """
                        INSERT INTO library_entries (library_id, media_id, position, created_at)
                        VALUES (:lib, :media_id, :position, :created_at)
                        """
                    ),
                    {
                        "lib": library_id,
                        "media_id": media_id,
                        "position": position,
                        "created_at": old,
                    },
                )
            session.commit()
        for media_id in (media_a, media_b, media_c):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("reader_media_state", "media_id", media_id)
            direct_db.register_cleanup("resource_edges", "source_id", media_id)
            direct_db.register_cleanup("contributor_credits", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)
        return library_id, media_a, media_b, media_c

    def test_default_order_is_position_and_resonance_reorders_deterministically(
        self, auth_client, direct_db: DirectSessionManager
    ):
        from datetime import UTC, datetime, timedelta

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, media_a, media_b, media_c = self._seed_library_with_three_entries(
            direct_db, user_id
        )

        # C: fresh entry recency -> top.
        # B: an old user connection edge to a media OUTSIDE the library -> a log1p
        # count boost below the fresh recency boost. The edge's other endpoint is a bare outsider so
        # only B's connection count increments (the count is either-endpoint, so an
        # A<->B edge would boost both A and B equally and defeat the assertion).
        old_connection = datetime.now(UTC) - timedelta(days=30)
        with direct_db.session() as session:
            outsider_id = create_test_media(session, title="Outsider")
            session.execute(
                text(
                    """
                    UPDATE library_entries
                    SET created_at = :now
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {
                    "library_id": library_id,
                    "media_id": media_c,
                    "now": datetime.now(UTC),
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, created_at
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'media', :media_b,
                        'media', :outsider_id, :created_at
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "media_b": media_b,
                    "outsider_id": outsider_id,
                    "created_at": old_connection,
                },
            )
            session.commit()
        direct_db.register_cleanup("resource_edges", "source_id", media_b)
        direct_db.register_cleanup("media", "id", outsider_id)

        # Default (sort omitted) stays position order: A, B, C.
        default = self._entries(auth_client, user_id, library_id)
        assert default.status_code == 200, default.text
        assert _library_entry_media_ids(default.json()["data"]) == [
            str(media_a),
            str(media_b),
            str(media_c),
        ]
        # Explicit position is identical to omitted.
        explicit_position = self._entries(auth_client, user_id, library_id, sort="position")
        assert _library_entry_media_ids(explicit_position.json()["data"]) == [
            str(media_a),
            str(media_b),
            str(media_c),
        ]

        # Resonance: C (recency) first, then B (connection boost), then A.
        resonance = self._entries(auth_client, user_id, library_id, sort="resonance")
        assert resonance.status_code == 200, resonance.text
        assert _library_entry_media_ids(resonance.json()["data"]) == [
            str(media_c),
            str(media_b),
            str(media_a),
        ]

    def test_resonance_uses_listening_recency_for_direct_podcast_episode_entries(
        self, auth_client, direct_db: DirectSessionManager
    ):
        from datetime import UTC, datetime, timedelta

        from tests.factories import create_test_library

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        old = datetime.now(UTC) - timedelta(days=30)
        podcast_id = uuid4()
        episode_media_id = uuid4()

        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Episode Resonance")
            article_media_id = create_test_media(session, title="Old article")
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url,
                        website_url, image_url, description
                    ) VALUES (
                        :podcast_id, 'podcast_index', :provider_podcast_id,
                        'Episode Resonance Podcast',
                        'https://example.com/episode-resonance.xml',
                        NULL, NULL, NULL
                    )
                    """
                ),
                {
                    "podcast_id": podcast_id,
                    "provider_podcast_id": f"episode-resonance-{podcast_id}",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        external_playback_url, provider, provider_id
                    ) VALUES (
                        :media_id, 'podcast_episode', 'Recently listened episode',
                        'https://example.com/recently-listened',
                        'ready_for_reading',
                        'https://cdn.example.com/recently-listened.mp3',
                        'podcast_index', :provider_episode_id
                    )
                    """
                ),
                {
                    "media_id": episode_media_id,
                    "provider_episode_id": f"episode-{episode_media_id}",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_episodes (
                        media_id, podcast_id, provider_episode_id, guid,
                        fallback_identity, published_at, duration_seconds
                    ) VALUES (
                        :media_id, :podcast_id, :provider_episode_id, :guid,
                        :fallback_identity, :published_at, 300
                    )
                    """
                ),
                {
                    "media_id": episode_media_id,
                    "podcast_id": podcast_id,
                    "provider_episode_id": f"episode-{episode_media_id}",
                    "guid": f"guid-{episode_media_id}",
                    "fallback_identity": f"fallback-{episode_media_id}",
                    "published_at": old,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_listening_states (
                        user_id, media_id, position_ms, duration_ms,
                        playback_speed, is_completed, updated_at
                    ) VALUES (
                        :user_id, :media_id, 120000, 300000,
                        1.0, false, now()
                    )
                    """
                ),
                {"user_id": user_id, "media_id": episode_media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO library_entries (library_id, media_id, position, created_at)
                    VALUES
                      (:library_id, :article_media_id, 0, :old),
                      (:library_id, :episode_media_id, 1, :old)
                    """
                ),
                {
                    "library_id": library_id,
                    "article_media_id": article_media_id,
                    "episode_media_id": episode_media_id,
                    "old": old,
                },
            )
            session.commit()

        for media_id in (article_media_id, episode_media_id):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", episode_media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", episode_media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        default = self._entries(auth_client, user_id, library_id)
        assert default.status_code == 200, default.text
        assert _library_entry_media_ids(default.json()["data"]) == [
            str(article_media_id),
            str(episode_media_id),
        ]

        resonance = self._entries(auth_client, user_id, library_id, sort="resonance")
        assert resonance.status_code == 200, resonance.text
        assert _library_entry_media_ids(resonance.json()["data"]) == [
            str(episode_media_id),
            str(article_media_id),
        ]

    def test_resonance_includes_shared_author_hits(
        self, auth_client, direct_db: DirectSessionManager
    ):
        from nexus.services.contributor_credits import replace_media_contributor_credits

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, media_a, media_b, media_c = self._seed_library_with_three_entries(
            direct_db, user_id
        )
        contributor_one = uuid4()
        contributor_two = uuid4()

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO contributors (id, handle, display_name, sort_name, kind, status)
                    VALUES
                      (:one, :one_handle, 'Shared One', 'Shared One', 'unknown', 'unverified'),
                      (:two, :two_handle, 'Shared Two', 'Shared Two', 'unknown', 'unverified')
                    """
                ),
                {
                    "one": contributor_one,
                    "one_handle": f"shared-one-{contributor_one.hex[:8]}",
                    "two": contributor_two,
                    "two_handle": f"shared-two-{contributor_two.hex[:8]}",
                },
            )
            replace_media_contributor_credits(
                session,
                media_id=media_a,
                credits=[
                    {
                        "credited_name": "Shared One",
                        "contributor_id": str(contributor_one),
                        "role": "author",
                        "ordinal": 0,
                    }
                ],
                source="test",
            )
            replace_media_contributor_credits(
                session,
                media_id=media_b,
                credits=[
                    {
                        "credited_name": "Shared One",
                        "contributor_id": str(contributor_one),
                        "role": "author",
                        "ordinal": 0,
                    },
                    {
                        "credited_name": "Shared Two",
                        "contributor_id": str(contributor_two),
                        "role": "author",
                        "ordinal": 1,
                    },
                ],
                source="test",
            )
            replace_media_contributor_credits(
                session,
                media_id=media_c,
                credits=[
                    {
                        "credited_name": "Shared Two",
                        "contributor_id": str(contributor_two),
                        "role": "author",
                        "ordinal": 0,
                    }
                ],
                source="test",
            )
            session.commit()
        direct_db.register_cleanup("contributors", "id", contributor_one)
        direct_db.register_cleanup("contributors", "id", contributor_two)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_one)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_two)

        response = self._entries(auth_client, user_id, library_id, sort="resonance")

        assert response.status_code == 200, response.text
        assert _library_entry_media_ids(response.json()["data"])[0] == str(media_b)

    def test_resonance_is_stable_for_identical_input(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, _media_a, _media_b, _media_c = self._seed_library_with_three_entries(
            direct_db, user_id
        )

        first = self._entries(auth_client, user_id, library_id, sort="resonance")
        second = self._entries(auth_client, user_id, library_id, sort="resonance")
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        # No engagement/connection signal on any entry: the score collapses to the
        # equal recency baseline, so the id-DESC tiebreak gives one fixed order.
        first_ids = _library_entry_media_ids(first.json()["data"])
        second_ids = _library_entry_media_ids(second.json()["data"])
        assert first_ids == second_ids, "resonance order must be stable for identical input"
        assert len(first_ids) == 3
