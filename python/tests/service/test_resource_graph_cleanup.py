"""Real PostgreSQL resource-death semantics at content-index cardinality."""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, func, insert, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    ContentChunk,
    Conversation,
    EvidenceSpan,
    Message,
    NoteBlock,
    ResourceEdge,
    ResourceViewState,
    User,
)
from nexus.services.content_indexing import IndexOwner, replace_content_index_materialization
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.refs import ResourceRef
from tests.testkit.auth import UserRecord


def _seed_index(db: Session, owner_id: UUID, count: int) -> tuple[list[UUID], list[UUID]]:
    block_id = uuid4()
    db.add(
        ContentBlock(
            id=block_id,
            owner_kind="note_block",
            owner_id=owner_id,
            block_idx=0,
            block_kind="paragraph",
            canonical_text="kept prose",
            source_start_offset=0,
            source_end_offset=10,
            heading_path=[],
            locator={},
            selector={},
            metadata_json={},
        )
    )
    db.flush()
    spans = [uuid4() for _ in range(count)]
    chunks = [uuid4() for _ in range(count)]
    db.execute(
        insert(EvidenceSpan),
        [
            {
                "id": span_id,
                "owner_kind": "note_block",
                "owner_id": owner_id,
                "start_block_id": block_id,
                "end_block_id": block_id,
                "start_block_offset": 0,
                "end_block_offset": 10,
                "span_text": "kept prose",
                "selector": {},
                "citation_label": "note",
                "resolver_kind": "note",
            }
            for span_id in spans
        ],
    )
    db.execute(
        insert(ContentChunk),
        [
            {
                "id": chunk_id,
                "owner_kind": "note_block",
                "owner_id": owner_id,
                "primary_evidence_span_id": span_id,
                "chunk_idx": index,
                "source_kind": "note",
                "chunk_text": "kept prose",
                "token_count": 2,
                "heading_path": [],
                "summary_locator": {},
            }
            for index, (chunk_id, span_id) in enumerate(zip(chunks, spans, strict=True))
        ],
    )
    return spans, chunks


@pytest.mark.parametrize("count", [1, 4100])
def test_content_index_cleanup_keeps_graph_semantics_at_large_cardinality(
    db_session: Session, test_user: UserRecord, count: int
) -> None:
    owner_id, foreign_owner, motif_note, conversation_id, message_id, other_user, parent_id = (
        uuid4() for _ in range(7)
    )
    db_session.add(User(id=other_user, email=f"cleanup-{other_user}@example.invalid"))
    db_session.flush()
    for note_id in (owner_id, foreign_owner, motif_note):
        db_session.add(
            NoteBlock(
                id=note_id,
                user_id=other_user if note_id == motif_note else test_user.id,
                body_text="kept prose",
                body_pm_json={"type": "doc", "content": []},
            )
        )
    db_session.add(Conversation(id=conversation_id, owner_user_id=test_user.id))
    db_session.flush()
    db_session.add(
        Message(
            id=parent_id, conversation_id=conversation_id, seq=1, role="user", content="cite it"
        )
    )
    db_session.flush()
    db_session.add(
        Message(
            id=message_id,
            conversation_id=conversation_id,
            seq=2,
            role="assistant",
            content="cited",
            parent_message_id=parent_id,
        )
    )
    spans, chunks = _seed_index(db_session, owner_id, count)
    foreign_spans, foreign_chunks = _seed_index(db_session, foreign_owner, 1)
    motif_a, motif_b, bare, citation, foreign_edge = (uuid4() for _ in range(5))
    edges = [
        (motif_a, "note_block", motif_note, "evidence_span", spans[-1], "link_note", None),
        (motif_b, "note_block", motif_note, "note_block", foreign_owner, "link_note", None),
        (bare, "content_chunk", chunks[0], "note_block", foreign_owner, "user", None),
        (citation, "message", message_id, "evidence_span", spans[0], "citation", 1),
        (
            foreign_edge,
            "content_chunk",
            foreign_chunks[0],
            "note_block",
            foreign_owner,
            "user",
            None,
        ),
    ]
    for edge_id, source_scheme, source_id, target_scheme, target_id, origin, ordinal in edges:
        db_session.add(
            ResourceEdge(
                id=edge_id,
                user_id=other_user if origin == "link_note" else test_user.id,
                kind="context",
                origin=origin,
                source_scheme=source_scheme,
                source_id=source_id,
                target_scheme=target_scheme,
                target_id=target_id,
                ordinal=ordinal,
                snapshot={"excerpt": "kept prose"} if ordinal else None,
            )
        )
    db_session.flush()
    for edge_id, *_ in edges:
        db_session.add(
            ResourceViewState(
                user_id=other_user if edge_id in (motif_a, motif_b) else test_user.id,
                surface_scheme="note_block",
                surface_id=foreign_owner,
                edge_id=edge_id,
                state={"collapsed": True},
            )
        )
    db_session.flush()
    original_edges = {row[0] for row in edges}
    statement_sizes: list[int] = []

    def observe_statement(_connection, _cursor, statement, _parameters, _context, _many):
        statement_sizes.append(len(statement.encode()))

    connection = db_session.connection()
    event.listen(connection, "before_cursor_execute", observe_statement)
    savepoint = db_session.begin_nested()
    try:
        replace_content_index_materialization(db_session, owner=IndexOwner("note_block", owner_id))
    except DBAPIError as error:
        raise AssertionError(f"bulk graph cleanup failed in PostgreSQL: {error.orig}") from None
    finally:
        event.remove(connection, "before_cursor_execute", observe_statement)
    surviving = set(
        db_session.scalars(select(ResourceEdge.id).where(ResourceEdge.id.in_(original_edges)))
    )
    assert surviving == {citation, foreign_edge}, (
        "bulk resource death changed cited or foreign survivors"
    )
    assert (
        set(
            db_session.scalars(
                select(ResourceViewState.edge_id).where(
                    ResourceViewState.edge_id.in_(original_edges)
                )
            )
        )
        == surviving
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(ContentChunk).where(ContentChunk.owner_id == owner_id)
        )
        == 0
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(EvidenceSpan).where(EvidenceSpan.owner_id == owner_id)
        )
        == 0
    )
    assert db_session.get(EvidenceSpan, foreign_spans[0]) is not None
    assert (
        db_session.scalar(select(NoteBlock.body_text).where(NoteBlock.id == motif_note))
        == "kept prose"
    )
    snapshot = db_session.scalar(select(ResourceEdge.snapshot).where(ResourceEdge.id == citation))
    assert snapshot == {"excerpt": "kept prose"}, (
        "target cleanup changed the retained citation snapshot"
    )
    receipt = {
        "dying_resources": count * 2,
        "remaining_edges": sorted(str(value) for value in surviving),
        "sql_statement_count": len(statement_sizes),
        "maximum_sql_bytes": max(statement_sizes),
        "scope": "real PostgreSQL index replacement over persisted span/chunk identities; no capacity or cold-database claim",
    }
    destination = Path(__file__).parents[3] / "test-results/runs" / os.environ["NEXUS_TEST_RUN_ID"]
    (destination / f"resource-cleanup-{count}.json").write_text(json.dumps(receipt) + "\n")
    savepoint.rollback()
    assert (
        set(db_session.scalars(select(ResourceEdge.id).where(ResourceEdge.id.in_(original_edges))))
        == original_edges
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(ContentChunk).where(ContentChunk.owner_id == owner_id)
        )
        == count
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(EvidenceSpan).where(EvidenceSpan.owner_id == owner_id)
        )
        == count
    )
    assert (
        set(
            db_session.scalars(
                select(ResourceViewState.edge_id).where(
                    ResourceViewState.edge_id.in_(original_edges)
                )
            )
        )
        == original_edges
    )

    delete_edges_for_deleted_resource(db_session, ref=ResourceRef(scheme="message", id=message_id))
    assert db_session.scalar(select(ResourceEdge.id).where(ResourceEdge.id == citation)) is None
    assert (
        db_session.scalar(select(ResourceViewState.id).where(ResourceViewState.edge_id == citation))
        is None
    )
    assert (
        db_session.scalar(
            select(func.count()).select_from(EvidenceSpan).where(EvidenceSpan.owner_id == owner_id)
        )
        == count
    )


