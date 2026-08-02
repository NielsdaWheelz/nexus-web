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
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from nexus.db.models import MediaKind, Podcast, PodcastEpisode
from nexus.services import library_entries, library_governance
from nexus.services.collection_revisions import CollectionFamily
from nexus.services.sealed_handles import (
    seal_library_invitation,
    seal_user,
    unseal_library_invitation,
    unseal_user,
)
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    encode_signed_keyset_cursor,
)
from tests.factories import (
    add_media_to_library,
    add_test_podcast_episode_identity,
    add_test_podcast_subscription,
    create_test_fragment,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.support.teardown import drive_media_teardown, install_fake_storage_for_teardown
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _library_create_body(name: str) -> dict[str, str]:
    return {"library_id": str(uuid4()), "name": name}


def _file_podcast_in_libraries(
    auth_client,
    user_id: UUID,
    podcast_id: UUID,
    library_ids: list[UUID],
):
    return auth_client.post(
        "/podcasts/subscriptions",
        json={
            "target": {
                "kind": "Canonical",
                "podcastId": str(podcast_id),
            },
            "namedLibraryIds": [str(library_id) for library_id in library_ids],
            "replacementConfirmation": {"kind": "Absent"},
        },
        headers={
            **auth_headers(user_id),
            "Idempotency-Key": f"file-podcast-{uuid4()}",
        },
    )


def _user_handle(user_id: UUID) -> str:
    return str(seal_user(user_id))


def _invite_handle(invitation_id: UUID | str) -> str:
    return str(seal_library_invitation(UUID(str(invitation_id))))


def _collection_revision(
    direct_db: DirectSessionManager,
    viewer_id: UUID,
    family: str,
) -> int:
    with direct_db.session() as session:
        revision = session.execute(
            text(
                "SELECT revision FROM viewer_collection_revisions "
                "WHERE viewer_id = :viewer_id AND family = :family"
            ),
            {"viewer_id": viewer_id, "family": family},
        ).scalar_one_or_none()
    return 0 if revision is None else revision


def _user_invitee(user_id: UUID) -> dict:
    return {"kind": "User", "userHandle": _user_handle(user_id)}


def _run_concurrently(*operations):
    barrier = threading.Barrier(len(operations))
    results = [None] * len(operations)
    errors: list[BaseException] = []

    def run(index, operation):
        try:
            barrier.wait(timeout=10)
            results[index] = operation()
        except BaseException as exc:  # noqa: BLE001 - surfaced to the asserting thread
            errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(index, operation))
        for index, operation in enumerate(operations)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)
        assert not thread.is_alive()
    if errors:
        raise errors[0]
    return results


@pytest.fixture
def _sharing_entitled(monkeypatch):
    from nexus.services import billing_entitlements

    def entitlement(_db, _user_id):
        return SimpleNamespace(can_share=True)

    monkeypatch.setattr(
        billing_entitlements,
        "get_effective_entitlements",
        entitlement,
    )
    monkeypatch.setattr(library_entries, "get_effective_entitlements", entitlement)


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


def _entry_page(response) -> dict:
    return response.json()["data"]


def _entry_items(response) -> list[dict]:
    return _entry_page(response)["items"]


def _entry_revision(response) -> int:
    return _entry_page(response)["collectionRevision"]


def _entry_cursor(response) -> str | None:
    presence = _entry_page(response)["nextCursor"]
    if presence["kind"] == "Absent":
        return None
    assert presence["kind"] == "Present"
    return presence["value"]


def _entry_placement_id(row: dict) -> str:
    placement = row["placement"]
    assert placement["kind"] == "Present", row
    return placement["value"]["libraryEntryId"]


def _library_entry_media_ids(rows: list[dict]) -> list[str]:
    return [
        row["media"]["id"] for row in rows if row["kind"] == "media" and row["media"] is not None
    ]


