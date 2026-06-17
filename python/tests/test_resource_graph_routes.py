"""Integration tests for the resource provenance graph API routes.

Covers the spec §10 surface:
- /conversations/{id}/context-refs (replaces /conversations/{id}/references)
- /resource-graph/edges (replaces /object-links)
- /resource-graph/resolve

Assertions go through the API per testing standards. The one direct ORM write
seeds a non-user-origin edge to exercise the route-level delete gate, since no
API writes non-user origins by design.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.schemas.notes import CreatePageRequest
from nexus.services import notes
from nexus.services.resource_graph.context import (
    admits_resource_for_conversation_read,
    batch_conversations_with_any_edge_to_ref,
    list_conversations_with_any_edge_to_ref,
    search_scope_refs_for_conversation,
)
from nexus.services.resource_graph.refs import ResourceRef
from tests.factories import (
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

CONTEXT_REF_KEYS = {
    "id",
    "conversation_id",
    "resource_ref",
    "label",
    "summary",
    "missing",
    "created_at",
}
EDGE_KEYS = {
    "id",
    "kind",
    "origin",
    "source_ref",
    "target_ref",
    "source_order_key",
    "target_order_key",
    "ordinal",
    "snapshot",
    "source_label",
    "source_missing",
    "target_label",
    "target_missing",
    "created_at",
}
RESOLVED_KEYS = {"ref", "label", "summary", "missing"}


def _bootstrap_user(auth_client, direct_db: DirectSessionManager) -> UUID:
    user_id = create_test_user_id()
    me_response = auth_client.get("/me", headers=auth_headers(user_id))
    assert me_response.status_code == 200, me_response.text
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("conversations", "owner_user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    return user_id


def _create_media(direct_db: DirectSessionManager, user_id: UUID, title: str) -> UUID:
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None, f"Bootstrapped user {user_id} must have a default library"
        media_id = create_test_media_in_library(session, user_id, library_id, title=title)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
    return media_id


def _query_connections(auth_client, headers: dict[str, str], ref: str, **body):
    payload = {"refs": [ref], "direction": "both", "limit": 100, **body}
    return auth_client.post("/resource-graph/connections/query", headers=headers, json=payload)


def _create_content_chunk(direct_db: DirectSessionManager, media_id: UUID) -> UUID:
    with direct_db.session() as session:
        chunk_id = session.execute(
            text(
                """
                INSERT INTO content_chunks (
                    owner_kind, owner_id, chunk_idx, source_kind, chunk_text,
                    token_count, heading_path, summary_locator
                )
                VALUES (
                    'media', :media_id, 0, 'web_article', 'Attachable chunk',
                    2, '[]'::jsonb, '{}'::jsonb
                )
                RETURNING id
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        session.commit()
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
    return chunk_id


# =============================================================================
# Conversation context refs
# =============================================================================


def test_add_context_ref_returns_resolved_payload_and_is_idempotent(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Context API Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    resource_ref = f"media:{media_id}"
    response = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=headers,
        json={"resource_ref": resource_ref},
    )

    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert set(data) == CONTEXT_REF_KEYS, (
        f"Context-ref payload must carry exactly {sorted(CONTEXT_REF_KEYS)}; got {sorted(data)}"
    )
    assert data["resource_ref"] == resource_ref
    assert data["conversation_id"] == str(conversation_id)
    assert "Context API Doc" in data["label"], f"Label should be hydrated; got {data['label']!r}"
    assert data["missing"] is False

    duplicate = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=headers,
        json={"resource_ref": resource_ref},
    )
    assert duplicate.status_code == 201, duplicate.text
    assert duplicate.json()["data"]["id"] == data["id"], (
        "Re-adding the same ref must return the existing edge id, not a second row"
    )

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert listing.status_code == 200, listing.text
    rows = listing.json()["data"]
    assert len(rows) == 1, f"Idempotent add must leave one row; got {rows}"


