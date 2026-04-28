"""Conversation memory validation, inspection, and deterministic refresh."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.schemas.context_memory import (
    ConversationMemoryInspectionOut,
    ConversationMemoryItemOut,
    ConversationMemoryItemSourceOut,
    ConversationStateSnapshotOut,
    SourceRef,
)

MemoryKind = Literal[
    "goal",
    "constraint",
    "decision",
    "correction",
    "open_question",
    "task",
    "assistant_commitment",
    "user_preference",
    "source_claim",
]
MemoryStatus = Literal["active", "superseded", "invalid"]
EvidenceRole = Literal["supports", "contradicts", "supersedes", "context"]

MEMORY_KINDS: frozenset[str] = frozenset(
    {
        "goal",
        "constraint",
        "decision",
        "correction",
        "open_question",
        "task",
        "assistant_commitment",
        "user_preference",
        "source_claim",
    }
)
MEMORY_STATUSES: frozenset[str] = frozenset({"active", "superseded", "invalid"})
EVIDENCE_ROLES: frozenset[str] = frozenset({"supports", "contradicts", "supersedes", "context"})
SOURCE_REF_TYPES: frozenset[str] = frozenset(
    {"message", "message_context", "message_retrieval", "app_context_ref", "web_result"}
)
MAX_MEMORY_BODY_CHARS = 2000
RECENT_HISTORY_WINDOW_MESSAGES = 12


class MemoryValidationError(ValueError):
    """Raised when a memory item or source ref violates deterministic rules."""


@dataclass(frozen=True)
class MemorySource:
    source_ref: Mapping[str, object]
    evidence_role: EvidenceRole


@dataclass(frozen=True)
class ConversationMemoryItem:
    id: UUID
    conversation_id: UUID
    kind: MemoryKind
    body: str
    source_required: bool
    valid_from_seq: int | None
    valid_through_seq: int | None
    sources: tuple[MemorySource, ...]


@dataclass(frozen=True)
class ConversationStateSnapshot:
    id: UUID
    conversation_id: UUID
    covered_through_seq: int
    state_text: str
    source_refs: tuple[Mapping[str, object], ...]
    memory_item_ids: tuple[UUID, ...]


def validate_source_ref(source_ref: Mapping[str, object]) -> None:
    """Validate the shared SourceRef shape deterministically."""

    ref_type = source_ref.get("type")
    if not isinstance(ref_type, str) or ref_type not in SOURCE_REF_TYPES:
        raise MemoryValidationError("source_ref.type is invalid")
    if not _has_str(source_ref, "id"):
        raise MemoryValidationError("source_ref.id is required")

    if ref_type == "message":
        if not _has_str(source_ref, "message_id"):
            raise MemoryValidationError("message source_ref requires message_id")
        return

    if ref_type == "message_context":
        if not _has_str(source_ref, "message_context_id") and not _has_str(source_ref, "id"):
            raise MemoryValidationError("message_context source_ref requires id")
        return

    if ref_type == "message_retrieval":
        if not _has_str(source_ref, "retrieval_id") and not _has_str(source_ref, "id"):
            raise MemoryValidationError("message_retrieval source_ref requires retrieval_id or id")
        return

    if ref_type == "app_context_ref":
        context_ref = source_ref.get("context_ref")
        if not isinstance(context_ref, Mapping):
            raise MemoryValidationError("app_context_ref source_ref requires context_ref")
        if not _has_str(context_ref, "type") or not _has_str(context_ref, "id"):
            raise MemoryValidationError("context_ref requires type and id")
        return

    if ref_type == "web_result":
        if _has_str(source_ref, "id") or isinstance(source_ref.get("result_ref"), Mapping):
            return
        raise MemoryValidationError("web_result source_ref requires id or result_ref")

    raise MemoryValidationError("unreachable source_ref type")


def validate_memory_candidate(
    *,
    kind: str,
    body: str,
    source_required: bool,
    source_refs: Sequence[Mapping[str, object]],
) -> None:
    """Validate a memory candidate before it can be persisted by the parent cutover."""

    if kind not in MEMORY_KINDS:
        raise MemoryValidationError("memory kind is invalid")
    normalized_body = " ".join(body.split()).strip()
    if not normalized_body:
        raise MemoryValidationError("memory body is required")
    if len(normalized_body) > MAX_MEMORY_BODY_CHARS:
        raise MemoryValidationError("memory body is too long")
    if kind == "source_claim" and not source_required:
        raise MemoryValidationError("source_claim memory requires source_required")
    if kind == "source_claim" and not source_refs:
        raise MemoryValidationError("source_claim memory requires a source ref")
    if source_required and not source_refs:
        raise MemoryValidationError("source_required memory requires a source ref")
    for source_ref in source_refs:
        validate_source_ref(source_ref)


def validate_memory_sources(sources: Sequence[MemorySource]) -> None:
    for source in sources:
        if source.evidence_role not in EVIDENCE_ROLES:
            raise MemoryValidationError("memory source evidence_role is invalid")
        validate_source_ref(source.source_ref)


def load_active_state_snapshot(
    db: Session,
    *,
    conversation_id: UUID,
    prompt_version: str | None = None,
) -> ConversationStateSnapshot | None:
    """Load the active state snapshot."""

    filters = ["conversation_id = :conversation_id", "status = 'active'"]
    params: dict[str, object] = {"conversation_id": conversation_id}
    if prompt_version is not None:
        filters.append("prompt_version = :prompt_version")
        params["prompt_version"] = prompt_version
    row = db.execute(
        text(
            f"""
            SELECT id, conversation_id, covered_through_seq, state_text, source_refs,
                   memory_item_ids
            FROM conversation_state_snapshots
            WHERE {" AND ".join(filters)}
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        params,
    ).first()
    if row is None:
        return None
    return ConversationStateSnapshot(
        id=row[0],
        conversation_id=row[1],
        covered_through_seq=int(row[2]),
        state_text=str(row[3] or ""),
        source_refs=tuple(row[4] or []),
        memory_item_ids=tuple(UUID(str(item_id)) for item_id in (row[5] or [])),
    )


