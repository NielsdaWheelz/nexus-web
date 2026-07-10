"""Chat-run tool dispatch and output.

Sole owner of the ``message_tool_calls`` lifecycle (start / error / trace) and of
the provider-tool-event binding plus the tool-output rendering for
``app_search`` / ``web_search``. Extracted verbatim from ``chat_runs.py`` (the
executor calls into here); behavior — SQL, commit handling, event payload shapes
— is unchanged.

One-way dependency: this module reaches into ``chat_run_citations`` for the prune
owner (``persist_tool_call_start`` / ``persist_tool_call_trace`` re-arm a tool
call by pruning its prior telemetry rows). ``chat_run_citations`` must not import
back.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.services.chat_run_citations import prune_tool_call_retrievals


def app_search_tool_output(run_result: Any, start_ordinal: int) -> str:
    next_ordinal = start_ordinal
    results = []
    for citation in run_result.selected_citations:
        item: dict[str, object] = {
            "title": citation.title,
            "snippet": citation.snippet,
            "kind": citation.result_type,
            "source_label": citation.source_label,
        }
        if citation.citation_target is not None:
            item["n"] = next_ordinal
            next_ordinal += 1
        results.append(item)
    return json.dumps(
        {
            "results": results,
            "total_candidates": len(run_result.citations),
            "status": run_result.status,
            "error_code": run_result.error_code,
        },
        default=str,
    )


def web_search_tool_output(run_result: Any, start_ordinal: int) -> str:
    results = [
        {
            "n": start_ordinal + i,
            "title": citation.title,
            "url": citation.url,
            "snippet": citation.snippet,
            "source": citation.source_name,
            "published_at": citation.published_at,
        }
        for i, citation in enumerate(run_result.selected_citations)
    ]
    return json.dumps(
        {
            "results": results,
            "total_candidates": len(run_result.citations),
            "status": run_result.status,
            "error_code": run_result.error_code,
        },
        default=str,
    )


def persist_tool_call_start(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    scope: str,
    requested_types: list[str],
) -> UUID:
    params = {
        "conversation_id": run.conversation_id,
        "user_message_id": run.user_message_id,
        "assistant_message_id": run.assistant_message_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "scope": scope,
        "requested_types": requested_types,
    }
    existing = db.execute(
        text(
            """
            SELECT id
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = :tool_call_index
            FOR UPDATE
            """
        ),
        params,
    ).first()
    if existing is None:
        return db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    tool_name,
                    tool_call_index,
                    query_hash,
                    scope,
                    requested_types,
                    result_refs,
                    selected_context_refs,
                    provider_request_ids,
                    latency_ms,
                    status,
                    error_code
                )
                VALUES (
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    :tool_name,
                    :tool_call_index,
                    NULL,
                    :scope,
                    :requested_types,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    NULL,
                    'running',
                    NULL
                )
                RETURNING id
                """
            ).bindparams(bindparam("requested_types", type_=JSONB)),
            params,
        ).scalar_one()

    tool_call_id = existing[0]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET tool_name = :tool_name,
                query_hash = NULL,
                scope = :scope,
                requested_types = :requested_types,
                result_refs = '[]'::jsonb,
                selected_context_refs = '[]'::jsonb,
                provider_request_ids = '[]'::jsonb,
                latency_ms = NULL,
                status = 'running',
                error_code = NULL,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ).bindparams(bindparam("requested_types", type_=JSONB)),
        {**params, "tool_call_id": tool_call_id},
    )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def persist_tool_call_error(db: Session, *, tool_call_id: UUID, error_code: str) -> None:
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET status = 'error',
                error_code = :error_code,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ),
        {"tool_call_id": tool_call_id, "error_code": error_code},
    )