def test_add_context_ref_does_not_touch_non_context_edge_to_same_target(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Context API Doc")
    source_media_id = _create_media(direct_db, user_id, title="Supporting Source")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        support_edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id,
                    ordinal, snapshot
                )
                VALUES (
                    :user_id, 'supports', 'synapse', 'media', :source_media_id,
                    'media', :media_id, NULL, '{"excerpt": "supporting edge"}'::jsonb
                )
                RETURNING id
                """
            ),
            {"user_id": user_id, "source_media_id": source_media_id, "media_id": media_id},
        ).scalar_one()
        session.commit()

    target_ref = f"media:{media_id}"
    attached = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=headers,
        json={"resource_ref": target_ref},
    )
    assert attached.status_code == 201, attached.text
    assert attached.json()["data"]["id"] != str(support_edge_id)

    with direct_db.session() as session:
        rows = session.execute(
            text(
                """
                SELECT origin, kind, COUNT(*)
                FROM resource_edges
                WHERE target_scheme = 'media'
                  AND target_id = :media_id
                GROUP BY origin, kind
                """
            ),
            {"media_id": media_id},
        ).all()
    assert {(origin, kind): count for origin, kind, count in rows} == {
        ("synapse", "supports"): 1,
        ("user", "context"): 1,
    }


def test_context_ref_surface_ignores_ordinal_citation_edges(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Citation-only Context Doc")
    with direct_db.session() as session:
        conversation_id, message_id = create_test_conversation_with_message(
            session, user_id, role="assistant"
        )
        citation_edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme,
                    target_id, ordinal, snapshot
                )
                VALUES (
                    :user_id, 'context', 'citation', 'message', :message_id,
                    'media', :media_id, 1, '{"title": "citation only"}'::jsonb
                )
                RETURNING id
                """
            ),
            {"user_id": user_id, "message_id": message_id, "media_id": media_id},
        ).scalar_one()
        session.commit()

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert listing.status_code == 200, listing.text
    assert listing.json()["data"] == []

    removed = auth_client.delete(
        f"/conversations/{conversation_id}/context-refs/{citation_edge_id}", headers=headers
    )
    assert removed.status_code == 404, removed.text

    attached = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=headers,
        json={"resource_ref": f"media:{media_id}"},
    )
    assert attached.status_code == 201, attached.text

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert [row["resource_ref"] for row in listing.json()["data"]] == [f"media:{media_id}"]

    with direct_db.session() as session:
        assert session.get(ResourceEdge, citation_edge_id) is not None


