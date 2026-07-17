"""Integration tests for library service and routes.

Tests cover:
- Library CRUD operations
- Membership enforcement
- Default library protections
- Library-media management
- Default virtual-view invariants (spec S4.1/S4.2 keyset pagination)
- Visibility masking
"""

import base64
import json
import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from nexus.services import library_entries, library_governance
from tests.factories import add_media_to_library, create_test_library, create_test_media
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.support.teardown import drive_media_teardown, install_fake_storage_for_teardown
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _clean_teardown_state(direct_db: DirectSessionManager):
    """Clear teardown intents + jobs after each test so media cleanup (FK'd by
    media_teardown_intents) is unblocked and background_jobs stays isolated."""
    yield
    with direct_db.session() as db:
        db.execute(text("DELETE FROM media_teardown_intents"))
        db.execute(
            text(
                "DELETE FROM background_jobs "
                "WHERE kind IN ('media_teardown', 'storage_object_cleanup', 'storage_orphan_sweep')"
            )
        )
        db.commit()


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


def _decode_cursor_payload(cursor: str) -> dict:
    """Decode an opaque entry cursor's base64url JSON payload for direct
    field assertions (e.g. `resonance_as_of` pinning) that a page's observable
    ordering alone cannot distinguish."""
    padded = cursor + "=" * (-len(cursor) % 4)
    return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))