def _seed_podcast_episode_roots(
    direct_db: DirectSessionManager,
    *,
    library_ids: list[UUID],
    episode_count: int,
) -> tuple[UUID, list[UUID]]:
    podcast_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Podcast(
                id=podcast_id,
                provider="podcast_index",
                provider_podcast_id=f"root-inventory-{podcast_id}",
                title="Root Inventory Podcast",
                feed_url=f"https://example.com/{podcast_id}.xml",
            )
        )
        session.commit()
    direct_db.register_cleanup("podcasts", "id", podcast_id)

    media_ids: list[UUID] = []
    for index in range(episode_count):
        with direct_db.session() as session:
            media_id = create_test_media(
                session,
                title=f"Root Inventory Episode {index}",
                kind=MediaKind.podcast_episode.value,
            )
            session.add(PodcastEpisode(media_id=media_id, podcast_id=podcast_id))
            for library_id in library_ids:
                add_media_to_library(session, library_id, media_id)
            session.commit()
        media_ids.append(media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    return podcast_id, media_ids


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
    filed directly (bypassing REST) — the minimum precondition actor-authorized
    filing enforces (spec S4.3 rule 1, F2/F3:
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
            json=_library_create_body("My New Library"),
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["name"] == "My New Library"
        assert data["isDefault"] is False
        assert data["role"] == "admin"
        assert unseal_user(data["ownerUserHandle"]) == user_id
        assert data["canTransferOwnership"] is True

    def test_create_library_owner_is_admin(self, auth_client, direct_db: DirectSessionManager):
        """Creator becomes admin of new library."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json=_library_create_body("Test Library"),
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
            json=_library_create_body(""),
            headers=auth_headers(user_id),
        )

        # Pydantic validation returns 400 E_INVALID_REQUEST for empty string
        # (Field min_length=1 triggers validation error)
        assert response.status_code == 400
        # Accept either E_INVALID_REQUEST (from Pydantic) or E_NAME_INVALID (from service)
        assert response.json()["error"]["code"] in ("E_INVALID_REQUEST", "E_NAME_INVALID")

    def test_create_library_whitespace_only_name(self, auth_client):
        """Whitespace-only name fails the strict request schema."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json=_library_create_body("   "),
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_create_library_name_too_long(self, auth_client):
        """Name > 100 chars returns 400."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json=_library_create_body("x" * 101),
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400

    def test_create_library_name_trimmed(self, auth_client):
        """Name is trimmed of leading/trailing whitespace."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/libraries",
            json=_library_create_body("  My Library  "),
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
        assert set(body) == {"data"}
        assert set(body["data"]) == {
            "items",
            "collectionRevision",
            "nextCursor",
        }
        assert body["data"]["collectionRevision"] >= 1
        assert body["data"]["nextCursor"] == {"kind": "Absent"}
        data = body["data"]["items"]
        assert len(data) >= 1

        # Find default library
        default_libs = [lib for lib in data if lib["isDefault"]]
        assert len(default_libs) == 1
        assert default_libs[0]["name"] == "My Library"
        assert default_libs[0]["canTransferOwnership"] is False

    def test_list_libraries_ordering(self, auth_client):
        """Libraries are ordered by created_at ASC, id ASC."""
        user_id = create_test_user_id()

        # Create some libraries
        auth_client.post(
            "/libraries", json=_library_create_body("Lib A"), headers=auth_headers(user_id)
        )
        auth_client.post(
            "/libraries", json=_library_create_body("Lib B"), headers=auth_headers(user_id)
        )
        auth_client.post(
            "/libraries", json=_library_create_body("Lib C"), headers=auth_headers(user_id)
        )

        response = auth_client.get("/libraries", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]["items"]

        # First should be default (created first), then A, B, C in order
        assert data[0]["isDefault"] is True
        # Verify ascending order by checking created_at
        for i in range(len(data) - 1):
            assert data[i]["createdAt"] <= data[i + 1]["createdAt"]

    def test_list_libraries_limit(self, auth_client):
        """Limit parameter works correctly."""
        user_id = create_test_user_id()

        # Create 5 libraries
        for i in range(5):
            auth_client.post(
                "/libraries", json=_library_create_body(f"Lib {i}"), headers=auth_headers(user_id)
            )

        response = auth_client.get("/libraries?limit=3", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]["items"]
        assert len(data) == 3

    def test_list_libraries_rejects_noncanonical_limit(self, auth_client):
        user_id = create_test_user_id()

        response = auth_client.get("/libraries?limit=500", headers=auth_headers(user_id))

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_libraries_paginates_with_next_cursor(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        for idx in range(3):
            response = auth_client.post(
                "/libraries",
                json=_library_create_body(f"Cursor Library {idx}"),
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get("/libraries?limit=2", headers=auth_headers(user_id))
        assert first.status_code == 200, first.text
        first_page = first.json()["data"]
        assert len(first_page["items"]) == 2
        assert first_page["nextCursor"]["kind"] == "Present"
        cursor = first_page["nextCursor"]["value"]
        revision = first_page["collectionRevision"]

        second = auth_client.get(
            f"/libraries?limit=2&cursor={cursor}&collection_revision={revision}",
            headers=auth_headers(user_id),
        )
        assert second.status_code == 200, second.text
        second_page = second.json()["data"]
        assert second_page["nextCursor"] == {"kind": "Absent"}
        assert second_page["collectionRevision"] == revision
        first_ids = {row["id"] for row in first_page["items"]}
        second_ids = {row["id"] for row in second_page["items"]}
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
                json=_library_create_body(f"Scoped Cursor Library {idx}"),
                headers=auth_headers(owner_id),
            )
            assert response.status_code == 201, response.text

        first = auth_client.get("/libraries?limit=2", headers=auth_headers(owner_id))
        assert first.status_code == 200, first.text
        cursor = first.json()["data"]["nextCursor"]["value"]
        other_revision = auth_client.get(
            "/libraries",
            headers=auth_headers(other_id),
        ).json()["data"]["collectionRevision"]

        response = auth_client.get(
            f"/libraries?limit=2&cursor={cursor}&collection_revision={other_revision}",
            headers=auth_headers(other_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_libraries_rejects_invalid_cursor(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        revision = auth_client.get(
            "/libraries",
            headers=auth_headers(user_id),
        ).json()["data"]["collectionRevision"]
        response = auth_client.get(
            f"/libraries?cursor=not-a-cursor&collection_revision={revision}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_libraries_invalid_limit(self, auth_client):
        """Limit <= 0 is rejected by the one raw collection parser."""
        user_id = create_test_user_id()

        response = auth_client.get("/libraries?limit=0", headers=auth_headers(user_id))

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    @pytest.mark.parametrize(
        "query",
        [
            "offset=0",
            "unknown=1",
            "limit=01",
            "limit=2&limit=3",
            "cursor=orphan",
            "collection_revision=1",
        ],
    )
    def test_list_libraries_rejects_legacy_or_malformed_query(
        self,
        auth_client,
        query: str,
    ):
        user_id = create_test_user_id()

        response = auth_client.get(
            f"/libraries?{query}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_libraries_rejects_continuation_after_revision_change(
        self,
        auth_client,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        for index in range(3):
            auth_client.post(
                "/libraries",
                json=_library_create_body(f"Revision Library {index}"),
                headers=auth_headers(user_id),
            )
        first = auth_client.get(
            "/libraries?limit=2",
            headers=auth_headers(user_id),
        ).json()["data"]

        auth_client.post(
            "/libraries",
            json=_library_create_body("Revision changed"),
            headers=auth_headers(user_id),
        )
        response = auth_client.get(
            "/libraries",
            params={
                "limit": 2,
                "cursor": first["nextCursor"]["value"],
                "collection_revision": first["collectionRevision"],
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_COLLECTION_CHANGED"


@pytest.mark.usefixtures("_sharing_entitled")
class TestLibrariesIndexRevisionBumps:
    def test_create_and_replay_bump_once(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        viewer_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(viewer_id))
        before = _collection_revision(
            direct_db,
            viewer_id,
            "LibrariesIndex",
        )
        body = _library_create_body("Revision create")

        first = auth_client.post(
            "/libraries",
            json=body,
            headers=auth_headers(viewer_id),
        )
        replay = auth_client.post(
            "/libraries",
            json=body,
            headers=auth_headers(viewer_id),
        )

        assert first.status_code == replay.status_code == 201
        assert _collection_revision(direct_db, viewer_id, "LibrariesIndex") == before + 1

    def test_system_library_create_and_replay_bump_once(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        viewer_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(viewer_id))
        before = _collection_revision(
            direct_db,
            viewer_id,
            "LibrariesIndex",
        )
        system_key = f"revision_system_{uuid4().hex}"

        with direct_db.session() as session:
            first_id = library_governance.ensure_system_library(
                session,
                system_key=system_key,
                name="Revision system",
                owner_user_id=viewer_id,
            )
            replay_id = library_governance.ensure_system_library(
                session,
                system_key=system_key,
                name="Revision system",
                owner_user_id=viewer_id,
            )

        direct_db.register_cleanup("memberships", "library_id", first_id)
        direct_db.register_cleanup("libraries", "id", first_id)
        assert replay_id == first_id
        assert _collection_revision(direct_db, viewer_id, "LibrariesIndex") == before + 1

    def test_rename_role_transfer_and_removal_bump_affected_viewers(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Revision governance"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:library_id, :member_id, 'member')"
                ),
                {"library_id": library_id, "member_id": member_id},
            )
            session.commit()
        before_owner = _collection_revision(
            direct_db,
            owner_id,
            "LibrariesIndex",
        )
        before_member = _collection_revision(
            direct_db,
            member_id,
            "LibrariesIndex",
        )

        renamed = auth_client.patch(
            f"/libraries/{library_id}",
            json={"name": "Revision renamed"},
            headers=auth_headers(owner_id),
        )
        promoted = auth_client.patch(
            f"/libraries/{library_id}/members/{_user_handle(member_id)}",
            json={"role": "admin"},
            headers=auth_headers(owner_id),
        )
        transferred = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"newOwnerUserHandle": _user_handle(member_id)},
            headers=auth_headers(owner_id),
        )

        assert renamed.status_code == 200
        assert promoted.status_code == 200
        assert transferred.status_code == 200
        assert _collection_revision(direct_db, owner_id, "LibrariesIndex") == before_owner + 3
        assert _collection_revision(direct_db, member_id, "LibrariesIndex") == before_member + 3
        before_member_conversations = _collection_revision(
            direct_db,
            owner_id,
            "ConversationIndex",
        )
        removed = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
            headers=auth_headers(member_id),
        )
        assert removed.status_code == 204
        assert _collection_revision(direct_db, owner_id, "LibrariesIndex") == before_owner + 4
        assert (
            _collection_revision(direct_db, owner_id, "ConversationIndex")
            == before_member_conversations + 1
        )

    def test_invitation_acceptance_bumps_both_visible_indexes(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Revision invitation"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        invitation_handle = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        ).json()["data"]["invitationHandle"]
        before_libraries = _collection_revision(
            direct_db,
            invitee_id,
            "LibrariesIndex",
        )
        before_conversations = _collection_revision(
            direct_db,
            invitee_id,
            "ConversationIndex",
        )

        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )
        replay = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

        assert response.status_code == 200
        assert replay.status_code == 200
        assert replay.json()["data"]["idempotent"] is True
        assert _collection_revision(direct_db, invitee_id, "LibrariesIndex") == before_libraries + 1
        assert (
            _collection_revision(direct_db, invitee_id, "ConversationIndex")
            == before_conversations + 1
        )

    def test_delete_bumps_all_members_and_conversation_visibility(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Revision delete"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:library_id, :member_id, 'member')"
                ),
                {"library_id": library_id, "member_id": member_id},
            )
            session.commit()
        before = {
            (viewer_id, family): _collection_revision(
                direct_db,
                viewer_id,
                family,
            )
            for viewer_id in (owner_id, member_id)
            for family in ("LibrariesIndex", "ConversationIndex")
        }

        response = auth_client.delete(
            f"/libraries/{library_id}",
            headers=auth_headers(owner_id),
        )

        assert response.status_code == 200
        assert response.json()["data"] == {
            "libraryId": library_id,
            "collectionRevision": before[(owner_id, "LibrariesIndex")] + 1,
        }
        for key, revision in before.items():
            assert _collection_revision(direct_db, *key) == revision + 1


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
                json=_library_create_body(f"Destination {idx:03d}"),
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

        # Insert in scrambled order so timestamp order != alphabetical order; the
        # keyset must page in alphabetical (lower(name), name, id) order.
        for idx in (3, 1, 0, 2):
            response = auth_client.post(
                "/libraries",
                json=_library_create_body(f"Paged Destination {idx}"),
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        names: list[str] = []
        ids: list[str] = []
        cursor: str | None = None
        for _ in range(10):  # generous page bound; 4 rows / limit 2 = 2 pages
            url = "/libraries/writable-destinations?q=Paged%20Destination&limit=2"
            if cursor is not None:
                url += f"&cursor={cursor}"
            page = auth_client.get(url, headers=auth_headers(user_id))
            assert page.status_code == 200, page.text
            body = page.json()
            names.extend(row["name"] for row in body["data"])
            ids.extend(row["id"] for row in body["data"])
            cursor = body["page"]["next_cursor"]
            if not body["page"]["has_more"]:
                break

        # Complete (all four, no duplicates) and in alphabetical order.
        assert names == [
            "Paged Destination 0",
            "Paged Destination 1",
            "Paged Destination 2",
            "Paged Destination 3",
        ]
        assert len(ids) == len(set(ids)) == 4

    def test_blank_query_returns_alphabetical(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Mixed case, inserted out of alphabetical order.
        for name in ("Zebra Shelf", "apple Shelf", "Mango Shelf", "banana Shelf"):
            response = auth_client.post(
                "/libraries",
                json=_library_create_body(name),
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        response = auth_client.get(
            "/libraries/writable-destinations",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        assert [row["name"] for row in response.json()["data"]] == [
            "apple Shelf",
            "banana Shelf",
            "Mango Shelf",
            "Zebra Shelf",
        ]

    def test_query_ranks_then_orders_alphabetically(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Scrambled insertion order so the result cannot be an insertion artifact.
        for name in ("Concat", "Cat", "Category", "Bobcat", "Catalog"):
            response = auth_client.post(
                "/libraries",
                json=_library_create_body(name),
                headers=auth_headers(user_id),
            )
            assert response.status_code == 201, response.text

        response = auth_client.get(
            "/libraries/writable-destinations?q=cat",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200, response.text
        # rank 0 (exact) -> rank 1 (prefix) -> rank 2 (contains); alphabetical within each rank.
        assert [row["name"] for row in response.json()["data"]] == [
            "Cat",
            "Catalog",
            "Category",
            "Bobcat",
            "Concat",
        ]

    def test_cursor_rejects_another_viewer(self, auth_client):
        owner_id = create_test_user_id()
        other_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(other_id))
        for idx in range(3):
            response = auth_client.post(
                "/libraries",
                json=_library_create_body(f"Scoped Destination {idx}"),
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

    def test_pre_cutover_cursor_rejected(self, auth_client):
        """A well-formed cursor of the OLD unversioned kind is rejected (hard cutover)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        old_payload = {
            "k": "library_destinations",
            "viewer_id": str(user_id),
            "rank": 0,
            "updated_at": "2026-01-01T00:00:00+00:00",
            "created_at": "2026-01-01T00:00:00+00:00",
            "id": str(uuid4()),
            "q": "",
        }
        old_cursor = (
            base64.urlsafe_b64encode(json.dumps(old_payload).encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )

        response = auth_client.get(
            f"/libraries/writable-destinations?cursor={old_cursor}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_cursor_rejects_unknown_key(self, auth_client):
        """A v2 cursor with the right viewer/query but an extra key is rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        payload = {
            "k": "library_destinations:v2",
            "viewer_id": str(user_id),
            "q": "",
            "rank": 3,
            "normalized_name": "shelf",
            "name": "Shelf",
            "id": str(uuid4()),
            "extra": "unexpected",
        }
        cursor = (
            base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )

        response = auth_client.get(
            f"/libraries/writable-destinations?cursor={cursor}",
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

        entries = _entry_items(_list_library_entries(auth_client, owner_id, str(system_id)))
        entry_ids = [_entry_placement_id(row) for row in entries]
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
                json={"invitee": _user_invitee(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            ),
            auth_client.get(f"/libraries/{system_id}/invites", headers=auth_headers(owner_id)),
            auth_client.patch(
                f"/libraries/{system_id}/members/{_user_handle(owner_id)}",
                json={"role": "admin"},
                headers=auth_headers(owner_id),
            ),
            auth_client.delete(
                f"/libraries/{system_id}/members/{_user_handle(owner_id)}",
                headers=auth_headers(owner_id),
            ),
            auth_client.post(
                f"/libraries/{system_id}/transfer-ownership",
                json={"newOwnerUserHandle": _user_handle(invitee_id)},
                headers=auth_headers(owner_id),
            ),
            auth_client.post(
                f"/media/{new_media_id}/libraries",
                json={"library_ids": [str(system_id)]},
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


class TestFrozenLibraryInvitationLifecycle:
    @pytest.mark.parametrize("library_kind", ["default", "system"])
    @pytest.mark.parametrize("command", ["accept", "decline", "revoke"])
    def test_pending_legacy_invitation_cannot_mutate_frozen_library(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        library_kind: str,
        command: str,
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        default_library_id = auth_client.get(
            "/me",
            headers=auth_headers(owner_id),
        ).json()["data"]["default_library_id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        with direct_db.session() as session:
            if library_kind == "system":
                library_id = library_governance.ensure_system_library(
                    session,
                    system_key=f"legacy_invite_guard_{uuid4().hex}",
                    name="Legacy invite guard",
                    owner_user_id=owner_id,
                )
            else:
                library_id = UUID(default_library_id)
            invitation_id = session.execute(
                text("""
                    INSERT INTO library_invitations
                        (library_id, inviter_user_id, invitee_user_id, role, status)
                    VALUES
                        (:library_id, :owner_id, :invitee_id, 'member', 'pending')
                    RETURNING id
                """),
                {
                    "library_id": library_id,
                    "owner_id": owner_id,
                    "invitee_id": invitee_id,
                },
            ).scalar_one()
            session.commit()

        if library_kind == "system":
            direct_db.register_cleanup("libraries", "id", library_id)
            direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("library_invitations", "id", invitation_id)

        invitation_handle = _invite_handle(invitation_id)
        if command == "revoke":
            response = auth_client.delete(
                f"/libraries/invites/{invitation_handle}",
                headers=auth_headers(owner_id),
            )
        else:
            response = auth_client.post(
                f"/libraries/invites/{invitation_handle}/{command}",
                headers=auth_headers(invitee_id),
            )

        assert response.status_code == 403
        expected_code = (
            "E_LIBRARY_FORBIDDEN" if library_kind == "system" else "E_DEFAULT_LIBRARY_FORBIDDEN"
        )
        assert response.json()["error"]["code"] == expected_code
        with direct_db.session() as session:
            assert (
                session.execute(
                    text("SELECT status FROM library_invitations WHERE id = :invitation_id"),
                    {"invitation_id": invitation_id},
                ).scalar_one()
                == "pending"
            )
            assert (
                session.execute(
                    text("""
                        SELECT 1
                        FROM memberships
                        WHERE library_id = :library_id AND user_id = :invitee_id
                    """),
                    {"library_id": library_id, "invitee_id": invitee_id},
                ).fetchone()
                is None
            )


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
            "/libraries", json=_library_create_body("Original Name"), headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Rename
        response = auth_client.patch(
            f"/libraries/{library_id}",
            json={"name": "New Name"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        assert response.json()["data"]["library"]["name"] == "New Name"
        assert response.json()["data"]["library"]["id"] == library_id
        assert response.json()["data"]["collectionRevision"] >= 1

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
            "/libraries", json=_library_create_body("Test"), headers=auth_headers(user_id)
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
            "/libraries", json=_library_create_body("To Delete"), headers=auth_headers(user_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Delete
        response = auth_client.delete(f"/libraries/{library_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"]["libraryId"] == library_id
        assert response.json()["data"]["collectionRevision"] >= 1

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
            "/libraries", json=_library_create_body("To Delete"), headers=auth_headers(user_id)
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


class TestDeleteDocument:
    """Tests for whole-resource DELETE /media/{media_id}."""

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
            "/libraries", json=_library_create_body("Shared"), headers=auth_headers(owner_id)
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
            f"/media/{media_id}/libraries/{library_id}",
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
            json=_library_create_body("Podcasts"),
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
            add_test_podcast_subscription(session, user_id=user_id, podcast_id=podcast_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        response = _file_podcast_in_libraries(
            auth_client,
            user_id,
            podcast_id,
            [UUID(library_id)],
        )

        assert response.status_code == 200, response.text
        assert response.json()["data"]["outcome"] == "DestinationsAdded"
        entries = _entry_items(_list_library_entries(auth_client, user_id, library_id))
        data = next(row for row in entries if row["kind"] == "podcast")
        assert data["podcast"]["id"] == str(podcast_id)
        assert data["readingTimeEstimate"] == {"kind": "Absent"}

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
            add_test_podcast_subscription(session, user_id=user_id, podcast_id=podcast_id)
            session.commit()

        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        response = _file_podcast_in_libraries(
            auth_client,
            user_id,
            podcast_id,
            [UUID(default_library_id)],
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_remove_podcast_success(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries",
            json=_library_create_body("Sports"),
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
            add_test_podcast_subscription(session, user_id=user_id, podcast_id=podcast_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        add_resp = _file_podcast_in_libraries(
            auth_client,
            user_id,
            podcast_id,
            [UUID(library_id)],
        )
        assert add_resp.status_code == 200, add_resp.text

        remove_resp = auth_client.delete(
            f"/libraries/{library_id}/podcasts/{podcast_id}",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": f"remove-podcast-{uuid4()}",
            },
        )
        assert remove_resp.status_code == 200
        assert remove_resp.json()["data"]["outcome"] == "Removed"
        assert remove_resp.json()["data"]["libraryEntriesCollectionRevision"] >= 1


class TestListLibraryMedia:
    """Tests for GET /libraries/{id}/entries endpoint."""

    def test_list_media_empty(self, auth_client):
        """List media in empty library returns empty list."""
        user_id = create_test_user_id()

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        response = _list_library_entries(auth_client, user_id, library_id)

        assert response.status_code == 200
        assert _entry_cursor(response) is None
        assert _entry_items(response) == []

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
        assert _entry_cursor(response) is None
        data = _entry_items(response)
        assert len(data) == 1
        assert data[0]["kind"] == "media"
        assert data[0]["media"]["id"] == str(media_id)
        assert data[0]["media"]["kind"] == "web_article"
        assert data[0]["media"]["read_state"] == "unread"
        assert "read_state" not in data[0]
        assert "progress_fraction" not in data[0]
        assert data[0]["readingTimeEstimate"] == {"kind": "Absent"}
        assert "reading_time_estimate" not in data[0]

    def test_list_media_projects_document_reading_time_policy(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        # 3,000 words at 40% progression proves remaining is calculated from
        # raw words: total rounds to 15, while the raw 7.5 minutes rounds to 8.
        # Deriving from the rounded total would incorrectly produce 9.
        document_text = " ".join(["word"] * 3000)

        with direct_db.session() as session:
            unread_id = create_test_media(session, title="Unread estimate")
            in_progress_id = create_test_media(session, title="Remaining estimate")
            finished_id = create_test_media(session, title="Finished estimate")
            override_unread_id = create_test_media(session, title="Unread override estimate")
            epub_id = create_test_media(session, title="EPUB estimate")
            pending_id = create_test_media(session, title="Pending estimate", status="extracting")
            zero_id = create_test_media(session, title="Zero estimate")
            session.execute(
                text("UPDATE media SET kind = 'epub' WHERE id = :media_id"),
                {"media_id": epub_id},
            )
            for media_id in (
                unread_id,
                in_progress_id,
                finished_id,
                override_unread_id,
                epub_id,
                pending_id,
                zero_id,
            ):
                add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        for media_id in (
            unread_id,
            in_progress_id,
            finished_id,
            override_unread_id,
            epub_id,
            pending_id,
            zero_id,
        ):
            direct_db.register_cleanup("media", "id", media_id)
            direct_db.register_cleanup("fragments", "media_id", media_id)
            direct_db.register_cleanup("library_entries", "media_id", media_id)
        for media_id in (in_progress_id, finished_id, override_unread_id):
            direct_db.register_cleanup("reader_engagement_states", "media_id", media_id)
            direct_db.register_cleanup("reader_media_state", "media_id", media_id)
        direct_db.register_cleanup("consumption_overrides", "media_id", finished_id)
        direct_db.register_cleanup("consumption_overrides", "media_id", override_unread_id)
        direct_db.register_cleanup("consumption_completion_facts", "media_id", finished_id)

        fragment_ids: dict[UUID, UUID] = {}
        for media_id in (
            unread_id,
            in_progress_id,
            finished_id,
            override_unread_id,
            epub_id,
            pending_id,
        ):
            with direct_db.session() as session:
                fragment_ids[media_id] = create_test_fragment(session, media_id, document_text)

        for media_id in (in_progress_id, finished_id, override_unread_id):
            reader_state = auth_client.put(
                f"/media/{media_id}/reader-state",
                headers=auth_headers(user_id),
                json={
                    "locator": {
                        "kind": "web",
                        "target": {"fragment_id": str(fragment_ids[media_id])},
                        "locations": {
                            "text_offset": 0,
                            "progression": 0.4,
                            "total_progression": 0.4,
                            "position": 1,
                        },
                        "text": {
                            "quote": None,
                            "quote_prefix": None,
                            "quote_suffix": None,
                        },
                    },
                    "base_revision": 0,
                },
            )
            assert reader_state.status_code == 200, reader_state.text

        for kind, media_id in (
            ("EnsureMediaFinished", finished_id),
            ("SetUnread", override_unread_id),
        ):
            command = auth_client.post(
                "/consumption/commands",
                headers=auth_headers(user_id),
                json={
                    "kind": kind,
                    "clientMutationId": str(uuid4()),
                    "mediaId": str(media_id),
                },
            )
            assert command.status_code == 200, command.text

        response = _list_library_entries(auth_client, user_id, library_id)
        assert response.status_code == 200, response.text
        by_id = {row["media"]["id"]: row for row in _entry_items(response)}

        assert by_id[str(unread_id)]["readingTimeEstimate"] == {
            "kind": "Present",
            "value": {
                "totalMinutes": 15,
                "remainingMinutes": {"kind": "Absent"},
            },
        }
        assert by_id[str(in_progress_id)]["readingTimeEstimate"] == {
            "kind": "Present",
            "value": {
                "totalMinutes": 15,
                "remainingMinutes": {"kind": "Present", "value": 8},
            },
        }
        assert by_id[str(finished_id)]["readingTimeEstimate"]["value"] == {
            "totalMinutes": 15,
            "remainingMinutes": {"kind": "Absent"},
        }
        assert by_id[str(finished_id)]["media"]["progress_fraction"] == pytest.approx(0.4)
        assert by_id[str(finished_id)]["media"]["read_state"] == "finished"
        assert by_id[str(override_unread_id)]["readingTimeEstimate"]["value"] == {
            "totalMinutes": 15,
            "remainingMinutes": {"kind": "Absent"},
        }
        assert by_id[str(override_unread_id)]["media"]["progress_fraction"] == pytest.approx(0.4)
        assert by_id[str(override_unread_id)]["media"]["read_state"] == "unread"
        assert by_id[str(epub_id)]["readingTimeEstimate"]["value"] == {
            "totalMinutes": 15,
            "remainingMinutes": {"kind": "Absent"},
        }
        assert by_id[str(pending_id)]["readingTimeEstimate"] == {"kind": "Absent"}
        assert by_id[str(zero_id)]["readingTimeEstimate"] == {"kind": "Absent"}

    def test_list_media_reading_time_rounds_half_up_in_coarse_buckets(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        cases = [
            (1, 1),
            (359, 1),
            (360, 2),
            (2279, 9),
            (2280, 10),
            (2399, 10),
            (2400, 10),
            (2999, 10),
            (3000, 15),
            (13799, 55),
            (13800, 60),
            (14399, 60),
            (14400, 60),
            (16199, 60),
            (16200, 75),
        ]
        expected_by_id: dict[str, int] = {}
        for word_count, expected_minutes in cases:
            with direct_db.session() as session:
                media_id = create_test_media(session, title=f"Rounding {word_count}")
                create_test_fragment(session, media_id, " ".join(["word"] * word_count))
                add_media_to_library(session, UUID(library_id), media_id)
                session.commit()
            expected_by_id[str(media_id)] = expected_minutes
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("fragments", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        response = _list_library_entries(auth_client, user_id, library_id)
        assert response.status_code == 200, response.text
        actual_by_id = {
            row["media"]["id"]: row["readingTimeEstimate"]["value"]["totalMinutes"]
            for row in _entry_items(response)
        }
        assert actual_by_id == expected_by_id

    def test_list_media_uses_canonical_media_hydration_for_podcast_episode(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        media_id = uuid4()
        podcast_id = uuid4()
        provider_podcast_id = f"library-hydration-{podcast_id}"
        episode_ref = f"episode-{media_id}"

        with direct_db.session() as session:
            named_library_id = create_test_library(session, user_id, "Episode Hydration")
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
                        :episode_ref
                    )
                """),
                {
                    "media_id": media_id,
                    "episode_ref": episode_ref,
                },
            )
            session.execute(
                text("""
                    INSERT INTO podcast_episodes (
                        media_id,
                        podcast_id,
                        published_at,
                        duration_seconds,
                        description_html,
                        description_text
                    ) VALUES (
                        :media_id,
                        :podcast_id,
                        '2026-03-22T00:00:00Z',
                        180,
                        '<p>Episode HTML description</p>',
                        'Episode text description'
                    )
                """),
                {
                    "media_id": media_id,
                    "podcast_id": podcast_id,
                },
            )
            add_test_podcast_episode_identity(
                session,
                podcast_id=podcast_id,
                media_id=media_id,
                value=episode_ref,
            )
            session.execute(
                text("""
                    INSERT INTO media_transcript_states (
                        media_id,
                        transcript_state,
                        transcript_coverage,
                        semantic_status,
                        transcript_origin
                    ) VALUES (
                        :media_id,
                        'ready',
                        'full',
                        'ready',
                        'Generated'
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
            add_test_podcast_subscription(
                session,
                user_id=user_id,
                podcast_id=podcast_id,
                default_playback_speed=1.5,
                pause_shortening_mode="Natural",
            )
            session.execute(
                text("""
                    INSERT INTO podcast_listening_states (
                        user_id,
                        media_id,
                        position_ms,
                        duration_ms,
                        playback_speed,
                        is_completed,
                        last_engaged_at
                    ) VALUES (
                        :user_id,
                        :media_id,
                        12000,
                        180000,
                        1.25,
                        false,
                        now()
                    )
                """),
                {"user_id": user_id, "media_id": media_id},
            )
            # Read-state for podcast episodes derives purely from the listening
            # threshold (position > 0 -> in_progress); no separate session/ledger
            # row is needed.
            add_media_to_library(session, UUID(library_id), media_id)
            add_media_to_library(session, named_library_id, media_id)
            session.commit()

        direct_db.register_cleanup("libraries", "id", named_library_id)
        direct_db.register_cleanup("memberships", "library_id", named_library_id)
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

        default_response = _list_library_entries(auth_client, user_id, library_id)

        assert default_response.status_code == 200
        default_rows = _entry_items(default_response)
        assert [row for row in default_rows if row["kind"] == "media"] == []
        podcast_rows = [row for row in default_rows if row["kind"] == "podcast"]
        assert [row["podcast"]["id"] for row in podcast_rows] == [str(podcast_id)]
        assert podcast_rows[0]["subscription"]["value"]["defaultPlaybackSpeed"] == {
            "kind": "Present",
            "value": 1.5,
        }
        assert podcast_rows[0]["subscription"]["value"]["pauseShorteningMode"] == {
            "kind": "Present",
            "value": "Natural",
        }

        for params in (
            {"entry_type": MediaKind.podcast_episode.value},
            {"completion": "unfinished"},
            {"projection": "in-progress"},
        ):
            filtered_default = _list_library_entries(
                auth_client,
                user_id,
                library_id,
                **params,
            )
            assert filtered_default.status_code == 200, filtered_default.text
            assert _entry_items(filtered_default) == []

        response = _list_library_entries(auth_client, user_id, str(named_library_id))
        assert response.status_code == 200
        data = _entry_items(response)
        media_rows = [row for row in data if row["kind"] == "media"]
        assert len(media_rows) == 1
        assert [row for row in data if row["kind"] == "podcast"] == []
        media_row = media_rows[0]
        media = media_row["media"]
        assert media["id"] == str(media_id)
        assert media["read_state"] == "in_progress"
        assert media["progress_fraction"] == pytest.approx(12000 / 180000)
        assert "read_state" not in media_row
        assert "progress_fraction" not in media_row
        assert media_row["readingTimeEstimate"] == {"kind": "Absent"}
        assert {
            "transcript_state",
            "transcript_coverage",
            "description_html",
            "description_text",
            "listening_state",
            "playerDescriptor",
            "chapters",
        }.isdisjoint(media)

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
        assert _entry_cursor(response) is None
        data = _entry_items(response)
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
        assert _library_entry_media_ids(_entry_items(first)) == [
            str(media_ids[2]),
            str(media_ids[1]),
        ]
        cursor = _entry_cursor(first)
        revision = _entry_revision(first)
        assert cursor is not None

        second = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            limit=2,
            cursor=cursor,
            collection_revision=revision,
        )
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(_entry_items(second)) == [str(media_ids[0])]
        assert _entry_cursor(second) is None
        assert _entry_revision(second) == revision

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
        cursor = _entry_cursor(first)
        assert cursor is not None

        response = _list_library_entries(
            auth_client,
            user_id,
            library_b,
            limit=1,
            cursor=cursor,
            collection_revision=_entry_revision(first),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_media_default_mutation_invalidates_continuation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A production filing bumps LibraryEntries and rejects a stale drain."""
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
        assert _library_entry_media_ids(_entry_items(first)) == [
            str(media_ids[2]),
            str(media_ids[1]),
        ]
        cursor = _entry_cursor(first)
        revision = _entry_revision(first)
        assert cursor is not None

        # Mutate through the production owner so the collection epoch advances.
        with direct_db.session() as session:
            newest_media_id = create_test_media(session, title="Filed after page 1")
            library_entries.ensure_media_in_default_library(session, user_id, newest_media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", newest_media_id)
        direct_db.register_cleanup("media", "id", newest_media_id)

        second = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            limit=2,
            cursor=cursor,
            collection_revision=revision,
        )
        assert second.status_code == 409, second.text
        assert second.json()["error"]["code"] == "E_COLLECTION_CHANGED"

        refreshed = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert refreshed.status_code == 200, refreshed.text
        assert _library_entry_media_ids(_entry_items(refreshed)) == [
            str(newest_media_id),
            str(media_ids[2]),
        ]

    def test_list_media_non_default_mutation_invalidates_continuation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """A production filing invalidates a named-library continuation."""
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

        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        assert _library_entry_media_ids(_entry_items(first)) == [
            str(media_ids[0]),
            str(media_ids[1]),
        ]
        cursor = _entry_cursor(first)
        revision = _entry_revision(first)
        assert cursor is not None

        with direct_db.session() as session:
            newest_media_id = create_test_media(session, title="Filed during drain")
            library_entries.ensure_media_in_default_library(session, user_id, newest_media_id)
            session.commit()
            library_entries.ensure_media_in_library(
                session,
                user_id,
                library_id,
                newest_media_id,
            )
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", newest_media_id)
        direct_db.register_cleanup("media", "id", newest_media_id)

        second = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            limit=2,
            cursor=cursor,
            collection_revision=revision,
        )
        assert second.status_code == 409, second.text
        assert second.json()["error"]["code"] == "E_COLLECTION_CHANGED"

        refreshed = _list_library_entries(auth_client, user_id, library_id, limit=4)
        assert refreshed.status_code == 200, refreshed.text
        assert _library_entry_media_ids(_entry_items(refreshed))[-1] == str(newest_media_id)

    def test_list_media_non_default_position_excludes_tombstoned_media_at_page_boundary(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """F4: a non-default member library's canonical (position-order) page filters to
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

        first = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert first.status_code == 200, first.text
        # A full page of 2 VISIBLE entries — the tombstoned one is skipped
        # entirely, not counted toward the page and then silently dropped.
        assert _library_entry_media_ids(_entry_items(first)) == [
            str(media_ids[0]),
            str(media_ids[2]),
        ]
        cursor = _entry_cursor(first)
        revision = _entry_revision(first)
        assert cursor is not None

        second = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            limit=2,
            cursor=cursor,
            collection_revision=revision,
        )
        assert second.status_code == 200, second.text
        assert _library_entry_media_ids(_entry_items(second)) == [str(media_ids[3])]
        assert _entry_cursor(second) is None

        # The tombstoned entry never surfaces on any page.
        assert str(tombstoned_media_id) not in _library_entry_media_ids(
            _entry_items(first)
        ) and str(tombstoned_media_id) not in _library_entry_media_ids(_entry_items(second))

    def test_list_media_rejects_invalid_cursor(self, auth_client):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        current = _list_library_entries(auth_client, user_id, library_id)
        assert current.status_code == 200, current.text

        response = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            cursor="not-a-cursor",
            collection_revision=_entry_revision(current),
        )

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
        """A canonical-view cursor is bound to the exact view; replaying it under
        a factual sort (cross-sort reuse) fails E_INVALID_CURSOR."""
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

        first = _list_library_entries(auth_client, user_id, library_id, limit=1)
        assert first.status_code == 200, first.text
        cursor = _entry_cursor(first)
        assert cursor is not None

        response = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            sort="title",
            direction="asc",
            cursor=cursor,
            collection_revision=_entry_revision(first),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"


class TestDefaultLibraryVirtualView:
    """Default's live, deduplicated "personal All" virtual read surface (spec
    S4.1/S4.2, AC2/AC6/AC7): direct+shared dedupe, tombstone hiding,
    system-library exclusion, and cursor scoping. Replaces the deleted
    closure/intrinsic materialization tests — there is no provenance table to
    assert on anymore, only the live query's observable behavior."""

    def test_active_subscription_subsumes_episode_roots_for_viewer_and_count(
        self, auth_client, direct_db: DirectSessionManager
    ):
        subscribed_viewer = create_test_user_id()
        unsubscribed_viewer = create_test_user_id()
        subscribed_default = UUID(_default_library_id(auth_client, subscribed_viewer))
        unsubscribed_default = UUID(_default_library_id(auth_client, unsubscribed_viewer))
        podcast_id, episode_ids = _seed_podcast_episode_roots(
            direct_db,
            library_ids=[subscribed_default, unsubscribed_default],
            episode_count=3,
        )
        standalone_ids = [
            _create_default_media(
                direct_db,
                str(subscribed_default),
                title=f"Standalone Root {index}",
            )
            for index in range(4)
        ]

        with direct_db.session() as session:
            add_test_podcast_subscription(
                session,
                user_id=subscribed_viewer,
                podcast_id=podcast_id,
            )
            session.commit()
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)

        exhausted_rows: list[dict] = []
        cursor = None
        revision = None
        page_count = 0
        for _ in range(10):
            subscribed = _list_library_entries(
                auth_client,
                subscribed_viewer,
                str(subscribed_default),
                limit=2,
                **(
                    {"cursor": cursor, "collection_revision": revision}
                    if cursor is not None
                    else {}
                ),
            )
            assert subscribed.status_code == 200, subscribed.text
            exhausted_rows.extend(_entry_items(subscribed))
            page_count += 1
            revision = _entry_revision(subscribed)
            cursor = _entry_cursor(subscribed)
            if cursor is None:
                break

        exhausted_roots = [
            (
                row["kind"],
                row["media"]["id"] if row["kind"] == "media" else row["podcast"]["id"],
            )
            for row in exhausted_rows
        ]
        expected_roots = {
            *(("media", str(media_id)) for media_id in standalone_ids),
            ("podcast", str(podcast_id)),
        }
        assert page_count > 1
        assert cursor is None
        assert set(exhausted_roots) == expected_roots
        assert len(exhausted_roots) == len(set(exhausted_roots))
        assert not (
            {str(media_id) for media_id in episode_ids}
            & {target_id for kind, target_id in exhausted_roots if kind == "media"}
        )

        unfiled = _list_library_entries(
            auth_client,
            subscribed_viewer,
            str(subscribed_default),
            projection="unfiled",
        )
        assert unfiled.status_code == 200, unfiled.text
        unfiled_rows = _entry_items(unfiled)
        assert {row["media"]["id"] for row in unfiled_rows if row["kind"] == "media"} == {
            str(media_id) for media_id in standalone_ids
        }
        assert [row for row in unfiled_rows if row["kind"] == "podcast"] == []

        podcast_only = _list_library_entries(
            auth_client,
            subscribed_viewer,
            str(subscribed_default),
            entry_type="podcast",
        )
        assert podcast_only.status_code == 200, podcast_only.text
        podcast_rows = _entry_items(podcast_only)
        assert len(podcast_rows) == 1
        assert podcast_rows[0]["kind"] == "podcast"
        assert podcast_rows[0]["podcast"]["id"] == str(podcast_id)

        unsubscribed = _list_library_entries(
            auth_client,
            unsubscribed_viewer,
            str(unsubscribed_default),
        )
        assert unsubscribed.status_code == 200, unsubscribed.text
        unsubscribed_rows = _entry_items(unsubscribed)
        assert set(_library_entry_media_ids(unsubscribed_rows)) == {
            str(media_id) for media_id in episode_ids
        }
        assert [row for row in unsubscribed_rows if row["kind"] == "podcast"] == []

        with direct_db.session() as session:
            assert library_entries.count_default_root_inventory(
                session,
                viewer_id=subscribed_viewer,
                library_id=subscribed_default,
            ) == len(exhausted_roots)
            assert library_entries.count_default_root_inventory(
                session,
                viewer_id=unsubscribed_viewer,
                library_id=unsubscribed_default,
            ) == len(episode_ids)

    def test_direct_and_shared_media_appears_once_preferring_direct_entry(
        self, auth_client, direct_db: DirectSessionManager, _sharing_entitled
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
            "/libraries", json=_library_create_body("Shared"), headers=auth_headers(owner_id)
        )
        shared_library_id = lib_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(viewer_id))
        invite_resp = auth_client.post(
            f"/libraries/{shared_library_id}/invites",
            json={"invitee": _user_invitee(viewer_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        invitation_handle = invite_resp.json()["data"]["invitationHandle"]
        accept_resp = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept", headers=auth_headers(viewer_id)
        )
        assert accept_resp.status_code == 200
        add_resp = auth_client.post(
            f"/media/{media_id}/libraries",
            json={"library_ids": [str(shared_library_id)]},
            headers=auth_headers(owner_id),
        )
        assert add_resp.status_code == 204

        viewer_default_id = auth_client.get("/me", headers=auth_headers(viewer_id)).json()["data"][
            "default_library_id"
        ]

        # Sanity: shared-only membership already surfaces it once in Default.
        shared_only = _list_library_entries(auth_client, viewer_id, viewer_default_id)
        assert _library_entry_media_ids(_entry_items(shared_only)) == [str(media_id)]

        # Direct: viewer also files it directly into their own Default.
        with direct_db.session() as session:
            library_entries.ensure_media_in_default_library(session, viewer_id, media_id)
            session.commit()

        response = _list_library_entries(auth_client, viewer_id, viewer_default_id)
        assert response.status_code == 200
        data = _entry_items(response)
        assert _library_entry_media_ids(data) == [str(media_id)]
        assert data[0]["placement"] == {"kind": "Absent"}

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

        with direct_db.session() as session:
            library_entries.ensure_media_in_default_library(session, user_id, media_id)
            session.commit()
        assert str(media_id) in _library_entry_media_ids(
            _entry_items(_list_library_entries(auth_client, user_id, library_id))
        )

        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO user_media_deletions (user_id, media_id) VALUES (:uid, :mid)"),
                {"uid": user_id, "mid": media_id},
            )
            session.commit()

        response = _list_library_entries(auth_client, user_id, library_id)
        assert response.status_code == 200
        assert str(media_id) not in _library_entry_media_ids(_entry_items(response))

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
        assert str(media_id) not in _library_entry_media_ids(_entry_items(before))

        with direct_db.session() as session:
            library_entries.ensure_media_in_default_library(session, user_id, media_id)
            session.commit()

        after = _list_library_entries(auth_client, user_id, library_id)
        assert after.status_code == 200
        assert _library_entry_media_ids(_entry_items(after)).count(str(media_id)) == 1

    def test_default_cursor_rejects_cross_scope(self, auth_client, direct_db: DirectSessionManager):
        """A Default v2 cursor is bound to the exact (viewer, library, view);
        replaying it against a different library the viewer also belongs to fails
        E_INVALID_CURSOR, and a foreign viewer is masked as not-found before the
        cursor is even reached."""
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
            "/libraries", json=_library_create_body("Other library"), headers=auth_headers(user_a)
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
        cursor = _entry_cursor(first)
        assert cursor is not None

        # Same viewer, a DIFFERENT library they also belong to.
        cross_library = _list_library_entries(
            auth_client,
            user_a,
            library_c,
            cursor=cursor,
            collection_revision=_entry_revision(first),
        )
        assert cross_library.status_code == 400
        assert cross_library.json()["error"]["code"] == "E_INVALID_CURSOR"

        # Foreign viewer, same library id is masked as not-found before the
        # cursor is even reached (viewer_b is not a member of library_a).
        cross_viewer = _list_library_entries(
            auth_client,
            user_b,
            library_a,
            cursor=cursor,
            collection_revision=_entry_revision(first),
        )
        assert cross_viewer.status_code == 404


class TestReorderLibraryMedia:
    """Tests for PATCH /libraries/{id}/entries/reorder endpoint.

    Default has no physical order to reorder — it is a live virtual view (spec
    S4.1/AC8) — so every non-rejection scenario here targets a freshly created
    non-default library; Default-targeting reorder is covered separately by
    ``test_reorder_library_entries_rejects_default`` below.
    """

    def _create_non_default_library(self, auth_client, user_id: UUID, name: str) -> str:
        resp = auth_client.post(
            "/libraries", json=_library_create_body(name), headers=auth_headers(user_id)
        )
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

        # A malformed body (wrong set) against Default still yields the Default
        # rejection, not the exact-set 400 — the guard runs first.
        response = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": [str(uuid4()), str(uuid4())]},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

        after = _entry_items(_list_library_entries(auth_client, user_id, library_id))
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
        existing_entries = _entry_items(list_resp)
        media_entry_id_by_media_id = {
            row["media"]["id"]: _entry_placement_id(row)
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
        assert reorder_resp.status_code == 204, (
            f"Expected 204 reorder response, got {reorder_resp.status_code}: {reorder_resp.text}"
        )
        assert reorder_resp.content == b""

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        assert list_resp.status_code == 200
        assert _library_entry_media_ids(_entry_items(list_resp)) == [
            str(media_id) for media_id in reordered_media_ids
        ]

        idempotent_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": reordered_entry_ids},
            headers=auth_headers(user_id),
        )
        assert idempotent_resp.status_code == 204
        assert idempotent_resp.content == b""
        assert _library_entry_media_ids(
            _entry_items(_list_library_entries(auth_client, user_id, library_id))
        ) == [str(media_id) for media_id in reordered_media_ids]

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
        existing_entries = _entry_items(list_resp)
        media_entry_id_by_media_id = {
            row["media"]["id"]: _entry_placement_id(row)
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

        first_page = _list_library_entries(auth_client, user_id, library_id, limit=2)
        assert _entry_cursor(first_page) is not None
        partial_ids = [_entry_placement_id(row) for row in _entry_items(first_page)]

        response = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": partial_ids},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_reorder_library_entries_forbids_non_admin(
        self, auth_client, direct_db: DirectSessionManager, _sharing_entitled
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(member_id))

        create_resp = auth_client.post(
            "/libraries",
            json=_library_create_body("Shared order library"),
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
            json={"invitee": _user_invitee(member_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert invite_resp.status_code == 201
        invitation_handle = invite_resp.json()["data"]["invitationHandle"]
        accept_resp = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(member_id),
        )
        assert accept_resp.status_code == 200

        list_resp = _list_library_entries(auth_client, owner_id, library_id)
        existing_entries = _entry_items(list_resp)
        media_entry_id_by_media_id = {
            row["media"]["id"]: _entry_placement_id(row)
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
            "/libraries", json=_library_create_body("Mixed order"), headers=auth_headers(user_id)
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
            add_test_podcast_subscription(session, user_id=user_id, podcast_id=podcast_id)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)

        placement = _file_podcast_in_libraries(
            auth_client,
            user_id,
            podcast_id,
            [UUID(library_id)],
        )
        assert placement.status_code == 200, placement.text

        entries = _entry_items(_list_library_entries(auth_client, user_id, library_id))
        media_entry_id = next(
            row["placement"]["value"]["libraryEntryId"] for row in entries if row["kind"] == "media"
        )
        podcast_entry_id = next(
            row["placement"]["value"]["libraryEntryId"]
            for row in entries
            if row["kind"] == "podcast"
        )

        reorder_resp = auth_client.patch(
            f"/libraries/{library_id}/entries/reorder",
            json={"entry_ids": [podcast_entry_id, media_entry_id]},
            headers=auth_headers(user_id),
        )
        assert reorder_resp.status_code == 204, reorder_resp.text
        assert reorder_resp.content == b""

        after = _entry_items(_list_library_entries(auth_client, user_id, library_id))
        assert [row["placement"]["value"]["libraryEntryId"] for row in after] == [
            podcast_entry_id,
            media_entry_id,
        ]
        assert [row["placement"]["value"]["position"] for row in after] == [0, 1]

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

        entries = _entry_items(_list_library_entries(auth_client, user_id, library_id))
        entry_id_a = next(
            _entry_placement_id(row)
            for row in entries
            if row["media"] and row["media"]["id"] == str(media_a)
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

        after = _entry_items(_list_library_entries(auth_client, user_id, library_id))
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
            "/libraries", json=_library_create_body("Test Lib"), headers=auth_headers(user_id)
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
            "/libraries", json=_library_create_body("Private"), headers=auth_headers(user_a)
        )
        library_id = create_resp.json()["data"]["id"]

        # Bootstrap user_b
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/libraries/{library_id}", headers=auth_headers(user_b))
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_get_library_non_owner_admin_cannot_transfer_ownership(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Shared"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                """),
                {"library_id": library_id, "user_id": admin_id},
            )
            session.commit()

        response = auth_client.get(f"/libraries/{library_id}", headers=auth_headers(admin_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["canManageMembers"] is True
        assert data["canDelete"] is False
        assert data["canTransferOwnership"] is False


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
            "/libraries", json=_library_create_body("Shared"), headers=auth_headers(owner_id)
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
        assert response.status_code == 200
        assert response.json()["data"]["libraryId"] == library_id
        assert response.json()["data"]["collectionRevision"] >= 1

    def test_delete_library_non_owner_admin_returns_owner_required(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-owner admin gets 403 E_OWNER_REQUIRED."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Shared"), headers=auth_headers(owner_id)
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
            "/libraries", json=_library_create_body("Private"), headers=auth_headers(owner_id)
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

    def test_list_members_admin_success_ordered_by_immutable_user_id(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Members are listed in the indexed immutable user-id order."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
        assert [unseal_user(row["userHandle"]) for row in data] == sorted(
            [owner_id, admin_id, member_id]
        )
        rows_by_user = {unseal_user(row["userHandle"]): row for row in data}
        assert rows_by_user[owner_id]["isOwner"] is True
        assert rows_by_user[owner_id]["role"] == "admin"
        assert rows_by_user[admin_id]["isOwner"] is False
        assert rows_by_user[admin_id]["role"] == "admin"
        assert rows_by_user[member_id]["isOwner"] is False
        assert rows_by_user[member_id]["role"] == "member"
        assert response.json()["page"] == {"nextCursor": {"kind": "Absent"}}

    def test_list_members_limit_and_clamp(self, auth_client, direct_db: DirectSessionManager):
        """Limit parameter works and clamps to 200."""
        owner_id = create_test_user_id()
        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.get(
            f"/libraries/{library_id}/members?limit=1", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1
        assert response.json()["page"] == {"nextCursor": {"kind": "Absent"}}

    def test_list_members_non_admin_member_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-admin member gets 403."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            "/libraries", json=_library_create_body("Private"), headers=auth_headers(owner_id)
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
        assert unseal_user(data[0]["userHandle"]) == user_id

    def test_list_members_reaches_more_than_200_exactly_once(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        library_response = auth_client.post(
            "/libraries",
            json=_library_create_body("Large team"),
            headers=auth_headers(owner_id),
        )
        library_id = library_response.json()["data"]["id"]
        member_ids = [uuid4() for _ in range(205)]
        marker = f"member-page-{uuid4()}"
        direct_db.register_cleanup("users", "display_name", marker)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO users (id, display_name) VALUES (:id, :marker)"),
                [{"id": user_id, "marker": marker} for user_id in member_ids],
            )
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'member')
                """),
                [{"library_id": library_id, "user_id": user_id} for user_id in member_ids],
            )
            session.commit()

        seen: list[UUID] = []
        cursor: str | None = None
        while True:
            params = {"limit": 73}
            if cursor is not None:
                params["cursor"] = cursor
            response = auth_client.get(
                f"/libraries/{library_id}/members",
                params=params,
                headers=auth_headers(owner_id),
            )
            assert response.status_code == 200
            body = response.json()
            seen.extend(unseal_user(row["userHandle"]) for row in body["data"])
            next_cursor = body["page"]["nextCursor"]
            if next_cursor["kind"] == "Absent":
                break
            cursor = next_cursor["value"]

        expected = sorted([owner_id, *member_ids])
        assert seen == expected
        assert len(seen) == len(set(seen)) == 206

    def test_list_members_rejects_malformed_and_wrong_scope_cursors(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        library_response = auth_client.post(
            "/libraries",
            json=_library_create_body("Cursor scope"),
            headers=auth_headers(owner_id),
        )
        library_id = library_response.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(admin_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :admin_id, 'admin')
                """),
                {"library_id": library_id, "admin_id": admin_id},
            )
            session.commit()

        first = auth_client.get(
            f"/libraries/{library_id}/members?limit=1",
            headers=auth_headers(owner_id),
        )
        cursor = first.json()["page"]["nextCursor"]["value"]

        wrong_viewer = auth_client.get(
            f"/libraries/{library_id}/members",
            params={"cursor": cursor},
            headers=auth_headers(admin_id),
        )
        assert wrong_viewer.status_code == 400
        assert wrong_viewer.json()["error"]["code"] == "E_INVALID_CURSOR"

        malformed = auth_client.get(
            f"/libraries/{library_id}/members",
            params={"cursor": f"{cursor}!"},
            headers=auth_headers(owner_id),
        )
        assert malformed.status_code == 400
        assert malformed.json()["error"]["code"] == "E_INVALID_CURSOR"

        other_library = auth_client.post(
            "/libraries",
            json=_library_create_body("Other scope"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        wrong_library = auth_client.get(
            f"/libraries/{other_library}/members",
            params={"cursor": cursor},
            headers=auth_headers(owner_id),
        )
        assert wrong_library.status_code == 400
        assert wrong_library.json()["error"]["code"] == "E_INVALID_CURSOR"


class TestUpdateMemberRole:
    """Tests for PATCH /libraries/{id}/members/{user_handle} endpoint."""

    def test_patch_member_role_promote_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can promote member to admin."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        member_email = f"hydrated-{member_id}@example.com"

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        member_headers = auth_headers(member_id, email=member_email)
        auth_client.get("/me", headers=member_headers)
        auth_client.patch("/me", json={"display_name": "Hydrated Member"}, headers=member_headers)
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
            f"/libraries/{library_id}/members/{_user_handle(member_id)}",
            json={"role": "admin"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["role"] == "admin"
        assert unseal_user(data["userHandle"]) == member_id
        assert data["email"] == {"kind": "Present", "value": member_email}
        assert data["displayName"] == {"kind": "Present", "value": "Hydrated Member"}

    def test_patch_member_role_idempotent_no_change(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Setting same role is idempotent."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        member_email = f"idempotent-{member_id}@example.com"

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(member_id, email=member_email))
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
            f"/libraries/{library_id}/members/{_user_handle(member_id)}",
            json={"role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["role"] == "member"
        assert data["email"] == {"kind": "Present", "value": member_email}
        assert data["displayName"] == {"kind": "Absent"}

    def test_patch_member_role_non_admin_member_forbidden(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-admin member cannot change roles."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        target_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(target_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
            json={"role": "member"},
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_patch_member_role_target_missing_not_found(self, auth_client):
        """Target member not found returns 404 E_NOT_FOUND."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{_user_handle(uuid4())}",
            json={"role": "admin"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_patch_member_role_owner_self_demotion_forbidden_owner_exit(self, auth_client):
        """Owner cannot self-demote."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.patch(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(admin_id)}",
            json={"role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["role"] == "member"
        assert unseal_user(data["userHandle"]) == admin_id

    def test_patch_member_role_default_library_forbidden(self, auth_client):
        """Cannot change roles in default library."""
        user_id = create_test_user_id()
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = me_resp.json()["data"]["default_library_id"]

        response = auth_client.patch(
            f"/libraries/{default_library_id}/members/{_user_handle(user_id)}",
            json={"role": "member"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"


class TestRemoveMember:
    """Tests for DELETE /libraries/{id}/members/{user_handle} endpoint."""

    def test_delete_member_success(self, auth_client, direct_db: DirectSessionManager):
        """Admin can remove a member."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(member_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(uuid4())}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(target_id)}",
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_delete_member_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Private"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
            headers=auth_headers(outsider_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_delete_member_owner_self_removal_forbidden_owner_exit(self, auth_client):
        """Owner cannot self-remove."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(admin_id)}",
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
            f"/libraries/{default_library_id}/members/{_user_handle(user_id)}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"


# =============================================================================
# Ownership Transfer
# =============================================================================


class TestTransferOwnership:
    """Tests for POST /libraries/{id}/transfer-ownership endpoint."""

    def test_transfer_rejects_snake_case_user_handle_alias(self, auth_client):
        viewer_id = create_test_user_id()

        response = auth_client.post(
            f"/libraries/{uuid4()}/transfer-ownership",
            json={
                "new_owner_user_handle": _user_handle(
                    create_test_user_id(),
                )
            },
            headers=auth_headers(viewer_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_transfer_ownership_success_promotes_target_to_admin_and_preserves_previous_owner_admin(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Owner transfers to member; target promoted to admin, previous owner stays admin."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"newOwnerUserHandle": _user_handle(member_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert unseal_user(data["ownerUserHandle"]) == member_id
        assert data["canDelete"] is False
        assert data["canTransferOwnership"] is False

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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"newOwnerUserHandle": _user_handle(owner_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        assert unseal_user(response.json()["data"]["ownerUserHandle"]) == owner_id

    def test_transfer_ownership_non_owner_admin_owner_required(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Non-owner admin gets E_OWNER_REQUIRED."""
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"newOwnerUserHandle": _user_handle(admin_id)},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"newOwnerUserHandle": _user_handle(member_id)},
            headers=auth_headers(member_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_OWNER_REQUIRED"

    def test_transfer_ownership_non_member_masked_not_found(self, auth_client):
        """Non-member gets masked 404."""
        owner_id = create_test_user_id()
        outsider_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"newOwnerUserHandle": _user_handle(owner_id)},
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
            json={"newOwnerUserHandle": _user_handle(uuid4())},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_transfer_ownership_target_non_member_invalid(self, auth_client):
        """Transfer to non-member returns E_OWNERSHIP_TRANSFER_INVALID."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/transfer-ownership",
            json={"newOwnerUserHandle": _user_handle(uuid4())},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        original_updated_at = create_resp.json()["data"]["updatedAt"]

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
            json={"newOwnerUserHandle": _user_handle(member_id)},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 200
        new_updated_at = response.json()["data"]["updatedAt"]
        assert new_updated_at >= original_updated_at

    def test_transfer_then_previous_owner_exit_path_allowed(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """After transfer, previous owner can be demoted/removed."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"newOwnerUserHandle": _user_handle(member_id)},
            headers=auth_headers(owner_id),
        )

        # New owner can now remove previous owner
        response = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(owner_id)}",
            headers=auth_headers(member_id),
        )
        assert response.status_code == 204


# =============================================================================
# Governance Command Races
# =============================================================================


@pytest.mark.usefixtures("_sharing_entitled")
class TestGovernanceCommandRaces:
    def test_role_update_vs_remove_has_one_serializable_outcome(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Role remove race"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(member_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :member_id, 'member')
                """),
                {"library_id": library_id, "member_id": member_id},
            )
            session.commit()

        update, remove = _run_concurrently(
            lambda: auth_client.patch(
                f"/libraries/{library_id}/members/{_user_handle(member_id)}",
                json={"role": "admin"},
                headers=auth_headers(owner_id),
            ),
            lambda: auth_client.delete(
                f"/libraries/{library_id}/members/{_user_handle(member_id)}",
                headers=auth_headers(owner_id),
            ),
        )

        assert (update.status_code, remove.status_code) in {(200, 204), (404, 204)}
        with direct_db.session() as session:
            assert (
                session.execute(
                    text("""
                        SELECT 1 FROM memberships
                        WHERE library_id = :library_id AND user_id = :member_id
                    """),
                    {"library_id": library_id, "member_id": member_id},
                ).fetchone()
                is None
            )

    @pytest.mark.parametrize("competing_command", ["remove", "demote"])
    def test_transfer_vs_target_mutation_preserves_owner_invariant(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        competing_command: str,
    ):
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        target_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body(f"Transfer {competing_command} race"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(admin_id))
        auth_client.get("/me", headers=auth_headers(target_id))
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES
                        (:library_id, :admin_id, 'admin'),
                        (:library_id, :target_id, :target_role)
                """),
                {
                    "library_id": library_id,
                    "admin_id": admin_id,
                    "target_id": target_id,
                    "target_role": ("admin" if competing_command == "demote" else "member"),
                },
            )
            session.commit()

        def mutate_target():
            if competing_command == "remove":
                return auth_client.delete(
                    f"/libraries/{library_id}/members/{_user_handle(target_id)}",
                    headers=auth_headers(admin_id),
                )
            return auth_client.patch(
                f"/libraries/{library_id}/members/{_user_handle(target_id)}",
                json={"role": "member"},
                headers=auth_headers(admin_id),
            )

        transfer, mutation = _run_concurrently(
            lambda: auth_client.post(
                f"/libraries/{library_id}/transfer-ownership",
                json={"newOwnerUserHandle": _user_handle(target_id)},
                headers=auth_headers(owner_id),
            ),
            mutate_target,
        )

        if competing_command == "remove":
            assert (transfer.status_code, mutation.status_code) in {
                (200, 403),
                (409, 204),
            }
        else:
            assert (transfer.status_code, mutation.status_code) in {
                (200, 200),
                (200, 403),
            }

        with direct_db.session() as session:
            library_owner = session.execute(
                text("SELECT owner_user_id FROM libraries WHERE id = :library_id"),
                {"library_id": library_id},
            ).scalar_one()
            owner_membership = session.execute(
                text("""
                    SELECT role FROM memberships
                    WHERE library_id = :library_id AND user_id = :owner_id
                """),
                {"library_id": library_id, "owner_id": library_owner},
            ).scalar_one()
        assert owner_membership == "admin"

    def test_accept_vs_revoke_has_one_serializable_terminal_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Accept revoke race"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        invitation_handle = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        ).json()["data"]["invitationHandle"]

        accept, revoke = _run_concurrently(
            lambda: auth_client.post(
                f"/libraries/invites/{invitation_handle}/accept",
                headers=auth_headers(invitee_id),
            ),
            lambda: auth_client.delete(
                f"/libraries/invites/{invitation_handle}",
                headers=auth_headers(owner_id),
            ),
        )

        assert (accept.status_code, revoke.status_code) in {(200, 409), (409, 204)}
        with direct_db.session() as session:
            status = session.execute(
                text("SELECT status FROM library_invitations WHERE id = :invitation_id"),
                {"invitation_id": unseal_library_invitation(invitation_handle)},
            ).scalar_one()
            membership = session.execute(
                text("""
                    SELECT 1 FROM memberships
                    WHERE library_id = :library_id AND user_id = :invitee_id
                """),
                {"library_id": library_id, "invitee_id": invitee_id},
            ).fetchone()
        assert (status, membership is not None) in {
            ("accepted", True),
            ("revoked", False),
        }


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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            f"/libraries/{library_id}/members/{_user_handle(member_id)}",
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
            "/libraries",
            json=_library_create_body("User A's Library"),
            headers=auth_headers(user_a),
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
            "/libraries",
            json=_library_create_body("User A's Library"),
            headers=auth_headers(user_a),
        )
        library_id = create_resp.json()["data"]["id"]

        # User B lists their libraries
        list_resp = auth_client.get("/libraries", headers=auth_headers(user_b))

        library_ids = [lib["id"] for lib in list_resp.json()["data"]["items"]]
        assert library_id not in library_ids


# =============================================================================
# V1-V6 Visibility Closure Tests (from spec)
# =============================================================================


# =============================================================================
# Invitation Lifecycle Tests
# =============================================================================


@pytest.mark.usefixtures("_sharing_entitled")
class TestLibraryInviteCreateList:
    """Tests for POST /libraries/{library_id}/invites and GET invite list endpoints."""

    def test_create_invite_success_returns_201(self, auth_client, direct_db: DirectSessionManager):
        """Admin creates invite for existing non-member user; returns 201."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        # Bootstrap invitee
        auth_client.get("/me", headers=auth_headers(invitee_id))

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["status"] == "pending"
        assert unseal_user(data["inviteeUserHandle"]) == invitee_id
        assert unseal_user(data["inviterUserHandle"]) == owner_id
        assert data["libraryId"] == library_id
        assert data["role"] == "member"
        assert data["respondedAt"] == {"kind": "Absent"}
        assert data["inviteeEmail"] == {"kind": "Absent"}
        assert data["inviteeDisplayName"] == {"kind": "Absent"}

    def test_create_invite_rejects_snake_case_user_handle_alias(self, auth_client):
        owner_id = create_test_user_id()

        response = auth_client.post(
            f"/libraries/{uuid4()}/invites",
            json={
                "invitee": {
                    "kind": "User",
                    "user_handle": _user_handle(create_test_user_id()),
                },
                "role": "member",
            },
            headers=auth_headers(owner_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_create_invite_non_admin_forbidden(self, auth_client, direct_db: DirectSessionManager):
        """Non-admin member cannot create invites."""
        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(outsider_id))
        auth_client.get("/me", headers=auth_headers(invitee_id))

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
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
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DEFAULT_LIBRARY_FORBIDDEN"

    def test_create_invite_user_not_found(self, auth_client):
        """Invite for non-existent user returns 404 E_USER_NOT_FOUND."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(uuid4()), "role": "member"},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
            json={"invitee": _user_invitee(member_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_MEMBER_EXISTS"

    def test_create_invite_self_conflicts_as_member_exists(self, auth_client):
        """Self-invite is caught by membership check (owner is a member)."""
        owner_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        response = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(owner_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_MEMBER_EXISTS"

    def test_create_invite_pending_duplicate_conflict(self, auth_client):
        """Creating a second pending invite for the same invitee returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        # First invite
        resp1 = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp1.status_code == 201

        # Second invite — duplicate
        resp2 = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "admin"},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_a))
        auth_client.get("/me", headers=auth_headers(invitee_b))

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_a), "role": "member"},
            headers=auth_headers(owner_id),
        )
        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_b), "role": "member"},
            headers=auth_headers(owner_id),
        )

        response = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(owner_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 2
        # DESC order: last created first
        assert data[0]["createdAt"] >= data[1]["createdAt"]
        for inv in data:
            assert inv["libraryId"] == library_id
            assert inv["status"] == "pending"
            assert inv["inviteeEmail"] == {"kind": "Absent"}
            assert inv["inviteeDisplayName"] == {"kind": "Absent"}
            assert inv["respondedAt"] == {"kind": "Absent"}
        assert response.json()["page"] == {"nextCursor": {"kind": "Absent"}}

    def test_list_library_invites_status_filter_default_pending(self, auth_client):
        """Default status filter is pending."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(invitee_id))

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        # Decline the invite
        list_resp = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(owner_id)
        )
        invitation_handle = list_resp.json()["data"][0]["invitationHandle"]
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline", headers=auth_headers(invitee_id)
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(outsider_id))

        response = auth_client.get(
            f"/libraries/{library_id}/invites", headers=auth_headers(outsider_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"

    def test_list_library_invites_reaches_more_than_200_exactly_once(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Large invite set"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        invitee_ids = [uuid4() for _ in range(205)]
        marker = f"invite-page-{uuid4()}"
        direct_db.register_cleanup("users", "display_name", marker)
        direct_db.register_cleanup("library_invitations", "library_id", library_id)
        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO users (id, display_name) VALUES (:id, :marker)"),
                [{"id": user_id, "marker": marker} for user_id in invitee_ids],
            )
            session.execute(
                text("""
                    INSERT INTO library_invitations
                        (library_id, inviter_user_id, invitee_user_id, role, status)
                    VALUES
                        (:library_id, :owner_id, :invitee_id, 'member', 'pending')
                """),
                [
                    {
                        "library_id": library_id,
                        "owner_id": owner_id,
                        "invitee_id": invitee_id,
                    }
                    for invitee_id in invitee_ids
                ],
            )
            expected_ids = [
                row[0]
                for row in session.execute(
                    text("""
                        SELECT id
                        FROM library_invitations
                        WHERE library_id = :library_id AND status = 'pending'
                        ORDER BY created_at DESC, id DESC
                    """),
                    {"library_id": library_id},
                )
            ]
            session.commit()

        seen: list[UUID] = []
        cursor: str | None = None
        while True:
            params = {"status": "pending", "limit": 71}
            if cursor is not None:
                params["cursor"] = cursor
            response = auth_client.get(
                f"/libraries/{library_id}/invites",
                params=params,
                headers=auth_headers(owner_id),
            )
            assert response.status_code == 200
            body = response.json()
            seen.extend(unseal_library_invitation(row["invitationHandle"]) for row in body["data"])
            next_cursor = body["page"]["nextCursor"]
            if next_cursor["kind"] == "Absent":
                break
            cursor = next_cursor["value"]

        assert seen == expected_ids
        assert len(seen) == len(set(seen)) == 205

    def test_list_library_invites_rejects_malformed_and_wrong_scope_cursors(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        owner_id = create_test_user_id()
        admin_id = create_test_user_id()
        invitee_ids = [create_test_user_id(), create_test_user_id()]
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Invite cursor scope"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(admin_id))
        for invitee_id in invitee_ids:
            auth_client.get("/me", headers=auth_headers(invitee_id))
            created = auth_client.post(
                f"/libraries/{library_id}/invites",
                json={"invitee": _user_invitee(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            )
            assert created.status_code == 201
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :admin_id, 'admin')
                """),
                {"library_id": library_id, "admin_id": admin_id},
            )
            session.commit()

        first = auth_client.get(
            f"/libraries/{library_id}/invites?limit=1",
            headers=auth_headers(owner_id),
        )
        cursor = first.json()["page"]["nextCursor"]["value"]

        wrong_viewer = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"cursor": cursor},
            headers=auth_headers(admin_id),
        )
        assert wrong_viewer.status_code == 400
        assert wrong_viewer.json()["error"]["code"] == "E_INVALID_CURSOR"

        wrong_status = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"status": "declined", "cursor": cursor},
            headers=auth_headers(owner_id),
        )
        assert wrong_status.status_code == 400
        assert wrong_status.json()["error"]["code"] == "E_INVALID_CURSOR"

        malformed = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"cursor": f"{cursor}!"},
            headers=auth_headers(owner_id),
        )
        assert malformed.status_code == 400
        assert malformed.json()["error"]["code"] == "E_INVALID_CURSOR"

        payload = _decode_cursor_payload(cursor)
        payload["created_at"] = "2026-01-01T00:00:00"
        naive_timestamp_cursor = (
            base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
            .decode("ascii")
            .rstrip("=")
        )
        naive_timestamp = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"cursor": naive_timestamp_cursor},
            headers=auth_headers(owner_id),
        )
        assert naive_timestamp.status_code == 400
        assert naive_timestamp.json()["error"]["code"] == "E_INVALID_CURSOR"

        other_library = auth_client.post(
            "/libraries",
            json=_library_create_body("Other invite scope"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        wrong_library = auth_client.get(
            f"/libraries/{other_library}/invites",
            params={"cursor": cursor},
            headers=auth_headers(owner_id),
        )
        assert wrong_library.status_code == 400
        assert wrong_library.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_viewer_invites_success(self, auth_client):
        """Viewer can list their own pending invites across libraries."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(invitee_id))

        # Create two libraries and invite the same user
        for name in ("Lib A", "Lib B"):
            create_resp = auth_client.post(
                "/libraries", json=_library_create_body(name), headers=auth_headers(owner_id)
            )
            lib_id = create_resp.json()["data"]["id"]
            auth_client.post(
                f"/libraries/{lib_id}/invites",
                json={"invitee": _user_invitee(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            )

        response = auth_client.get("/libraries/invites", headers=auth_headers(invitee_id))
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 2
        assert {inv["libraryName"] for inv in data} == {"Lib A", "Lib B"}
        for inv in data:
            assert unseal_user(inv["inviteeUserHandle"]) == invitee_id
            assert inv["status"] == "pending"
            assert inv["inviteeEmail"] == {"kind": "Absent"}
            assert inv["inviteeDisplayName"] == {"kind": "Absent"}
            assert inv["respondedAt"] == {"kind": "Absent"}

    def test_list_viewer_invites_hydrates_present_projection(self, auth_client):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        invitee_email = f"viewer-invite-{invitee_id}@example.com"
        invitee_headers = auth_headers(invitee_id, email=invitee_email)
        auth_client.get("/me", headers=invitee_headers)
        auth_client.patch(
            "/me",
            json={"display_name": "Viewer Invitee"},
            headers=invitee_headers,
        )
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Viewer projection"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        response = auth_client.get("/libraries/invites", headers=invitee_headers)

        assert response.status_code == 200
        invite = response.json()["data"][0]
        assert invite["inviteeEmail"] == {
            "kind": "Present",
            "value": invitee_email,
        }
        assert invite["inviteeDisplayName"] == {
            "kind": "Present",
            "value": "Viewer Invitee",
        }
        assert invite["respondedAt"] == {"kind": "Absent"}

    def test_invite_page_refresh_observes_write_above_stale_cursor(self, auth_client):
        owner_id = create_test_user_id()
        invitee_ids = [create_test_user_id() for _ in range(3)]
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Invite page refresh"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        for invitee_id in invitee_ids:
            auth_client.get("/me", headers=auth_headers(invitee_id))

        handles = []
        for invitee_id in invitee_ids[:2]:
            response = auth_client.post(
                f"/libraries/{library_id}/invites",
                json={"invitee": _user_invitee(invitee_id), "role": "member"},
                headers=auth_headers(owner_id),
            )
            handles.append(response.json()["data"]["invitationHandle"])

        first = auth_client.get(
            f"/libraries/{library_id}/invites?limit=1",
            headers=auth_headers(owner_id),
        ).json()
        assert first["data"][0]["invitationHandle"] == handles[1]
        cursor = first["page"]["nextCursor"]["value"]

        created_above_cursor = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_ids[2]), "role": "member"},
            headers=auth_headers(owner_id),
        ).json()["data"]["invitationHandle"]

        continuation = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"limit": 1, "cursor": cursor},
            headers=auth_headers(owner_id),
        ).json()
        retried_continuation = auth_client.get(
            f"/libraries/{library_id}/invites",
            params={"limit": 1, "cursor": cursor},
            headers=auth_headers(owner_id),
        ).json()
        assert continuation == retried_continuation
        assert [row["invitationHandle"] for row in continuation["data"]] == [handles[0]]

        refreshed = auth_client.get(
            f"/libraries/{library_id}/invites?limit=1",
            headers=auth_headers(owner_id),
        ).json()
        assert refreshed["data"][0]["invitationHandle"] == created_above_cursor

    def test_list_viewer_invites_status_filter_and_order(self, auth_client):
        """Viewer invite list respects status filter and order."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(invitee_id))

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )

        # Accept it
        inv_resp = auth_client.get("/libraries/invites", headers=auth_headers(invitee_id))
        invitation_handle = inv_resp.json()["data"][0]["invitationHandle"]
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

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


@pytest.mark.usefixtures("_sharing_entitled")
class TestLibraryInviteAccept:
    """Tests for POST /libraries/invites/{invitation_handle}/accept endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        """Create a pending invitation and return its sealed handle."""
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["invitationHandle"]

    def test_accept_invite_happy_path_returns_200(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Invitee accepts pending invite; returns 200 with correct shape."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["invite"]["status"] == "accepted"
        assert data["invite"]["respondedAt"]["kind"] == "Present"
        assert data["invite"]["inviteeEmail"] == {"kind": "Absent"}
        assert data["invite"]["inviteeDisplayName"] == {"kind": "Absent"}
        assert data["membership"]["libraryId"] == library_id
        assert unseal_user(data["membership"]["userHandle"]) == invitee_id
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        auth_client.get("/me", headers=auth_headers(invitee_id))
        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
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
                {"iid": unseal_library_invitation(invitation_handle)},
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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
        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Before accept: shared media is absent from invitee's Default.
        before = _entry_items(_list_library_entries(auth_client, invitee_id, default_library_id))
        assert str(media_id) not in _library_entry_media_ids(before)

        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

        # Immediately after accept, with no worker/projection step run:
        # shared media appears in invitee's Default.
        after_accept = _entry_items(
            _list_library_entries(auth_client, invitee_id, default_library_id)
        )
        assert str(media_id) in _library_entry_media_ids(after_accept)

        # Owner (admin) removes the invitee from the shared library.
        response = auth_client.delete(
            f"/libraries/{library_id}/members/{_user_handle(invitee_id)}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

        # Immediately after removal, with no worker/projection step run: the
        # media is gone from invitee's Default again.
        after_removal = _entry_items(
            _list_library_entries(auth_client, invitee_id, default_library_id)
        )
        assert str(media_id) not in _library_entry_media_ids(after_removal)

    def test_accept_invite_grants_immediate_media_access_before_backfill_worker(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Invitee can read source library media immediately after accept (no backfill needed)."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]

        with direct_db.session() as session:
            media_id = create_test_media(session)
            add_media_to_library(session, UUID(library_id), media_id)
            session.commit()
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        auth_client.get("/me", headers=auth_headers(invitee_id))
        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

        # Invitee can immediately list media in the source library
        response = _list_library_entries(auth_client, invitee_id, library_id)
        assert response.status_code == 200
        media_ids = _library_entry_media_ids(_entry_items(response))
        assert str(media_id) in media_ids

    def test_accept_invite_idempotent_when_already_accepted(self, auth_client):
        """Accept on already accepted invite returns 200 idempotent no-op."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept first time
        resp1 = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )
        assert resp1.status_code == 200
        assert resp1.json()["data"]["idempotent"] is False

        # Accept second time — idempotent
        resp2 = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )
        assert resp2.status_code == 200
        data = resp2.json()["data"]
        assert data["idempotent"] is True
        assert data["invite"]["inviteeEmail"] == {"kind": "Absent"}
        assert data["invite"]["inviteeDisplayName"] == {"kind": "Absent"}
        assert data["invite"]["respondedAt"]["kind"] == "Present"

    def test_accept_invite_hydrates_present_projection_changed_and_idempotent(
        self,
        auth_client,
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        invitee_email = f"accept-present-{invitee_id}@example.com"
        invitee_headers = auth_headers(invitee_id, email=invitee_email)
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Accept projection"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=invitee_headers)
        auth_client.patch(
            "/me",
            json={"display_name": "Accepted Invitee"},
            headers=invitee_headers,
        )
        invitation_handle = self._create_invite(
            auth_client,
            owner_id,
            invitee_id,
            library_id,
        )

        first = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=invitee_headers,
        )
        second = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=invitee_headers,
        )

        assert first.status_code == second.status_code == 200
        assert first.json()["data"]["idempotent"] is False
        assert second.json()["data"]["idempotent"] is True
        for response in (first, second):
            invite = response.json()["data"]["invite"]
            assert invite["inviteeEmail"] == {
                "kind": "Present",
                "value": invitee_email,
            }
            assert invite["inviteeDisplayName"] == {
                "kind": "Present",
                "value": "Accepted Invitee",
            }
            assert invite["respondedAt"]["kind"] == "Present"

    def test_accept_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Accept on declined/revoked invite returns 409 E_INVITE_NOT_PENDING."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Decline it
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=auth_headers(invitee_id),
        )

        # Try to accept
        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        auth_client.get("/me", headers=auth_headers(other_user))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
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
            invitation_handle = _invite_handle(inv[0])

        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

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
            f"/libraries/invites/{invitation_handle}/accept",
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


@pytest.mark.usefixtures("_sharing_entitled")
class TestLibraryInviteDecline:
    """Tests for POST /libraries/invites/{invitation_handle}/decline endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["invitationHandle"]

    def test_decline_invite_pending_to_declined(self, auth_client):
        """Invitee declines pending invite; invite becomes declined."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["invite"]["status"] == "declined"
        assert data["invite"]["respondedAt"]["kind"] == "Present"
        assert data["invite"]["inviteeEmail"] == {"kind": "Absent"}
        assert data["invite"]["inviteeDisplayName"] == {"kind": "Absent"}
        assert data["idempotent"] is False

    def test_decline_invite_idempotent_when_already_declined(self, auth_client):
        """Decline on already declined invite returns 200 idempotent."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Decline first time
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=auth_headers(invitee_id),
        )

        # Decline second time
        resp2 = auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=auth_headers(invitee_id),
        )
        assert resp2.status_code == 200
        data = resp2.json()["data"]
        assert data["idempotent"] is True
        assert data["invite"]["inviteeEmail"] == {"kind": "Absent"}
        assert data["invite"]["inviteeDisplayName"] == {"kind": "Absent"}
        assert data["invite"]["respondedAt"]["kind"] == "Present"

    def test_decline_invite_hydrates_present_projection_changed_and_idempotent(
        self,
        auth_client,
    ):
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()
        invitee_email = f"decline-present-{invitee_id}@example.com"
        invitee_headers = auth_headers(invitee_id, email=invitee_email)
        library_id = auth_client.post(
            "/libraries",
            json=_library_create_body("Decline projection"),
            headers=auth_headers(owner_id),
        ).json()["data"]["id"]
        auth_client.get("/me", headers=invitee_headers)
        auth_client.patch(
            "/me",
            json={"display_name": "Declined Invitee"},
            headers=invitee_headers,
        )
        invitation_handle = self._create_invite(
            auth_client,
            owner_id,
            invitee_id,
            library_id,
        )

        first = auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=invitee_headers,
        )
        second = auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=invitee_headers,
        )

        assert first.status_code == second.status_code == 200
        assert first.json()["data"]["idempotent"] is False
        assert second.json()["data"]["idempotent"] is True
        for response in (first, second):
            invite = response.json()["data"]["invite"]
            assert invite["inviteeEmail"] == {
                "kind": "Present",
                "value": invitee_email,
            }
            assert invite["inviteeDisplayName"] == {
                "kind": "Present",
                "value": "Declined Invitee",
            }
            assert invite["respondedAt"]["kind"] == "Present"

    def test_decline_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Decline on accepted/revoked invite returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept first
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

        # Try to decline
        response = auth_client.post(
            f"/libraries/invites/{invitation_handle}/decline",
            headers=auth_headers(invitee_id),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_INVITE_NOT_PENDING"

    def test_decline_invite_unknown_masked_not_found(self, auth_client):
        """Decline unknown invite returns masked 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            f"/libraries/invites/{_invite_handle(uuid4())}/decline",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_INVITE_NOT_FOUND"


@pytest.mark.usefixtures("_sharing_entitled")
class TestLibraryInviteRevoke:
    """Tests for DELETE /libraries/invites/{invitation_handle} endpoint."""

    def _create_invite(self, auth_client, owner_id, invitee_id, library_id):
        resp = auth_client.post(
            f"/libraries/{library_id}/invites",
            json={"invitee": _user_invitee(invitee_id), "role": "member"},
            headers=auth_headers(owner_id),
        )
        assert resp.status_code == 201
        return resp.json()["data"]["invitationHandle"]

    def test_revoke_invite_pending_to_revoked(self, auth_client):
        """Admin revokes pending invite; returns 204."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

    def test_revoke_invite_idempotent_when_already_revoked(self, auth_client):
        """Revoke on already revoked invite returns 204."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Revoke first time
        auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
            headers=auth_headers(owner_id),
        )

        # Revoke second time
        response = auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
            headers=auth_headers(owner_id),
        )
        assert response.status_code == 204

    def test_revoke_invite_non_pending_returns_invite_not_pending(self, auth_client):
        """Revoke on accepted/declined invite returns 409."""
        owner_id = create_test_user_id()
        invitee_id = create_test_user_id()

        create_resp = auth_client.post(
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        # Accept it
        auth_client.post(
            f"/libraries/invites/{invitation_handle}/accept",
            headers=auth_headers(invitee_id),
        )

        # Try to revoke
        response = auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
        )
        library_id = create_resp.json()["data"]["id"]
        auth_client.get("/me", headers=auth_headers(invitee_id))
        auth_client.get("/me", headers=auth_headers(outsider_id))

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
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
            "/libraries", json=_library_create_body("Team"), headers=auth_headers(owner_id)
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

        invitation_handle = self._create_invite(auth_client, owner_id, invitee_id, library_id)

        response = auth_client.delete(
            f"/libraries/invites/{invitation_handle}",
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
            mid_whitespace = _create_pdf_media_for_library(
                session,
                processing_status="ready_for_reading",
                plain_text=" \t\n",
                page_count=1,
                with_page_spans=True,
            )
            add_media_to_library(session, UUID(library_id), mid_ready)
            add_media_to_library(session, UUID(library_id), mid_not_ready)
            add_media_to_library(session, UUID(library_id), mid_whitespace)
            session.commit()

        for media_id in (mid_ready, mid_not_ready, mid_whitespace):
            direct_db.register_cleanup("media", "id", media_id)
            direct_db.register_cleanup("library_entries", "media_id", media_id)
            direct_db.register_cleanup("media_file", "media_id", media_id)
            direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)

        list_resp = _list_library_entries(auth_client, user_id, library_id)
        assert list_resp.status_code == 200
        entries = {
            row["media"]["id"]: row
            for row in _entry_items(list_resp)
            if row["kind"] == "media" and row["media"] is not None
        }

        ready_caps = entries[str(mid_ready)]["media"]["capabilities"]
        assert ready_caps["can_quote"] is True
        assert "can_search" not in ready_caps
        assert "can_read" not in ready_caps
        assert entries[str(mid_ready)]["readingTimeEstimate"] == {
            "kind": "Present",
            "value": {
                "totalMinutes": 1,
                "remainingMinutes": {"kind": "Absent"},
            },
        }

        not_ready_caps = entries[str(mid_not_ready)]["media"]["capabilities"]
        assert not_ready_caps["can_quote"] is False
        assert "can_search" not in not_ready_caps
        assert "can_read" not in not_ready_caps
        assert entries[str(mid_not_ready)]["readingTimeEstimate"] == {"kind": "Absent"}

        whitespace_caps = entries[str(mid_whitespace)]["media"]["capabilities"]
        assert whitespace_caps["can_quote"] is False
        assert "can_search" not in whitespace_caps
        assert "can_read" not in whitespace_caps
        assert entries[str(mid_whitespace)]["readingTimeEstimate"] == {"kind": "Absent"}

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
            for row in _entry_items(list_resp)
            if row["kind"] == "media"
            and row["media"] is not None
            and row["media"]["id"] == str(mid)
        )

        detail_resp = auth_client.get(f"/media/{mid}", headers=auth_headers(user_id))
        detail_caps = detail_resp.json()["data"]["capabilities"]

        assert list_caps["can_quote"] == detail_caps["can_quote"]
        assert "can_read" not in list_caps
        assert "can_search" not in list_caps


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


# =============================================================================
# Library View Lenses (library-sorting hard cutover)
# =============================================================================


def _view_ids(response) -> list[str]:
    return _library_entry_media_ids(_entry_items(response))


def _add_creator(session, media_id: UUID, display_name: str, *, ordinal: int = 1) -> UUID:
    """Attach one authored contributor credit to a media, minting a fresh
    contributor (unique handle) so `primary_creator_rows_sql` reads back
    ``display_name`` as the media's first creator."""
    contributor_id = uuid4()
    handle = f"{display_name.lower().replace(' ', '-')}-{contributor_id}"
    session.execute(
        text("INSERT INTO contributors (id, handle, display_name) VALUES (:id, :handle, :name)"),
        {"id": contributor_id, "handle": handle, "name": display_name},
    )
    session.execute(
        text(
            """
            INSERT INTO contributor_credits
                (contributor_id, media_id, credited_name, normalized_credited_name,
                 role, ordinal, source)
            VALUES (:cid, :mid, :cn, :nn, 'author', :ord, 'test')
            """
        ),
        {
            "cid": contributor_id,
            "mid": media_id,
            "cn": display_name,
            "nn": display_name.lower(),
            "ord": ordinal,
        },
    )
    return contributor_id


def _seed_view_library(
    direct_db: DirectSessionManager,
    user_id: UUID,
    name: str,
    specs: list[dict],
) -> tuple[UUID, list[UUID]]:
    """A non-default library whose entries are inserted in `specs` order at
    ascending positions and ascending entry ``created_at`` (index 0 oldest).
    Each spec is ``{title, creator?: str, published?: str}``; missing creator or
    published is left NULL. Returns (library_id, media_ids in insert order)."""
    from datetime import UTC, datetime, timedelta

    base = datetime(2020, 1, 1, tzinfo=UTC)
    media_ids: list[UUID] = []
    contributor_ids: list[UUID] = []
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, name)
        for index, spec in enumerate(specs):
            media_id = create_test_media(session, title=spec["title"])
            if spec.get("published") is not None:
                session.execute(
                    text("UPDATE media SET published_date = :pub WHERE id = :mid"),
                    {"pub": spec["published"], "mid": media_id},
                )
            session.execute(
                text(
                    """
                    INSERT INTO library_entries (library_id, media_id, position, created_at)
                    VALUES (:lib, :mid, :pos, :created_at)
                    """
                ),
                {
                    "lib": library_id,
                    "mid": media_id,
                    "pos": index,
                    "created_at": base + timedelta(days=index),
                },
            )
            if spec.get("creator") is not None:
                contributor_ids.append(_add_creator(session, media_id, spec["creator"]))
            media_ids.append(media_id)
        session.commit()

    # Cleanup runs LIFO, so a parent row must be registered BEFORE the rows that
    # FK it (media before its credits/overrides/entries; contributors before the
    # credits that reference them).
    for contributor_id in contributor_ids:
        direct_db.register_cleanup("contributors", "id", contributor_id)
    for media_id in media_ids:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("contributor_credits", "media_id", media_id)
        direct_db.register_cleanup("consumption_overrides", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    return library_id, media_ids


class TestLibraryEntryViewParsing:
    """Strict entry-view query parsing (spec API validation). Every malformed
    request is 400 E_INVALID_REQUEST; the removed sorts/completion all fail."""

    def _default_library(self, auth_client, user_id: UUID) -> str:
        return auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

    @pytest.mark.parametrize("sort", ["position", "manual", "resonance", "reading_time", ""])
    def test_removed_and_unknown_sorts_rejected(self, auth_client, sort):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, sort=sort)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_factual_sort_requires_direction(self, auth_client):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, sort="title")
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_direction_requires_factual_sort(self, auth_client):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, direction="asc")
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_bad_direction_rejected(self, auth_client):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(
            auth_client, user_id, library_id, sort="title", direction="sideways"
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    @pytest.mark.parametrize("completion", ["all", "finished", "true", ""])
    def test_bad_completion_rejected(self, auth_client, completion):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, completion=completion)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    @pytest.mark.parametrize("limit", ["0", "-3", "abc"])
    def test_bad_limit_rejected(self, auth_client, limit):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, limit=limit)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_unknown_and_duplicate_params_rejected(self, auth_client):
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)

        unknown = _list_library_entries(auth_client, user_id, library_id, offset=1)
        assert unknown.status_code == 400
        assert unknown.json()["error"]["code"] == "E_INVALID_REQUEST"

        # multi_items() sees duplicates a params-dict would collapse.
        duplicate = auth_client.get(
            f"/libraries/{library_id}/entries?sort=title&direction=asc&sort=creator",
            headers=auth_headers(user_id),
        )
        assert duplicate.status_code == 400, duplicate.text
        assert duplicate.json()["error"]["code"] == "E_INVALID_REQUEST"

    @pytest.mark.parametrize("projection", ["unfiled", "in-progress"])
    def test_projection_values_accepted_on_default(self, auth_client, projection):
        """AC4/AC9: Default accepts both derived projections."""
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, projection=projection)
        assert response.status_code == 200, response.text

    def test_unknown_projection_rejected(self, auth_client):
        """AC9: an unsupported projection value fails E_INVALID_REQUEST."""
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(auth_client, user_id, library_id, projection="starred")
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_unfiled_on_non_default_rejected(self, auth_client):
        """AC5/AC9: projection=unfiled is revalidated against the requested
        library and rejected for a non-default one."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id = auth_client.post(
            "/libraries", json=_library_create_body("Named lib"), headers=auth_headers(user_id)
        ).json()["data"]["id"]
        response = _list_library_entries(auth_client, user_id, library_id, projection="unfiled")
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_in_progress_with_completion_rejected(self, auth_client):
        """AC9: `InProgress + Unfinished` is unrepresentable and rejected at the
        boundary."""
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = _list_library_entries(
            auth_client, user_id, library_id, projection="in-progress", completion="unfinished"
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_duplicate_projection_rejected(self, auth_client):
        """AC9: a duplicate projection key fails E_INVALID_REQUEST."""
        user_id = create_test_user_id()
        library_id = self._default_library(auth_client, user_id)
        response = auth_client.get(
            f"/libraries/{library_id}/entries?projection=unfiled&projection=in-progress",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestLibraryEntryTypeFilter:
    """The committed Library type lens is strict, exhaustive, and cursor-bound."""

    def test_each_exact_type_returns_all_and_only_its_entries(self, auth_client, direct_db):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Typed Library")
            media_by_kind = {
                kind: create_test_media(session, title=title, kind=kind)
                for kind, title in (
                    ("web_article", "Article"),
                    ("epub", "Book"),
                    ("pdf", "Paper"),
                    ("video", "Film"),
                    ("podcast_episode", "Episode"),
                )
            }
            for media_id in media_by_kind.values():
                add_media_to_library(session, library_id, media_id)

            podcast_id = uuid4()
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                    VALUES (:id, 'podcast_index', :provider_id, 'Show', :feed_url)
                    """
                ),
                {
                    "id": podcast_id,
                    "provider_id": f"typed-{podcast_id}",
                    "feed_url": f"https://example.com/{podcast_id}.xml",
                },
            )
            add_test_podcast_subscription(session, user_id=user_id, podcast_id=podcast_id)
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, podcast_id, position) "
                    "VALUES (:library_id, :podcast_id, 5)"
                ),
                {"library_id": library_id, "podcast_id": podcast_id},
            )
            session.commit()

        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        for media_id in media_by_kind.values():
            direct_db.register_cleanup("media", "id", media_id)
            direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("podcast_subscriptions", "podcast_id", podcast_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)

        all_entries = _list_library_entries(auth_client, user_id, str(library_id))
        assert all_entries.status_code == 200, all_entries.text
        assert len(_entry_items(all_entries)) == 6

        for entry_type, expected_id in (*media_by_kind.items(), ("podcast", podcast_id)):
            response = _list_library_entries(
                auth_client, user_id, str(library_id), entry_type=entry_type
            )
            assert response.status_code == 200, f"{entry_type}: {response.text}"
            rows = _entry_items(response)
            assert len(rows) == 1, f"{entry_type}: {rows}"
            row = rows[0]
            actual_id = row["media"]["id"] if row["kind"] == "media" else row["podcast"]["id"]
            assert actual_id == str(expected_id), f"{entry_type}: {row}"

    @pytest.mark.parametrize(
        "query",
        [
            "entry_type=",
            "entry_type=all",
            "entry_type=other",
            "entry_type=pdf&entry_type=epub",
            "kind=pdf",
            "type=pdf",
            "types=pdf",
            "entry_type=podcast&completion=unfinished",
            "entry_type=podcast&projection=unfiled",
            "entry_type=podcast&projection=in-progress",
        ],
    )
    def test_invalid_aliased_and_incompatible_type_queries_are_rejected(self, auth_client, query):
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        response = auth_client.get(
            f"/libraries/{library_id}/entries?{query}", headers=auth_headers(user_id)
        )
        assert response.status_code == 400, f"{query}: {response.text}"
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST", query

    def test_exact_type_filters_before_keyset_and_limit_and_binds_cursor(
        self, auth_client, direct_db
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Typed Pagination")
            seeded: list[tuple[str, UUID]] = []
            for position, (kind, title) in enumerate(
                (
                    ("web_article", "Article A"),
                    ("pdf", "PDF A"),
                    ("web_article", "Article B"),
                    ("pdf", "PDF B"),
                    ("web_article", "Article C"),
                )
            ):
                media_id = create_test_media(session, title=title, kind=kind)
                session.execute(
                    text(
                        "INSERT INTO library_entries (library_id, media_id, position) "
                        "VALUES (:library_id, :media_id, :position)"
                    ),
                    {
                        "library_id": library_id,
                        "media_id": media_id,
                        "position": position,
                    },
                )
                seeded.append((kind, media_id))
            session.commit()

        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        for _, media_id in seeded:
            direct_db.register_cleanup("media", "id", media_id)
            direct_db.register_cleanup("library_entries", "media_id", media_id)

        expected = [str(media_id) for kind, media_id in seeded if kind == "web_article"]
        collected: list[str] = []
        cursor = None
        revision = None
        first_cursor = None
        for _ in range(4):
            response = _list_library_entries(
                auth_client,
                user_id,
                str(library_id),
                entry_type="web_article",
                limit=1,
                **(
                    {"cursor": cursor, "collection_revision": revision}
                    if cursor is not None
                    else {}
                ),
            )
            assert response.status_code == 200, response.text
            assert len(_entry_items(response)) == 1
            collected.extend(_view_ids(response))
            revision = _entry_revision(response)
            cursor = _entry_cursor(response)
            if first_cursor is None:
                first_cursor = cursor
            if cursor is None:
                break
        assert collected == expected
        assert first_cursor is not None

        cross_type = _list_library_entries(
            auth_client,
            user_id,
            str(library_id),
            entry_type="pdf",
            cursor=first_cursor,
            collection_revision=revision,
        )
        assert cross_type.status_code == 400, cross_type.text
        assert cross_type.json()["error"]["code"] == "E_INVALID_CURSOR"


class TestLibraryEntryViewLenses:
    """Factual view lenses over a physical non-default library (spec ordering
    rules + AC2/AC3/AC4/AC5/AC8). Every assertion is through the API response."""

    def test_eight_factual_presets_order_complete_set(self, auth_client, direct_db):
        """AC2: all eight factual direction presets order the complete set."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (a, b, c) = _seed_view_library(
            direct_db,
            user_id,
            "Eight Presets",
            [
                {"title": "Apple", "creator": "Charlie", "published": "2001"},
                {"title": "Mango", "creator": "Alice", "published": "2010-05"},
                {"title": "Cherry", "creator": "Bob", "published": "1999-12-31"},
            ],
        )
        a, b, c = str(a), str(b), str(c)

        def order(**params) -> list[str]:
            resp = _list_library_entries(auth_client, user_id, library_id, **params)
            assert resp.status_code == 200, resp.text
            return _view_ids(resp)

        assert order(sort="title", direction="asc") == [a, c, b]
        assert order(sort="title", direction="desc") == [b, c, a]
        assert order(sort="creator", direction="asc") == [b, c, a]
        assert order(sort="creator", direction="desc") == [a, c, b]
        assert order(sort="published", direction="asc") == [c, a, b]
        assert order(sort="published", direction="desc") == [b, a, c]
        assert order(sort="added", direction="asc") == [a, b, c]
        assert order(sort="added", direction="desc") == [c, b, a]

    def test_missing_creator_sorts_last_in_both_directions(self, auth_client, direct_db):
        """AC4: media with no creator stays last for creator asc AND desc."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (present, missing) = _seed_view_library(
            direct_db,
            user_id,
            "Missing Creator",
            [
                {"title": "Beta", "creator": "Anna", "published": "2005"},
                {"title": "Alpha"},
            ],
        )
        present, missing = str(present), str(missing)

        asc = _list_library_entries(
            auth_client, user_id, library_id, sort="creator", direction="asc"
        )
        desc = _list_library_entries(
            auth_client, user_id, library_id, sort="creator", direction="desc"
        )
        assert _view_ids(asc) == [present, missing]
        assert _view_ids(desc) == [present, missing]

    def test_missing_publication_sorts_last_in_both_directions(self, auth_client, direct_db):
        """AC4: media with no published_date stays last for published asc AND desc."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (present, missing) = _seed_view_library(
            direct_db,
            user_id,
            "Missing Published",
            [
                {"title": "Beta", "published": "2005"},
                {"title": "Alpha"},
            ],
        )
        present, missing = str(present), str(missing)

        asc = _list_library_entries(
            auth_client, user_id, library_id, sort="published", direction="asc"
        )
        desc = _list_library_entries(
            auth_client, user_id, library_id, sort="published", direction="desc"
        )
        assert _view_ids(asc) == [present, missing]
        assert _view_ids(desc) == [present, missing]

    def test_factual_cursor_paginates_deterministically(self, auth_client, direct_db):
        """AC5: a factual-view cursor is exact and its pages reconstruct the
        complete order with no duplicates or omissions."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, _media_ids = _seed_view_library(
            direct_db,
            user_id,
            "Factual Cursor",
            [
                {"title": "Delta"},
                {"title": "Alpha"},
                {"title": "Charlie"},
                {"title": "Bravo"},
            ],
        )
        full = _list_library_entries(
            auth_client, user_id, library_id, sort="title", direction="asc"
        )
        expected = _view_ids(full)
        assert len(expected) == 4

        collected: list[str] = []
        cursor = None
        revision = None
        for _ in range(4):
            resp = _list_library_entries(
                auth_client,
                user_id,
                library_id,
                sort="title",
                direction="asc",
                limit=1,
                **(
                    {"cursor": cursor, "collection_revision": revision}
                    if cursor is not None
                    else {}
                ),
            )
            assert resp.status_code == 200, resp.text
            collected.extend(_view_ids(resp))
            revision = _entry_revision(resp)
            cursor = _entry_cursor(resp)
            if cursor is None:
                break
        assert collected == expected

    def test_cross_direction_and_cross_completion_cursor_reuse_rejected(
        self, auth_client, direct_db
    ):
        """AC5: a cursor is bound to the exact view — replaying it under a
        different direction or completion fails E_INVALID_CURSOR."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, _media_ids = _seed_view_library(
            direct_db,
            user_id,
            "Cursor Binding",
            [{"title": "Alpha"}, {"title": "Bravo"}, {"title": "Charlie"}],
        )
        first = _list_library_entries(
            auth_client, user_id, library_id, sort="title", direction="asc", limit=1
        )
        cursor = _entry_cursor(first)
        revision = _entry_revision(first)
        assert cursor is not None

        cross_direction = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            sort="title",
            direction="desc",
            cursor=cursor,
            collection_revision=revision,
        )
        assert cross_direction.status_code == 400
        assert cross_direction.json()["error"]["code"] == "E_INVALID_CURSOR"

        cross_completion = _list_library_entries(
            auth_client,
            user_id,
            library_id,
            sort="title",
            direction="asc",
            completion="unfinished",
            cursor=cursor,
            collection_revision=revision,
        )
        assert cross_completion.status_code == 400
        assert cross_completion.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_hide_finished_filters_before_pagination(self, auth_client, direct_db):
        """AC3/AC8: completion=unfinished excludes canonically finished media
        BEFORE pagination — no short page — and only finished media drop."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (y, x, z) = _seed_view_library(
            direct_db,
            user_id,
            "Hide Finished",
            [{"title": "Y"}, {"title": "X"}, {"title": "Z"}],
        )
        # Mark the middle canonical entry (X) finished for this viewer.
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO consumption_overrides (user_id, media_id, status) "
                    "VALUES (:u, :m, 'finished')"
                ),
                {"u": user_id, "m": x},
            )
            session.commit()

        page = _list_library_entries(
            auth_client, user_id, library_id, completion="unfinished", limit=2
        )
        assert page.status_code == 200, page.text
        # Both surviving unfinished rows fill the page; the finished X is filtered
        # out up front, not counted then dropped (which would yield a short page).
        assert _view_ids(page) == [str(y), str(z)]
        assert _entry_cursor(page) is None

    def test_hide_finished_excludes_podcast_shows_without_completion_facts(
        self, auth_client, direct_db
    ):
        """AC8: completion=unfinished excludes shows and finished media because
        subscriptions have no honest completion fact."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (media_finished,) = _seed_view_library(
            direct_db, user_id, "Podcast Keep", [{"title": "Finished Media"}]
        )
        podcast_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                    VALUES (:id, 'podcast_index', :pid, 'Kept Show', :feed)
                    """
                ),
                {
                    "id": podcast_id,
                    "pid": f"keep-{podcast_id}",
                    "feed": f"https://ex/{podcast_id}.xml",
                },
            )
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, podcast_id, position, created_at) "
                    "VALUES (:lib, :pid, 99, now())"
                ),
                {"lib": library_id, "pid": podcast_id},
            )
            add_test_podcast_subscription(
                session,
                user_id=user_id,
                podcast_id=podcast_id,
            )
            session.execute(
                text(
                    "INSERT INTO consumption_overrides (user_id, media_id, status) "
                    "VALUES (:u, :m, 'finished')"
                ),
                {"u": user_id, "m": media_finished},
            )
            session.commit()
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)

        page = _list_library_entries(auth_client, user_id, library_id, completion="unfinished")
        assert page.status_code == 200, page.text
        rows = _entry_items(page)
        podcast_ids = [row["podcast"]["id"] for row in rows if row["kind"] == "podcast"]
        assert podcast_ids == []
        assert str(media_finished) not in _view_ids(page)


