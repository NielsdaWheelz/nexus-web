"""Integration tests for POST /media/{id}/libraries.

Covers the additive bulk-add endpoint per docs/multi-library-assignment.md §7.2:
- 200 response with `library_ids_added` exactly equal to inserted ids.
- Idempotent: re-call with same ids returns empty `library_ids_added`.
- 403 `E_LIBRARY_FORBIDDEN` for inaccessible ids, atomic (no partial inserts).
- Default and duplicate destination ids are rejected.
"""

from uuid import UUID

import pytest
from sqlalchemy import text

from nexus.services import library_entries, library_governance
from tests.factories import (
    add_library_member,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, (
        f"bootstrap failed for user {user_id}: {response.status_code} {response.text}"
    )
    return UUID(response.json()["data"]["default_library_id"])


def _attach_media_to_default_library(auth_client, user_id: UUID, media_id: UUID) -> UUID:
    default_library_id = _bootstrap_user(auth_client, user_id)
    response = auth_client.post(
        f"/libraries/{default_library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    assert response.status_code == 201, (
        f"default-library attach failed: {response.status_code} {response.text}"
    )
    return default_library_id


def _library_entry_ids_for_media(direct_db: DirectSessionManager, media_id: UUID) -> set[UUID]:
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


class TestPostMediaLibrariesEndpoint:
    """Tests for POST /media/{id}/libraries — additive multi-library attach."""

    def test_post_media_libraries_adds_set(self, auth_client, direct_db: DirectSessionManager):
        """Posting a set of accessible library ids adds them all in one call."""
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Adds Set Media")
            lib_a = create_test_library(session, viewer_id, "Library A")
            lib_b = create_test_library(session, viewer_id, "Library B")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200, (
            f"expected 200 from POST /media/{{id}}/libraries, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert UUID(data["media_id"]) == media_id
        added = {UUID(value) for value in data["library_ids_added"]}
        assert added == {lib_a, lib_b}, (
            f"library_ids_added must reflect every newly inserted id, got {data}"
        )

        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert lib_a in memberships
        assert lib_b in memberships
        assert default_library_id in memberships, (
            "default library membership must be preserved by additive add"
        )

    def test_post_media_libraries_idempotent(self, auth_client, direct_db: DirectSessionManager):
        """Calling twice with the same ids yields empty `library_ids_added` second time."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Idempotent Media")
            lib_a = create_test_library(session, viewer_id, "Idempotent Lib A")
            lib_b = create_test_library(session, viewer_id, "Idempotent Lib B")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        first = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )
        assert first.status_code == 200, (
            f"first add must succeed, got {first.status_code}: {first.text}"
        )
        first_added = {UUID(value) for value in first.json()["data"]["library_ids_added"]}
        assert first_added == {lib_a, lib_b}

        second = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )
        assert second.status_code == 200, (
            "second add with identical ids must remain a successful no-op, "
            f"got {second.status_code}: {second.text}"
        )
        assert second.json()["data"]["library_ids_added"] == [], (
            f"idempotent re-call must report zero ids inserted, got {second.json()['data']}"
        )

        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert {lib_a, lib_b}.issubset(memberships), (
            "memberships must be unchanged after idempotent re-call"
        )

    def test_post_media_libraries_reports_only_new_inserts(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Existing entries stay idempotent; response lists only rows inserted by this call."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Partial Existing Media")
            existing_lib = create_test_library(session, viewer_id, "Already Present")
            new_lib = create_test_library(session, viewer_id, "New Destination")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        for library_id in (existing_lib, new_lib):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)
        first = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(existing_lib)]},
            headers=auth_headers(viewer_id),
        )
        assert first.status_code == 200, first.text

        second = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(existing_lib), str(new_lib)]},
            headers=auth_headers(viewer_id),
        )

        assert second.status_code == 200, second.text
        assert second.json()["data"]["library_ids_added"] == [str(new_lib)]

    def test_post_media_libraries_forbids_inaccessible(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Including any inaccessible id yields 403 `E_LIBRARY_FORBIDDEN` with no partial insert."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, other_owner_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Forbidden Media")
            viewer_lib = create_test_library(session, viewer_id, "Viewer Lib")
            other_lib = create_test_library(session, other_owner_id, "Other Owner Lib")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", viewer_lib)
        direct_db.register_cleanup("libraries", "id", viewer_lib)
        direct_db.register_cleanup("memberships", "library_id", other_lib)
        direct_db.register_cleanup("libraries", "id", other_lib)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(viewer_lib), str(other_lib)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 403, (
            "mixing an accessible id with an inaccessible id must yield 403, "
            f"got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN", (
            f"unexpected error code: {response.json()['error']}"
        )

        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert viewer_lib not in memberships, (
            "no partial application: the accessible id must NOT be inserted "
            "when the call is rejected"
        )
        assert other_lib not in memberships

    def test_post_media_libraries_forbids_member_only_without_partial_insert(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Member-only libraries are visible but not writable destinations."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, other_owner_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Member Only Media")
            viewer_lib = create_test_library(session, viewer_id, "Writable Lib")
            member_only_lib = create_test_library(session, other_owner_id, "Member Only Lib")
            add_library_member(session, member_only_lib, viewer_id, role="member")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        for library_id in (viewer_lib, member_only_lib):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(viewer_lib), str(member_only_lib)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"
        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert viewer_lib not in memberships
        assert member_only_lib not in memberships

    def test_post_media_libraries_rejects_default_library_id(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Passing the viewer's default library id is invalid."""
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Default Dedupe Media")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(default_library_id)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_post_media_libraries_rejects_duplicate_ids(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Duplicate destination ids are invalid."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Duplicate Destination Media")
            library_id = create_test_library(session, viewer_id, "Duplicate Destination")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(library_id), str(library_id)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestSystemMediaDeletionGuards:
    def test_delete_media_from_system_library_is_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="System Delete Media")
            system_library_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_delete_system_{media_id.hex[:12]}",
                name="System Delete Library",
                owner_user_id=viewer_id,
            )
            library_entries.ensure_entry(
                session,
                system_library_id,
                library_entries.media_target(media_id),
            )
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", system_library_id)
        direct_db.register_cleanup("libraries", "id", system_library_id)

        response = auth_client.delete(
            f"/media/{media_id}?library_id={system_library_id}",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"
        assert system_library_id in _library_entry_ids_for_media(direct_db, media_id)

    def test_delete_media_for_viewer_does_not_hide_system_library_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="System Hidden Media")
            system_library_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_hidden_system_{media_id.hex[:12]}",
                name="System Hidden Library",
                owner_user_id=viewer_id,
            )
            library_entries.ensure_entry(
                session,
                system_library_id,
                library_entries.media_target(media_id),
            )
            session.commit()

        direct_db.register_cleanup("user_media_deletions", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", system_library_id)
        direct_db.register_cleanup("libraries", "id", system_library_id)

        response = auth_client.delete(
            f"/media/{media_id}",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 200, response.text
        # A retained system-library reference yields Removed (no viewer hide marker).
        assert response.json()["data"]["kind"] == "Removed"
        assert system_library_id in _library_entry_ids_for_media(direct_db, media_id)
        with direct_db.session() as session:
            tombstone = session.execute(
                text(
                    """
                    SELECT 1
                    FROM user_media_deletions
                    WHERE user_id = :viewer_id AND media_id = :media_id
                    """
                ),
                {"viewer_id": viewer_id, "media_id": media_id},
            ).first()
        assert tombstone is None
