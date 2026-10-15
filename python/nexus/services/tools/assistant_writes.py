"""Assistant writes as reads over ``tool_calls``: authorship, account history, undo.

A write's created targets live on its one row. The author of a target is the
successful write whose ``created_refs`` name it; the history is the principal's
finished writes; undo reverts the targets and stamps the row in one transaction.
Each outlives the conversation (its link is set null) and the target itself.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.assistant_writes import (
    AssistantWriteOut,
    AssistantWritePage,
    CreatedRefOut,
    MachineAuthorshipOut,
    TargetKind,
)
from nexus.schemas.presence import absent, present
from nexus.schemas.resource_graph import ConnectionCreationOut, UndoAssistantWriteMutation
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.suggestion_changes import record_input_change
from nexus.services.tools import writes
from nexus.services.tools.contract import WRITES

_TARGET_KIND: dict[str, TargetKind] = {
    "entry": "library_entry",
    "note_block": "note_block",
    "highlight": "highlight",
    "edge": "resource_edge",
    "queue": "queue_item",
}


def authorships(row: Any) -> list[MachineAuthorshipOut]:
    """Every target a successful write created, from its row; none for anything else."""

    if row.tool_id not in WRITES or row.status != "complete":
        return []
    return [
        MachineAuthorshipOut(
            target_kind=_TARGET_KIND[ref["kind"]],
            target_id=UUID(ref["id"]),
            generation_id=row.generation_id,
            generation_seq=row.generation_seq,
            tool_position=row.position,
            position_path=f"generation/{row.generation_seq}/tool/{row.position}",
            effect_id=row.id,
        )
        for ref in row.created_refs
    ]


def _authorship_of(row: Any, target_id: UUID) -> MachineAuthorshipOut:
    return next(a for a in authorships(row) if a.target_id == target_id)


def authorship_for_target(db: Session, viewer_id: UUID, uri: str) -> MachineAuthorshipOut | None:
    """Whether the viewer's assistant wrote the note block or highlight at ``uri``."""

    ref = parse_resource_ref(uri)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme not in ("note_block", "highlight"):
        return None
    row = db.execute(
        text(
            "SELECT * FROM tool_calls WHERE principal_user_id = :viewer AND status = 'complete'"
            " AND created_refs @> :probe"
        ).bindparams(bindparam("probe", type_=JSONB)),
        {"viewer": viewer_id, "probe": [{"kind": ref.scheme, "id": str(ref.id)}]},
    ).one_or_none()
    return None if row is None else _authorship_of(row, ref.id)


def _edge_rows(db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]) -> list[Any]:
    return list(
        db.execute(
            text(
                "SELECT t.*, m.conversation_id, CAST(ref ->> 'id' AS uuid) AS edge_id"
                " FROM tool_calls t CROSS JOIN jsonb_array_elements(t.created_refs) ref"
                " LEFT JOIN messages m ON m.id = t.assistant_message_id"
                " WHERE t.principal_user_id = :viewer AND t.tool_id = 'nexus.edge.create'"
                " AND t.status = 'complete' AND ref ->> 'id' = ANY(:edges)"
            ),
            {"viewer": viewer_id, "edges": [str(edge_id) for edge_id in edge_ids]},
        )
    )


def edge_authorships(
    db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]
) -> dict[UUID, MachineAuthorshipOut]:
    """The viewer's assistant-created edges among ``edge_ids``, with their authorship."""

    return {
        row.edge_id: _authorship_of(row, row.edge_id) for row in _edge_rows(db, viewer_id, edge_ids)
    }


def edge_provenance(
    db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]
) -> dict[UUID, tuple[ConnectionCreationOut, UndoAssistantWriteMutation | None]]:
    """For a connections page: who created each assistant edge, and its undo while live."""

    return {
        row.edge_id: (
            ConnectionCreationOut(
                authorship=_authorship_of(row, row.edge_id),
                tool_call_id=row.id,
                generation_id=row.generation_id,
                conversation_id=row.conversation_id,
                message_id=row.assistant_message_id,
            ),
            None if row.reverted_at else UndoAssistantWriteMutation(tool_call_id=row.id),
        )
        for row in _edge_rows(db, viewer_id, edge_ids)
    }


def history(
    db: Session, *, viewer_id: UUID, generation_id: UUID | None, before: UUID | None
) -> AssistantWritePage:
    """The viewer's finished write attempts, newest first, 30 a page, keyed by (time, id)."""

    after = None
    if before is not None:
        after = db.execute(
            text(
                "SELECT created_at, id FROM tool_calls WHERE id = :id AND principal_user_id = :viewer"
            ),
            {"id": before, "viewer": viewer_id},
        ).one_or_none()
        if after is None:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Unknown history cursor")
    rows = db.execute(
        text(
            "SELECT id, generation_id, tool_id, created_at, created_refs, result, reverted_at"
            " FROM tool_calls WHERE principal_user_id = :viewer AND tool_id = ANY(:writes)"
            " AND result IS NOT NULL"
            " AND (CAST(:generation AS uuid) IS NULL OR generation_id = :generation)"
            " AND (CAST(:at AS timestamptz) IS NULL OR (created_at, id) < (:at, :after))"
            " ORDER BY created_at DESC, id DESC LIMIT 31"
        ),
        {
            "viewer": viewer_id,
            "writes": list(WRITES),
            "generation": generation_id,
            "at": after.created_at if after else None,
            "after": after.id if after else None,
        },
    ).all()
    items = [
        AssistantWriteOut(
            id=row.id,
            generation_id=row.generation_id,
            tool_id=row.tool_id,
            created_at=row.created_at,
            created_refs=[CreatedRefOut.model_validate(ref) for ref in row.created_refs],
            error_type=row.result["error"]["type"] if row.result["type"] == "Failure" else None,
            reverted_at=row.reverted_at,
            undo_allowed=row.result["type"] == "Success"
            and bool(row.created_refs)
            and row.reverted_at is None,
        )
        for row in rows[:30]
    ]
    return AssistantWritePage(
        items=items, next_cursor=present(rows[29].id) if len(rows) > 30 else absent()
    )


def undo(db: Session, *, viewer_id: UUID, tool_call_id: UUID) -> None:
    """Revert one successful write's targets and stamp its row, atomically. Idempotent.

    The one undo: the chat card, the connections menu and account settings.
    """

    row = db.execute(
        text(
            "SELECT result, created_refs, reverted_at FROM tool_calls WHERE id = :id"
            " AND principal_user_id = :viewer AND tool_id = ANY(:writes) FOR UPDATE"
        ),
        {"id": tool_call_id, "viewer": viewer_id, "writes": list(WRITES)},
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Assistant write not found")
    if row.reverted_at is not None:
        return
    if row.result is None or row.result["type"] != "Success" or not row.created_refs:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "This write created nothing to undo")
    for ref in row.created_refs:
        writes.revert(db, viewer_id, ref)
    db.execute(
        text("UPDATE tool_calls SET reverted_at = clock_timestamp() WHERE id = :id"),
        {"id": tool_call_id},
    )
    record_input_change(db)
    db.commit()