class TestLibraryEntryViewSurfaces:
    """Every library surface (Default, system, read-only member) receives the
    factual view lenses (spec capability contract, AC6/AC7)."""

    def test_default_supports_factual_sort(self, auth_client, direct_db):
        """AC6: Default supports factual sorts over its live virtual set."""
        user_id = create_test_user_id()
        library_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]
        with direct_db.session() as session:
            zebra = create_test_media(session, title="Zebra")
            apple = create_test_media(session, title="Apple")
            for media_id in (zebra, apple):
                add_media_to_library(session, UUID(library_id), media_id)
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()

        response = _list_library_entries(
            auth_client, user_id, library_id, sort="title", direction="asc"
        )
        assert response.status_code == 200, response.text
        assert _view_ids(response) == [str(apple), str(zebra)]

    def test_system_library_supports_view_sort(self, auth_client, direct_db):
        """AC7: a system library receives view sorts (read-only surface)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        system_library_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO libraries (id, name, owner_user_id, is_default, system_key)
                    VALUES (:id, 'System View', :owner, false, :system_key)
                    """
                ),
                {
                    "id": system_library_id,
                    "owner": user_id,
                    "system_key": f"test-system-{system_library_id}",
                },
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :uid, 'admin')"
                ),
                {"lib": system_library_id, "uid": user_id},
            )
            zebra = create_test_media(session, title="Zebra")
            apple = create_test_media(session, title="Apple")
            for position, media_id in enumerate((zebra, apple)):
                session.execute(
                    text(
                        "INSERT INTO library_entries (library_id, media_id, position) "
                        "VALUES (:lib, :mid, :pos)"
                    ),
                    {"lib": system_library_id, "mid": media_id, "pos": position},
                )
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.commit()
        direct_db.register_cleanup("memberships", "library_id", system_library_id)
        direct_db.register_cleanup("libraries", "id", system_library_id)

        response = _list_library_entries(
            auth_client, user_id, str(system_library_id), sort="title", direction="asc"
        )
        assert response.status_code == 200, response.text
        assert _view_ids(response) == [str(apple), str(zebra)]

    def test_read_only_member_supports_view_sort(self, auth_client, direct_db):
        """AC7: a non-admin (read-only) member of a shared library gets view
        sorts without any mutation capability."""
        owner_id = create_test_user_id()
        viewer_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(viewer_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, owner_id, "Shared Read Only")
            zebra = create_test_media(session, title="Zebra")
            apple = create_test_media(session, title="Apple")
            for position, media_id in enumerate((zebra, apple)):
                session.execute(
                    text(
                        "INSERT INTO library_entries (library_id, media_id, position) "
                        "VALUES (:lib, :mid, :pos)"
                    ),
                    {"lib": library_id, "mid": media_id, "pos": position},
                )
                direct_db.register_cleanup("library_entries", "media_id", media_id)
                direct_db.register_cleanup("media", "id", media_id)
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :uid, 'member')"
                ),
                {"lib": library_id, "uid": viewer_id},
            )
            session.commit()
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = _list_library_entries(
            auth_client, viewer_id, str(library_id), sort="title", direction="asc"
        )
        assert response.status_code == 200, response.text
        assert _view_ids(response) == [str(apple), str(zebra)]


