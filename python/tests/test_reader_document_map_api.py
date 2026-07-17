"""Route tests for the reader Document Map aggregate."""

import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.services.reader_apparatus import replace_media_apparatus, source_fingerprint
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from tests.factories import (
    add_context_edge,
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight_note,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_document_map_aggregates_reader_evidence(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Document Map target"
        )
        fragment_id = create_test_fragment(session, media_id, "Claim1\n1. Source note.")
        _seed_heading(session, media_id, fragment_id)
        _seed_document_embed(session, media_id, fragment_id)
        _register_media_cleanup(direct_db, media_id)

        highlight_id, note_block_id = create_test_highlight_note(
            session, user_id, media_id, body="Attached note"
        )
        conversation_id, message_id = create_test_conversation_with_message(session, user_id)
        add_context_edge(session, conversation_id, f"media:{media_id}")
        citation_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="fragment", id=fragment_id),
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title="Chat answer", excerpt="Claim1"),
            ),
        )
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("document-map-test", media_id),
            items=[
                _apparatus_item(media_id, fragment_id, stable_key="marker"),
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="target",
                    kind="footnote",
                    start_offset=7,
                    end_offset=21,
                ),
            ],
            edges=[
                {
                    "stable_key": "marker->target",
                    "from_stable_key": "marker",
                    "to_stable_key": "target",
                    "relation": "points_to_note",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html"},
                    "sort_key": "000000.edge",
                }
            ],
        )
        session.commit()

    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("conversations", "owner_user_id", user_id)

    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "ready"
    assert [lens["id"] for lens in data["lenses"]] == [
        "contents",
        "embeds",
        "highlights",
        "citations",
        "connections",
        "chat",
    ]
    items = data["items"]
    assert _item(items, "section:overview")["source_domain"] == "navigation"
    embed_lens = next(lens for lens in data["lenses"] if lens["id"] == "embeds")
    assert embed_lens["status"] == "ready"
    embed = next(item for item in items if item["kind"] == "document_embed")
    assert embed["source_domain"] == "document_embeds"
    assert embed["document_embed_id"]
    assert embed["provider"] == "generic"
    assert embed["resolution_status"] == "unsupported"
    assert embed["anchor"]["fragment_id"] == str(fragment_id)
    assert embed["actions"] == ["activate"]
    highlight = _item(items, f"highlight:{highlight_id}")
    assert highlight["note_block_count"] == 1
    assert highlight["source_domain"] == "highlight"
    assert highlight["target_status"] == "exact"
    assert "stable_key" not in highlight
    apparatus = _item(items, "apparatus:marker")
    assert apparatus["source_domain"] == "reader_apparatus"
    assert apparatus["target_stable_keys"] == ["target"]
    assert "highlight_id" not in apparatus
    connection = _item(items, f"connection:{citation_edge.id}")
    assert connection["source_domain"] == "generated_citation"
    assert connection["edge_id"] == str(citation_edge.id)
    assert "conversation_id" not in connection
    rows = data["connections"]["anchored"]
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
    chat = _item(items, f"chat:{conversation_id}")
    assert chat["source_domain"] == "chat"
    assert "edge_id" not in chat
    assert {marker["lens_id"] for marker in data["markers"]} >= {
        "contents",
        "embeds",
        "highlights",
        "citations",
        "connections",
    }
    assert data["connections"]["anchored"]
    assert data["apparatus"]["items"]
    assert data["chat_threads"][0]["id"] == str(conversation_id)
    assert str(note_block_id)


@pytest.mark.parametrize(
    ("artifact_status", "row_statuses"),
    [
        ("empty", []),
        ("failed", []),
        ("resolving", ["resolving"]),
        ("partial", ["resolved", "failed"]),
        ("ready", ["resolved"]),
        ("unsupported", []),
    ],
)
def test_document_map_embed_lens_uses_artifact_state_status(
    auth_client,
    direct_db: DirectSessionManager,
    artifact_status: str,
    row_statuses: list[str],
):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session, user_id, library_id, title=f"Embeds {artifact_status}"
        )
        fragment_id = create_test_fragment(session, media_id, "Embedded media")
        _seed_heading(session, media_id, fragment_id)
        _seed_document_embed_state(session, media_id, artifact_status, row_statuses, fragment_id)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint(
                f"document-map-embeds-{artifact_status}", media_id
            ),
            items=[],
            edges=[],
            status="empty",
        )
        _register_media_cleanup(direct_db, media_id)
        session.commit()

    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    embed_lens = next(lens for lens in response.json()["data"]["lenses"] if lens["id"] == "embeds")
    assert embed_lens["status"] == artifact_status


def test_document_map_anchors_content_chunk_summary_locator(auth_client, direct_db):
    user_id = _bootstrap_user(auth_client, direct_db)
    chunk_id = uuid4()
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Alpha beta gamma")
        _seed_heading(session, media_id, fragment_id)
        _conversation_id, message_id = create_test_conversation_with_message(session, user_id)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("document-map-empty", media_id),
            items=[],
            edges=[],
            status="empty",
        )
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
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    row = next(
        item
        for item in data["connections"]["anchored"]
        if item["connection"]["edge_id"] == str(edge.id)
    )
    connection = _item(data["items"], f"connection:{edge.id}")
    assert row["anchor"]["ref"] == f"content_chunk:{chunk_id}"
    assert row["anchor"]["fragment_id"] == str(fragment_id)
    assert row["anchor"]["locator"]["start_offset"] == 6
    assert row["anchor"]["locator"]["end_offset"] == 10
    assert connection["anchor"]["ref"] == f"content_chunk:{chunk_id}"
    assert connection["document_order_key"] == row["anchor"]["order_key"]
    assert connection["document_order_key"].endswith(":0000000006")