@pytest.mark.parametrize("same_endpoint", [False, True])
def test_detaching_a_link_note_keeps_other_notes_and_other_viewers(
    db_session: Session, test_user: UserRecord, same_endpoint: bool
) -> None:
    from nexus.services.resource_graph.cleanup import detach_link_note_motif

    other_user = uuid4()
    db_session.add(User(id=other_user, email=f"motif-{other_user}@example.invalid"))
    db_session.flush()
    a, b, c, matched, incomplete, foreign = (uuid4() for _ in range(6))
    for note_id in (a, b, c, matched, incomplete, foreign):
        db_session.add(
            NoteBlock(
                id=note_id,
                user_id=other_user if note_id == foreign else test_user.id,
                body_text="authored note survives",
                body_pm_json={"type": "doc", "content": []},
            )
        )
    db_session.flush()
    removed: set[UUID] = set()
    retained: set[UUID] = set()
    for note_id, targets, viewer_id in (
        (matched, (a, c) if same_endpoint else (a, b, c), test_user.id),
        (incomplete, (b,) if same_endpoint else (a,), test_user.id),
        (foreign, (a, b), other_user),
    ):
        for target_id in targets:
            edge_id = uuid4()
            (removed if note_id == matched else retained).add(edge_id)
            db_session.add(
                ResourceEdge(
                    id=edge_id,
                    user_id=viewer_id,
                    kind="context",
                    origin="link_note",
                    source_scheme="note_block",
                    source_id=note_id,
                    target_scheme="note_block",
                    target_id=target_id,
                )
            )
    db_session.flush()
    for edge_id in removed | retained:
        db_session.add(
            ResourceViewState(
                user_id=test_user.id,
                surface_scheme="note_block",
                surface_id=a,
                edge_id=edge_id,
                state={},
            )
        )
    db_session.flush()
    detach_link_note_motif(
        db_session,
        viewer_id=test_user.id,
        a=ResourceRef(scheme="note_block", id=a),
        b=ResourceRef(scheme="note_block", id=a if same_endpoint else b),
    )
    assert (
        set(
            db_session.scalars(
                select(ResourceEdge.id).where(ResourceEdge.id.in_(removed | retained))
            )
        )
        == retained
    )
    assert (
        set(
            db_session.scalars(
                select(ResourceViewState.edge_id).where(
                    ResourceViewState.edge_id.in_(removed | retained)
                )
            )
        )
        == retained
    )
    assert (
        db_session.scalar(select(NoteBlock.body_text).where(NoteBlock.id == matched))
        == "authored note survives"
    )