# =============================================================================
# Projection lenses — Unfiled / In Progress semantics + v2 cursor
# =============================================================================


def _default_library_id(auth_client, user_id: UUID) -> str:
    return auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
        "default_library_id"
    ]


def _create_default_media(
    direct_db: DirectSessionManager, default_library_id: str, *, title: str
) -> UUID:
    """Create media filed directly (and only) into the viewer's Default library.
    The media-id cleanup deletes its `library_entries`; reader/override facts are
    registered here so they are torn down before the media row."""
    with direct_db.session() as session:
        media_id = create_test_media(session, title=title)
        add_media_to_library(session, UUID(default_library_id), media_id)
        session.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("consumption_overrides", "media_id", media_id)
    direct_db.register_cleanup("reader_engagement_states", "media_id", media_id)
    return media_id


def _set_reader_progress(
    direct_db: DirectSessionManager, user_id: UUID, media_id: UUID, *, fraction: float
) -> None:
    """Give one web_article media a canonical reader engagement fact for a viewer:
    ``fraction`` below the finished threshold (0.95) derives ``InProgress``, at or
    above it derives ``Finished``."""
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO reader_engagement_states "
                "(id, user_id, media_id, last_engaged_at, max_total_progression) "
                "VALUES (:id, :u, :m, now(), :f)"
            ),
            {"id": uuid4(), "u": user_id, "m": media_id, "f": fraction},
        )
        session.commit()
    direct_db.register_cleanup("reader_engagement_states", "media_id", media_id)