def load_active_memory_items(
    db: Session,
    *,
    conversation_id: UUID,
    after_seq: int | None = None,
    prompt_version: str | None = None,
) -> list[ConversationMemoryItem]:
    """Load active memory items."""

    filters = ["conversation_id = :conversation_id", "status = 'active'"]
    params: dict[str, object] = {"conversation_id": conversation_id}
    if after_seq is not None:
        filters.append("(valid_from_seq IS NULL OR valid_from_seq > :after_seq)")
        params["after_seq"] = after_seq
    if prompt_version is not None:
        filters.append("prompt_version = :prompt_version")
        params["prompt_version"] = prompt_version

    rows = db.execute(
        text(
            f"""
            SELECT id, conversation_id, kind, body, source_required, valid_from_seq,
                   valid_through_seq
            FROM conversation_memory_items
            WHERE {" AND ".join(filters)}
            ORDER BY valid_from_seq ASC NULLS LAST, created_at ASC, id ASC
            """
        ),
        params,
    ).fetchall()
    if not rows:
        return []

    sources_by_item_id = _load_memory_sources(db, [row[0] for row in rows])
    items: list[ConversationMemoryItem] = []
    for row in rows:
        kind = str(row[2])
        if kind not in MEMORY_KINDS:
            continue
        sources = tuple(sources_by_item_id.get(row[0], []))
        validate_memory_candidate(
            kind=kind,
            body=str(row[3] or ""),
            source_required=bool(row[4]),
            source_refs=[source.source_ref for source in sources],
        )
        items.append(
            ConversationMemoryItem(
                id=row[0],
                conversation_id=row[1],
                kind=kind,  # type: ignore[arg-type]
                body=str(row[3]),
                source_required=bool(row[4]),
                valid_from_seq=row[5],
                valid_through_seq=row[6],
                sources=sources,
            )
        )
    return items


