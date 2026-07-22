"""Integration tests for the resource provenance graph API routes.

Covers the spec §10 surface:
- /conversations/{id}/context-refs (replaces /conversations/{id}/references)
- /resource-graph/connections/query + /connections/summary (hydrated reads)
- /resource-graph/resolve

Assertions go through the API per testing standards. Link/stance authoring moved
to the dedicated /resource-graph/links and /stances commands (see
test_user_relations.py); connection READ tests seed ``origin='user'`` rows
directly through ``_seed_user_edge`` since no read-surface writes edges.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import ResourceEdge
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
    "activation",
    "label",
    "summary",
    "missing",
    "created_at",
}
RESOLVED_KEYS = {"ref", "label", "summary", "missing"}
SUMMARY_KEYS = {
    "ref",
    "total",
    "by_kind",
    "last_connected_at",
    "dominant_kind",
    "top_peers",
}


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
    return media_id


def _query_connections(auth_client, headers: dict[str, str], ref: str, **body):
    payload = {"refs": [ref], "direction": "both", "limit": 100, **body}
    return auth_client.post("/resource-graph/connections/query", headers=headers, json=payload)


def _summarize_connections(auth_client, headers: dict[str, str], refs: list[str], **body):
    payload = {"refs": refs, **body}
    return auth_client.post("/resource-graph/connections/summary", headers=headers, json=payload)


def _seed_citation_edge(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    source_scheme: str,
    source_id: UUID,
    target_media_id: UUID,
    ordinal: int = 1,
) -> UUID:
    """Seed an origin='citation' edge directly (no API writes citation origins)."""
    with direct_db.session() as session:
        edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme,
                    target_id, ordinal, snapshot
                )
                VALUES (
                    :user_id, 'supports', 'citation', :source_scheme, :source_id,
                    'media', :target_media_id, :ordinal, '{"title": "cited"}'::jsonb
                )
                RETURNING id
                """
            ),
            {
                "user_id": user_id,
                "source_scheme": source_scheme,
                "source_id": source_id,
                "target_media_id": target_media_id,
                "ordinal": ordinal,
            },
        ).scalar_one()
        session.commit()
    return edge_id


def _seed_user_edge(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    source_ref: str,
    target_ref: str,
    kind: str = "context",
) -> str:
    """Seed an origin='user' edge directly (Links/stances are now authored via the
    dedicated /resource-graph/links and /stances commands; connection READ tests
    only need the row in place)."""
    source_scheme, source_id = source_ref.split(":", 1)
    target_scheme, target_id = target_ref.split(":", 1)
    with direct_db.session() as session:
        edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :user_id, :kind, 'user', :source_scheme, :source_id,
                    :target_scheme, :target_id
                )
                RETURNING id
                """
            ),
            {
                "user_id": user_id,
                "kind": kind,
                "source_scheme": source_scheme,
                "source_id": source_id,
                "target_scheme": target_scheme,
                "target_id": target_id,
            },
        ).scalar_one()
        session.commit()
    return str(edge_id)


def _seed_synapse_edge(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    source_media_id: UUID,
    target_media_id: UUID,
) -> UUID:
    """Seed an origin='synapse' (AI) edge — must be excluded from the list surface."""
    with direct_db.session() as session:
        edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme,
                    target_id, ordinal, snapshot
                )
                VALUES (
                    :user_id, 'supports', 'synapse', 'media', :source_media_id,
                    'media', :target_media_id, NULL, '{"excerpt": "ai edge"}'::jsonb
                )
                RETURNING id
                """
            ),
            {
                "user_id": user_id,
                "source_media_id": source_media_id,
                "target_media_id": target_media_id,
            },
        ).scalar_one()
        session.commit()
    return edge_id


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
    assert data["activation"] == {
        "resource_ref": resource_ref,
        "kind": "route",
        "href": f"/media/{media_id}",
        "unresolved_reason": None,
    }
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