def bind_provider_tool_call_events(
    db: Session, *, run: ChatRun, tool_call_index: int, tool_call_id: UUID
) -> None:
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
              AND event_type IN ('tool_call_start', 'tool_call_delta', 'tool_call_done')
              AND payload->>'tool_call_index' = :tool_call_index
            """
        ),
        {
            "run_id": run.id,
            "tool_call_index": str(tool_call_index),
            "tool_call_id": str(tool_call_id),
        },
    )


def tool_start_event(
    *,
    run: ChatRun,
    tool_call_id: UUID,
    tool_call_index: int,
    tool_name: str,
    scope: str,
    types: list[str],
    filters: dict[str, object],
) -> dict[str, object]:
    return {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(run.assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "status": "running",
        "scope": scope,
        "types": types,
        "filters": filters,
        "error_code": None,
    }


def persist_tool_call_trace(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    result: Any,
) -> UUID:
    """Persist a read_resource / inspect_resource invocation as a message_tool_calls row.

    Read evidence may get one message_retrievals row after this parent is
    inserted. Inspect maps and too_large redirects stay trace-only.
    """
    payload = {
        "uri": result.uri,
        "status": result.status,
        "error_code": result.error_code,
        "body_chars": len(result.body or ""),
    }
    params = {
        "conversation_id": run.conversation_id,
        "user_message_id": run.user_message_id,
        "assistant_message_id": run.assistant_message_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "payload": json.dumps([payload]),
        "status": "error" if result.is_error else "complete",
        "error_code": result.error_code,
    }
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :assistant_message_id "
            "AND tool_call_index = :tool_call_index "
            "FOR UPDATE"
        ),
        params,
    ).first()
    if existing is None:
        return db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    tool_name,
                    tool_call_index,
                    scope,
                    result_refs,
                    selected_context_refs,
                    provider_request_ids,
                    status,
                    error_code
                )
                VALUES (
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    :tool_name,
                    :tool_call_index,
                    'conversation_context',
                    CAST(:payload AS JSONB),
                    '[]'::jsonb,
                    '[]'::jsonb,
                    :status,
                    :error_code
                )
                RETURNING id
                """
            ),
            params,
        ).scalar_one()

    tool_call_id = existing[0]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET tool_name = :tool_name,
                scope = 'conversation_context',
                result_refs = CAST(:payload AS JSONB),
                selected_context_refs = '[]'::jsonb,
                provider_request_ids = '[]'::jsonb,
                status = :status,
                error_code = :error_code
            WHERE id = :tool_call_id
            """
        ),
        {**params, "tool_call_id": tool_call_id},
    )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def persist_write_tool_call(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    created_refs: list[dict[str, Any]],
    status: str,
    error_code: str | None,
) -> UUID:
    """Persist an assistant write tool call, recording its created refs.

    Sibling of ``persist_tool_call_trace`` (D-8), not a fork: the payload is a
    list of created refs (``[{kind, id, ...}]``) rather than the read
    ``{uri, status, body_chars}`` object, and — because
    ``create_highlight_for_fragment`` commits internally — this row is written
    *after* an intervening commit (the two-commit window, R-3). It shares the
    same ``FOR UPDATE`` re-arm-on-retry pattern so a re-driven turn overwrites
    the prior attempt's refs rather than duplicating them.
    """
    params = {
        "conversation_id": run.conversation_id,
        "user_message_id": run.user_message_id,
        "assistant_message_id": run.assistant_message_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "result_refs": json.dumps(created_refs),
        "status": status,
        "error_code": error_code,
    }
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :assistant_message_id "
            "AND tool_call_index = :tool_call_index "
            "FOR UPDATE"
        ),
        params,
    ).first()
    if existing is None:
        return db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    tool_name,
                    tool_call_index,
                    scope,
                    result_refs,
                    selected_context_refs,
                    provider_request_ids,
                    status,
                    error_code
                )
                VALUES (
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    :tool_name,
                    :tool_call_index,
                    'assistant_write',
                    CAST(:result_refs AS JSONB),
                    '[]'::jsonb,
                    '[]'::jsonb,
                    :status,
                    :error_code
                )
                RETURNING id
                """
            ),
            params,
        ).scalar_one()

    tool_call_id = existing[0]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET tool_name = :tool_name,
                scope = 'assistant_write',
                result_refs = CAST(:result_refs AS JSONB),
                selected_context_refs = '[]'::jsonb,
                provider_request_ids = '[]'::jsonb,
                status = :status,
                error_code = :error_code,
                reverted_at = NULL,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ),
        {**params, "tool_call_id": tool_call_id},
    )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def assistant_write_tool_call_count(
    db: Session, *, assistant_message_id: UUID, tool_names: Sequence[str]
) -> int:
    """Committed, non-reverted assistant write tool calls for this message.

    The per-run write cap (amanuensis D-6/AC-9) counts rows WHERE
    ``reverted_at IS NULL`` and ``status = 'complete'`` — so undo reclaims budget.
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
                  AND tool_name = ANY(:tool_names)
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "tool_names": list(tool_names),
            },
        ).scalar_one()
    )


def tool_trace_event(
    *,
    run: ChatRun,
    tool_call_id: UUID,
    tool_call_index: int,
    tool_name: str,
    result: Any,
) -> dict[str, object]:
    return {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(run.assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "status": "error" if result.is_error else "complete",
        "scope": "conversation_context",
        "types": [],
        "filters": {"uri": result.uri},
        "error_code": result.error_code,
    }