class TestLibraryEntryUnfiledProjection:
    """Unfiled projection semantics on the viewer's Default library (spec
    AC5/AC6). Every assertion is through the API response."""

    def test_direct_default_only_returned_and_named_filing_excluded(self, auth_client, direct_db):
        """AC5: direct-Default media with no other placement is Unfiled; the same
        media additionally filed in a named library drops out (while All keeps
        both)."""
        user_id = create_test_user_id()
        default_id = _default_library_id(auth_client, user_id)
        only_default = _create_default_media(direct_db, default_id, title="Only Default")
        also_named = _create_default_media(direct_db, default_id, title="Also Named")
        with direct_db.session() as session:
            named_id = create_test_library(session, user_id, "Named Filing")
            add_media_to_library(session, named_id, also_named)
            session.commit()
        direct_db.register_cleanup("libraries", "id", named_id)

        all_items = _list_library_entries(auth_client, user_id, default_id)
        assert all_items.status_code == 200, all_items.text
        assert set(_view_ids(all_items)) == {str(only_default), str(also_named)}

        unfiled = _list_library_entries(auth_client, user_id, default_id, projection="unfiled")
        assert unfiled.status_code == 200, unfiled.text
        assert _view_ids(unfiled) == [str(only_default)]

    def test_shared_only_media_absent_from_unfiled(self, auth_client, direct_db):
        """AC5: media visible through All only via a shared-library membership
        (no direct-Default entry) is not Unfiled; read-only shared placement
        counts as filing."""
        owner_id = create_test_user_id()
        viewer_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        default_id = _default_library_id(auth_client, viewer_id)
        mine = _create_default_media(direct_db, default_id, title="Mine")
        with direct_db.session() as session:
            shared_id = create_test_library(session, owner_id, "Shared")
            from tests.factories import add_library_member

            add_library_member(session, shared_id, viewer_id, role="member")
            shared_media = create_test_media(session, title="Shared Only")
            add_media_to_library(session, shared_id, shared_media)
            session.commit()
        direct_db.register_cleanup("media", "id", shared_media)
        direct_db.register_cleanup("libraries", "id", shared_id)

        all_items = _list_library_entries(auth_client, viewer_id, default_id)
        assert set(_view_ids(all_items)) == {str(mine), str(shared_media)}

        unfiled = _list_library_entries(auth_client, viewer_id, default_id, projection="unfiled")
        assert _view_ids(unfiled) == [str(mine)]

    def test_system_library_placement_keeps_media_unfiled(self, auth_client, direct_db):
        """AC6: a system-library placement does not change Unfiled — a media
        directly in Default and also seeded into a system library stays Unfiled."""
        user_id = create_test_user_id()
        default_id = _default_library_id(auth_client, user_id)
        media_id = _create_default_media(direct_db, default_id, title="Also System")
        system_library_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO libraries (id, name, owner_user_id, is_default, system_key) "
                    "VALUES (:id, 'System', :owner, false, :sk)"
                ),
                {"id": system_library_id, "owner": user_id, "sk": f"sys-{system_library_id}"},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :uid, 'admin')"
                ),
                {"lib": system_library_id, "uid": user_id},
            )
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, media_id, position) "
                    "VALUES (:lib, :m, 0)"
                ),
                {"lib": system_library_id, "m": media_id},
            )
            session.commit()
        direct_db.register_cleanup("libraries", "id", system_library_id)

        unfiled = _list_library_entries(auth_client, user_id, default_id, projection="unfiled")
        assert unfiled.status_code == 200, unfiled.text
        assert _view_ids(unfiled) == [str(media_id)]