def _seed_reachable_media(
    direct_db: DirectSessionManager, user_id: UUID, *, title: str = "Test Article"
) -> UUID:
    """Create media the given user can already reach, via a throwaway library
    filed directly (bypassing REST) — the minimum precondition POST
    /libraries/{id}/media now enforces (spec S4.3 rule 1, F2/F3:
    readable-or-restorable authorization). Mirrors production, where ingest
    always files new media into its creator's Default before it is ever
    addressable through this endpoint; `create_test_media` alone leaves media
    with no library_entries row anywhere, which the fixed authorization
    correctly refuses to file. `user_id` must already exist (an earlier
    `auth_client` call, e.g. `GET /me`) — `create_test_library`'s owner FK
    requires it."""
    with direct_db.session() as session:
        media_id = create_test_media(session, title=title)
        seed_library_id = create_test_library(session, user_id, f"Seed {title}")
        add_media_to_library(session, seed_library_id, media_id)
        session.commit()
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", seed_library_id)
    direct_db.register_cleanup("libraries", "id", seed_library_id)
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
        owner_default_id = auth_client.get("/me", headers=auth_headers(owner_id)).json()["data"][
            "default_library_id"
        ]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        with direct_db.session() as session:
            system_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_system_guard_{owner_id.hex[:12]}",
                name="System Guard",
                owner_user_id=owner_id,
            )
            existing_media_id = create_test_media(session, title="System Corpus Work")
            # Reachable via the owner's own Default (not the system library under
            # test), so the mutation below exercises ONLY the system-library
            # rejection, not the F2/F3 media-authorization gate.
            new_media_id = create_test_media(session, title="Unowned Addition")
            library_entries.ensure_entry(
                session, system_id, library_entries.media_target(existing_media_id)
            )
            library_entries.ensure_entry(
                session, owner_default_id, library_entries.media_target(new_media_id)
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

        with direct_db.session() as session:
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

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
        """Admin can add already-reachable media to another library."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = _seed_reachable_media(direct_db, user_id, title="Add Success")

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
        auth_client.get("/me", headers=auth_headers(user_id))
        media_id = _seed_reachable_media(direct_db, user_id, title="Library Not Found")

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

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = _seed_reachable_media(direct_db, user_id, title="Idempotent")

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

    def test_add_media_cross_user_own_default_only_returns_not_found(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """F2/F3 (spec S4.3 rule 1, privilege-escalation blocker): a media
        filed only in user A's own libraries is not membership-reachable for
        user B. POST /libraries/{id}/media must not let B file an EXISTING
        media_id into B's own library merely because the row exists — that
        would grant B read access to media they have no membership path to."""
        owner_id = create_test_user_id()
        other_id = create_test_user_id()

        owner_default_id = auth_client.get("/me", headers=auth_headers(owner_id)).json()["data"][
            "default_library_id"
        ]
        other_default_id = auth_client.get("/me", headers=auth_headers(other_id)).json()["data"][
            "default_library_id"
        ]

        media_id = _seed_reachable_media(direct_db, owner_id, title="Owner-only private")

        file_resp = auth_client.post(
            f"/libraries/{owner_default_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )
        assert file_resp.status_code == 201, file_resp.text

        response = auth_client.post(
            f"/libraries/{other_default_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(other_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        # No physical entry was ever created for the unauthorized filer.
        with direct_db.session() as session:
            leaked = session.execute(
                text("SELECT 1 FROM library_entries WHERE library_id = :lib AND media_id = :media"),
                {"lib": other_default_id, "media": media_id},
            ).first()
        assert leaked is None

    def test_add_media_restores_tombstoned_membership_reachable_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Restorable path (spec S4.3 rule 1): a media the viewer tombstoned
        but still reaches through a membership stays filable — restorable
        authorization ignores only the viewer's own tombstone, and a
        successful re-file clears it (rule 6)."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = _seed_reachable_media(direct_db, user_id, title="Restorable")
        direct_db.register_cleanup("user_media_deletions", "media_id", media_id)

        add_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201, add_resp.text

        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO user_media_deletions (user_id, media_id) VALUES (:u, :m)"),
                {"u": user_id, "m": media_id},
            )
            session.commit()

        # Confirm the tombstone is in effect first.
        assert str(media_id) not in _library_entry_media_ids(
            _list_library_entries(auth_client, user_id, library_id).json()["data"]
        )

        response = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 201

        with direct_db.session() as session:
            tombstone = session.execute(
                text("SELECT 1 FROM user_media_deletions WHERE user_id = :u AND media_id = :m"),
                {"u": user_id, "m": media_id},
            ).first()
        assert tombstone is None


class TestRemoveMediaFromLibrary:
    """Tests for DELETE /media/{media_id} endpoint."""

    def test_remove_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can remove media from library."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

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
        install_fake_storage_for_teardown(monkeypatch, storage)

        with direct_db.session() as session:
            media_id = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text="Delete me",
                page_count=1,
                with_page_spans=True,
            )
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        storage_path = f"media/{media_id}/original.pdf"
        storage.put_object(storage_path, b"%PDF-1.4 test", "application/pdf")
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        detail_resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert detail_resp.status_code == 200
        assert detail_resp.json()["data"]["capabilities"]["can_delete"] is True

        delete_resp = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

        assert delete_resp.status_code == 200
        assert delete_resp.json()["data"] == {"kind": "Deleting"}
        assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
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
                        (SELECT count(*) FROM library_entries WHERE media_id = :media_id)
                            AS library_entry_count
                """),
                {"media_id": media_id},
            ).one()
        assert counts == (0, 0, 0, 0)

    def test_delete_default_epub_removes_package_resources_and_storage(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)
        install_fake_storage_for_teardown(monkeypatch, storage)

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
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("epub_resources", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"]["kind"] == "Deleting"
        assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
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
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

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

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

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
            # Read-state for podcast episodes derives purely from the listening
            # threshold (position > 0 -> in_progress); no separate session/ledger
            # row is needed.
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_episode_chapters", "media_id", media_id)
        direct_db.register_cleanup("media_transcript_states", "media_id", media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        # Registered LAST so LIFO teardown deletes this BEFORE its media: migration
        # 0182 made the podcast_listening_states -> media FK non-cascading, so it no
        # longer disappears with the media row.
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)

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
        """Default orders (media.created_at DESC, media.id DESC) — newest media
        first (spec S4.2), the reverse of filing order."""
        user_id = create_test_user_id()

        # Create multiple media items, each its own commit so created_at strictly
        # increases in creation order.
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
        with direct_db.session() as session:
            for media_id in media_ids:
                add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        body = response.json()
        assert body["page"] == {"has_more": False, "next_cursor": None}
        data = body["data"]
        assert len(data) == 3
        assert _library_entry_media_ids(data) == [str(media_id) for media_id in reversed(media_ids)]

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
                add_media_to_library(session, UUID(library_id), media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        # Default orders newest-media-first: page 1 is the two most recently
        # created media, page 2 the oldest.
        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[2]),
            str(media_ids[1]),
        ]
        cursor = first_body["page"]["next_cursor"]
        assert first_body["page"]["has_more"] is True
        assert cursor is not None

        second = _list_library_entries(auth_client, user_id, library_id, limit=2, cursor=cursor)
        assert second.status_code == 200, second.text
        second_body = second.json()
        assert _library_entry_media_ids(second_body["data"]) == [str(media_ids[0])]
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

    def test_list_media_default_insert_above_cursor_keyset_invariant(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC6: Default's stateless keyset has no frozen snapshot — an insert
        above the cursor (newer than everything already fetched) neither
        duplicates nor omits the pre-existing lower rows a stale cursor still
        points at, and the new row appears on a fresh first page."""
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(3):
                media_id = create_test_media(session, title=f"Keyset Invariant {idx}")
                media_ids.append(media_id)
                add_media_to_library(session, UUID(library_id), media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[2]),
            str(media_ids[1]),
        ]
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        # Insert a media newer than everything already fetched — "above" the
        # cursor in Default's (media.created_at DESC) order — after page 1 but
        # before page 2 is fetched.
        with direct_db.session() as session:
            newest_media_id = create_test_media(session, title="Filed after page 1")
            add_media_to_library(session, UUID(library_id), newest_media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", newest_media_id)
        direct_db.register_cleanup("media", "id", newest_media_id)

        # The stale cursor's continuation is unaffected: the pre-existing lower
        # row appears exactly once, and the new row (above the cursor) never
        # leaks into it.
        second = _list_library_entries(auth_client, user_id, library_id, limit=2, cursor=cursor)
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(second.json()["data"]) == [str(media_ids[0])]
        assert second.json()["page"] == {"has_more": False, "next_cursor": None}

        # A fresh first page picks up the new row immediately.
        refreshed = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert refreshed.status_code == 200, refreshed.text
        assert _library_entry_media_ids(refreshed.json()["data"]) == [
            str(newest_media_id),
            str(media_ids[2]),
        ]

    def test_list_media_non_default_position_insert_above_cursor_keyset_invariant(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC6: non-default sort=position keyset survives inserts between page
        fetches the same way Default's does — a row landing before the
        pagination boundary neither duplicates nor omits the pre-existing
        higher-position rows a stale cursor still points at."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Position Keyset Invariant")
            media_ids = [
                create_test_media(session, title=f"Position Keyset {idx}") for idx in range(3)
            ]
            for position, media_id in zip((10, 20, 30), media_ids, strict=True):
                session.execute(
                    text(
                        "INSERT INTO library_entries (library_id, media_id, position) "
                        "VALUES (:library_id, :media_id, :position)"
                    ),
                    {"library_id": library_id, "media_id": media_id, "position": position},
                )
            session.commit()
        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        first = _list_library_entries(auth_client, user_id, library_id, sort="position", limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[0]),
            str(media_ids[1]),
        ]
        cursor = first_body["page"]["next_cursor"]
        assert first_body["page"]["has_more"] is True
        assert cursor is not None

        # Insert a media at position 5 — sorts before every existing entry
        # ("above the cursor") — after page 1 is fetched but before page 2 is.
        with direct_db.session() as session:
            newest_media_id = create_test_media(session, title="Inserted above cursor")
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, media_id, position) "
                    "VALUES (:library_id, :media_id, 5)"
                ),
                {"library_id": library_id, "media_id": newest_media_id},
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", newest_media_id)
        direct_db.register_cleanup("media", "id", newest_media_id)

        # The stale cursor's continuation is unaffected: the pre-existing
        # higher-position row appears exactly once, and the new row (above
        # the cursor) never leaks into it.
        second = _list_library_entries(
            auth_client, user_id, library_id, sort="position", limit=2, cursor=cursor
        )
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(second.json()["data"]) == [str(media_ids[2])]
        assert second.json()["page"] == {"has_more": False, "next_cursor": None}

        # A fresh first page picks up the new row immediately, at the top.
        refreshed = _list_library_entries(
            auth_client, user_id, library_id, sort="position", limit=1
        )
        assert refreshed.status_code == 200, refreshed.text
        assert _library_entry_media_ids(refreshed.json()["data"]) == [str(newest_media_id)]

    def test_list_media_non_default_position_excludes_tombstoned_media_at_page_boundary(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """F4: a non-default member library's ``sort=position`` page filters to
        visible media BEFORE computing ``has_more`` — a viewer-tombstoned entry
        landing inside the raw ``LIMIT + 1`` fetch window must not produce a
        short/empty page while ``has_more`` claims there is more (the
        tombstoned row silently drops out of hydration, but the pre-fix query
        counted it toward the page)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Tombstone Boundary")
            media_ids = [create_test_media(session, title=f"Boundary {idx}") for idx in range(4)]
            for position, media_id in enumerate(media_ids):
                session.execute(
                    text(
                        "INSERT INTO library_entries (library_id, media_id, position) "
                        "VALUES (:library_id, :media_id, :position)"
                    ),
                    {"library_id": library_id, "media_id": media_id, "position": position},
                )
            session.commit()
        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # Tombstone the second entry (position 1) — it sits inside page 1's
        # raw LIMIT+1=3 fetch window for limit=2.
        tombstoned_media_id = media_ids[1]
        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO user_media_deletions (user_id, media_id) VALUES (:u, :m)"),
                {"u": user_id, "m": tombstoned_media_id},
            )
            session.commit()
        direct_db.register_cleanup("user_media_deletions", "media_id", tombstoned_media_id)

        first = _list_library_entries(auth_client, user_id, library_id, sort="position", limit=2)
        assert first.status_code == 200, first.text
        first_body = first.json()
        # A full page of 2 VISIBLE entries — the tombstoned one is skipped
        # entirely, not counted toward the page and then silently dropped.
        assert _library_entry_media_ids(first_body["data"]) == [
            str(media_ids[0]),
            str(media_ids[2]),
        ]
        assert first_body["page"]["has_more"] is True
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        second = _list_library_entries(
            auth_client, user_id, library_id, sort="position", limit=2, cursor=cursor
        )
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(second.json()["data"]) == [str(media_ids[3])]
        assert second.json()["page"] == {"has_more": False, "next_cursor": None}

        # The tombstoned entry never surfaces on any page.
        assert str(tombstoned_media_id) not in _library_entry_media_ids(first_body["data"]) and str(
            tombstoned_media_id
        ) not in _library_entry_media_ids(second.json()["data"])

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

    def _seed_resonance_library(
        self, direct_db, user_id: UUID, name: str
    ) -> tuple[UUID, list[UUID]]:
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, name)
            media_ids = [create_test_media(session, title=f"{name} {idx}") for idx in range(3)]
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
        return library_id, media_ids

    def test_resonance_cursor_stable_when_score_inputs_do_not_mutate(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC7: the resonance cursor carries the pinned `resonance_as_of` plus a
        score/id key, and is stable when nothing underlying it changes — the
        same cursor fetched twice returns identical pages, and the full
        first+second page sequence matches a single unpaged fetch."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, _media_ids = self._seed_resonance_library(
            direct_db, user_id, "Stable Resonance Cursor"
        )

        full = _list_library_entries(auth_client, user_id, library_id, sort="resonance", limit=10)
        assert full.status_code == 200, full.text
        expected_media_ids = _library_entry_media_ids(full.json()["data"])
        assert len(expected_media_ids) == 3

        first = _list_library_entries(auth_client, user_id, library_id, sort="resonance", limit=1)
        assert first.status_code == 200, first.text
        first_body = first.json()
        first_media_ids = _library_entry_media_ids(first_body["data"])
        assert first_media_ids == expected_media_ids[:1]
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        second_a = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=2, cursor=cursor
        )
        second_b = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=2, cursor=cursor
        )
        assert second_a.status_code == 200, second_a.text
        assert second_b.status_code == 200, second_b.text
        assert second_a.json()["data"] == second_b.json()["data"], (
            "the same cursor must return the identical page when nothing mutates"
        )
        assert (
            first_media_ids + _library_entry_media_ids(second_a.json()["data"])
            == expected_media_ids
        )

    def test_resonance_as_of_pinned_across_pages_via_cursor_payload(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """F9/AC7: `resonance_as_of` is generated once and carried unchanged
        through every later page's cursor — decode the cursor payload
        directly to prove pinning, rather than relying on score stability
        (the existing stability tests above pass with or without pinning
        because the recency half-life is day-scale, so they would not catch a
        regression that regenerates `now()` on every page)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, _media_ids = self._seed_resonance_library(
            direct_db, user_id, "Pinned Resonance As Of"
        )

        first = _list_library_entries(auth_client, user_id, library_id, sort="resonance", limit=1)
        assert first.status_code == 200, first.text
        first_cursor = first.json()["page"]["next_cursor"]
        assert first_cursor is not None
        first_resonance_as_of = _decode_cursor_payload(first_cursor)["resonance_as_of"]

        second = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=1, cursor=first_cursor
        )
        assert second.status_code == 200, second.text
        second_cursor = second.json()["page"]["next_cursor"]
        assert second_cursor is not None
        second_resonance_as_of = _decode_cursor_payload(second_cursor)["resonance_as_of"]

        assert second_resonance_as_of == first_resonance_as_of

    def test_resonance_cursor_reflects_live_mutation_between_pages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Accepted 80/20 loss (spec S3): the resonance cursor pins
        `resonance_as_of` (the recency-decay clock) but is NOT a historical
        snapshot of the scored rows themselves — connection/engagement
        mutations between page fetches stay live, so a promoted entry's score
        is recomputed live on the next fetch (unlike the deleted TTL-snapshot
        design, which would have kept serving the pre-mutation ranking)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, media_ids = self._seed_resonance_library(
            direct_db, user_id, "Live Resonance Cursor"
        )

        first = _list_library_entries(auth_client, user_id, library_id, sort="resonance", limit=1)
        assert first.status_code == 200, first.text
        first_body = first.json()
        first_media_ids = _library_entry_media_ids(first_body["data"])
        assert len(first_media_ids) == 1
        cursor = first_body["page"]["next_cursor"]
        assert cursor is not None

        # Promote the oldest (lowest-scored, not-yet-fetched) entry to the
        # freshest recency signal between page fetches.
        oldest_media_id = media_ids[-1]
        with direct_db.session() as session:
            session.execute(
                text("""
                    UPDATE library_entries
                    SET created_at = now()
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": oldest_media_id},
            )
            session.commit()

        # The continuation still answers (no crash on a live-changed input);
        # a fresh unpaged fetch immediately reflects the promotion at the top —
        # confirming the mutation is live, not served from a frozen snapshot.
        second = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=2, cursor=cursor
        )
        assert second.status_code == 200, second.text

        refreshed = _list_library_entries(
            auth_client, user_id, library_id, sort="resonance", limit=1
        )
        assert refreshed.status_code == 200, refreshed.text
        assert _library_entry_media_ids(refreshed.json()["data"]) == [str(oldest_media_id)]


