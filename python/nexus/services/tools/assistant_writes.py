"""Assistant writes as reads over ``tool_calls``: authorship, account history, undo.

A write's created targets live on its one row. The author of a target is the
successful write whose ``created_refs`` name it; the history is the principal's
successful writes with created targets; undo reverts the targets and stamps the
row in one transaction.
Each outlives the turn (its link is set null) and the target itself.
Undo replays the whole database attempt under the central serializable commit
owner; a reverted receipt is already complete and changes nothing.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.assistant_writes import (
    AssistantWriteOut,
    CreatedRefOut,
    MachineAuthorshipOut,
    TargetKind,
)
from nexus.schemas.collection_index import CollectionIndex
from nexus.schemas.resource_evidence import ResourceField
from nexus.schemas.resource_graph import ConnectionCreationOut
from nexus.services import library_entries, users
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.search import projection
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
            field=ref["field"],
            generation_id=row.generation_id,
            generation_seq=row.generation_seq,
            tool_position=row.position,
            position_path=f"generation/{row.generation_seq}/tool/{row.position}",
            effect_id=row.id,
        )
        for ref in row.created_refs
    ]


def _authorship_of(
    row: Any, target_kind: TargetKind, target_id: UUID, field: ResourceField
) -> MachineAuthorshipOut:
    return next(
        a
        for a in authorships(row)
        if (a.target_kind, a.target_id, a.field) == (target_kind, target_id, field)
    )


def authorship_for_target(
    db: Session, viewer_id: UUID, uri: str, *, field: ResourceField
) -> MachineAuthorshipOut | None:
    """Whether the viewer's assistant wrote the note block or highlight at ``uri``."""

    ref = parse_resource_ref(uri)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme not in ("note_block", "highlight"):
        return None
    row = db.execute(
        text(
            "SELECT * FROM tool_calls WHERE principal_user_id = :viewer AND status = 'complete'"
            " AND created_refs @> :probe"
        ).bindparams(bindparam("probe", type_=JSONB)),
        {"viewer": viewer_id, "probe": [{"kind": ref.scheme, "id": str(ref.id), "field": field}]},
    ).one_or_none()
    return None if row is None else _authorship_of(row, ref.scheme, ref.id, field)


def _edge_rows(db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]) -> list[Any]:
    return list(
        db.execute(
            text(
                "SELECT t.*, CAST(ref ->> 'id' AS uuid) AS edge_id"
                " FROM tool_calls t CROSS JOIN jsonb_array_elements(t.created_refs) ref"
                " WHERE t.principal_user_id = :viewer AND t.tool_id = 'nexus.edge.create'"
                " AND t.status = 'complete' AND ref ->> 'kind'='edge' AND ref -> 'field'='null'::jsonb AND ref ->> 'id' = ANY(:edges)"
            ),
            {"viewer": viewer_id, "edges": [str(edge_id) for edge_id in edge_ids]},
        )
    )


def edge_authorships(
    db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]
) -> dict[UUID, MachineAuthorshipOut]:
    """The viewer's assistant-created edges among ``edge_ids``, with their authorship."""

    return {
        row.edge_id: _authorship_of(row, "resource_edge", row.edge_id, None)
        for row in _edge_rows(db, viewer_id, edge_ids)
    }


def edge_provenance(
    db: Session, viewer_id: UUID, edge_ids: Iterable[UUID]
) -> dict[UUID, ConnectionCreationOut]:
    """Receipt-backed creation metadata, independent of current edge removal."""

    return {
        row.edge_id: ConnectionCreationOut(
            authorship=_authorship_of(row, "resource_edge", row.edge_id, None),
            tool_call_id=row.id,
            generation_id=row.generation_id,
            message_id=row.assistant_message_id,
        )
        for row in _edge_rows(db, viewer_id, edge_ids)
    }