def test_broad_read_admission_is_not_search_scope(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    media_id = _create_media(direct_db, user_id, title="Broad Admission Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id,
                    ordinal, snapshot
                )
                VALUES (
                    :user_id, 'supports', 'user', 'conversation', :conversation_id,
                    'media', :media_id, NULL, NULL
                )
                """
            ),
            {"user_id": user_id, "conversation_id": conversation_id, "media_id": media_id},
        )
        session.commit()

    with direct_db.session() as session:
        target = ResourceRef(scheme="media", id=media_id)
        assert admits_resource_for_conversation_read(
            session, conversation_id=conversation_id, target=target
        )
        page = list_conversations_with_any_edge_to_ref(session, viewer_id=user_id, target=target)
        assert [conversation.id for conversation in page.conversations] == [conversation_id]
        batch = batch_conversations_with_any_edge_to_ref(
            session, viewer_id=user_id, targets=[media_id], target_scheme="media"
        )
        assert [conversation.id for conversation in batch[media_id]] == [conversation_id]
        assert (
            search_scope_refs_for_conversation(
                session, viewer_id=user_id, conversation_id=conversation_id
            )
            == []
        )


def test_reverse_context_edge_lookup_requires_edge_owner(
    auth_client, direct_db: DirectSessionManager
):
    owner_id = _bootstrap_user(auth_client, direct_db)
    intruder_id = _bootstrap_user(auth_client, direct_db)
    media_id = _create_media(direct_db, owner_id, title="Wrong Owner Edge Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, owner_id)
        target = ResourceRef(scheme="media", id=media_id)
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :intruder_id, 'context', 'user', 'conversation', :conversation_id,
                    'media', :media_id
                )
                """
            ),
            {
                "intruder_id": intruder_id,
                "conversation_id": conversation_id,
                "media_id": media_id,
            },
        )
        session.commit()

    with direct_db.session() as session:
        page = list_conversations_with_any_edge_to_ref(session, viewer_id=owner_id, target=target)
        assert page.conversations == []
        batch = batch_conversations_with_any_edge_to_ref(
            session, viewer_id=owner_id, targets=[media_id], target_scheme="media"
        )
        assert batch == {}

    response = auth_client.get(
        f"/conversations?has_context_ref=media:{media_id}",
        headers=auth_headers(owner_id),
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"] == []


def test_add_context_ref_rejects_malformed_ref(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    response = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=auth_headers(user_id),
        json={"resource_ref": "not-a-ref"},
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_add_context_ref_rejects_unknown_body_field(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    response = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=auth_headers(user_id),
        json={"resource_uri": f"media:{uuid4()}"},
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_add_context_ref_missing_resource_returns_404(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    response = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=auth_headers(user_id),
        json={"resource_ref": f"media:{uuid4()}"},
    )

    assert response.status_code == 404, response.text


def test_list_context_refs_orders_first_attached(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    first_media_id = _create_media(direct_db, user_id, title="First Doc")
    second_media_id = _create_media(direct_db, user_id, title="Second Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    for media_id in (first_media_id, second_media_id):
        response = auth_client.post(
            f"/conversations/{conversation_id}/context-refs",
            headers=headers,
            json={"resource_ref": f"media:{media_id}"},
        )
        assert response.status_code == 201, response.text

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert listing.status_code == 200, listing.text
    refs = [row["resource_ref"] for row in listing.json()["data"]]
    assert refs == [f"media:{first_media_id}", f"media:{second_media_id}"], (
        f"Context refs should list in first-attached order; got {refs}"
    )


def test_create_conversation_initial_context_refs_preserves_request_order(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Ordered Context Doc")
    chunk_id = _create_content_chunk(direct_db, media_id)
    expected_refs = [f"media:{media_id}", f"content_chunk:{chunk_id}"]

    created = auth_client.post(
        "/conversations",
        headers=headers,
        json={"initial_context_refs": expected_refs},
    )
    assert created.status_code == 201, created.text
    conversation_id = created.json()["data"]["id"]

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert listing.status_code == 200, listing.text
    refs = [row["resource_ref"] for row in listing.json()["data"]]
    assert refs == expected_refs


def test_remove_context_ref_deletes_row(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Doomed Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)

    added = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=headers,
        json={"resource_ref": f"media:{media_id}"},
    )
    assert added.status_code == 201, added.text
    edge_id = added.json()["data"]["id"]

    removed = auth_client.delete(
        f"/conversations/{conversation_id}/context-refs/{edge_id}", headers=headers
    )
    assert removed.status_code == 204, removed.text

    listing = auth_client.get(f"/conversations/{conversation_id}/context-refs", headers=headers)
    assert listing.json()["data"] == [], "Conversation should hold zero context refs after remove"

    removed_again = auth_client.delete(
        f"/conversations/{conversation_id}/context-refs/{edge_id}", headers=headers
    )
    assert removed_again.status_code == 404, removed_again.text


def test_context_refs_owner_only(auth_client, direct_db: DirectSessionManager):
    owner_id = _bootstrap_user(auth_client, direct_db)
    intruder_id = _bootstrap_user(auth_client, direct_db)
    media_id = _create_media(direct_db, intruder_id, title="Intruder Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, owner_id)

    intruder_headers = auth_headers(intruder_id)
    add_response = auth_client.post(
        f"/conversations/{conversation_id}/context-refs",
        headers=intruder_headers,
        json={"resource_ref": f"media:{media_id}"},
    )
    assert add_response.status_code == 404, (
        f"Non-owner add must 404, not leak existence: {add_response.text}"
    )

    list_response = auth_client.get(
        f"/conversations/{conversation_id}/context-refs", headers=intruder_headers
    )
    assert list_response.status_code == 404, (
        f"Non-owner list must 404, not leak existence: {list_response.text}"
    )


# =============================================================================
# Edges (user links + connections read)
# =============================================================================


def test_create_edge_defaults_to_context_kind_and_user_origin(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    source_media_id = _create_media(direct_db, user_id, title="Link Source")
    target_media_id = _create_media(direct_db, user_id, title="Link Target")

    response = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(user_id),
        json={"source_ref": f"media:{source_media_id}", "target_ref": f"media:{target_media_id}"},
    )

    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert set(data) == EDGE_KEYS, (
        f"Edge payload must carry exactly {sorted(EDGE_KEYS)}; got {sorted(data)}"
    )
    assert data["kind"] == "context", f"kind must default to context; got {data['kind']}"
    assert data["origin"] == "user", f"origin must be forced to user; got {data['origin']}"
    assert data["source_ref"] == f"media:{source_media_id}"
    assert data["target_ref"] == f"media:{target_media_id}"
    assert data["ordinal"] is None
    assert data["snapshot"] is None
    assert "Link Source" in data["source_label"], f"Hydrated source label: {data['source_label']}"
    assert "Link Target" in data["target_label"], f"Hydrated target label: {data['target_label']}"
    assert data["source_missing"] is False
    assert data["target_missing"] is False


def test_create_edge_accepts_stance_kind(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    source_media_id = _create_media(direct_db, user_id, title="Claim Doc")
    target_media_id = _create_media(direct_db, user_id, title="Counter Doc")

    response = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(user_id),
        json={
            "source_ref": f"media:{source_media_id}",
            "target_ref": f"media:{target_media_id}",
            "kind": "contradicts",
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["data"]["kind"] == "contradicts"


def test_create_edge_accepts_page_and_note_media_attachments(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    direct_db.register_cleanup("resource_view_states", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    media_id = _create_media(direct_db, user_id, title="Attached PDF")
    with direct_db.session() as session:
        page = notes.create_page(
            session,
            user_id,
            CreatePageRequest(title="Attachment page"),
        )
        page_id = page.id
        block = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "text", "text": "Attach here"}],
            },
            body_text="Attach here",
        )
        block_id = block.id
        session.add(block)
        session.flush()
        session.add(
            ResourceEdge(
                id=uuid4(),
                user_id=user_id,
                kind="context",
                origin="user",
                source_scheme="page",
                source_id=page_id,
                target_scheme="note_block",
                target_id=block_id,
                source_order_key="0000000001",
            )
        )
        session.commit()

    headers = auth_headers(user_id)
    page_response = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": f"page:{page_id}", "target_ref": f"media:{media_id}"},
    )
    block_response = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": f"note_block:{block_id}", "target_ref": f"media:{media_id}"},
    )

    assert page_response.status_code == 201, page_response.text
    assert block_response.status_code == 201, block_response.text
    assert page_response.json()["data"]["origin"] == "user"
    assert block_response.json()["data"]["origin"] == "user"
    assert page_response.json()["data"]["target_ref"] == f"media:{media_id}"
    assert block_response.json()["data"]["target_ref"] == f"media:{media_id}"


def test_create_edge_rejects_unknown_kind(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    source_media_id = _create_media(direct_db, user_id, title="Kind Doc")

    response = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(user_id),
        json={
            "source_ref": f"media:{source_media_id}",
            "target_ref": f"media:{source_media_id}",
            "kind": "refutes",
        },
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_create_edge_rejects_malformed_ref(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)

    response = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(user_id),
        json={"source_ref": "junk", "target_ref": f"media:{uuid4()}"},
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_create_edge_missing_target_returns_404(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    source_media_id = _create_media(direct_db, user_id, title="Real Source")

    response = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(user_id),
        json={"source_ref": f"media:{source_media_id}", "target_ref": f"media:{uuid4()}"},
    )

    assert response.status_code == 404, (
        f"Writes must reject missing targets (spec §7.3): {response.text}"
    )


def test_create_edge_duplicate_pair_rejected_both_directions(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    a_media_id = _create_media(direct_db, user_id, title="Pair A")
    b_media_id = _create_media(direct_db, user_id, title="Pair B")
    a_ref = f"media:{a_media_id}"
    b_ref = f"media:{b_media_id}"

    first = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": a_ref, "target_ref": b_ref},
    )
    assert first.status_code == 201, first.text

    duplicate = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": a_ref, "target_ref": b_ref},
    )
    assert duplicate.status_code == 400, (
        f"Duplicate user pair must be rejected; got {duplicate.status_code}: {duplicate.text}"
    )

    reversed_duplicate = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": b_ref, "target_ref": a_ref},
    )
    assert reversed_duplicate.status_code == 400, (
        f"User-link dedup is undirected; got {reversed_duplicate.status_code}: "
        f"{reversed_duplicate.text}"
    )


def test_query_connections_returns_edges_from_either_endpoint(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    a_media_id = _create_media(direct_db, user_id, title="Endpoint A")
    b_media_id = _create_media(direct_db, user_id, title="Endpoint B")

    created = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": f"media:{a_media_id}", "target_ref": f"media:{b_media_id}"},
    )
    assert created.status_code == 201, created.text
    edge_id = created.json()["data"]["id"]

    for ref in (f"media:{a_media_id}", f"media:{b_media_id}"):
        listing = _query_connections(auth_client, headers, ref)
        assert listing.status_code == 200, listing.text
        ids = [edge["edge_id"] for edge in listing.json()["data"]["items"]]
        assert ids == [edge_id], f"Edge must be listed from either endpoint (ref={ref}); got {ids}"


def test_query_connections_filters_by_kind_and_origin(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    a_media_id = _create_media(direct_db, user_id, title="Filter A")
    b_media_id = _create_media(direct_db, user_id, title="Filter B")
    c_media_id = _create_media(direct_db, user_id, title="Filter C")
    a_ref = f"media:{a_media_id}"

    context_edge = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": a_ref, "target_ref": f"media:{b_media_id}"},
    )
    assert context_edge.status_code == 201, context_edge.text
    supports_edge = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": a_ref, "target_ref": f"media:{c_media_id}", "kind": "supports"},
    )
    assert supports_edge.status_code == 201, supports_edge.text

    kind_filtered = _query_connections(auth_client, headers, a_ref, filters={"kinds": ["supports"]})
    assert kind_filtered.status_code == 200, kind_filtered.text
    kinds = [edge["kind"] for edge in kind_filtered.json()["data"]["items"]]
    assert kinds == ["supports"], f"kind filter must apply; got {kinds}"

    origin_filtered = _query_connections(auth_client, headers, a_ref, filters={"origins": ["user"]})
    assert origin_filtered.status_code == 200, origin_filtered.text
    assert len(origin_filtered.json()["data"]["items"]) == 2, origin_filtered.text


def test_query_connections_rejects_unknown_kind_and_origin_values(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    ref = f"media:{uuid4()}"

    bad_kind = _query_connections(auth_client, headers, ref, filters={"kinds": ["banana"]})
    assert bad_kind.status_code == 400, bad_kind.text
    assert bad_kind.json()["error"]["code"] == "E_INVALID_REQUEST"

    bad_origin = _query_connections(auth_client, headers, ref, filters={"origins": ["banana"]})
    assert bad_origin.status_code == 400, bad_origin.text
    assert bad_origin.json()["error"]["code"] == "E_INVALID_REQUEST"

    bad_ref = _query_connections(auth_client, headers, "not-a-ref")
    assert bad_ref.status_code == 400, bad_ref.text
    assert bad_ref.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_delete_edge_removes_user_edge(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    a_media_id = _create_media(direct_db, user_id, title="Delete A")
    b_media_id = _create_media(direct_db, user_id, title="Delete B")
    a_ref = f"media:{a_media_id}"

    created = auth_client.post(
        "/resource-graph/edges",
        headers=headers,
        json={"source_ref": a_ref, "target_ref": f"media:{b_media_id}"},
    )
    assert created.status_code == 201, created.text
    edge_id = created.json()["data"]["id"]

    deleted = auth_client.delete(f"/resource-graph/edges/{edge_id}", headers=headers)
    assert deleted.status_code == 204, deleted.text

    listing = _query_connections(auth_client, headers, a_ref)
    assert listing.json()["data"]["items"] == [], "Edge should be gone after delete"

    deleted_again = auth_client.delete(f"/resource-graph/edges/{edge_id}", headers=headers)
    assert deleted_again.status_code == 404, deleted_again.text


def test_delete_edge_refuses_non_user_origin_rows(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    media_id = _create_media(direct_db, user_id, title="Cited Doc")
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        # Seeded directly: no API writes non-user origins by design (the
        # citation pipeline owns them), so the gate needs an ORM fixture.
        edge = ResourceEdge(
            user_id=user_id,
            kind="context",
            origin="citation",
            source_scheme="conversation",
            source_id=conversation_id,
            target_scheme="media",
            target_id=media_id,
        )
        session.add(edge)
        session.commit()
        edge_id = edge.id

    response = auth_client.delete(f"/resource-graph/edges/{edge_id}", headers=headers)
    assert response.status_code == 403, (
        f"Non-user-origin rows must not be deletable here: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_FORBIDDEN"

    listing = _query_connections(
        auth_client, headers, f"media:{media_id}", filters={"origins": ["citation"]}
    )
    assert listing.status_code == 200, listing.text
    assert [edge["edge_id"] for edge in listing.json()["data"]["items"]] == [str(edge_id)], (
        "Citation edge must survive the refused delete"
    )


def test_delete_edge_unknown_id_returns_404(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)

    response = auth_client.delete(f"/resource-graph/edges/{uuid4()}", headers=auth_headers(user_id))

    assert response.status_code == 404, response.text


def test_delete_edge_another_users_edge_returns_404(auth_client, direct_db: DirectSessionManager):
    """The viewer-scoped accessor 404s another user's edge — it must not leak its
    existence (and must not 403, which would confirm the row)."""
    owner_id = _bootstrap_user(auth_client, direct_db)
    intruder_id = _bootstrap_user(auth_client, direct_db)
    source_media_id = _create_media(direct_db, owner_id, title="Owner Source")
    target_media_id = _create_media(direct_db, owner_id, title="Owner Target")

    created = auth_client.post(
        "/resource-graph/edges",
        headers=auth_headers(owner_id),
        json={"source_ref": f"media:{source_media_id}", "target_ref": f"media:{target_media_id}"},
    )
    assert created.status_code == 201, created.text
    edge_id = created.json()["data"]["id"]

    response = auth_client.delete(
        f"/resource-graph/edges/{edge_id}", headers=auth_headers(intruder_id)
    )
    assert response.status_code == 404, (
        f"Another user's edge must 404, not leak existence: {response.text}"
    )

    listing = _query_connections(auth_client, auth_headers(owner_id), f"media:{source_media_id}")
    assert [edge["edge_id"] for edge in listing.json()["data"]["items"]] == [edge_id], (
        "The owner's edge must survive an intruder's refused delete"
    )


# =============================================================================
# Resolve
# =============================================================================


def test_resolve_refs_returns_labels_and_missing_state(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    media_id = _create_media(direct_db, user_id, title="Resolvable Doc")
    missing_ref = f"media:{uuid4()}"

    response = auth_client.post(
        "/resource-graph/resolve",
        headers=auth_headers(user_id),
        json={"refs": [f"media:{media_id}", missing_ref]},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data) == 2, f"Resolve must return one item per input ref; got {data}"
    assert set(data[0]) == RESOLVED_KEYS, (
        f"Resolve payload must carry exactly {sorted(RESOLVED_KEYS)}; got {sorted(data[0])}"
    )
    assert data[0]["ref"] == f"media:{media_id}"
    assert "Resolvable Doc" in data[0]["label"]
    assert data[0]["missing"] is False
    assert data[1]["ref"] == missing_ref
    assert data[1]["missing"] is True, "Unknown refs must hydrate as missing, not error"


def test_resolve_refs_rejects_malformed_and_empty_input(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)

    malformed = auth_client.post(
        "/resource-graph/resolve", headers=headers, json={"refs": ["junk"]}
    )
    assert malformed.status_code == 400, malformed.text
    assert malformed.json()["error"]["code"] == "E_INVALID_REQUEST"

    empty = auth_client.post("/resource-graph/resolve", headers=headers, json={"refs": []})
    assert empty.status_code == 400, empty.text