class TestLibraryEntryInProgressProjection:
    """In Progress projection semantics (spec AC7)."""

    def test_only_in_progress_media_returned(self, auth_client, direct_db):
        """AC7: only canonical InProgress media appear; Unread, Finished, and
        missing facts are absent."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (in_prog, unread, finished, _missing) = _seed_view_library(
            direct_db,
            user_id,
            "Progress",
            [{"title": "InProg"}, {"title": "Unread"}, {"title": "Finished"}, {"title": "Missing"}],
        )
        _set_reader_progress(direct_db, user_id, in_prog, fraction=0.4)
        _set_reader_progress(direct_db, user_id, finished, fraction=1.0)
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO consumption_overrides (user_id, media_id, status) "
                    "VALUES (:u, :m, 'unread')"
                ),
                {"u": user_id, "m": unread},
            )
            session.commit()

        page = _list_library_entries(auth_client, user_id, library_id, projection="in-progress")
        assert page.status_code == 200, page.text
        assert _view_ids(page) == [str(in_prog)]

    def test_podcast_show_rows_absent_from_in_progress(self, auth_client, direct_db):
        """AC7: podcast-show entry rows (NULL read_state) never match In Progress
        even alongside a real InProgress media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (media_in_prog,) = _seed_view_library(
            direct_db, user_id, "Podcast Progress", [{"title": "Reading"}]
        )
        _set_reader_progress(direct_db, user_id, media_in_prog, fraction=0.5)
        podcast_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url) "
                    "VALUES (:id, 'podcast_index', :pid, 'Show', :feed)"
                ),
                {
                    "id": podcast_id,
                    "pid": f"ip-{podcast_id}",
                    "feed": f"https://ex/{podcast_id}.xml",
                },
            )
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, podcast_id, position) "
                    "VALUES (:lib, :pid, 99)"
                ),
                {"lib": library_id, "pid": podcast_id},
            )
            session.commit()
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("library_entries", "podcast_id", podcast_id)

        page = _list_library_entries(auth_client, user_id, library_id, projection="in-progress")
        assert page.status_code == 200, page.text
        rows = _entry_items(page)
        assert [row for row in rows if row["kind"] == "podcast"] == []
        assert _view_ids(page) == [str(media_in_prog)]