def test_document_map_replaces_old_reader_product_routes(auth_client, direct_db):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)

    for path in (
        f"/media/{media_id}/reader-connections",
        f"/media/{media_id}/apparatus",
    ):
        response = auth_client.get(path, headers=auth_headers(user_id))
        assert response.status_code == 404, response.text


def _bootstrap_user(auth_client, direct_db: DirectSessionManager) -> UUID:
    user_id = create_test_user_id()
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("users", "id", user_id)
    return user_id


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("content_chunks", "owner_id", media_id)
    direct_db.register_cleanup("content_blocks", "owner_id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    direct_db.register_cleanup("reader_apparatus_edges", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_items", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_states", "media_id", media_id)
    direct_db.register_cleanup("document_embeds", "media_id", media_id)
    direct_db.register_cleanup("document_embed_artifact_states", "media_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


def _seed_heading(session, media_id: UUID, fragment_id: UUID) -> None:
    session.execute(
        text(
            """
            INSERT INTO content_index_states (owner_kind, owner_id, status)
            VALUES ('media', :media_id, 'ready')
            """
        ),
        {"media_id": media_id},
    )
    session.execute(
        text(
            """
            INSERT INTO content_blocks (
                owner_kind, owner_id, block_idx, block_kind,
                canonical_text, extraction_confidence,
                source_start_offset, source_end_offset,
                heading_path, locator, selector, metadata
            )
            VALUES (
                'media', :media_id, 0, 'heading',
                'Overview', 1.0, 0, 8,
                '[]'::jsonb, CAST(:locator AS jsonb), '{}'::jsonb, CAST(:metadata AS jsonb)
            )
            """
        ),
        {
            "media_id": media_id,
            "locator": json.dumps(
                {
                    "section_id": "overview",
                    "fragment_id": str(fragment_id),
                    "fragment_idx": 0,
                    "heading_level": 1,
                    "start_offset": 0,
                    "end_offset": 8,
                }
            ),
            "metadata": json.dumps({"section_id": "overview", "ordinal": 0, "depth": 1}),
        },
    )


def _seed_document_embed(session, media_id: UUID, fragment_id: UUID) -> None:
    _seed_document_embed_state(session, media_id, "ready", ["unsupported"], fragment_id)


def _seed_document_embed_state(
    session,
    media_id: UUID,
    status: str,
    row_statuses: list[str],
    fragment_id: UUID,
) -> None:
    total_count = len(row_statuses)
    resolved_count = sum(1 for value in row_statuses if value == "resolved")
    unsupported_count = sum(1 for value in row_statuses if value == "unsupported")
    failed_count = sum(1 for value in row_statuses if value == "failed")
    session.execute(
        text(
            """
            INSERT INTO document_embed_artifact_states (
                media_id, status, total_count, resolved_count, unsupported_count, failed_count
            )
            VALUES (
                :media_id, :status, :total_count, :resolved_count,
                :unsupported_count, :failed_count
            )
            """
        ),
        {
            "media_id": media_id,
            "status": status,
            "total_count": total_count,
            "resolved_count": resolved_count,
            "unsupported_count": unsupported_count,
            "failed_count": failed_count,
        },
    )
    for ordinal, row_status in enumerate(row_statuses):
        session.execute(
            text(
                """
                INSERT INTO document_embeds (
                    media_id, fragment_id, ordinal, occurrence_key, provider, embed_kind,
                    source_shape, resolution_status, placeholder_text,
                    canonical_start_offset, canonical_end_offset, document_order_key
                )
                VALUES (
                    :media_id, :fragment_id, :ordinal, :occurrence_key, 'generic', 'unknown',
                    'iframe', :row_status, 'Unsupported embedded content: player.example',
                    0, 44, :document_order_key
                )
                """
            ),
            {
                "media_id": media_id,
                "fragment_id": fragment_id,
                "ordinal": ordinal,
                "occurrence_key": f"embed:document-map:{ordinal}",
                "row_status": row_status,
                "document_order_key": f"{ordinal:06d}",
            },
        )


def _apparatus_item(
    media_id: UUID,
    fragment_id: UUID,
    *,
    stable_key: str,
    kind: str = "footnote_ref",
    start_offset: int = 5,
    end_offset: int = 6,
) -> dict[str, object]:
    return {
        "stable_key": stable_key,
        "kind": kind,
        "label": "1",
        "body_text": None if kind.endswith("_ref") else "1. Source note.",
        "body_html_sanitized": None,
        "locator": {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": start_offset,
            "end_offset": end_offset,
            "media_kind": "web_article",
            "text_quote_selector": {"exact": "1"},
        },
        "confidence": "exact",
        "extraction_method": "html_semantic",
        "source_ref": {"format": "html"},
        "sort_key": f"000000.{stable_key}",
    }


def _item(items: list[dict[str, object]], item_id: str, *, required: bool = True):
    match = next((item for item in items if item["id"] == item_id), None)
    if required:
        assert match is not None, f"missing {item_id} in {[item['id'] for item in items]}"
    return match
