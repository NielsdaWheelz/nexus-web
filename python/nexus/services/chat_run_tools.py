"""The ``message_tool_calls`` writer and reader.

Sole owner of the strict tool-call row: its canonical replay identity, the
upsert at one position, the attached-context row at index 0, and the back-bind
of the provider events written before the row existed.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, MessageToolCall

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class RecordKind(StrEnum):
    current_execution = "current_execution"
    historical_execution = "historical_execution"
    attached_context = "attached_context"


@dataclass(frozen=True, slots=True)
class PersistedToolRecord:
    id: UUID
    assistant_message_id: UUID
    canonical_tool_id: str | None
    record_kind: RecordKind
    provider_wire_name: str | None
    canonical_input_sha256: str | None
    tool_contract_revision: str | None
    binding_policy_revision: str | None
    tool_call_index: int
    scope: str
    status: str
    error_code: str | None


@dataclass(frozen=True, slots=True)
class CurrentToolRecordIdentity:
    canonical_tool_id: str
    canonical_input_sha256: str
    tool_contract_revision: str
    binding_policy_revision: str

    def __post_init__(self) -> None:
        if _SHA256.fullmatch(self.canonical_input_sha256) is None:
            raise ValueError("current tool identity has an invalid canonical-input digest")
        if _SHA256.fullmatch(self.binding_policy_revision) is None:
            raise ValueError("current tool identity has an invalid binding-policy revision")


def _declaration(canonical_tool_id: str) -> Any:
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

    declaration = CHAT_TOOL_DECLARATIONS_BY_ID.get(canonical_tool_id)
    if declaration is None:
        raise ValueError(f"unknown current tool id: {canonical_tool_id!r}")
    return declaration


def current_tool_record_identity(
    *,
    canonical_tool_id: str,
    canonical_input_sha256: str,
    binding_policy_revision: str,
) -> CurrentToolRecordIdentity:
    """Bind storage identity to the digest already occupied by ToolExecutor."""

    return CurrentToolRecordIdentity(
        canonical_tool_id=canonical_tool_id,
        canonical_input_sha256=canonical_input_sha256,
        tool_contract_revision=_declaration(canonical_tool_id).spec.tool_contract_revision,
        binding_policy_revision=binding_policy_revision,
    )


def decode_persisted_tool_record(row: MessageToolCall) -> PersistedToolRecord:
    try:
        kind = RecordKind(row.record_kind)
    except (TypeError, ValueError) as exc:
        raise AssertionError("invalid persisted tool record: unknown record kind") from exc
    return PersistedToolRecord(
        id=row.id,
        assistant_message_id=row.assistant_message_id,
        canonical_tool_id=row.canonical_tool_id,
        record_kind=kind,
        provider_wire_name=row.provider_wire_name,
        canonical_input_sha256=row.canonical_input_sha256,
        tool_contract_revision=row.tool_contract_revision,
        binding_policy_revision=row.binding_policy_revision,
        tool_call_index=row.tool_call_index,
        scope=row.scope,
        status=row.status,
        error_code=row.error_code,
    )


_INSERT_CURRENT = text(
    """
    INSERT INTO message_tool_calls (
        conversation_id, user_message_id, assistant_message_id, canonical_tool_id,
        record_kind, provider_wire_name, canonical_input_sha256, tool_contract_revision,
        binding_policy_revision, tool_position_id, tool_call_index, search_query_fingerprint,
        scope, requested_types, result_refs, selected_context_refs, provider_request_ids,
        latency_ms, status, error_code
    ) VALUES (
        :conversation_id, :user_message_id, :assistant_message_id, :canonical_tool_id,
        'current_execution', :provider_wire_name, :canonical_input_sha256,
        :tool_contract_revision, :binding_policy_revision, :tool_position_id,
        :tool_call_index, :search_query_fingerprint, :scope, :requested_types, :result_refs,
        :selected_context_refs, :provider_request_ids, :latency_ms, :status, :error_code
    )
    RETURNING id
    """
).bindparams(
    bindparam("requested_types", type_=JSONB),
    bindparam("result_refs", type_=JSONB),
    bindparam("selected_context_refs", type_=JSONB),
    bindparam("provider_request_ids", type_=JSONB),
)

_UPDATE_CURRENT = text(
    """
    UPDATE message_tool_calls
    SET provider_wire_name = :provider_wire_name,
        search_query_fingerprint = :search_query_fingerprint,
        scope = :scope,
        requested_types = :requested_types,
        result_refs = :result_refs,
        selected_context_refs = :selected_context_refs,
        provider_request_ids = :provider_request_ids,
        latency_ms = :latency_ms,
        status = :status,
        error_code = :error_code,
        reverted_at = CASE WHEN :clear_reverted THEN NULL ELSE reverted_at END,
        updated_at = now()
    WHERE id = :tool_call_id
    """
).bindparams(
    bindparam("requested_types", type_=JSONB),
    bindparam("result_refs", type_=JSONB),
    bindparam("selected_context_refs", type_=JSONB),
    bindparam("provider_request_ids", type_=JSONB),
)


def persist_current_tool_record(
    db: Session,
    *,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    tool_call_index: int,
    tool_position_id: UUID | None,
    identity: CurrentToolRecordIdentity,
    provider_wire_name: str | None = None,
    search_query_fingerprint: str | None,
    scope: str,
    requested_types: list[str],
    result_refs: list[dict[str, Any]],
    selected_context_refs: list[dict[str, Any]],
    provider_request_ids: list[str],
    latency_ms: int | None,
    status: str,
    error_code: str | None,
    clear_reverted: bool = False,
) -> UUID:
    """Insert or update one current row without changing position identity."""

    if tool_call_index < 1:
        raise ValueError("current tool-call index must be positive")
    params = {
        "conversation_id": conversation_id,
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_message_id,
        "tool_call_index": tool_call_index,
        "tool_position_id": tool_position_id,
        "canonical_tool_id": identity.canonical_tool_id,
        "provider_wire_name": provider_wire_name,
        "canonical_input_sha256": identity.canonical_input_sha256,
        "tool_contract_revision": identity.tool_contract_revision,
        "binding_policy_revision": identity.binding_policy_revision,
        "search_query_fingerprint": search_query_fingerprint,
        "scope": scope,
        "requested_types": requested_types,
        "result_refs": result_refs,
        "selected_context_refs": selected_context_refs,
        "provider_request_ids": provider_request_ids,
        "latency_ms": latency_ms,
        "status": status,
        "error_code": error_code,
        "clear_reverted": clear_reverted,
    }
    existing = db.execute(
        text(
            """
            SELECT id FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = :tool_call_index
            FOR UPDATE
            """
        ),
        params,
    ).scalar_one_or_none()
    if existing is None:
        return db.execute(_INSERT_CURRENT, params).scalar_one()
    db.execute(_UPDATE_CURRENT, {**params, "tool_call_id": existing})
    return existing


def persist_tool_call_start(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_position_id: UUID | None,
    identity: CurrentToolRecordIdentity,
    provider_wire_name: str | None = None,
    scope: str,
    requested_types: list[str],
) -> UUID:
    tool_call_id = persist_current_tool_record(
        db,
        conversation_id=run.conversation_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=tool_call_index,
        tool_position_id=tool_position_id,
        identity=identity,
        provider_wire_name=provider_wire_name,
        search_query_fingerprint=None,
        scope=scope,
        requested_types=requested_types,
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[],
        latency_ms=None,
        status="running",
        error_code=None,
    )
    from nexus.services.chat_run_citations import prune_tool_call_retrievals

    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def upsert_attached_context_tool_call(db: Session, *, run: ChatRun) -> UUID:
    """The index-0 row that carries this turn's attached evidence."""

    existing = db.execute(
        text(
            """
            SELECT id FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = 0
            FOR UPDATE
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    return db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id, user_message_id, assistant_message_id,
                canonical_tool_id, record_kind, provider_wire_name,
                canonical_input_sha256, tool_contract_revision,
                binding_policy_revision, tool_call_index, scope,
                requested_types, result_refs, selected_context_refs,
                provider_request_ids, status, error_code
            ) VALUES (
                :conversation_id, :user_message_id, :assistant_message_id,
                NULL, 'attached_context', NULL, NULL, NULL, NULL, 0,
                'attached_context', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '[]'::jsonb, 'complete', NULL
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
        },
    ).scalar_one()


def bind_provider_tool_call_events(
    db: Session, *, run: ChatRun, tool_call_index: int, tool_call_id: UUID
) -> None:
    """Stamp the row id onto the events written before the row existed."""

    db.execute(
        text(
            """
            UPDATE chat_run_events
            SET payload = jsonb_set(
                payload,
                '{tool_call_id}',
                to_jsonb(CAST(:tool_call_id AS text)),
                true
            )
            WHERE run_id = :run_id
              AND event_type IN ('tool_call_start', 'tool_call_done')
              AND payload->>'tool_call_index' = :tool_call_index
            """
        ),
        {
            "run_id": run.id,
            "tool_call_index": str(tool_call_index),
            "tool_call_id": str(tool_call_id),
        },
    )


def assistant_write_tool_call_count(
    db: Session, *, assistant_message_id: UUID, canonical_tool_ids: Sequence[str]
) -> int:
    """Committed, non-reverted assistant write tool calls for this message.

    The per-run write cap counts rows WHERE ``reverted_at IS NULL`` and
    ``status = 'complete'`` — so undo reclaims budget.
    """

    return int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND status = 'complete'
                  AND reverted_at IS NULL
                  AND record_kind = 'current_execution'
                  AND canonical_tool_id = ANY(:canonical_tool_ids)
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "canonical_tool_ids": list(canonical_tool_ids),
            },
        ).scalar_one()
    )
