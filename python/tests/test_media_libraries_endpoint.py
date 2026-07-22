"""Integration tests for canonical media-library membership endpoints.

The additive POST remains the bulk filing owner. The member DELETE is idempotent,
kind-neutral, authorization-first, and refuses the last lifetime reference.

POST coverage per docs/multi-library-assignment.md §7.2:
- 204 No Content after authoritative membership mutation.
- Idempotent: re-call with the same ids remains 204 and changes no membership.
- 403 `E_LIBRARY_FORBIDDEN` for inaccessible ids, atomic (no partial inserts).
- Default and duplicate destination ids are rejected.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import MediaKind
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


def _attach_media_to_default_library(
    auth_client, direct_db: DirectSessionManager, user_id: UUID, media_id: UUID
) -> UUID:
    """Seed the default membership that production ingest establishes."""
    default_library_id = _bootstrap_user(auth_client, user_id)
    with direct_db.session() as session:
        library_entries.ensure_media_in_default_library(session, user_id, media_id)
        session.commit()
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
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 204, (
            f"expected 204 from POST /media/{{id}}/libraries, "
            f"got {response.status_code}: {response.text}"
        )
        assert response.content == b""

        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert memberships == {default_library_id, lib_a, lib_b}

    def test_post_media_libraries_idempotent(self, auth_client, direct_db: DirectSessionManager):
        """Calling twice with the same ids is a bodyless successful no-op."""
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Idempotent Media")
            lib_a = create_test_library(session, viewer_id, "Idempotent Lib A")
            lib_b = create_test_library(session, viewer_id, "Idempotent Lib B")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", lib_a)
        direct_db.register_cleanup("libraries", "id", lib_a)
        direct_db.register_cleanup("memberships", "library_id", lib_b)
        direct_db.register_cleanup("libraries", "id", lib_b)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

        first = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )
        assert first.status_code == 204, (
            f"first add must succeed, got {first.status_code}: {first.text}"
        )
        assert first.content == b""

        second = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(lib_a), str(lib_b)]},
            headers=auth_headers(viewer_id),
        )
        assert second.status_code == 204, (
            "second add with identical ids must remain a successful no-op, "
            f"got {second.status_code}: {second.text}"
        )
        assert second.content == b""

        memberships = _library_entry_ids_for_media(direct_db, media_id)
        assert memberships == {default_library_id, lib_a, lib_b}

    def test_post_media_libraries_preserves_existing_and_adds_missing(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Existing entries stay idempotent while missing memberships are added."""
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="Partial Existing Media")
            existing_lib = create_test_library(session, viewer_id, "Already Present")
            new_lib = create_test_library(session, viewer_id, "New Destination")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        for library_id in (existing_lib, new_lib):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)
        first = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(existing_lib)]},
            headers=auth_headers(viewer_id),
        )
        assert first.status_code == 204, first.text
        assert first.content == b""

        second = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(existing_lib), str(new_lib)]},
            headers=auth_headers(viewer_id),
        )

        assert second.status_code == 204, second.text
        assert second.content == b""
        assert _library_entry_ids_for_media(direct_db, media_id) == {
            default_library_id,
            existing_lib,
            new_lib,
        }

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
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", viewer_lib)
        direct_db.register_cleanup("libraries", "id", viewer_lib)
        direct_db.register_cleanup("memberships", "library_id", other_lib)
        direct_db.register_cleanup("libraries", "id", other_lib)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

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
        direct_db.register_cleanup("media", "id", media_id)
        for library_id in (viewer_lib, member_only_lib):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

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
        direct_db.register_cleanup("media", "id", media_id)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

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
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        _attach_media_to_default_library(auth_client, direct_db, viewer_id, media_id)

        response = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(library_id), str(library_id)]},
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestDeleteMediaLibraryEndpoint:
    @pytest.mark.parametrize(
        "media_kind",
        [
            MediaKind.web_article.value,
            MediaKind.pdf.value,
            MediaKind.epub.value,
            MediaKind.video.value,
            MediaKind.podcast_episode.value,
        ],
    )
    def test_removes_every_media_kind(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        media_kind: str,
    ):
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        with direct_db.session() as session:
            media_id = create_test_media(
                session,
                title=f"Remove {media_kind}",
                kind=media_kind,
            )
            library_id = create_test_library(session, viewer_id, f"Remove {media_kind}")
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
            session.commit()
            library_entries.ensure_media_in_library(session, viewer_id, library_id, media_id)

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.delete(
            f"/media/{media_id}/libraries/{library_id}",
            headers=auth_headers(viewer_id),
        )
        assert response.status_code == 204, response.text
        assert response.content == b""

        memberships = auth_client.get(
            f"/media/{media_id}/libraries", headers=auth_headers(viewer_id)
        )
        assert memberships.status_code == 200, memberships.text
        target = next(row for row in memberships.json()["data"] if row["id"] == str(library_id))
        assert target["is_in_library"] is False

    def test_authorized_absent_and_unknown_media_are_replay_safe(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, other_owner_id)
        with direct_db.session() as session:
            library_id = create_test_library(session, viewer_id, "Replay safe")
            private_library_id = create_test_library(
                session, other_owner_id, "Inaccessible media source"
            )
            private_media_id = create_test_media(session, title="Existing inaccessible media")
            library_entries.ensure_entry(
                session,
                private_library_id,
                library_entries.media_target(private_media_id),
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", private_media_id)
        direct_db.register_cleanup("media", "id", private_media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("memberships", "library_id", private_library_id)
        direct_db.register_cleanup("libraries", "id", private_library_id)

        for media_id in (uuid4(), private_media_id):
            response = auth_client.delete(
                f"/media/{media_id}/libraries/{library_id}",
                headers=auth_headers(viewer_id),
            )
            assert response.status_code == 204, response.text
            assert response.content == b""
        assert _library_entry_ids_for_media(direct_db, private_media_id) == {private_library_id}

    def test_member_only_library_is_forbidden_without_a_media_oracle(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        owner_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, owner_id)
        with direct_db.session() as session:
            library_id = create_test_library(session, owner_id, "Member-only target")
            add_library_member(session, library_id, viewer_id, role="member")
            private_media_id = create_test_media(session, title="Private media oracle guard")
            library_entries.ensure_entry(
                session, library_id, library_entries.media_target(private_media_id)
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", private_media_id)
        direct_db.register_cleanup("media", "id", private_media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        for media_id in (uuid4(), private_media_id):
            response = auth_client.delete(
                f"/media/{media_id}/libraries/{library_id}",
                headers=auth_headers(viewer_id),
            )
            assert response.status_code == 403, response.text
            assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_inaccessible_library_is_masked_without_a_media_oracle(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        owner_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, owner_id)
        with direct_db.session() as session:
            library_id = create_test_library(session, owner_id, "Inaccessible target")
            readable_media_id = create_test_media(session, title="Readable media oracle guard")
            library_entries.ensure_media_in_default_library(session, viewer_id, readable_media_id)
            library_entries.ensure_entry(
                session,
                library_id,
                library_entries.media_target(readable_media_id),
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", readable_media_id)
        direct_db.register_cleanup("media", "id", readable_media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        for media_id in (uuid4(), readable_media_id):
            response = auth_client.delete(
                f"/media/{media_id}/libraries/{library_id}",
                headers=auth_headers(viewer_id),
            )
            assert response.status_code == 404, response.text
            assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_refuses_last_lifetime_reference(self, auth_client, direct_db: DirectSessionManager):
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        with direct_db.session() as session:
            media_id = create_test_media(session, title="Last reference")
            library_id = create_test_library(session, viewer_id, "Only reference")
            library_entries.ensure_entry(
                session, library_id, library_entries.media_target(media_id)
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.delete(
            f"/media/{media_id}/libraries/{library_id}",
            headers=auth_headers(viewer_id),
        )
        assert response.status_code == 409, response.text
        assert response.json()["error"]["code"] == "E_MEDIA_LAST_REFERENCE"
        assert library_id in _library_entry_ids_for_media(direct_db, media_id)

    def test_lost_response_replay_succeeds_after_last_visible_path_is_removed(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        other_owner_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)
        _bootstrap_user(auth_client, other_owner_id)
        with direct_db.session() as session:
            media_id = create_test_media(session, title="Lost response replay")
            visible_library_id = create_test_library(session, viewer_id, "Visible path")
            private_library_id = create_test_library(session, other_owner_id, "Private survivor")
            for library_id in (visible_library_id, private_library_id):
                library_entries.ensure_entry(
                    session, library_id, library_entries.media_target(media_id)
                )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        for library_id in (visible_library_id, private_library_id):
            direct_db.register_cleanup("memberships", "library_id", library_id)
            direct_db.register_cleanup("libraries", "id", library_id)

        endpoint = f"/media/{media_id}/libraries/{visible_library_id}"
        first = auth_client.delete(endpoint, headers=auth_headers(viewer_id))
        replay = auth_client.delete(endpoint, headers=auth_headers(viewer_id))
        assert first.status_code == 204, first.text
        assert replay.status_code == 204, replay.text
        assert (
            auth_client.get(f"/media/{media_id}", headers=auth_headers(viewer_id)).status_code
            == 404
        )
        assert (
            auth_client.get(f"/media/{media_id}", headers=auth_headers(other_owner_id)).status_code
            == 200
        )

    def test_default_library_is_not_a_removal_target(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)
        with direct_db.session() as session:
            media_id = create_test_media(session, title="Default guard")
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.delete(
            f"/media/{media_id}/libraries/{default_library_id}",
            headers=auth_headers(viewer_id),
        )
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_whole_resource_delete_rejects_every_query_without_mutation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        viewer_id = create_test_user_id()
        default_library_id = _bootstrap_user(auth_client, viewer_id)
        with direct_db.session() as session:
            media_id = create_test_media(session, title="Old query guard")
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        for query in (f"library_id={default_library_id}", "undeclared=value"):
            response = auth_client.delete(
                f"/media/{media_id}?{query}",
                headers=auth_headers(viewer_id),
            )
            assert response.status_code == 400, response.text
            assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
            assert (
                auth_client.get(f"/media/{media_id}", headers=auth_headers(viewer_id)).status_code
                == 200
            )


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
            f"/media/{media_id}/libraries/{system_library_id}",
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_LIBRARY_FORBIDDEN"
        assert system_library_id in _library_entry_ids_for_media(direct_db, media_id)

    def test_delete_media_for_viewer_is_forbidden_for_system_only_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Truthful viewer deletion (spec S4.3/S5): a viewer whose only path to a
        media is a system library they don't control gets a rejection, not a
        successful no-op — and the call mutates nothing."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="System Only Media")
            system_library_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_forbidden_system_{media_id.hex[:12]}",
                name="System Forbidden Library",
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

        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "E_FORBIDDEN"
        # No mutation: the system reference and (absent) tombstone are unchanged.
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

    def test_system_only_media_reports_can_delete_false(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Client-facing half of the same fix (spec S5): the UI must never offer a
        delete affordance the endpoint would then reject."""
        viewer_id = create_test_user_id()
        _bootstrap_user(auth_client, viewer_id)

        with direct_db.session() as session:
            media_id = create_test_media(session, title="System Only Capability Media")
            system_library_id = library_governance.ensure_system_library(
                session,
                system_key=f"test_capability_system_{media_id.hex[:12]}",
                name="System Capability Library",
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

        detail_resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(viewer_id))
        assert detail_resp.status_code == 200, detail_resp.text
        assert detail_resp.json()["data"]["capabilities"]["can_delete"] is False

        # Explicit non-system filing (own Default) makes it personally deletable.
        _bootstrap_user(auth_client, viewer_id)
        with direct_db.session() as session:
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
            session.commit()

        detail_resp = auth_client.get(f"/media/{media_id}", headers=auth_headers(viewer_id))
        assert detail_resp.status_code == 200, detail_resp.text
        assert detail_resp.json()["data"]["capabilities"]["can_delete"] is True
