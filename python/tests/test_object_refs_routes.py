from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.services import contributors as contributors_service
from nexus.services.contributor_taxonomy import ContributorObservation, ObservedRoleSlices
from tests.factories import create_searchable_media
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_object_ref_routes_reject_user_graph_tags(auth_client):
    headers = auth_headers(create_test_user_id())

    search = auth_client.get("/object-refs/search?q=sot&type=tag", headers=headers)
    assert search.status_code == 400, search.text
    assert search.json()["error"]["code"] == "E_INVALID_REQUEST"

    resolve = auth_client.get(f"/object-refs/resolve?ref=tag:{uuid4()}", headers=headers)
    assert resolve.status_code == 400, resolve.text
    assert resolve.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_contributor_search_hides_zero_work_key_owner(auth_client, direct_db: DirectSessionManager):
    """D-8/AC 25: the picker demands the credited-visible predicate. A retained
    key-owner contributor with zero visible credits is never volunteered, even
    when its display name matches the query."""
    user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(user_id)).status_code == 200

    token = f"objref{uuid4().hex[:10]}"
    findable_name = f"Findable {token} Author"

    with direct_db.session() as session:
        media_id = create_searchable_media(session, user_id, title=f"Work {token}")

    # A credited, viewer-visible contributor: it MUST surface.
    contributors_service.replace_observed_role_slices(
        target=contributors_service.MediaTarget(media_id),
        observation=ObservedRoleSlices(
            managed_roles=frozenset({"author"}),
            credits=(
                ContributorObservation(
                    credited_name=findable_name, role="author", raw_role=None, identity_key=None
                ),
            ),
        ),
        source="epub_opf",
    )

    # A retained key owner with an external identity key but ZERO credits: it must
    # stay privately reusable yet undiscoverable through the picker.
    hidden_id = uuid4()
    hidden_name = f"Hidden {token} Owner"
    hidden_handle = f"hidden-{token}"
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO contributors (id, handle, display_name) "
                "VALUES (:id, :handle, :display)"
            ),
            {"id": hidden_id, "handle": hidden_handle, "display": hidden_name},
        )
        session.execute(
            text(
                "INSERT INTO contributor_aliases "
                "(contributor_id, alias, normalized_alias, resolves_identity) "
                "VALUES (:cid, :alias, :normalized, true)"
            ),
            {"cid": hidden_id, "alias": hidden_name, "normalized": hidden_name.lower()},
        )
        session.execute(
            text(
                "INSERT INTO contributor_external_ids (contributor_id, authority, external_key) "
                "VALUES (:cid, 'orcid', :key)"
            ),
            {"cid": hidden_id, "key": f"0000-0000-0000-{uuid4().hex[:4]}"},
        )
        session.commit()

    # FK-safe teardown (LIFO deletion): the media row's cleanup removes its credits,
    # so register contributors earliest (deleted last), then their aliases/external
    # ids, then the media and its content children.
    direct_db.register_cleanup("contributors", "display_name", findable_name)
    direct_db.register_cleanup("contributors", "id", hidden_id)
    direct_db.register_cleanup("contributor_external_ids", "contributor_id", hidden_id)
    direct_db.register_cleanup("contributor_aliases", "alias", findable_name)
    direct_db.register_cleanup("contributor_aliases", "alias", hidden_name)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    response = auth_client.get(
        f"/object-refs/search?q={token}&type=contributor",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 200, response.text
    objects = response.json()["data"]["objects"]
    returned_ids = {UUID(obj["objectId"]) for obj in objects}
    assert hidden_id not in returned_ids, (
        "a zero-work key owner must not surface in the contributor picker (D-8)"
    )
    assert any(obj["label"] == findable_name for obj in objects), (
        "a credited visible contributor matching the query must surface"
    )
