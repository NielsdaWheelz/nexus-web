"""Route tests for media reader connection rows."""

import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.services.reader_connections import READER_CONNECTION_ORIGINS
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from tests.factories import (
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight_note,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_reader_connections_route_default_origin_policy_is_explicit():
    from nexus.api.routes.reader import _edge_origins

    assert _edge_origins(None) == READER_CONNECTION_ORIGINS


def _bootstrap_user(auth_client, direct_db: DirectSessionManager) -> UUID:
    user_id = create_test_user_id()
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("conversations", "owner_user_id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    return user_id


def _media(session, user_id: UUID, title: str) -> UUID:
    library_id = get_user_default_library(session, user_id)
    assert library_id is not None
    return create_test_media_in_library(session, user_id, library_id, title=title)


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def test_reader_connections_route_projects_incoming_and_outgoing_media_side_rows(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        media_id = _media(session, user_id, "Reader target")
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Reader cited body")
        _conversation_id, message_id = create_test_conversation_with_message(session, user_id)
        citation_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="fragment", id=fragment_id),
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title="Chat answer", excerpt="Reader cited body"),
            ),
        )
        highlight_id, note_block_id = create_test_highlight_note(
            session, user_id, media_id, body="Attached note"
        )
        session.commit()

    response = auth_client.get(
        f"/media/{media_id}/reader-connections", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    rows = response.json()["data"]["anchored"]
    incoming = next(row for row in rows if row["connection"]["edge_id"] == str(citation_edge.id))
    outgoing = next(
        row for row in rows if row["connection"]["source_ref"] == f"highlight:{highlight_id}"
    )
    assert incoming["connection"]["direction"] == "incoming"
    assert incoming["anchor"]["fragment_id"] == str(fragment_id)
    assert incoming["title"].startswith("user:")
    assert outgoing["connection"]["direction"] == "outgoing"
    assert outgoing["connection"]["target_ref"] == f"note_block:{note_block_id}"
    assert outgoing["anchor"]["highlight_id"] == str(highlight_id)
    assert outgoing["title"] == "Attached note"


def test_reader_connections_route_anchors_content_chunk_summary_locator(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    chunk_id = uuid4()
    with direct_db.session() as session:
        media_id = _media(session, user_id, "Chunk target")
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Alpha beta gamma")
        _conversation_id, message_id = create_test_conversation_with_message(session, user_id)
        session.execute(
            text(
                """
                INSERT INTO content_chunks (
                    id, owner_kind, owner_id, primary_evidence_span_id, chunk_idx,
                    source_kind, chunk_text, token_count, heading_path, summary_locator
                )
                VALUES (
                    :id, 'media', :media_id, NULL, 0,
                    'web_article', 'beta', 1, CAST('[]' AS jsonb), CAST(:locator AS jsonb)
                )
                """
            ),
            {
                "id": chunk_id,
                "media_id": media_id,
                "locator": json.dumps(
                    {
                        "type": "web_text_offsets",
                        "kind": "web_text",
                        "fragment_id": str(fragment_id),
                        "fragment_idx": 0,
                        "start_offset": 6,
                        "end_offset": 10,
                    }
                ),
            },
        )
        edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="content_chunk", id=chunk_id),
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title="Chunk citation", excerpt="beta"),
            ),
        )
        session.commit()

    response = auth_client.get(
        f"/media/{media_id}/reader-connections", headers=auth_headers(user_id)
    )

    assert response.status_code == 200, response.text
    row = next(
        item
        for item in response.json()["data"]["anchored"]
        if item["connection"]["edge_id"] == str(edge.id)
    )
    assert row["anchor"]["ref"] == f"content_chunk:{chunk_id}"
    assert row["anchor"]["fragment_id"] == str(fragment_id)
    assert row["anchor"]["locator"]["start_offset"] == 6
    assert row["anchor"]["locator"]["end_offset"] == 10