class TestDefaultLibraryVirtualView:
    """Default's live, deduplicated "personal All" virtual read surface (spec
    S4.1/S4.2, AC2/AC6/AC7): direct+shared dedupe, tombstone hiding,
    system-library exclusion, and cursor scoping. Replaces the deleted
    closure/intrinsic materialization tests — there is no provenance table to
    assert on anymore, only the live query's observable behavior."""

    def test_direct_and_shared_media_appears_once_preferring_direct_entry(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC2: direct + shared non-system media appears once. The two-stage
        DISTINCT ON dedupe prefers a direct default entry as the representative
        row over an entry reached only through a shared library."""
        owner_id = create_test_user_id()
        viewer_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))

        media_id = _seed_reachable_media(direct_db, owner_id, title="Direct and shared")

        # Share: owner files the media into a library shared with viewer.
        lib_resp = auth_client.post(
            "/libraries", json={"name": "Shared"}, headers=auth_headers(owner_id)
        )
        shared_library_id = lib_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(viewer_id))
        invite_resp = auth_client.post(
            f"/libraries/{shared_library_id}/invites",
            json={"invitee_user_id": str(viewer_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        invite_id = invite_resp.json()["data"]["id"]
        accept_resp = auth_client.post(
            f"/libraries/invites/{invite_id}/accept", headers=auth_headers(viewer_id)
        )
        assert accept_resp.status_code == 200
        add_resp = auth_client.post(
            f"/libraries/{shared_library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(owner_id),
        )
        assert add_resp.status_code == 201

        viewer_default_id = auth_client.get("/me", headers=auth_headers(viewer_id)).json()["data"][
            "default_library_id"
        ]

        # Sanity: shared-only membership already surfaces it once in Default.
        shared_only = _list_library_entries(auth_client, viewer_id, viewer_default_id)
        assert _library_entry_media_ids(shared_only.json()["data"]) == [str(media_id)]

        # Direct: viewer also files it directly into their own Default.
        direct_resp = auth_client.post(
            f"/libraries/{viewer_default_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(viewer_id),
        )
        assert direct_resp.status_code == 201

        response = _list_library_entries(auth_client, viewer_id, viewer_default_id)
        assert response.status_code == 200
        data = response.json()["data"]
        assert _library_entry_media_ids(data) == [str(media_id)]
        # The representative entry is the direct default one, not the shared
        # library's row.
        assert data[0]["library_id"] == viewer_default_id

    def test_viewer_tombstone_hides_media_from_default(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A viewer-scoped tombstone (`user_media_deletions`) hides otherwise-
        accessible media from Default, per-viewer only."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = _seed_reachable_media(direct_db, user_id, title="Tombstoned")
        direct_db.register_cleanup("user_media_deletions", "media_id", media_id)

        add_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert add_resp.status_code == 201
        assert str(media_id) in _library_entry_media_ids(
            _list_library_entries(auth_client, user_id, library_id).json()["data"]
        )

        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO user_media_deletions (user_id, media_id) VALUES (:uid, :mid)"),
                {"uid": user_id, "mid": media_id},
            )
            session.commit()

        response = _list_library_entries(auth_client, user_id, library_id)
        assert response.status_code == 200
        assert str(media_id) not in _library_entry_media_ids(response.json()["data"])

    def test_system_only_media_excluded_until_filed_personally(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC2: a system-library-only work never leaks into Default. Explicit
        non-system filing makes it appear exactly once."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_id = create_test_media(session, title="System only")
            system_library_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO libraries (id, name, owner_user_id, is_default, system_key)
                    VALUES (:id, 'System Corpus', :owner_user_id, false, :system_key)
                """),
                {
                    "id": system_library_id,
                    "owner_user_id": user_id,
                    "system_key": f"test-system-{system_library_id}",
                },
            )
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                """),
                {"library_id": system_library_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id, position)
                    VALUES (:library_id, :media_id, 0)
                """),
                {"library_id": system_library_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("memberships", "library_id", system_library_id)
        direct_db.register_cleanup("libraries", "id", system_library_id)
        direct_db.register_cleanup("media", "id", media_id)

        before = _list_library_entries(auth_client, user_id, library_id)
        assert before.status_code == 200
        assert str(media_id) not in _library_entry_media_ids(before.json()["data"])

        file_resp = auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )
        assert file_resp.status_code == 201

        after = _list_library_entries(auth_client, user_id, library_id)
        assert after.status_code == 200
        assert _library_entry_media_ids(after.json()["data"]).count(str(media_id)) == 1

    def test_default_cursor_rejects_cross_scope_and_legacy_snapshot_cursors(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A Default cursor is bound to (viewer_id, library_id, sort="position");
        reusing it for a different library and any pre-cutover
        `library_entries:snapshot` cursor both fail E_INVALID_CURSOR."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        library_a = auth_client.get("/me", headers=auth_headers(user_a)).json()["data"][
            "default_library_id"
        ]
        auth_client.get("/me", headers=auth_headers(user_b))
        # A second library user_a is ALSO a member of, so the cross-scope
        # check exercises the cursor's library_id binding, not membership
        # masking.
        other_resp = auth_client.post(
            "/libraries", json={"name": "Other library"}, headers=auth_headers(user_a)
        )
        library_c = other_resp.json()["data"]["id"]
        direct_db.register_cleanup("memberships", "library_id", UUID(library_c))
        direct_db.register_cleanup("libraries", "id", UUID(library_c))

        with direct_db.session() as session:
            media_ids = [create_test_media(session, title=f"Scope {i}") for i in range(2)]
            for media_id in media_ids:
                add_media_to_library(session, UUID(library_a), media_id)
            session.commit()
        for media_id in media_ids:
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        first = _list_library_entries(auth_client, user_a, library_a, limit=1)
        assert first.status_code == 200, first.text
        cursor = first.json()["page"]["next_cursor"]
        assert cursor is not None

        # Same viewer, a DIFFERENT library they also belong to.
        cross_library = _list_library_entries(auth_client, user_a, library_c, cursor=cursor)
        assert cross_library.status_code == 400
        assert cross_library.json()["error"]["code"] == "E_INVALID_CURSOR"

        # Foreign viewer, same library id is masked as not-found before the
        # cursor is even reached (viewer_b is not a member of library_a).
        cross_viewer = _list_library_entries(auth_client, user_b, library_a, cursor=cursor)
        assert cross_viewer.status_code == 404

        # A legacy pre-cutover snapshot cursor never decodes to any v1 kind.
        legacy_payload = {
            "k": "library_entries:snapshot",
            "viewer_id": str(user_a),
            "library_id": str(library_a),
            "sort": "position",
            "snapshot_id": str(uuid4()),
            "offset": 0,
        }
        legacy_cursor = (
            base64.urlsafe_b64encode(json.dumps(legacy_payload).encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )
        legacy_response = _list_library_entries(
            auth_client, user_a, library_a, cursor=legacy_cursor
        )
        assert legacy_response.status_code == 400
        assert legacy_response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_default_rejects_resonance_sort(self, auth_client):
        """AC7: Default rejects sort=resonance outright — there is no reorder or
        resonance surface for the virtual view."""
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        response = _list_library_entries(auth_client, user_id, library_id, sort="resonance")

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"


class TestReorderLibraryMedia:
    """Tests for PATCH /libraries/{id}/entries/reorder endpoint.

    Default has no physical order to reorder — it is a live virtual view (spec
    S4.1/AC8) — so every non-rejection scenario here targets a freshly created
    non-default library; Default-targeting reorder is covered separately by
    ``test_reorder_library_entries_rejects_default`` below.
    """

    def _create_non_default_library(self, auth_client, user_id: UUID, name: str) -> str:
        resp = auth_client.post("/libraries", json={"name": name}, headers=auth_headers(user_id))
        assert resp.status_code == 201, resp.text
        return resp.json()["data"]["id"]

    def test_reorder_library_entries_rejects_default(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH .../entries/reorder against the viewer's own Default library
        rejects E_DEFAULT_LIBRARY_FORBIDDEN before exact-set validation, and the
        Default view is unaffected (spec AC8)."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Default reorder target")
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        entries = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        entry_id = next(row["id"] for row in entries)

        # A malformed body (wrong set) against Default still yields the Default
        # rejection, not the exact-set 400 — the guard runs first.
        response = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": [entry_id, str(uuid4())]},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

        after = _list_library_entries(auth_client, user_id, library_id).json()["data"]
        assert _library_entry_media_ids(after) == [str(media_id)]

    def test_reorder_library_entries_replaces_order(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = self._create_non_default_library(auth_client, user_id, "Reorder library")

        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for index in range(3):
                media_id = create_test_media(session, title=f"Reorder {index}")
                media_ids.append(media_id)
                add_media_to_library(session, UUID(library_id), media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

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
        library_id = self._create_non_default_library(auth_client, user_id, "Exact set library")

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Order A")
            media_b = create_test_media(session, title="Order B")
            add_media_to_library(session, UUID(library_id), media_a)
            add_media_to_library(session, UUID(library_id), media_b)
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

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
        library_id = self._create_non_default_library(auth_client, user_id, "Partial page library")

        media_ids: list[UUID] = []
        with direct_db.session() as session:
            for idx in range(3):
                media_id = create_test_media(session, title=f"Partial Reorder {idx}")
                media_ids.append(media_id)
                add_media_to_library(session, UUID(library_id), media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

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
            add_media_to_library(session, UUID(library_id), media_a)
            add_media_to_library(session, UUID(library_id), media_b)
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

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
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

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
        library_id = self._create_non_default_library(auth_client, user_id, "Bad set library")

        with direct_db.session() as session:
            media_a = create_test_media(session, title="Bad set A")
            media_b = create_test_media(session, title="Bad set B")
            add_media_to_library(session, UUID(library_id), media_a)
            add_media_to_library(session, UUID(library_id), media_b)
            session.commit()
        for media_id in (media_a, media_b):
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

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
        assert "backfill_job_status" not in data

    def test_accept_invite_transaction_creates_membership_and_updates_invite_no_projection(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Accept atomically creates membership and updates invite. There is no
        backfill job or other follow-up projection (spec AC3): the membership
        commit alone is the whole contract."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        # Create library with media
        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

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

        # No background_jobs row is enqueued for this accept — membership
        # commit alone is the whole contract, no follow-up worker.
        with direct_db.session() as session:
            queued = session.execute(
                text(
                    "SELECT COUNT(*) FROM background_jobs "
                    "WHERE kind = 'backfill_default_library_closure_job'"
                )
            ).scalar_one()
            assert queued == 0

    def test_accept_invite_and_member_removal_change_default_list_immediately(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Membership commit alone changes Default list/count immediately after
        accept AND after the member is later removed — no follow-up projection
        work (spec AC3)."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json={"name": "Team"}, headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(invitee_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]
        invite_id = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Before accept: shared media is absent from invitee's Default.
        before = _list_library_entries(auth_client, invitee_id, default_library_id).json()["data"]
        assert str(media_id) not in _library_entry_media_ids(before)

        auth_client.post(
            f"/libraries/invites/{invite_id}/accept",
            headers=auth_headers(invitee_id),
        )

        # Immediately after accept, with no worker/projection step run:
        # shared media appears in invitee's Default.
        after_accept = _list_library_entries(auth_client, invitee_id, default_library_id).json()[
            "data"
        ]
        assert str(media_id) in _library_entry_media_ids(after_accept)

        # Owner (admin) removes the invitee from the shared library.
        response = auth_client.delete(
            f"/libraries/{library_id}/members/{invitee_id}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

        # Immediately after removal, with no worker/projection step run: the
        # media is gone from invitee's Default again.
        after_removal = _list_library_entries(auth_client, invitee_id, default_library_id).json()[
            "data"
        ]
        assert str(media_id) not in _library_entry_media_ids(after_removal)

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
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

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
            add_media_to_library(session, UUID(library_id), mid_ready)
            add_media_to_library(session, UUID(library_id), mid_not_ready)
            session.commit()

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_ready)
        direct_db.register_cleanup("media_file", "media_id", mid_ready)
        direct_db.register_cleanup("library_entries", "media_id", mid_ready)
        direct_db.register_cleanup("media", "id", mid_ready)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid_not_ready)
        direct_db.register_cleanup("media_file", "media_id", mid_not_ready)
        direct_db.register_cleanup("library_entries", "media_id", mid_not_ready)
        direct_db.register_cleanup("media", "id", mid_not_ready)

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
            add_media_to_library(session, UUID(library_id), mid)
            session.commit()

        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid)
        direct_db.register_cleanup("media_file", "media_id", mid)
        direct_db.register_cleanup("library_entries", "media_id", mid)
        direct_db.register_cleanup("media", "id", mid)

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
        from nexus.services import contributors as contributors_service
        from nexus.services.contributor_taxonomy import (
            ContributorObservation,
            ObservedRoleSlices,
        )

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, media_a, media_b, media_c = self._seed_library_with_three_entries(
            direct_db, user_id
        )

        def _observe(media_id: UUID, names: list[str]) -> None:
            contributors_service.replace_observed_role_slices(
                target=contributors_service.MediaTarget(media_id),
                observation=ObservedRoleSlices(
                    managed_roles=frozenset({"author"}),
                    credits=tuple(
                        ContributorObservation(
                            credited_name=name, role="author", raw_role=None, identity_key=None
                        )
                        for name in names
                    ),
                ),
                source="epub_opf",
            )

        # The facade resolves each name to one contributor, so media_b — which shares
        # "Shared One" with media_a and "Shared Two" with media_c — carries the most
        # shared-author affinity and ranks first under resonance.
        _observe(media_a, ["Shared One"])
        _observe(media_b, ["Shared One", "Shared Two"])
        _observe(media_c, ["Shared Two"])

        # Clean the facade-created rows FK-safe (LIFO): credits first, then each
        # contributor's alias, then the contributor.
        for name in ("Shared One", "Shared Two"):
            direct_db.register_cleanup("contributors", "display_name", name)
            direct_db.register_cleanup("contributor_aliases", "alias", name)
        for media_id in (media_a, media_b, media_c):
            direct_db.register_cleanup("contributor_credits", "media_id", media_id)

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
