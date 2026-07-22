"""Route tests for the reader Document Map aggregate."""

import json
import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services import reader_document_map
from nexus.services.reader_apparatus import replace_media_apparatus, source_fingerprint
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from tests.factories import (
    add_context_edge,
    add_library_member,
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_highlight_note,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_document_map_reads_one_repeatable_cross_owner_snapshot(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session,
            user_id,
            library_id,
            title="Snapshot target",
        )
        fragment_id = create_test_fragment(session, media_id, "Stable target text")
        _seed_heading(session, media_id, fragment_id)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("snapshot", "before"),
            items=[],
            edges=[],
            status="empty",
        )
        conversation_id, _message_id = create_test_conversation_with_message(session, user_id)
        session.commit()
    _register_media_cleanup(direct_db, media_id)

    highlights_read = threading.Event()
    writer_finished = threading.Event()
    writer_errors: list[BaseException] = []
    written_highlight_ids: list[UUID] = []
    original = reader_document_map.highlights.list_highlights_for_media

    def pause_after_highlight_read(
        db: Session,
        viewer_id: UUID,
        media_id: UUID,
        mine_only: bool = True,
    ):
        result = original(db, viewer_id, media_id, mine_only)
        highlights_read.set()
        assert writer_finished.wait(timeout=10)
        return result

    def commit_new_highlight_and_edge() -> None:
        try:
            assert highlights_read.wait(timeout=10)
            with direct_db.session() as session:
                highlight_id = create_test_highlight(
                    session,
                    user_id,
                    fragment_id,
                    exact="Stable",
                )
                add_context_edge(session, conversation_id, f"highlight:{highlight_id}")
                session.commit()
                written_highlight_ids.append(highlight_id)
        except BaseException as exc:  # pragma: no cover - asserted by parent thread
            writer_errors.append(exc)
        finally:
            writer_finished.set()

    monkeypatch.setattr(
        reader_document_map.highlights,
        "list_highlights_for_media",
        pause_after_highlight_read,
    )
    writer = threading.Thread(target=commit_new_highlight_and_edge, daemon=True)
    writer.start()
    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )
    writer.join(timeout=10)

    assert not writer.is_alive()
    assert writer_errors == []
    assert response.status_code == 200, response.text
    assert len(written_highlight_ids) == 1
    new_locus = f"highlight:{written_highlight_ids[0]}"
    assert all(
        group["locus_ref"] != new_locus
        for group in response.json()["data"]["evidence"]["passage_groups"]
    )


