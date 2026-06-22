"""Finalize chat runs: persist the assistant message, key-status feedback, done event."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, func, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.errors import ApiErrorCode
from nexus.schemas.conversation import chat_run_event_payload_json
from nexus.services import run_kit
from nexus.services.api_key_resolver import ResolvedKey, update_user_key_status
from nexus.services.chat_retrieval_plan import source_boundary_policy_json, source_domain_for_tool
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_message_blocks import message_document

MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"

ERROR_CODE_TO_MESSAGE = {
    "E_LLM_TIMEOUT": "The model timed out while responding. Please try again.",
    "E_LLM_RATE_LIMIT": "The model is temporarily rate-limited. Please try again shortly.",
    "E_LLM_INVALID_KEY": "The configured API key is invalid or has been revoked.",
    "E_LLM_PROVIDER_DOWN": "The model provider is currently unavailable. Please try again later.",
    "E_LLM_BAD_REQUEST": (
        "The request was rejected by the model provider. Please try a different model or setting."
    ),
    "E_LLM_CONTEXT_TOO_LARGE": "The context was too large for the model. Please try with less context.",
    "E_MODEL_NOT_AVAILABLE": "The requested model is not available.",
    "E_LLM_INTERRUPTED": "The model response was interrupted. Please try again.",
    "E_LLM_INCOMPLETE": (
        "The model ran out of output tokens before it could finish. "
        "Try again with less context or a lower reasoning setting."
    ),
    "E_LLM_TOOL_ITERATIONS_EXCEEDED": (
        "The response needed too many tool steps. Try a narrower question or fewer sources."
    ),
    "E_LLM_TOOL_OUTPUT_TOO_LARGE": (
        "The tools returned too much context. Try a narrower question or source."
    ),
    "E_CONTEXT_TOO_LARGE": "One selected context is too large or unavailable. Remove it and try again.",
    "E_APP_SEARCH_FAILED": "The scoped content search failed. Please try again.",
    "E_CANCELLED": "Request cancelled.",
    "E_TOKEN_BUDGET_EXCEEDED": "Monthly AI token quota exceeded.",
}


def finalize_error(
    db: Session,
    *,
    run_id: UUID,
    error_code: str,
    error_detail: str | None = None,
    resolved_key: ResolvedKey | None = None,
    assistant_content: str | None = None,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
    cancelled: bool | None = None,
    commit: bool = True,
) -> None:
    """Finalize a run as an error using the standard error/error/error status shape.

    Defaults `assistant_content` to `ERROR_CODE_TO_MESSAGE[error_code]` with a
    generic fallback when the code is unknown.
    """
    content = (
        assistant_content
        if assistant_content is not None
        else ERROR_CODE_TO_MESSAGE.get(
            error_code, "An unexpected error occurred. Please try again."
        )
    )
    finalize_run(
        db,
        run_id=run_id,
        assistant_content=content,
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=error_code,
        error_detail=error_detail,
        resolved_key=resolved_key,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
        cancelled=cancelled,
        commit=commit,
    )


def finalize_interrupted(db: Session, run: ChatRun) -> None:
    _repair_abandoned_tool_calls(
        db,
        run,
        error_code="interrupted_before_tool_result",
        source_policy_reason="provider_stream_interrupted",
    )
    finalize_error(db, run_id=run.id, error_code=ApiErrorCode.E_LLM_INTERRUPTED.value)


def finalize_cancelled(
    db: Session,
    run: ChatRun,
    resolved_key: ResolvedKey | None,
    *,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
) -> None:
    _repair_abandoned_tool_calls(
        db,
        run,
        error_code=ApiErrorCode.E_CANCELLED.value,
        source_policy_reason="chat_run_cancelled",
    )
    finalize_run(
        db,
        run_id=run.id,
        assistant_content=ERROR_CODE_TO_MESSAGE["E_CANCELLED"],
        assistant_status="cancelled",
        run_status="cancelled",
        done_status="cancelled",
        error_code=ApiErrorCode.E_CANCELLED.value,
        resolved_key=resolved_key,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
        cancelled=True,
    )


def finalize_run(
    db: Session,
    *,
    run_id: UUID,
    assistant_content: str,
    assistant_status: str,
    run_status: str,
    done_status: str,
    error_code: str | None,
    error_detail: str | None = None,
    resolved_key: ResolvedKey | None = None,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
    cancelled: bool | None = None,
    commit: bool = True,
) -> None:
    run = (
        db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().first()
    )
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        if commit:
            db.commit()
        return

    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is not None:
        content = assistant_content
        if assistant_status == "complete" and len(content) > MAX_ASSISTANT_CONTENT_LENGTH:
            content = content[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE
        assistant_message.content = content
        assistant_message.status = assistant_status
        assistant_message.error_code = error_code
        assistant_message.updated_at = func.now()
        assistant_message.message_document = message_document("assistant", content)

    if resolved_key is not None and resolved_key.mode == "byok":
        if assistant_status == "complete":
            update_user_key_status(db, resolved_key.user_key_id, "valid")
        elif error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
            update_user_key_status(db, resolved_key.user_key_id, "invalid")

    if run_status != "complete" and error_code is not None:
        _fail_started_llm_calls(
            db,
            run,
            error_code=error_code,
            error_detail=error_detail or ERROR_CODE_TO_MESSAGE.get(error_code, error_code),
        )

    done_payload: dict[str, Any] = {"status": done_status}
    if error_code is not None:
        done_payload["error_code"] = error_code
    if assistant_message is not None and done_status == "complete":
        done_payload["final_chars"] = len(assistant_message.content)
    done_payload["usage"] = usage
    done_payload["last_provider_event_seq"] = last_provider_event_seq
    done_payload["cancelled"] = cancelled
    run_kit.mark_terminal(
        db,
        stream=run_kit.chat_run_stream(run),
        status=run_status,
        done_payload=chat_run_event_payload_json("done", done_payload),
        error_code=error_code,
        error_detail=error_detail,
    )
    if commit:
        db.commit()


def _fail_started_llm_calls(
    db: Session,
    run: ChatRun,
    *,
    error_code: str,
    error_detail: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE llm_calls
            SET call_status = 'failed',
                error_class = :error_code,
                error_detail = COALESCE(error_detail, :error_detail),
                terminal_attempt_status = :terminal_attempt_status
            WHERE owner_kind = 'chat_run'
              AND owner_id = :run_id
              AND call_status = 'started'
            """
        ),
        {
            "run_id": run.id,
            "error_code": error_code,
            "error_detail": error_detail,
            "terminal_attempt_status": "abandoned"
            if error_code == ApiErrorCode.E_LLM_INTERRUPTED.value
            else "terminal_error",
        },
    )