def history(
    db: Session, *, viewer_id: UUID, generation_id: UUID | None
) -> CollectionIndex[AssistantWriteOut]:
    """All successful writes with created targets, newest first."""
    rows = db.execute(
        text(
            "SELECT id, created_at, created_refs, reverted_at"
            " FROM tool_calls WHERE principal_user_id = :viewer AND tool_id = ANY(:writes)"
            " AND result ->> 'type' = 'Success' AND jsonb_array_length(created_refs) > 0"
            " AND (CAST(:generation AS uuid) IS NULL OR generation_id = :generation)"
            " ORDER BY created_at DESC, id DESC"
        ),
        {"viewer": viewer_id, "writes": list(WRITES), "generation": generation_id},
    ).all()
    candidates = {
        row.id: _entry_undo_receipts(row.created_refs) for row in rows if row.reverted_at is None
    }
    eligible = library_entries.eligible_entry_undos(
        db,
        viewer_id,
        list(
            {
                receipt
                for receipts in candidates.values()
                if receipts is not None
                for receipt in receipts
            }
        ),
    )
    return CollectionIndex(
        items=[
            AssistantWriteOut(
                id=row.id,
                created_at=row.created_at,
                created_refs=[CreatedRefOut.model_validate(ref) for ref in row.created_refs],
                reverted_at=row.reverted_at,
                undo_allowed=(receipts := candidates.get(row.id)) is not None
                and all(receipt in eligible for receipt in receipts),
            )
            for row in rows
        ]
    )


def undo_eligible(
    db: Session,
    *,
    viewer_id: UUID,
    result: dict[str, Any] | None,
    created_refs: list[dict[str, Any]],
    reverted_at: object,
) -> bool:
    """Account and chat history share execution's exact entry-receipt predicate."""
    if result is None or result["type"] != "Success" or not created_refs or reverted_at is not None:
        return False
    receipts = _entry_undo_receipts(created_refs)
    return receipts is not None and set(receipts) <= library_entries.eligible_entry_undos(
        db, viewer_id, receipts
    )


def _entry_undo_receipts(
    refs: list[dict[str, Any]],
) -> list[library_entries.EntryUndoReceipt] | None:
    receipts = []
    for ref in refs:
        if ref["kind"] != "entry":
            continue
        if ref["target_scheme"] != "media" or ref["order_revision"] is None:
            return None
        receipts.append(
            library_entries.EntryUndoReceipt(
                UUID(ref["library_id"]),
                UUID(ref["target_id"]),
                UUID(ref["id"]),
                int(ref["order_revision"]),
            )
        )
    return receipts


def undo(db: Session, *, viewer_id: UUID, tool_call_id: UUID) -> None:
    """Revert one successful write's targets and stamp its row, atomically. Idempotent.

    Historical undo belongs to the chat trail, connections and librarian settings.
    """

    def attempt() -> None:
        users.lock_viewer(db, viewer_id)
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
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "This write created nothing to undo"
            )
        owners: set[str] = set()
        libraries: set[UUID] = set()
        whole_highlights = {
            ref["id"]
            for ref in row.created_refs
            if ref["kind"] == "highlight" and ref["field"] is None
        }
        for ref in row.created_refs:
            if ref["field"] == "annotation" and ref["id"] in whole_highlights:
                continue
            writes.revert(db, viewer_id, ref)
            if ref["kind"] == "entry":
                libraries.add(UUID(ref["library_id"]))
                owners.update(
                    (f"library:{ref['library_id']}", f"{ref['target_scheme']}:{ref['target_id']}")
                )
            else:
                owners.add(f"{ref['kind']}:{ref['id']}")
        if libraries:
            viewers = db.scalars(
                text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
                {"ids": list(libraries)},
            ).all()
            projection.refresh_viewer_contributors(db, [viewer_id, *viewers])
        db.execute(
            text("UPDATE tool_calls SET reverted_at = clock_timestamp() WHERE id = :id"),
            {"id": tool_call_id},
        )
        record_input_change(db, owners=owners)

    retry_serializable(db, "undo_assistant_write", attempt)