def test_document_map_aggregates_reader_evidence(auth_client, direct_db: DirectSessionManager):
    user_id = _bootstrap_user(auth_client, direct_db)
    other_user_id = _bootstrap_user(auth_client, direct_db)
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
        document_edge_id = add_context_edge(session, conversation_id, f"media:{media_id}")
        companion_edge_id = add_context_edge(session, conversation_id, f"fragment:{fragment_id}")
        highlight_chat_edge_id = add_context_edge(
            session, conversation_id, f"highlight:{highlight_id}"
        )
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
        highlight_citation_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="highlight", id=highlight_id),
                kind="context",
                origin="citation",
                ordinal=2,
                snapshot=CitationSnapshot(title="Highlighted answer", excerpt="test exact"),
            ),
        )
        stance_conversation_id, stance_message_id = create_test_conversation_with_message(
            session,
            user_id,
        )
        create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=stance_message_id),
                target=ResourceRef(scheme="fragment", id=fragment_id),
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title="Second answer", excerpt="Claim1"),
            ),
        )
        stance_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="conversation", id=stance_conversation_id),
                target=ResourceRef(scheme="fragment", id=fragment_id),
                kind="supports",
                origin="user",
            ),
        )
        also_references_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="note_block", id=note_block_id),
                target=ResourceRef(scheme="fragment", id=fragment_id),
                kind="context",
                origin="note_body",
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
                },
                {
                    "stable_key": "marker->target:duplicate-relation",
                    "from_stable_key": "marker",
                    "to_stable_key": "target",
                    "relation": "contains_reference",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html"},
                    "sort_key": "000001.edge",
                },
            ],
        )
        target_apparatus_id = session.scalar(
            text(
                """
                SELECT id
                FROM reader_apparatus_items
                WHERE media_id = :media_id AND stable_key = 'target'
                """
            ),
            {"media_id": media_id},
        )
        assert target_apparatus_id is not None
        apparatus_chat_edge_id = add_context_edge(
            session,
            conversation_id,
            f"reader_apparatus_item:{target_apparatus_id}",
        )
        apparatus_citation_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="reader_apparatus_item", id=target_apparatus_id),
                kind="context",
                origin="citation",
                ordinal=3,
                snapshot=CitationSnapshot(title="Footnote answer", excerpt="Source note"),
            ),
        )
        unreadable_note_id = uuid4()
        unreadable_edge_id = uuid4()
        session.execute(
            text(
                """
                INSERT INTO note_blocks (id, user_id, body_pm_json, body_text)
                VALUES (:id, :user_id, '{}'::jsonb, 'Private note')
                """
            ),
            {"id": unreadable_note_id, "user_id": other_user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    id, user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id
                )
                VALUES (
                    :id, :user_id, 'context', 'user', 'note_block', :note_id,
                    'reader_apparatus_item', :target_id
                )
                """
            ),
            {
                "id": unreadable_edge_id,
                "user_id": user_id,
                "note_id": unreadable_note_id,
                "target_id": target_apparatus_id,
            },
        )
        session.commit()

    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", other_user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("conversations", "owner_user_id", user_id)

    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "ready"
    assert set(data["source_version"]) == {
        "media_updated_at",
        "apparatus_source_fingerprint",
        "graph_max_updated_at",
        "highlights_max_updated_at",
    }
    assert all(value["kind"] == "Present" for value in data["source_version"].values())
    assert data["navigation"]["kind"] == "Present"
    assert set(data["diagnostics"]) == {"omitted_item_counts"}
    assert (
        not {
            "lenses",
            "items",
            "highlights",
            "apparatus",
            "connections",
            "chat_threads",
        }
        & data.keys()
    )

    embed = data["embeds"][0]
    assert embed["provider"] == "generic"
    assert embed["resolution_status"] == "unsupported"

    evidence = data["evidence"]
    assert evidence["counts"] == {
        "highlights": 1,
        "citations": 5,
        "links": 2,
        "synapses": 0,
        "passages": 7,
        "document": 1,
    }
    highlight_group = _group(evidence, f"highlight:{highlight_id}")
    assert highlight_group["resolution"]["kind"] == "Resolved"
    highlight = _item(highlight_group["items"], f"highlight:{highlight_id}")
    assert highlight["kind"] == "Highlight"
    assert highlight_group["resolution"]["anchor"]["locator"]["type"] == "web_text_offsets"
    assert highlight_group["resolution"]["anchor"]["locator"]["text_quote_selector"] == {
        "exact": "test exact",
        "prefix": "prefix",
        "suffix": "suffix",
    }
    attached = {
        association["object"]["ref"]: association for association in highlight["associations"]
    }
    note = attached[f"note_block:{note_block_id}"]
    assert note["relationship"] == "DirectlyAttached"
    assert note["object"]["kind"] == "Note"
    assert note["object"]["body_pm_json"]["type"] == "paragraph"
    assert f"conversation:{conversation_id}" not in attached
    highlight_citation = _item(
        highlight_group["items"], f"generated-citation:{highlight_citation_edge.id}"
    )
    assert highlight_citation["associations"][0]["object"]["message_ref"] == {
        "kind": "Present",
        "value": f"message:{message_id}",
    }
    assert all(
        association.get("edge_id") != str(highlight_chat_edge_id)
        for association in highlight["associations"]
    )

    source_reference = next(
        item
        for group in evidence["passage_groups"]
        for item in group["items"]
        if item["kind"] == "SourceReference"
    )
    source_group = next(
        group for group in evidence["passage_groups"] if source_reference in group["items"]
    )
    assert source_group["target_excerpt"] == {"kind": "Present", "value": "1"}
    assert source_reference["stable_key"] == "marker"
    assert source_reference["confidence"] == "exact"
    assert [target["stable_key"] for target in source_reference["targets"]] == ["target"]
    target = source_reference["targets"][0]
    assert target["resolution"]["kind"] == "Resolved"
    assert target["resolution"]["anchor"]["locator"]["start_offset"] == 7
    assert target["activation"]["href"] == (
        f"/media/{media_id}?apparatus=target&apparatus_id={target_apparatus_id}"
    )
    apparatus_associations = {
        association["object"]["ref"]: association
        for association in source_reference["associations"]
    }
    assert f"conversation:{conversation_id}" not in apparatus_associations
    apparatus_citation_group = _group(evidence, f"reader_apparatus_item:{target_apparatus_id}")
    apparatus_citation = _item(
        apparatus_citation_group["items"],
        f"generated-citation:{apparatus_citation_edge.id}",
    )
    assert apparatus_citation["associations"][0]["object"]["message_ref"] == {
        "kind": "Present",
        "value": f"message:{message_id}",
    }
    assert all(
        association.get("edge_id") != str(apparatus_chat_edge_id)
        for association in source_reference["associations"]
    )
    assert f"note_block:{unreadable_note_id}" not in apparatus_associations
    assert data["diagnostics"]["omitted_item_counts"]["unreadable_related_object"] == 1
    assert str(unreadable_edge_id) not in {
        item.get("edge_id") for group in evidence["passage_groups"] for item in group["items"]
    }

    citation_group = _group(evidence, f"fragment:{fragment_id}")
    citation = _item(citation_group["items"], f"generated-citation:{citation_edge.id}")
    assert citation["kind"] == "GeneratedCitation"
    authored_in = citation["associations"][0]
    assert authored_in["relationship"] == "AuthoredIn"
    assert authored_in["object"]["kind"] == "Chat"
    assert authored_in["object"]["conversation_id"] == str(conversation_id)
    assert authored_in["object"]["message_ref"] == {
        "kind": "Present",
        "value": f"message:{message_id}",
    }
    assert authored_in["object"]["activation"]["href"] == (
        f"/conversations/{conversation_id}?message={message_id}"
    )
    assert all(item.get("edge_id") != str(companion_edge_id) for item in citation_group["items"])
    assert data["diagnostics"]["omitted_item_counts"]["coalesced_chat_context"] == 3
    stance_link = _item(
        citation_group["items"], f"link:{stance_edge.id}:anchor:fragment:{fragment_id}"
    )
    assert stance_link["kind"] == "Link"
    assert stance_link["role"] == "supports"
    assert citation_group["also_references"] == [
        {
            "relationship": "AlsoReferences",
            "object": {
                "ref": f"note_block:{note_block_id}",
                "label": "Attached note",
                "excerpt": {"kind": "Present", "value": "Attached note"},
                "activation": {
                    "resource_ref": f"note_block:{note_block_id}",
                    "kind": "route",
                    "href": f"/notes/{note_block_id}",
                    "unresolved_reason": None,
                },
                "kind": "Note",
                "note_block_id": str(note_block_id),
                "body_pm_json": {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Attached note"}],
                },
            },
        }
    ]
    assert str(also_references_edge.id) not in {
        item.get("edge_id") for group in evidence["passage_groups"] for item in group["items"]
    }

    document_link = _item(
        evidence["document_items"], f"link:{document_edge_id}:anchor:media:{media_id}"
    )
    assert document_link["kind"] == "Link"
    assert document_link["object"]["kind"] == "Chat"
    assert {marker["kind"] for marker in data["markers"]} >= {
        "Contents",
        "Embed",
        "Highlight",
        "SourceReference",
        "GeneratedCitation",
    }


@pytest.mark.parametrize("query", ["include_unanchored=true", "limit=1", "unknown=true"])
def test_document_map_rejects_all_query_options(
    auth_client, direct_db: DirectSessionManager, query: str
):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)

    response = auth_client.get(
        f"/media/{media_id}/document-map?{query}",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_document_map_exhausts_internal_graph_pages(auth_client, direct_db):
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("many-links", media_id),
            items=[],
            edges=[],
            status="empty",
        )
        note_ids = [uuid4() for _ in range(101)]
        session.execute(
            text(
                """
                INSERT INTO note_blocks (id, user_id, body_pm_json, body_text)
                VALUES (
                    :id, :user_id,
                    jsonb_build_object('type', 'paragraph'), :body_text
                )
                """
            ),
            [
                {"id": note_id, "user_id": user_id, "body_text": f"Note {index}"}
                for index, note_id in enumerate(note_ids)
            ],
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    id, user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id
                )
                VALUES (
                    :id, :user_id, 'context', 'user', 'note_block', :note_id,
                    'media', :media_id
                )
                """
            ),
            [
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "note_id": note_id,
                    "media_id": media_id,
                }
                for note_id in note_ids
            ],
        )
        session.commit()

    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    response = auth_client.get(f"/media/{media_id}/document-map", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["navigation"] == {"kind": "Absent"}
    assert data["source_version"]["highlights_max_updated_at"] == {"kind": "Absent"}
    evidence = data["evidence"]
    assert evidence["counts"]["links"] == 101
    assert evidence["counts"]["document"] == 101
    assert len(evidence["document_items"]) == 101


def test_document_map_does_not_resolve_storage_shaped_summary_locator(auth_client, direct_db):
    user_id = _bootstrap_user(auth_client, direct_db)
    chunk_id = uuid4()
    canonical_chunk_id = uuid4()
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Alpha beta gamma")
        highlight_id = create_test_highlight(session, user_id, fragment_id, exact="Alpha")
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
        session.execute(
            text(
                """
                INSERT INTO content_chunks (
                    id, owner_kind, owner_id, primary_evidence_span_id, chunk_idx,
                    source_kind, chunk_text, token_count, heading_path, summary_locator
                )
                VALUES (
                    :id, 'media', :media_id, NULL, 1,
                    'web_article', 'beta', 1, CAST('[]' AS jsonb), CAST(:locator AS jsonb)
                )
                """
            ),
            {
                "id": canonical_chunk_id,
                "media_id": media_id,
                "locator": json.dumps(
                    {
                        "type": "web_text_offsets",
                        "media_id": str(media_id),
                        "fragment_id": str(fragment_id),
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
        canonical_edge = create_edge(
            session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="content_chunk", id=canonical_chunk_id),
                kind="context",
                origin="citation",
                ordinal=2,
                snapshot=CitationSnapshot(title="Canonical citation", excerpt="beta"),
            ),
        )
        session.commit()

    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    group = _group(data["evidence"], f"content_chunk:{chunk_id}")
    assert group["resolution"] == {
        "kind": "Unavailable",
        "reason": "Unanchorable",
    }
    citation = _item(group["items"], f"generated-citation:{edge.id}")
    assert citation["kind"] == "GeneratedCitation"
    canonical_group = _group(data["evidence"], f"content_chunk:{canonical_chunk_id}")
    assert canonical_group["resolution"]["kind"] == "Resolved"
    _item(canonical_group["items"], f"generated-citation:{canonical_edge.id}")
    locus_order = [
        passage_group["locus_ref"] for passage_group in data["evidence"]["passage_groups"]
    ]
    assert locus_order.index(f"highlight:{highlight_id}") < locus_order.index(
        f"content_chunk:{canonical_chunk_id}"
    )


def test_document_map_marks_apparatus_with_a_deleted_fragment_stale(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, user_id, library_id)
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Current text")
        _seed_heading(session, media_id, fragment_id)
        item = _apparatus_item(
            media_id,
            uuid4(),
            stable_key="stale-marker",
        )
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("stale-apparatus", media_id),
            items=[item],
            edges=[],
        )
        item_id = session.scalar(
            text(
                "SELECT id FROM reader_apparatus_items "
                "WHERE media_id = :media_id AND stable_key = 'stale-marker'"
            ),
            {"media_id": media_id},
        )
        assert item_id is not None
        session.commit()

    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    group = _group(
        response.json()["data"]["evidence"],
        f"reader_apparatus_item:{item_id}",
    )
    assert group["resolution"] == {"kind": "Unavailable", "reason": "Stale"}
    assert group["target_excerpt"] == {"kind": "Present", "value": "1"}


def test_document_map_associates_viewer_graph_with_shared_visible_highlight(
    auth_client, direct_db: DirectSessionManager
):
    viewer_id = _bootstrap_user(auth_client, direct_db)
    author_id = _bootstrap_user(auth_client, direct_db)
    with direct_db.session() as session:
        library_id = get_user_default_library(session, viewer_id)
        assert library_id is not None
        add_library_member(session, library_id, author_id)
        media_id = create_test_media_in_library(session, viewer_id, library_id)
        _register_media_cleanup(direct_db, media_id)
        fragment_id = create_test_fragment(session, media_id, "Shared highlight text")
        _seed_heading(session, media_id, fragment_id)
        highlight_id = create_test_highlight(
            session,
            author_id,
            fragment_id,
            exact="Shared",
        )
        conversation_id, _message_id = create_test_conversation_with_message(
            session,
            viewer_id,
        )
        edge_id = add_context_edge(session, conversation_id, f"highlight:{highlight_id}")
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("shared-highlight", media_id),
            items=[],
            edges=[],
            status="empty",
        )
        session.commit()

    direct_db.register_cleanup("conversations", "owner_user_id", viewer_id)
    response = auth_client.get(
        f"/media/{media_id}/document-map",
        headers=auth_headers(viewer_id),
    )

    assert response.status_code == 200, response.text
    evidence = response.json()["data"]["evidence"]
    highlight = _item(
        _group(evidence, f"highlight:{highlight_id}")["items"],
        f"highlight:{highlight_id}",
    )
    assert highlight["author_user_id"] == str(author_id)
    assert highlight["is_owner"] is False
    association = next(
        item
        for item in highlight["associations"]
        if item["object"]["ref"] == f"conversation:{conversation_id}"
    )
    assert association["relationship"] == "DirectlyAttached"
    assert association["edge_id"] == str(edge_id)


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


def _group(evidence: dict[str, object], locus_ref: str) -> dict[str, object]:
    groups = evidence["passage_groups"]
    assert isinstance(groups, list)
    match = next((group for group in groups if group["locus_ref"] == locus_ref), None)
    assert match is not None, f"missing {locus_ref} in {[group['locus_ref'] for group in groups]}"
    return match