def _repair_abandoned_tool_calls(
    db: Session,
    run: ChatRun,
    *,
    error_code: str,
    source_policy_reason: str,
) -> None:
    running_tools = db.execute(
        text(
            """
            SELECT id, source_domain
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND status = 'running'
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    ).fetchall()
    for tool_id, source_domain in running_tools:
        db.execute(
            text(
                """
                UPDATE message_tool_calls
                SET status = 'error',
                    error_code = :error_code,
                    source_policy = :source_policy,
                    updated_at = now()
                WHERE id = :tool_id
                """
            ).bindparams(bindparam("source_policy", type_=JSONB)),
            {
                "tool_id": tool_id,
                "error_code": error_code,
                "source_policy": source_boundary_policy_json(
                    source_domain=source_domain,
                    decision="blocked",
                    reason=source_policy_reason,
                ),
            },
        )
    rows = db.execute(
        text(
            """
            SELECT DISTINCT
                CAST(payload->>'tool_call_index' AS integer) AS tool_call_index,
                payload->>'tool_name' AS tool_name
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('tool_call_start', 'tool_call_delta', 'tool_call_done')
              AND payload->>'tool_call_id' IS NULL
              AND payload->>'tool_call_index' ~ '^[0-9]+$'
            ORDER BY tool_call_index
            """
        ),
        {"run_id": run.id},
    ).fetchall()
    for tool_call_index, tool_name in rows:
        tool_name = tool_name or "unknown_tool"
        source_domain = source_domain_for_tool(tool_name)
        tool_call_id = db.execute(
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
                    source_domain,
                    source_policy,
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
                    'provider_stream',
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    :source_domain,
                    :source_policy,
                    NULL,
                    'error',
                    :error_code
                )
                ON CONFLICT (assistant_message_id, tool_call_index)
                DO UPDATE SET
                    status = 'error',
                    error_code = :error_code,
                    source_domain = :source_domain,
                    source_policy = :source_policy,
                    updated_at = now()
                RETURNING id
                """
            ).bindparams(bindparam("source_policy", type_=JSONB)),
            {
                "conversation_id": run.conversation_id,
                "user_message_id": run.user_message_id,
                "assistant_message_id": run.assistant_message_id,
                "tool_name": tool_name,
                "tool_call_index": tool_call_index,
                "source_domain": source_domain,
                "source_policy": source_boundary_policy_json(
                    source_domain=source_domain,
                    decision="blocked",
                    reason=source_policy_reason,
                ),
                "error_code": error_code,
            },
        ).scalar_one()
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
    db.execute(
        text(
            """
            UPDATE message_rerank_ledgers
            SET status = 'error',
                metadata = jsonb_set(
                    metadata,
                    '{error_code}',
                    to_jsonb(CAST(:error_code AS text)),
                    true
                )
            WHERE tool_call_id IN (
                SELECT id
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND error_code = :error_code
            )
            """
        ),
        {"assistant_message_id": run.assistant_message_id, "error_code": error_code},
    )
