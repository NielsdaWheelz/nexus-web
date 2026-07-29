"""Complete-collection contract for the primary conversation index."""

from urllib.parse import quote

import pytest

from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


def _create_conversation(auth_client, user_id):
    response = auth_client.post("/conversations", headers=auth_headers(user_id))
    assert response.status_code == 201, response.text
    return response.json()["data"]


def test_primary_index_is_one_strict_compact_collection_page(auth_client) -> None:
    user_id = create_test_user_id()
    created = _create_conversation(auth_client, user_id)

    response = auth_client.get("/conversations?limit=100", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    page = response.json()
    assert set(page) == {"data"}
    assert set(page["data"]) == {"items", "collectionRevision", "nextCursor"}
    assert page["data"]["nextCursor"] == {"kind": "Absent"}
    assert len(page["data"]["items"]) == 1
    assert page["data"]["items"][0] == {
        "id": created["id"],
        "title": created["title"],
        "message_count": 0,
        "updated_at": created["updated_at"],
    }


def test_primary_index_signed_chain_requires_revision_and_detects_change(auth_client) -> None:
    user_id = create_test_user_id()
    for _ in range(3):
        _create_conversation(auth_client, user_id)

    first_response = auth_client.get(
        "/conversations?scope=mine&limit=2",
        headers=auth_headers(user_id),
    )
    assert first_response.status_code == 200, first_response.text
    first = first_response.json()["data"]
    assert first["nextCursor"]["kind"] == "Present"
    cursor = first["nextCursor"]["value"]
    revision = first["collectionRevision"]

    missing_revision = auth_client.get(
        f"/conversations?scope=mine&limit=2&cursor={quote(cursor)}",
        headers=auth_headers(user_id),
    )
    assert missing_revision.status_code == 400
    assert missing_revision.json()["error"]["code"] == "E_INVALID_REQUEST"

    cross_mode = auth_client.get(
        (f"/conversations?scope=all&limit=2&cursor={quote(cursor)}&collection_revision={revision}"),
        headers=auth_headers(user_id),
    )
    assert cross_mode.status_code == 400
    assert cross_mode.json()["error"]["code"] == "E_INVALID_CURSOR"

    _create_conversation(auth_client, user_id)
    changed = auth_client.get(
        (
            "/conversations?scope=mine&limit=2"
            f"&cursor={quote(cursor)}&collection_revision={revision}"
        ),
        headers=auth_headers(user_id),
    )
    assert changed.status_code == 409
    assert changed.json()["error"]["code"] == "E_COLLECTION_CHANGED"


@pytest.mark.parametrize(
    "query",
    [
        "offset=0",
        "unknown=value",
        "limit=01",
        "scope=mine&scope=mine",
        "cursor=opaque",
        "collection_revision=0",
    ],
)
def test_primary_index_rejects_legacy_or_noncanonical_query_shapes(
    auth_client,
    query: str,
) -> None:
    user_id = create_test_user_id()

    response = auth_client.get(
        f"/conversations?{query}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_destination_and_context_modes_keep_explicit_pagination(auth_client) -> None:
    user_id = create_test_user_id()
    created = _create_conversation(auth_client, user_id)

    destination = auth_client.get(
        "/conversations?q=&limit=25",
        headers=auth_headers(user_id),
    )

    assert destination.status_code == 200, destination.text
    assert set(destination.json()) == {"data", "page"}
    assert destination.json()["page"] == {"next_cursor": None}
    assert destination.json()["data"][0]["id"] == created["id"]
    assert "owner_user_id" in destination.json()["data"][0]

    context = auth_client.get(
        "/conversations?has_context_ref=not-a-uri",
        headers=auth_headers(user_id),
    )
    assert context.status_code == 400
    assert context.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_retained_mode_cursors_are_signed_family_and_query_bound(auth_client) -> None:
    user_id = create_test_user_id()
    for _ in range(3):
        _create_conversation(auth_client, user_id)

    first = auth_client.get(
        "/conversations?q=&limit=1",
        headers=auth_headers(user_id),
    )
    assert first.status_code == 200, first.text
    cursor = first.json()["page"]["next_cursor"]
    assert cursor is not None

    changed_query = auth_client.get(
        f"/conversations?q=other&limit=1&cursor={quote(cursor)}",
        headers=auth_headers(user_id),
    )
    assert changed_query.status_code == 400
    assert changed_query.json()["error"]["code"] == "E_INVALID_CURSOR"

    cross_mode = auth_client.get(
        (
            "/conversations?"
            "has_context_ref=media%3A00000000-0000-4000-8000-000000000001"
            f"&limit=1&cursor={quote(cursor)}"
        ),
        headers=auth_headers(user_id),
    )
    assert cross_mode.status_code == 400
    assert cross_mode.json()["error"]["code"] == "E_INVALID_CURSOR"


@pytest.mark.parametrize(
    "query",
    [
        "q=one&q=two",
        "q=&scope=mine",
        "q=&has_context_ref=media%3A00000000-0000-4000-8000-000000000001",
        "q=&unknown=value",
        "q=&offset=0",
        "q=&collection_revision=0",
        "q=&limit=01",
        "has_context_ref=not-a-uri&scope=mine",
        "has_context_ref=not-a-uri&unknown=value",
    ],
)
def test_retained_modes_reject_cross_mode_legacy_or_noncanonical_queries(
    auth_client,
    query: str,
) -> None:
    user_id = create_test_user_id()
    response = auth_client.get(
        f"/conversations?{query}",
        headers=auth_headers(user_id),
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_delete_returns_the_new_revision_for_safe_row_removal(auth_client) -> None:
    user_id = create_test_user_id()
    created = _create_conversation(auth_client, user_id)
    before = auth_client.get("/conversations", headers=auth_headers(user_id)).json()["data"]

    deleted = auth_client.delete(
        f"/conversations/{created['id']}",
        headers=auth_headers(user_id),
    )

    assert deleted.status_code == 200, deleted.text
    assert set(deleted.json()["data"]) == {"collectionRevision"}
    assert deleted.json()["data"]["collectionRevision"] > before["collectionRevision"]