def test_query_connections_returns_edges_from_either_endpoint(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    a_media_id = _create_media(direct_db, user_id, title="Endpoint A")
    b_media_id = _create_media(direct_db, user_id, title="Endpoint B")

    edge_id = _seed_user_edge(
        direct_db,
        user_id=user_id,
        source_ref=f"media:{a_media_id}",
        target_ref=f"media:{b_media_id}",
    )

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

    _seed_user_edge(direct_db, user_id=user_id, source_ref=a_ref, target_ref=f"media:{b_media_id}")
    _seed_user_edge(
        direct_db,
        user_id=user_id,
        source_ref=a_ref,
        target_ref=f"media:{c_media_id}",
        kind="supports",
    )

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


# =============================================================================
# Connection summaries (collection surface, spec S4)
# =============================================================================


def test_connection_summary_counts_by_kind_and_excludes_synapse(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    subject_media_id = _create_media(direct_db, user_id, title="Subject Doc")
    user_peer_id = _create_media(direct_db, user_id, title="User Peer")
    citing_message_media_id = _create_media(direct_db, user_id, title="Cited Doc")
    synapse_peer_id = _create_media(direct_db, user_id, title="AI Peer")
    subject_ref = f"media:{subject_media_id}"

    # One user 'context' edge to user_peer.
    _seed_user_edge(
        direct_db, user_id=user_id, source_ref=subject_ref, target_ref=f"media:{user_peer_id}"
    )
    # One 'citation' edge FROM a message TO the subject media (subject is the target).
    with direct_db.session() as session:
        _conversation_id, message_id = create_test_conversation_with_message(
            session, user_id, role="assistant"
        )
    _seed_citation_edge(
        direct_db,
        user_id=user_id,
        source_scheme="message",
        source_id=message_id,
        target_media_id=subject_media_id,
    )
    # One 'synapse' (AI) edge — MUST be excluded from the list surface.
    _seed_synapse_edge(
        direct_db,
        user_id=user_id,
        source_media_id=synapse_peer_id,
        target_media_id=subject_media_id,
    )
    # A citation edge to an unrelated media (proves we scope to the subject's edges).
    # Distinct ordinal: uq_resource_edges_citation_ordinal is (user, source, ordinal).
    _seed_citation_edge(
        direct_db,
        user_id=user_id,
        source_scheme="message",
        source_id=message_id,
        target_media_id=citing_message_media_id,
        ordinal=2,
    )

    response = _summarize_connections(auth_client, headers, [subject_ref])
    assert response.status_code == 200, response.text
    summaries = response.json()["data"]["summaries"]
    assert len(summaries) == 1, summaries
    summary = summaries[0]
    assert set(summary) == SUMMARY_KEYS, (
        f"Summary payload must carry exactly {sorted(SUMMARY_KEYS)}; got {sorted(summary)}"
    )
    assert summary["ref"] == subject_ref
    # user 'context' edge (1) + citation 'supports' edge (1) = 2; synapse excluded.
    assert summary["total"] == 2, f"synapse edge must be excluded; got {summary}"
    assert summary["by_kind"] == {"context": 1, "supports": 1}
    assert summary["last_connected_at"] is not None
    # Peers carry the two non-synapse counterparts; the AI peer is absent.
    peer_refs = {peer["ref"] for peer in summary["top_peers"]}
    assert peer_refs == {f"media:{user_peer_id}", f"message:{message_id}"}, peer_refs
    assert f"media:{synapse_peer_id}" not in peer_refs


def test_connection_summary_rejects_explicit_non_list_origins(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    subject_media_id = _create_media(direct_db, user_id, title="Subject Doc")

    response = _summarize_connections(
        auth_client,
        headers,
        [f"media:{subject_media_id}"],
        origins=["synapse"],
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_connection_summary_dominant_kind_is_highest_count(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    subject_media_id = _create_media(direct_db, user_id, title="Dominant Subject")
    context_peer_id = _create_media(direct_db, user_id, title="Context Peer")
    subject_ref = f"media:{subject_media_id}"

    # One user 'context' edge + two 'supports' citation edges -> dominant=supports.
    _seed_user_edge(
        direct_db, user_id=user_id, source_ref=subject_ref, target_ref=f"media:{context_peer_id}"
    )
    with direct_db.session() as session:
        _conversation_id, message_id = create_test_conversation_with_message(
            session, user_id, role="assistant"
        )
    other_media_id = _create_media(direct_db, user_id, title="Support One")
    _seed_citation_edge(
        direct_db,
        user_id=user_id,
        source_scheme="message",
        source_id=message_id,
        target_media_id=subject_media_id,
        ordinal=1,
    )
    # Second supports edge from a different message source to the same subject.
    with direct_db.session() as session:
        _conversation_id2, message_id2 = create_test_conversation_with_message(
            session, user_id, role="assistant"
        )
    _seed_citation_edge(
        direct_db,
        user_id=user_id,
        source_scheme="message",
        source_id=message_id2,
        target_media_id=subject_media_id,
        ordinal=1,
    )
    assert other_media_id is not None

    response = _summarize_connections(auth_client, headers, [subject_ref])
    assert response.status_code == 200, response.text
    summary = response.json()["data"]["summaries"][0]
    assert summary["by_kind"] == {"context": 1, "supports": 2}
    assert summary["total"] == 3
    assert summary["dominant_kind"] == "supports"


def test_connection_summary_deleted_peer_comes_back_missing(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    subject_media_id = _create_media(direct_db, user_id, title="Subject With Dead Peer")
    doomed_peer_id = _create_media(direct_db, user_id, title="Doomed Peer")
    subject_ref = f"media:{subject_media_id}"

    _seed_user_edge(
        direct_db, user_id=user_id, source_ref=subject_ref, target_ref=f"media:{doomed_peer_id}"
    )

    # Delete the peer media out from under the edge (edges have no FKs by design),
    # leaving a dangling edge — the peer must hydrate missing, never leaked.
    with direct_db.session() as session:
        session.execute(
            text("DELETE FROM library_entries WHERE media_id = :id"), {"id": doomed_peer_id}
        )
        session.execute(text("DELETE FROM media WHERE id = :id"), {"id": doomed_peer_id})
        session.commit()

    response = _summarize_connections(auth_client, headers, [subject_ref])
    assert response.status_code == 200, response.text
    summary = response.json()["data"]["summaries"][0]
    # The edge still counts (provenance outlives the endpoint).
    assert summary["total"] == 1
    assert len(summary["top_peers"]) == 1
    peer = summary["top_peers"][0]
    assert peer["ref"] == f"media:{doomed_peer_id}"
    assert peer["missing"] is True, f"Deleted peer must hydrate missing: {peer}"
    assert peer["href"] is None, "A missing peer must not leak a route href"


def test_connection_summary_returns_one_entry_per_ref_in_order(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)
    connected_id = _create_media(direct_db, user_id, title="Has Edges")
    peer_id = _create_media(direct_db, user_id, title="Its Peer")
    isolated_id = _create_media(direct_db, user_id, title="No Edges")
    connected_ref = f"media:{connected_id}"
    isolated_ref = f"media:{isolated_id}"

    _seed_user_edge(
        direct_db, user_id=user_id, source_ref=connected_ref, target_ref=f"media:{peer_id}"
    )

    response = _summarize_connections(auth_client, headers, [isolated_ref, connected_ref])
    assert response.status_code == 200, response.text
    summaries = response.json()["data"]["summaries"]
    assert [s["ref"] for s in summaries] == [isolated_ref, connected_ref], (
        "Summaries must come back one-per-ref in request order"
    )
    assert summaries[0]["total"] == 0, "A ref with no edges summarizes to total 0"
    assert summaries[0]["by_kind"] == {}
    assert summaries[0]["dominant_kind"] is None
    assert summaries[0]["top_peers"] == []
    assert summaries[1]["total"] == 1


def test_connection_summary_rejects_malformed_ref_and_over_limit(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    headers = auth_headers(user_id)

    malformed = _summarize_connections(auth_client, headers, ["not-a-ref"])
    assert malformed.status_code == 400, malformed.text
    assert malformed.json()["error"]["code"] == "E_INVALID_REQUEST"

    over_limit = _summarize_connections(
        auth_client, headers, [f"media:{uuid4()}" for _ in range(201)]
    )
    assert over_limit.status_code == 400, over_limit.text
    assert over_limit.json()["error"]["code"] == "E_INVALID_REQUEST"


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