def collect_memory_source_refs(
    *,
    memory_items: Sequence[ConversationMemoryItem],
    snapshot: ConversationStateSnapshot | None,
) -> list[Mapping[str, object]]:
    """Return source refs from active memory and snapshot state in prompt order."""

    refs: list[Mapping[str, object]] = []
    if snapshot is not None:
        refs.extend(snapshot.source_refs)
    for item in memory_items:
        for source in item.sources:
            refs.append(source.source_ref)
    return refs


def conversation_memory_inspection(
    db: Session,
    *,
    conversation_id: UUID,
) -> ConversationMemoryInspectionOut:
    snapshot_row = db.execute(
        text(
            """
            SELECT id, conversation_id, covered_through_seq, state_text, state_json,
                   source_refs, memory_item_ids, prompt_version, snapshot_version,
                   status, invalid_reason, created_at, updated_at
            FROM conversation_state_snapshots
            WHERE conversation_id = :conversation_id
              AND status = 'active'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"conversation_id": conversation_id},
    ).first()
    snapshot = None
    if snapshot_row is not None:
        snapshot = ConversationStateSnapshotOut(
            id=snapshot_row[0],
            conversation_id=snapshot_row[1],
            covered_through_seq=snapshot_row[2],
            state_text=snapshot_row[3],
            state_json=snapshot_row[4] or {},
            source_refs=[SourceRef.model_validate(ref) for ref in snapshot_row[5] or []],
            memory_item_ids=[UUID(str(item_id)) for item_id in snapshot_row[6] or []],
            prompt_version=snapshot_row[7],
            snapshot_version=snapshot_row[8],
            status=snapshot_row[9],
            invalid_reason=snapshot_row[10],
            created_at=snapshot_row[11],
            updated_at=snapshot_row[12],
        )

    item_rows = db.execute(
        text(
            """
            SELECT id, conversation_id, kind, status, body, source_required, confidence,
                   valid_from_seq, valid_through_seq, supersedes_id, created_by_message_id,
                   prompt_version, memory_version, invalid_reason, created_at, updated_at
            FROM conversation_memory_items
            WHERE conversation_id = :conversation_id
              AND status = 'active'
            ORDER BY valid_from_seq ASC NULLS LAST, created_at ASC, id ASC
            """
        ),
        {"conversation_id": conversation_id},
    ).fetchall()
    sources_by_item_id = _load_memory_source_rows(db, [row[0] for row in item_rows])
    return ConversationMemoryInspectionOut(
        state_snapshot=snapshot,
        memory_items=[
            ConversationMemoryItemOut(
                id=row[0],
                conversation_id=row[1],
                kind=row[2],
                status=row[3],
                body=row[4],
                source_required=row[5],
                confidence=row[6],
                valid_from_seq=row[7],
                valid_through_seq=row[8],
                supersedes_id=row[9],
                created_by_message_id=row[10],
                prompt_version=row[11],
                memory_version=row[12],
                invalid_reason=row[13],
                created_at=row[14],
                updated_at=row[15],
                sources=sources_by_item_id.get(row[0], []),
            )
            for row in item_rows
        ],
    )


def refresh_conversation_memory(
    db: Session,
    *,
    conversation_id: UUID,
    prompt_version: str,
) -> None:
    rows = db.execute(
        text(
            """
            SELECT id, seq, role, content
            FROM messages
            WHERE conversation_id = :conversation_id
              AND status = 'complete'
              AND role IN ('user', 'assistant')
            ORDER BY seq ASC
            """
        ),
        {"conversation_id": conversation_id},
    ).fetchall()
    if len(rows) <= RECENT_HISTORY_WINDOW_MESSAGES:
        return

    existing_message_ids = {
        row[0]
        for row in db.execute(
            text(
                """
                SELECT created_by_message_id
                FROM conversation_memory_items
                WHERE conversation_id = :conversation_id
                  AND created_by_message_id IS NOT NULL
                """
            ),
            {"conversation_id": conversation_id},
        ).fetchall()
    }

    insert_item = text(
        """
        INSERT INTO conversation_memory_items (
            conversation_id,
            kind,
            body,
            source_required,
            confidence,
            valid_from_seq,
            valid_through_seq,
            created_by_message_id,
            prompt_version
        )
        VALUES (
            :conversation_id,
            :kind,
            :body,
            false,
            :confidence,
            :seq,
            :seq,
            :message_id,
            :prompt_version
        )
        RETURNING id
        """
    )
    insert_source = text(
        """
        INSERT INTO conversation_memory_item_sources (
            memory_item_id,
            ordinal,
            source_ref,
            evidence_role
        )
        VALUES (
            :memory_item_id,
            0,
            :source_ref,
            'supports'
        )
        """
    ).bindparams(bindparam("source_ref", type_=JSONB))

    for row in rows:
        message_id = row[0]
        if message_id in existing_message_ids:
            continue
        body = " ".join(str(row[3] or "").split()).strip()
        if not body:
            continue
        lowered = body.lower()
        kind: str | None = None
        if row[2] == "user":
            if any(
                term in lowered for term in ("prefer", "i like", "i don't like", "i do not like")
            ):
                kind = "user_preference"
            elif any(
                term in lowered for term in ("must", "constraint", "do not", "don't", "avoid")
            ):
                kind = "constraint"
            elif any(
                term in lowered
                for term in ("remember", "goal", "objective", "we need to", "i need to")
            ):
                kind = "goal"
            elif any(
                term in lowered
                for term in ("decided", "decision", "we will", "let's use", "lets use")
            ):
                kind = "decision"
            elif any(term in lowered for term in ("actually", "correction", "instead")):
                kind = "correction"
            elif any(term in lowered for term in ("todo", "task", "follow up", "next step")):
                kind = "task"
            elif "?" in body:
                kind = "open_question"
        elif row[2] == "assistant":
            if any(term in lowered for term in ("i will", "i'll", "i am going to", "i'm going to")):
                kind = "assistant_commitment"
        else:
            raise MemoryValidationError("unsupported message role")

        if kind is None:
            continue
        body = body[:MAX_MEMORY_BODY_CHARS].rstrip()
        memory_item_id = db.execute(
            insert_item,
            {
                "conversation_id": conversation_id,
                "kind": kind,
                "body": body,
                "confidence": 0.72,
                "seq": row[1],
                "message_id": message_id,
                "prompt_version": prompt_version,
            },
        ).scalar_one()
        db.execute(
            insert_source,
            {
                "memory_item_id": memory_item_id,
                "source_ref": {
                    "type": "message",
                    "id": str(message_id),
                    "label": f"Message #{row[1]}",
                    "conversation_id": str(conversation_id),
                    "message_id": str(message_id),
                    "message_seq": row[1],
                },
            },
        )

    covered_through_seq = rows[-RECENT_HISTORY_WINDOW_MESSAGES - 1][1]
    memory_rows = db.execute(
        text(
            """
            SELECT id, kind, body
            FROM conversation_memory_items
            WHERE conversation_id = :conversation_id
              AND status = 'active'
              AND prompt_version = :prompt_version
              AND (valid_from_seq IS NULL OR valid_from_seq <= :covered_through_seq)
            ORDER BY valid_from_seq ASC NULLS LAST, created_at ASC, id ASC
            """
        ),
        {
            "conversation_id": conversation_id,
            "prompt_version": prompt_version,
            "covered_through_seq": covered_through_seq,
        },
    ).fetchall()
    source_rows = []
    if memory_rows:
        source_rows = db.execute(
            text(
                """
                SELECT source_ref
                FROM conversation_memory_item_sources
                WHERE memory_item_id IN :memory_item_ids
                ORDER BY memory_item_id ASC, ordinal ASC
                """
            ).bindparams(bindparam("memory_item_ids", expanding=True)),
            {"memory_item_ids": [row[0] for row in memory_rows]},
        ).fetchall()

    state_lines = [f"Conversation state through message #{covered_through_seq}:"]
    if memory_rows:
        for row in memory_rows[:80]:
            state_lines.append(f"- {row[1]}: {row[2]}")
    else:
        state_lines.append(
            "- No durable decisions, tasks, constraints, or preferences were extracted."
        )
    state_lines.append("- Exact older wording must be resolved through the attached source refs.")
    state_text = "\n".join(state_lines)
    source_refs = [row[0] for row in source_rows]
    if not source_refs:
        source_refs = [
            {
                "type": "message",
                "id": str(row[0]),
                "label": f"Message #{row[1]}",
                "conversation_id": str(conversation_id),
                "message_id": str(row[0]),
                "message_seq": row[1],
            }
            for row in rows
            if row[1] <= covered_through_seq
        ][-RECENT_HISTORY_WINDOW_MESSAGES:]

    db.execute(
        text(
            """
            UPDATE conversation_state_snapshots
            SET status = 'superseded',
                updated_at = now()
            WHERE conversation_id = :conversation_id
              AND status = 'active'
            """
        ),
        {"conversation_id": conversation_id},
    )
    insert_snapshot = text(
        """
        INSERT INTO conversation_state_snapshots (
            conversation_id,
            covered_through_seq,
            state_text,
            state_json,
            source_refs,
            memory_item_ids,
            prompt_version
        )
        VALUES (
            :conversation_id,
            :covered_through_seq,
            :state_text,
            :state_json,
            :source_refs,
            :memory_item_ids,
            :prompt_version
        )
        """
    ).bindparams(
        bindparam("state_json", type_=JSONB),
        bindparam("source_refs", type_=JSONB),
        bindparam("memory_item_ids", type_=JSONB),
    )
    db.execute(
        insert_snapshot,
        {
            "conversation_id": conversation_id,
            "covered_through_seq": covered_through_seq,
            "state_text": state_text,
            "state_json": {
                "covered_message_count": len(
                    [row for row in rows if row[1] <= covered_through_seq]
                ),
                "memory_item_count": len(memory_rows),
            },
            "source_refs": source_refs,
            "memory_item_ids": [str(row[0]) for row in memory_rows],
            "prompt_version": prompt_version,
        },
    )


def _load_memory_sources(
    db: Session,
    item_ids: Sequence[UUID],
) -> dict[UUID, list[MemorySource]]:
    if not item_ids:
        return {item_id: [] for item_id in item_ids}
    statement = text(
        """
        SELECT memory_item_id, source_ref, evidence_role
        FROM conversation_memory_item_sources
        WHERE memory_item_id IN :item_ids
        ORDER BY memory_item_id ASC, ordinal ASC
        """
    ).bindparams(bindparam("item_ids", expanding=True))
    rows = db.execute(
        statement,
        {"item_ids": list(item_ids)},
    ).fetchall()
    sources_by_item_id: dict[UUID, list[MemorySource]] = {item_id: [] for item_id in item_ids}
    for row in rows:
        role = str(row[2])
        if role not in EVIDENCE_ROLES:
            continue
        source = MemorySource(source_ref=row[1], evidence_role=role)  # type: ignore[arg-type]
        validate_memory_sources([source])
        sources_by_item_id.setdefault(row[0], []).append(source)
    return sources_by_item_id


def _load_memory_source_rows(
    db: Session,
    item_ids: Sequence[UUID],
) -> dict[UUID, list[ConversationMemoryItemSourceOut]]:
    if not item_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT id, memory_item_id, ordinal, source_ref, evidence_role, created_at
            FROM conversation_memory_item_sources
            WHERE memory_item_id IN :item_ids
            ORDER BY memory_item_id ASC, ordinal ASC
            """
        ).bindparams(bindparam("item_ids", expanding=True)),
        {"item_ids": list(item_ids)},
    ).fetchall()
    sources_by_item_id: dict[UUID, list[ConversationMemoryItemSourceOut]] = {
        item_id: [] for item_id in item_ids
    }
    for row in rows:
        sources_by_item_id.setdefault(row[1], []).append(
            ConversationMemoryItemSourceOut(
                id=row[0],
                memory_item_id=row[1],
                ordinal=row[2],
                source_ref=SourceRef.model_validate(row[3]),
                evidence_role=row[4],
                created_at=row[5],
            )
        )
    return sources_by_item_id


def _has_str(mapping: Mapping[str, object], key: str) -> bool:
    value = mapping.get(key)
    return isinstance(value, str) and bool(value)
