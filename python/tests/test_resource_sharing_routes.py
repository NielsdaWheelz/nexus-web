from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.auth.permissions import can_read_media
from nexus.services import public_resource_sharing, resource_grants, resource_sharing
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import seal_user, unseal_resource_grant
from tests.factories import (
    add_media_to_library,
    create_test_fragment,
    create_test_highlight,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


def _enable_sharing(direct_db, user_id) -> None:
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO billing_entitlement_overrides
                    (id, user_id, plan_tier, reason)
                VALUES (:id, :user_id, 'plus', 'resource sharing test')
                """
            ),
            {"id": uuid4(), "user_id": user_id},
        )
        db.commit()


def test_user_share_snapshot_create_idempotence_and_decline(
    auth_client,
    direct_db,
    monkeypatch,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    owner_headers = auth_headers(owner_id, email=f"owner-{owner_id}@example.com")
    recipient_headers = auth_headers(
        recipient_id,
        email=f"recipient-{recipient_id}@example.com",
    )
    owner_profile = auth_client.get("/me", headers=owner_headers).json()["data"]
    auth_client.get("/me", headers=recipient_headers)
    _enable_sharing(direct_db, owner_id)

    def projection_available(*_args, **_kwargs):
        return public_resource_sharing.Available()

    monkeypatch.setattr(
        resource_sharing,
        "link_projection_availability",
        projection_available,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "link_projection_availability",
        projection_available,
    )

    with direct_db.session() as db:
        media_id = create_test_media(db)
        create_test_fragment(db, media_id, "Public article body")
        add_media_to_library(db, owner_profile["default_library_id"], media_id)
        db.commit()

    resource_ref = f"media:{media_id}"
    path = f"/resource-items/{resource_ref}/shares"
    initial = auth_client.get(path, headers=owner_headers)
    assert initial.status_code == 200, initial.json()
    initial_data = initial.json()["data"]
    assert set(initial_data) == {
        "subject",
        "sharing",
        "authenticatedHref",
        "creationAvailability",
        "shares",
        "receivedAccess",
    }
    assert initial_data["sharing"] == "ResourceGrants"
    assert initial_data["creationAvailability"]["user"] == {"kind": "Available"}

    request = {
        "audience": {
            "kind": "User",
            "userHandle": seal_user(recipient_id),
        }
    }
    created = auth_client.post(path, headers=owner_headers, json=request)
    assert created.status_code == 200, created.json()
    assert created.json()["data"]["created"] is True
    share = created.json()["data"]["share"]
    assert set(share) == {"kind", "handle", "user"}
    assert share["kind"] == "User"
    assert unseal_resource_grant(share["handle"]).version == 7

    repeated = auth_client.post(path, headers=owner_headers, json=request)
    assert repeated.status_code == 200
    assert repeated.json()["data"]["created"] is False
    assert repeated.json()["data"]["share"]["handle"] == share["handle"]

    link_request = {"audience": {"kind": "Link"}}
    link_created = auth_client.post(path, headers=owner_headers, json=link_request)
    assert link_created.status_code == 200, link_created.json()
    assert link_created.json()["data"]["created"] is True
    link_handle = link_created.json()["data"]["share"]["handle"]

    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM billing_entitlement_overrides WHERE user_id = :user_id"),
            {"user_id": owner_id},
        )
        db.commit()

    def projection_must_not_be_rechecked(*_args, **_kwargs):
        raise AssertionError("existing grant must resolve before projection availability")

    monkeypatch.setattr(
        resource_sharing,
        "link_projection_availability",
        projection_must_not_be_rechecked,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "link_projection_availability",
        projection_must_not_be_rechecked,
    )

    for downgraded_request, expected_handle in (
        (request, share["handle"]),
        (link_request, link_handle),
    ):
        downgraded = auth_client.post(
            path,
            headers=owner_headers,
            json=downgraded_request,
        )
        assert downgraded.status_code == 200, downgraded.json()
        assert downgraded.json()["data"]["created"] is False
        assert downgraded.json()["data"]["share"]["handle"] == expected_handle

    received = auth_client.get(path, headers=recipient_headers)
    assert received.status_code == 200
    received_access = received.json()["data"]["receivedAccess"]
    assert len(received_access) == 1
    assert received_access[0]["subject"] == resource_ref

    declined = auth_client.delete(
        f"/resource-shares/{share['handle']}",
        headers=recipient_headers,
    )
    assert declined.status_code == 204
    missing = auth_client.delete(
        f"/resource-shares/{share['handle']}",
        headers=recipient_headers,
    )
    assert missing.status_code == 404


@pytest.mark.parametrize(
    ("processing_status", "projection_type"),
    [
        ("pending", public_resource_sharing.ProjectionNotReady),
        ("ready_for_reading", public_resource_sharing.ProjectionUnsupported),
    ],
)
def test_new_link_share_checks_entitlement_before_projection_availability(
    auth_client,
    direct_db,
    processing_status,
    projection_type,
) -> None:
    owner_id = create_test_user_id()
    owner_headers = auth_headers(owner_id, email=f"owner-{owner_id}@example.com")
    default_library_id = auth_client.get(
        "/me",
        headers=owner_headers,
    ).json()["data"]["default_library_id"]

    with direct_db.session() as db:
        media_id = create_test_media(db, status=processing_status)
        add_media_to_library(db, default_library_id, media_id)
        db.commit()
        projection = public_resource_sharing.link_projection_availability(
            db,
            subject=ResourceRef(scheme="media", id=media_id),
        )
        assert isinstance(projection, projection_type)

    response = auth_client.post(
        f"/resource-items/media:{media_id}/shares",
        headers=owner_headers,
        json={"audience": {"kind": "Link"}},
    )

    assert response.status_code == 402
    assert response.json()["error"]["code"] == "E_BILLING_REQUIRED"
    with direct_db.session() as db:
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM resource_grants "
                    "WHERE subject_scheme = 'media' AND subject_id = :media_id"
                ),
                {"media_id": media_id},
            )
            == 0
        )


def test_resource_share_rejects_snake_case_user_handle_alias(auth_client) -> None:
    viewer_id = create_test_user_id()

    response = auth_client.post(
        f"/resource-items/media:{uuid4()}/shares",
        headers=auth_headers(viewer_id),
        json={
            "audience": {
                "kind": "User",
                "user_handle": seal_user(create_test_user_id()),
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


@pytest.mark.parametrize("delete_actor", ["creator", "recipient"])
def test_last_grant_revoke_or_decline_claims_document_teardown(
    auth_client,
    direct_db,
    monkeypatch,
    delete_actor: str,
) -> None:
    invalidated: list[set] = []
    monkeypatch.setattr(
        resource_grants,
        "_notify_user_visibility_changed",
        lambda _db, user_ids: invalidated.append(set(user_ids)),
    )
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    owner_headers = auth_headers(owner_id, email=f"owner-{owner_id}@example.com")
    recipient_headers = auth_headers(
        recipient_id,
        email=f"recipient-{recipient_id}@example.com",
    )
    default_library_id = auth_client.get(
        "/me",
        headers=owner_headers,
    ).json()["data"]["default_library_id"]
    auth_client.get("/me", headers=recipient_headers)
    _enable_sharing(direct_db, owner_id)

    with direct_db.session() as db:
        media_id = create_test_media(db)
        add_media_to_library(db, default_library_id, media_id)
        db.commit()

    response = auth_client.post(
        f"/resource-items/media:{media_id}/shares",
        headers=owner_headers,
        json={
            "audience": {
                "kind": "User",
                "userHandle": seal_user(recipient_id),
            }
        },
    )
    assert response.status_code == 200, response.json()
    handle = response.json()["data"]["share"]["handle"]
    invalidated.clear()

    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM library_entries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        db.commit()

    deleting_headers = owner_headers if delete_actor == "creator" else recipient_headers
    deleted = auth_client.delete(
        f"/resource-shares/{handle}",
        headers=deleting_headers,
    )
    assert deleted.status_code == 204, deleted.text
    assert invalidated == [{owner_id, recipient_id}]
    with direct_db.session() as db:
        assert db.scalar(
            text("SELECT EXISTS (SELECT 1 FROM media_teardown_intents WHERE media_id = :media_id)"),
            {"media_id": media_id},
        )


def test_highlight_target_is_rechecked_after_write_lock(
    auth_client,
    direct_db,
    monkeypatch,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    owner_headers = auth_headers(owner_id, email=f"owner-{owner_id}@example.com")
    default_library_id = auth_client.get(
        "/me",
        headers=owner_headers,
    ).json()["data"]["default_library_id"]
    auth_client.get("/me", headers=auth_headers(recipient_id))
    _enable_sharing(direct_db, owner_id)
    with direct_db.session() as db:
        media_id = create_test_media(db)
        add_media_to_library(db, default_library_id, media_id)
        fragment_id = create_test_fragment(db, media_id, "highlighted text")
        highlight_id = create_test_highlight(db, owner_id, fragment_id)
        db.commit()

    monkeypatch.setattr(
        resource_sharing,
        "highlight_target_available",
        lambda _db, *, highlight_id: True,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "highlight_target_available",
        lambda _db, *, highlight_id: False,
    )
    response = auth_client.post(
        f"/resource-items/highlight:{highlight_id}/shares",
        headers=owner_headers,
        json={
            "audience": {
                "kind": "User",
                "userHandle": seal_user(recipient_id),
            }
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "Share unavailable: HighlightUnresolved"
    with direct_db.session() as db:
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM resource_grants "
                    "WHERE subject_scheme = 'highlight' AND subject_id = :subject_id"
                ),
                {"subject_id": highlight_id},
            )
            == 0
        )


def test_user_grant_revocation_is_path_local_after_recipient_reshares(
    auth_client,
    direct_db,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    downstream_id = create_test_user_id()
    outsider_id = create_test_user_id()
    owner_headers = auth_headers(owner_id, email=f"owner-{owner_id}@example.com")
    recipient_headers = auth_headers(
        recipient_id,
        email=f"recipient-{recipient_id}@example.com",
    )
    downstream_headers = auth_headers(
        downstream_id,
        email=f"downstream-{downstream_id}@example.com",
    )
    outsider_headers = auth_headers(outsider_id, email=f"outsider-{outsider_id}@example.com")
    default_library_id = auth_client.get(
        "/me",
        headers=owner_headers,
    ).json()["data"]["default_library_id"]
    for headers in (recipient_headers, downstream_headers, outsider_headers):
        auth_client.get("/me", headers=headers)
    _enable_sharing(direct_db, owner_id)
    _enable_sharing(direct_db, recipient_id)

    with direct_db.session() as db:
        media_id = create_test_media(db)
        add_media_to_library(db, default_library_id, media_id)
        db.commit()

    share_path = f"/resource-items/media:{media_id}/shares"
    owner_to_recipient = auth_client.post(
        share_path,
        headers=owner_headers,
        json={
            "audience": {
                "kind": "User",
                "userHandle": seal_user(recipient_id),
            }
        },
    ).json()["data"]["share"]["handle"]
    recipient_to_downstream = auth_client.post(
        share_path,
        headers=recipient_headers,
        json={
            "audience": {
                "kind": "User",
                "userHandle": seal_user(downstream_id),
            }
        },
    ).json()["data"]["share"]["handle"]

    uncontrolled = auth_client.delete(
        f"/resource-shares/{owner_to_recipient}",
        headers=outsider_headers,
    )
    assert uncontrolled.status_code == 404

    revoked = auth_client.delete(
        f"/resource-shares/{owner_to_recipient}",
        headers=owner_headers,
    )
    assert revoked.status_code == 204
    with direct_db.session() as db:
        assert can_read_media(db, recipient_id, media_id) is True
        assert can_read_media(db, downstream_id, media_id) is True

    declined = auth_client.delete(
        f"/resource-shares/{recipient_to_downstream}",
        headers=downstream_headers,
    )
    assert declined.status_code == 204
    with direct_db.session() as db:
        assert can_read_media(db, recipient_id, media_id) is False
        assert can_read_media(db, downstream_id, media_id) is False