class TestLibraryEntryProjectionPagination:
    """Projection is applied before completion/order/keyset/limit+1, so pages are
    never falsely empty or short (spec AC8)."""

    def test_unfiled_paginates_before_order(self, auth_client, direct_db):
        user_id = create_test_user_id()
        default_id = _default_library_id(auth_client, user_id)
        with direct_db.session() as session:
            named_id = create_test_library(session, user_id, "Filed Elsewhere")
            session.commit()
        direct_db.register_cleanup("libraries", "id", named_id)

        unfiled = {
            t: _create_default_media(direct_db, default_id, title=t) for t in ("A", "C", "E")
        }
        for title in ("B", "D"):
            filed = _create_default_media(direct_db, default_id, title=title)
            with direct_db.session() as session:
                add_media_to_library(session, named_id, filed)
                session.commit()

        collected: list[str] = []
        cursor = None
        revision = None
        for _ in range(10):
            resp = _list_library_entries(
                auth_client,
                user_id,
                default_id,
                projection="unfiled",
                sort="title",
                direction="asc",
                limit=1,
                **(
                    {"cursor": cursor, "collection_revision": revision}
                    if cursor is not None
                    else {}
                ),
            )
            assert resp.status_code == 200, resp.text
            page_ids = _view_ids(resp)
            assert len(page_ids) == 1
            collected.extend(page_ids)
            revision = _entry_revision(resp)
            cursor = _entry_cursor(resp)
            if cursor is None:
                break
        assert collected == [str(unfiled["A"]), str(unfiled["C"]), str(unfiled["E"])]

    def test_in_progress_paginates_before_order(self, auth_client, direct_db):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id, (a, b, c, _d) = _seed_view_library(
            direct_db,
            user_id,
            "IP Page",
            [{"title": "A"}, {"title": "B"}, {"title": "C"}, {"title": "D"}],
        )
        _set_reader_progress(direct_db, user_id, a, fraction=0.3)
        _set_reader_progress(direct_db, user_id, c, fraction=0.3)
        _set_reader_progress(direct_db, user_id, b, fraction=1.0)

        collected: list[str] = []
        cursor = None
        revision = None
        for _ in range(10):
            resp = _list_library_entries(
                auth_client,
                user_id,
                library_id,
                projection="in-progress",
                sort="title",
                direction="asc",
                limit=1,
                **(
                    {"cursor": cursor, "collection_revision": revision}
                    if cursor is not None
                    else {}
                ),
            )
            assert resp.status_code == 200, resp.text
            collected.extend(_view_ids(resp))
            revision = _entry_revision(resp)
            cursor = _entry_cursor(resp)
            if cursor is None:
                break
        assert collected == [str(a), str(c)]


