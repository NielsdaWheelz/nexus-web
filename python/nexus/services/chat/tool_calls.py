"""``message_tool_calls``: one row per tool position of an answer; index 0 is attached evidence.

A position's row is inserted before its events are written and completed once;
nothing replays it.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun

_FINISH = text(
    """
    UPDATE message_tool_calls
    SET search_query_fingerprint = :fingerprint, scope = :scope,
        requested_types = :requested_types, result_refs = :result_refs,
        selected_context_refs = :selected_context_refs,
        provider_request_ids = :provider_request_ids, latency_ms = :latency_ms,
        status = CASE WHEN CAST(:error_code AS text) IS NULL THEN 'complete' ELSE 'error' END,
        error_code = :error_code, updated_at = now()
    WHERE assistant_message_id = :assistant_message_id AND tool_call_index = :index
    RETURNING id, provider_wire_name
    """
).bindparams(
    *(
        bindparam(name, type_=JSONB)
        for name in (
            "requested_types",
            "result_refs",
            "selected_context_refs",
            "provider_request_ids",
        )
    )
)


def start(
    db: Session,
    *,
    run: ChatRun,
    index: int,
    position_id: UUID,
    canonical_tool_id: str,
    input_sha256: str,
    contract_revision: str,
    binding_revision: str,
    wire_name: str,
    scope: str,
) -> UUID:
    """The running row of one dispatched position (positions start at 1)."""

    return db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id, user_message_id, assistant_message_id, canonical_tool_id,
                record_kind, provider_wire_name, canonical_input_sha256, tool_contract_revision,
                binding_policy_revision, tool_position_id, tool_call_index, scope, status
            ) VALUES (
                :conversation_id, :user_message_id, :assistant_message_id, :canonical_tool_id,
                'current_execution', :wire_name, :input_sha256, :contract_revision,
                :binding_revision, :position_id, :index, :scope, 'running'
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
            "canonical_tool_id": canonical_tool_id,
            "wire_name": wire_name,
            "input_sha256": input_sha256,
            "contract_revision": contract_revision,
            "binding_revision": binding_revision,
            "position_id": position_id,
            "index": index,
            "scope": scope,
        },
    ).scalar_one()


def finish(
    db: Session,
    *,
    assistant_message_id: UUID,
    index: int,
    error_code: str | None,
    search_query_fingerprint: str | None,
    scope: str,
    requested_types: list[str],
    result_refs: list[dict[str, Any]],
    selected_context_refs: list[dict[str, Any]],
    provider_request_ids: list[str],
    latency_ms: int | None,
) -> tuple[UUID, str]:
    """Complete (or fail) a position's row; returns its id and provider wire name."""

    row = db.execute(
        _FINISH,
        {
            "assistant_message_id": assistant_message_id,
            "index": index,
            "error_code": error_code,
            "fingerprint": search_query_fingerprint,
            "scope": scope,
            "requested_types": requested_types,
            "result_refs": result_refs,
            "selected_context_refs": selected_context_refs,
            "provider_request_ids": provider_request_ids,
            "latency_ms": latency_ms,
        },
    ).one()
    return row.id, row.provider_wire_name


def attached(db: Session, run: ChatRun) -> UUID:
    """The index-0 row that carries this turn's attached evidence."""

    return db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id, user_message_id, assistant_message_id, record_kind,
                tool_call_index, scope, status
            ) VALUES (
                :conversation_id, :user_message_id, :assistant_message_id, 'attached_context',
                0, 'attached_context', 'complete'
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


def live_write_count(db: Session, *, assistant_message_id: UUID, tool_ids: Collection[str]) -> int:
    """Complete, unreverted writes of this answer: an Undo reclaims write budget."""

    return db.execute(
        text(
            """
            SELECT count(*) FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND status = 'complete' AND reverted_at IS NULL
              AND record_kind = 'current_execution' AND canonical_tool_id = ANY(:tool_ids)
            """
        ),
        {"assistant_message_id": assistant_message_id, "tool_ids": list(tool_ids)},
    ).scalar_one()