class TestLibraryEntryCursor:
    """The v2 view cursor is authenticated and bound to the exact
    viewer/library/view; it is non-coercing and hides the viewer UUID (spec
    AC10). No v1 code or v1-specific test remains."""

    def _seed(self, auth_client, direct_db) -> tuple[UUID, str]:
        user_id = create_test_user_id()
        default_id = _default_library_id(auth_client, user_id)
        for title in ("A", "B", "C"):
            _create_default_media(direct_db, default_id, title=title)
        return user_id, default_id

    def _first_cursor(self, auth_client, user_id, library_id) -> tuple[str, int]:
        first = _list_library_entries(
            auth_client, user_id, library_id, sort="title", direction="asc", limit=1
        )
        assert first.status_code == 200, first.text
        cursor = _entry_cursor(first)
        assert cursor is not None
        return cursor, _entry_revision(first)

    def test_pre_root_subsumption_default_cursor_is_rejected(self, auth_client, direct_db):
        user_id, default_id = self._seed(auth_client, direct_db)
        _, revision = self._first_cursor(auth_client, user_id, default_id)
        pre_cutover = encode_signed_keyset_cursor(
            family=CollectionFamily.LibraryEntries.value,
            query={
                "libraryId": default_id,
                "plan": [
                    {"column": "title_key", "direction": "asc", "valueKind": "text"},
                    {"column": "target_kind", "direction": "asc", "valueKind": "text"},
                    {"column": "target_id", "direction": "desc", "valueKind": "uuid"},
                ],
                "view": {
                    "entryType": {"kind": "all-types"},
                    "order": {"sort": "title", "direction": "asc"},
                    "projection": {"completion": "all", "kind": "all-items"},
                },
                "viewerId": str(user_id),
            },
            after=(
                KeysetValue(KeysetValueKind.Text, "a"),
                KeysetValue(KeysetValueKind.Text, "media"),
                KeysetValue(KeysetValueKind.Uuid, uuid4()),
            ),
        )

        response = _list_library_entries(
            auth_client,
            user_id,
            default_id,
            sort="title",
            direction="asc",
            cursor=pre_cutover,
            collection_revision=revision,
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_cursor_bound_to_exact_view(self, auth_client, direct_db):
        user_id, default_id = self._seed(auth_client, direct_db)
        cursor, revision = self._first_cursor(auth_client, user_id, default_id)

        cross = {
            "projection": _list_library_entries(
                auth_client,
                user_id,
                default_id,
                sort="title",
                direction="asc",
                projection="in-progress",
                cursor=cursor,
                collection_revision=revision,
            ),
            "order": _list_library_entries(
                auth_client,
                user_id,
                default_id,
                sort="added",
                direction="asc",
                cursor=cursor,
                collection_revision=revision,
            ),
            "direction": _list_library_entries(
                auth_client,
                user_id,
                default_id,
                sort="title",
                direction="desc",
                cursor=cursor,
                collection_revision=revision,
            ),
            "completion": _list_library_entries(
                auth_client,
                user_id,
                default_id,
                sort="title",
                direction="asc",
                completion="unfinished",
                cursor=cursor,
                collection_revision=revision,
            ),
        }
        for label, resp in cross.items():
            assert resp.status_code == 400, f"{label}: {resp.text}"
            assert resp.json()["error"]["code"] == "E_INVALID_CURSOR", label

    def test_tampered_cursor_rejected(self, auth_client, direct_db):
        user_id, default_id = self._seed(auth_client, direct_db)
        cursor, revision = self._first_cursor(auth_client, user_id, default_id)

        packed = bytearray(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        packed[0] ^= 0x01
        tampered = base64.urlsafe_b64encode(bytes(packed)).rstrip(b"=").decode()

        resp = _list_library_entries(
            auth_client,
            user_id,
            default_id,
            sort="title",
            direction="asc",
            cursor=tampered,
            collection_revision=revision,
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_non_canonical_body_rejected(self, auth_client, direct_db):
        user_id, default_id = self._seed(auth_client, direct_db)
        cursor, revision = self._first_cursor(auth_client, user_id, default_id)

        packed = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        body_bytes, tag = packed[:-32], packed[-32:]
        # Re-serialize the identical body non-canonically (whitespace) while
        # keeping the original tag: the MAC binds the exact canonical bytes, so
        # any re-encoding is rejected.
        non_canonical = json.dumps(json.loads(body_bytes), indent=2).encode()
        assert non_canonical != body_bytes
        forged = base64.urlsafe_b64encode(non_canonical + tag).rstrip(b"=").decode()

        resp = _list_library_entries(
            auth_client,
            user_id,
            default_id,
            sort="title",
            direction="asc",
            cursor=forged,
            collection_revision=revision,
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "E_INVALID_CURSOR"


class TestReservedLibraryName:
    """`All` is reserved for the All view alias (spec AC2)."""

    @pytest.mark.parametrize("name", ["All", "all", "  ALL  "])
    def test_create_reserved_name_rejected(self, auth_client, name):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        response = auth_client.post(
            "/libraries", json=_library_create_body(name), headers=auth_headers(user_id)
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_NAME_INVALID"

    def test_rename_to_reserved_name_rejected(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        library_id = auth_client.post(
            "/libraries", json=_library_create_body("Rename Me"), headers=auth_headers(user_id)
        ).json()["data"]["id"]
        response = auth_client.patch(
            f"/libraries/{library_id}",
            json={"name": "All"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_NAME_INVALID"

    def test_normal_name_still_accepted(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        response = auth_client.post(
            "/libraries", json=_library_create_body("Almanac"), headers=auth_headers(user_id)
        )
        assert response.status_code == 201, response.text
