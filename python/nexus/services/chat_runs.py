"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID

from llm_calling.errors import LLMError
from llm_calling.types import LLMChunk, LLMRequest, LLMUsage, ToolResult, ToolSpec, Turn
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    Conversation,
    Message,
    Model,
)
from nexus.errors import (
    LLM_ERROR_CODE_TO_API_ERROR_CODE,
    ApiError,
    ApiErrorCode,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    BranchAnchorRequest,
    ChatRunEventOut,
    ChatRunResponse,
    ReaderContextHint,
)
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_TOOL_DEFINITION,
    APP_SEARCH_TOOL_NAME,
    execute_app_search,
)
from nexus.services.agent_tools.read_resource import (
    READ_RESOURCE_TOOL_DEFINITION,
    READ_RESOURCE_TOOL_NAME,
    execute_read_resource,
)
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.api_key_resolver import (
    get_model_by_id,
    resolve_api_key,
)
from nexus.services.chat_run_access import (
    get_run_for_owner,
    load_retryable_failed_assistant_message,
    load_source_run_for_retry,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    append_and_commit,
    append_run_event,
    has_delta_without_terminal,
    is_cancel_requested,
    mark_running,
)
from nexus.services.chat_run_finalize import (
    ERROR_CODE_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    dummy_resolved_key,
    finalize_cancelled,
    finalize_error,
    finalize_interrupted,
    finalize_run,
)
from nexus.services.chat_run_idempotency import (
    compute_payload_hash,
    compute_retry_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_blocks import (
    message_document,
)
from nexus.services.chat_run_message_prep import prepare_messages
from nexus.services.chat_run_prompt_tracking import (
    reconcile_prompt_retrievals,
)
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_usage import usage_log_fields, usage_tokens
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.conversation_branches import (
    ensure_branch_metadata,
    persist_active_leaf,
)
from nexus.services.conversation_references import insert_reference_if_absent
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096
LLM_TIMEOUT_SECONDS = 45.0
MAX_TOOL_ITERATIONS = 8

_CHAT_TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name=APP_SEARCH_TOOL_NAME,
        description=APP_SEARCH_TOOL_DEFINITION["description"],
        parameters=APP_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=WEB_SEARCH_TOOL_NAME,
        description=WEB_SEARCH_TOOL_DEFINITION["description"],
        parameters=WEB_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=READ_RESOURCE_TOOL_NAME,
        description=READ_RESOURCE_TOOL_DEFINITION["description"],
        parameters=READ_RESOURCE_TOOL_DEFINITION["parameters"],
    ),
)


class ChatRunLLMRouter(Protocol):
    def generate_stream(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]: ...


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    if model.provider == "openai" and reasoning in {"default", "low", "medium", "high", "max"}:
        return min(REASONING_OUTPUT_TOKENS, model.max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, model.max_context_tokens)


def _assign_citation_ordinals(db: Session, *, tool_call_id: UUID | None, start_ordinal: int) -> int:
    """Assign citation_ordinal to selected retrievals for a tool call; return next ordinal."""
    if tool_call_id is None:
        return start_ordinal
    rows = db.execute(
        text(
            """
            WITH numbered AS (
                SELECT id, :start_ordinal + (ROW_NUMBER() OVER (ORDER BY ordinal) - 1) AS n
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                  AND citation_ordinal IS NULL
            )
            UPDATE message_retrievals AS mr
            SET citation_ordinal = numbered.n
            FROM numbered
            WHERE mr.id = numbered.id
            RETURNING numbered.n
            """
        ),
        {"tool_call_id": tool_call_id, "start_ordinal": start_ordinal},
    ).fetchall()
    return start_ordinal + len(rows)


def _app_search_tool_output(run_result: Any, start_ordinal: int) -> str:
    results = [
        {
            "n": start_ordinal + i,
            "title": citation.title,
            "snippet": citation.snippet,
            "kind": citation.result_type,
            "source_label": citation.source_label,
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


def _web_search_tool_output(run_result: Any, start_ordinal: int) -> str:
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


def _persist_read_resource_tool_call(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    args: dict[str, Any],
    result: Any,
) -> None:
    """Persist a read_resource invocation as a message_tool_calls row.

    No message_retrievals are written: read_resource returns a single body,
    not a list of search candidates. ``result`` is a ``ReadResourceResult``
    from :mod:`nexus.services.agent_tools.read_resource`.
    """
    payload = {
        "uri": result.uri,
        "status": result.status,
        "error_code": result.error_code,
        "args": {"uri": str(args.get("uri") or "")},
        "body_chars": len(result.body or ""),
    }
    db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                scope,
                semantic,
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
                'conversation_references',
                false,
                CAST(:payload AS JSONB),
                '[]'::jsonb,
                '[]'::jsonb,
                :status,
                :error_code
            )
            """
        ),
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
            "tool_name": READ_RESOURCE_TOOL_NAME,
            "tool_call_index": tool_call_index,
            "payload": json.dumps([payload]),
            "status": "error" if result.is_error else "complete",
            "error_code": result.error_code,
        },
    )


def _emit_citation_index(db: Session, run: ChatRun) -> None:
    rows = db.execute(
        text(
            """
            SELECT mr.citation_ordinal,
                   mr.id,
                   mr.tool_call_id,
                   mr.ordinal,
                   mr.result_type,
                   mr.evidence_span_id,
                   mr.media_id,
                   mr.result_ref
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :amid
              AND mr.citation_ordinal IS NOT NULL
            ORDER BY mr.citation_ordinal ASC
            """
        ),
        {"amid": run.assistant_message_id},
    ).fetchall()
    if not rows:
        return
    append_run_event(
        db,
        run,
        "citation_index",
        {
            "assistant_message_id": str(run.assistant_message_id),
            "entries": [
                {
                    "n": row[0],
                    "retrieval_id": str(row[1]),
                    "tool_call_id": str(row[2]),
                    "ordinal": row[3],
                }
                for row in rows
            ],
        },
    )
    for row in rows:
        uri = _retrieval_row_to_uri(
            result_type=row[4],
            evidence_span_id=row[5],
            media_id=row[6],
            result_ref=row[7] or {},
        )
        if uri is None:
            continue
        new_row = insert_reference_if_absent(db, run.conversation_id, uri)
        if new_row is None:
            continue
        append_run_event(
            db,
            run,
            "reference_added",
            {
                "reference_id": str(new_row.id),
                "conversation_id": str(run.conversation_id),
                "resource_uri": uri,
                "created_at": new_row.created_at.isoformat(),
            },
        )


def _retrieval_row_to_uri(
    *,
    result_type: str,
    evidence_span_id: UUID | None,
    media_id: UUID | None,
    result_ref: dict[str, Any],
) -> str | None:
    """Derive a conversation_reference URI from a cited MessageRetrieval row.

    Returns ``None`` for retrieval types that have no persistent URI (e.g.
    ``web_result``) or when required identifiers are missing.
    """
    if result_type == "evidence_span":
        if evidence_span_id is None:
            return None
        return f"span:{evidence_span_id}"
    if result_type == "content_chunk":
        chunk_id = result_ref.get("id")
        if not chunk_id:
            return None
        return f"chunk:{chunk_id}"
    if result_type == "highlight":
        highlight_id = result_ref.get("id")
        if not highlight_id:
            return None
        return f"highlight:{highlight_id}"
    if result_type == "page":
        page_id = result_ref.get("id")
        if not page_id:
            return None
        return f"page:{page_id}"
    if result_type == "note_block":
        block_id = result_ref.get("id")
        if not block_id:
            return None
        return f"note_block:{block_id}"
    if result_type == "media":
        if media_id is None:
            return None
        return f"media:{media_id}"
    if result_type == "conversation":
        conversation_id = result_ref.get("id")
        if not conversation_id:
            return None
        return f"conversation:{conversation_id}"
    if result_type == "message":
        message_id = result_ref.get("id")
        if not message_id:
            return None
        return f"message:{message_id}"
    if result_type == "fragment":
        fragment_id = result_ref.get("id")
        if not fragment_id:
            return None
        return f"fragment:{fragment_id}"
    return None


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    reader_context: ReaderContextHint | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)

    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        conversation_id,
        parent_message_id,
        branch_anchor,
    )

    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        return build_chat_run_response(db, viewer_id, existing)

    model = get_model_by_id(db, model_id)
    if model is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

    try:
        resolved = resolve_api_key(db, viewer_id, model.provider, key_mode)
        use_platform_key = resolved.mode == "platform"
    except ApiError as exc:
        if exc.code != ApiErrorCode.E_MODEL_NOT_AVAILABLE:
            raise
        use_platform_key = False
    except LLMError:
        # justify-ignore-error: BYOK probe may fail when the user has no key
        # yet; treat as "no platform key in use" and continue pre-validation.
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
        content,
        model_id,
        reasoning,
        key_mode,
        use_platform_key,
    )

    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
            content,
            model_id,
        )
        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=model_id,
            reasoning=reasoning,
            key_mode=key_mode,
            next_event_seq=1,
        )
        db.add(run)
        db.flush()
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload=_chat_run_job_payload(run.id, reader_context),
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def _chat_run_job_payload(
    run_id: UUID,
    reader_context: ReaderContextHint | None,
) -> dict[str, object]:
    """Job payload for the chat_run worker.

    Carries reader_context (a request-only model-prompt hint per spec §7.1)
    through to the worker so prompt assembly can render the hint block without
    a dedicated `ChatRun` column. The values are looked up to titles inside
    `_build_reader_context_block` and otherwise discarded.
    """
    payload: dict[str, object] = {"run_id": str(run_id)}
    if reader_context is not None:
        hint: dict[str, str] = {}
        if reader_context.media_id is not None:
            hint["media_id"] = str(reader_context.media_id)
        if reader_context.library_id is not None:
            hint["library_id"] = str(reader_context.library_id)
        if hint:
            payload["reader_context"] = hint
    return payload


def retry_failed_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        assistant_message = load_retryable_failed_assistant_message(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
        )
        source_run = load_source_run_for_retry(
            db,
            viewer_id=viewer_id,
            assistant_message=assistant_message,
        )
        source_user_message = db.get(Message, source_run.user_message_id)
        if source_user_message is None or source_user_message.role != "user":
            raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source prompt not found")
        payload_hash = compute_retry_payload_hash(
            failed_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
        )

        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        model = db.get(Model, source_run.model_id)
        if model is None:
            raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

        user_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="user",
            content=source_user_message.content,
            message_document=message_document("user", source_user_message.content),
            status="complete",
            parent_message_id=source_user_message.parent_message_id,
            branch_root_message_id=source_user_message.branch_root_message_id,
            branch_anchor_kind=source_user_message.branch_anchor_kind,
            branch_anchor=dict(source_user_message.branch_anchor or {}),
        )
        db.add(user_message)
        db.flush()
        if user_message.parent_message_id is not None:
            ensure_branch_metadata(
                db,
                conversation_id=source_run.conversation_id,
                branch_user_message_id=user_message.id,
            )

        assistant_retry_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="assistant",
            content="",
            message_document=message_document("assistant", ""),
            status="pending",
            model_id=source_run.model_id,
            parent_message_id=user_message.id,
            branch_root_message_id=user_message.branch_root_message_id,
            branch_anchor_kind="none",
            branch_anchor={},
        )
        db.add(assistant_retry_message)
        db.flush()
        persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=source_run.conversation_id,
            active_leaf_message_id=assistant_retry_message.id,
        )

        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=source_run.conversation_id,
            user_message_id=user_message.id,
            assistant_message_id=assistant_retry_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=source_run.model_id,
            reasoning=source_run.reasoning,
            key_mode=source_run.key_mode,
            next_event_seq=1,
        )
        db.add(run)
        db.flush()
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(source_run.conversation_id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_retry_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def get_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    return build_chat_run_response(db, viewer_id, run)


def list_chat_runs_for_conversation(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    status: str,
) -> list[ChatRunResponse]:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    if status == "active":
        filters = [ChatRun.status.notin_(TERMINAL_RUN_STATUSES)]
    elif status in {"queued", "running", "complete", "error", "cancelled"}:
        filters = [ChatRun.status == status]
    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid chat run status")

    runs = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.conversation_id == conversation_id,
                *filters,
            )
            .order_by(ChatRun.created_at.asc(), ChatRun.id.asc())
        )
        .scalars()
        .all()
    )
    return [build_chat_run_response(db, viewer_id, run) for run in runs]


def cancel_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    if run.status not in TERMINAL_RUN_STATUSES and run.cancel_requested_at is None:
        run.cancel_requested_at = datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
        db.commit()
    return build_chat_run_response(db, viewer_id, run)


def get_chat_run_events(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
    after: int,
) -> list[ChatRunEventOut]:
    get_run_for_owner(db, viewer_id, run_id)
    rows = (
        db.execute(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id == run_id, ChatRunEvent.seq > after)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    return [
        ChatRunEventOut(
            seq=row.seq,
            event_type=cast(Any, row.event_type),
            payload=row.payload,
            created_at=row.created_at,
        )
        for row in rows
    ]


def is_chat_run_terminal(db: Session, *, viewer_id: UUID, run_id: UUID) -> bool:
    run = get_run_for_owner(db, viewer_id, run_id)
    return run.status in TERMINAL_RUN_STATUSES


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunLLMRouter,
    web_search_provider: WebSearchProvider | None = None,
    reader_context: ReaderContextHint | None = None,
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
            reader_context=reader_context,
        )
    except ApiError as exc:
        logger.warning(
            "chat_run.api_error",
            run_id=str(run_id),
            error_code=exc.code.value,
            error=str(exc),
        )
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=exc.code.value,
                viewer_id=None,
                assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
            )
            return {"status": "error", "error_code": exc.code.value}
        except Exception:
            db.rollback()
            raise
    except Exception as exc:  # justify-ignore-error: chat-run boundary; finalize the run as failed and report E_INTERNAL
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=ApiErrorCode.E_INTERNAL.value,
                viewer_id=None,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_INTERNAL.value}
        except Exception:
            db.rollback()
            raise
    finally:
        set_flow_id(None)


async def _execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunLLMRouter,
    web_search_provider: WebSearchProvider | None = None,
    reader_context: ReaderContextHint | None = None,
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if has_delta_without_terminal(db, run.id):
        finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        finalize_error(
            db,
            run_id=run.id,
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
            viewer_id=run.owner_user_id,
            key_mode=run.key_mode,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        finalize_cancelled(db, run, model, None, 0)
        return {"status": "cancelled"}

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except LLMError as exc:
        error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[exc.error_code].value
        finalize_error(
            db,
            run_id=run.id,
            error_code=error_code,
            viewer_id=run.owner_user_id,
            model=model,
            resolved_key=dummy_resolved_key(model),
            key_mode=run.key_mode,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
        )
        return {"status": "error", "error_code": error_code}

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    budget_reserved = False
    start_time = time.monotonic()
    max_output_tokens = _max_output_tokens_for_reasoning(model, run.reasoning)
    try:
        if resolved_key.mode == "platform":
            est_tokens = len(run.user_message.content) // 4 + max_output_tokens
            rate_limiter.reserve_token_budget(
                run.owner_user_id, run.assistant_message_id, est_tokens
            )
            budget_reserved = True

        conversation = db.get(Conversation, run.conversation_id)
        user_message = db.get(Message, run.user_message_id)
        if conversation is None or user_message is None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                assistant_content="Conversation not found.",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

        if is_cancel_requested(db, run.id):
            finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        try:
            assembly = assemble_chat_context(
                db,
                run=run,
                model=model,
                environment=get_settings().nexus_env.value,
                key_mode_used=resolved_key.mode,
                provider_account_boundary=resolved_key.user_key_id or resolved_key.mode,
                max_output_tokens=max_output_tokens,
                reader_context=reader_context,
            )
            persist_prompt_assembly(db, run=run, assembly=assembly)
            reconcile_prompt_retrievals(db, run=run, assembly=assembly)
            db.commit()
        except ContextBudgetError as exc:
            logger.warning(
                "chat_run.context_budget_exceeded",
                run_id=str(run.id),
                lane=exc.lane,
                item_key=exc.item_key,
                requested_tokens=exc.requested_tokens,
                remaining_tokens=exc.remaining_tokens,
            )
            error_code = exc.api_error_code.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
            )
            return {"status": "error", "error_code": error_code}

        llm_request = dataclasses.replace(assembly.llm_request, tools=_CHAT_TOOL_SPECS)
        turns: list[Turn] = list(llm_request.messages)
        full_content = ""
        usage: LLMUsage | None = None
        provider_request_id: str | None = None
        incomplete_reason: str | None = None
        terminal_seen = False
        locally_truncated = False
        citation_n_next = 1
        tool_call_index_next = 0
        llm_start = time.monotonic()
        llm_log_fields = safe_kv(
            provider=model.provider,
            model_name=llm_request.model_name,
            reasoning_effort=llm_request.reasoning_effort,
            key_mode=resolved_key.mode,
            streaming=True,
            llm_operation="chat_send",
            conversation_id=str(run.conversation_id),
            assistant_message_id=str(run.assistant_message_id),
            prompt_chars=assembly.prompt_plan.text_char_count(),
            stable_prefix_hash=assembly.prompt_plan.stable_prefix_hash,
            provider_request_hash=assembly.prompt_plan.provider_request_hash,
            cacheable_input_tokens_estimate=assembly.prompt_plan.cacheable_input_tokens_estimate,
        )
        logger.info("llm.request.started", **llm_log_fields)
        try:
            for _iteration in range(MAX_TOOL_ITERATIONS):
                pending_tool_calls: list[Any] = []
                iter_text = ""
                iter_terminal = False
                iter_request = dataclasses.replace(llm_request, messages=turns)
                async for chunk in llm_router.generate_stream(
                    model.provider,
                    iter_request,
                    resolved_key.api_key,
                    timeout_s=int(LLM_TIMEOUT_SECONDS),
                ):
                    if chunk.done:
                        iter_terminal = True
                        terminal_seen = True
                        usage = chunk.usage
                        provider_request_id = chunk.provider_request_id
                        if chunk.status == "incomplete":
                            incomplete_reason = "unknown"
                            if chunk.incomplete_details is not None:
                                reason = chunk.incomplete_details.get("reason")
                                incomplete_reason = reason if isinstance(reason, str) else "unknown"
                        break
                    if chunk.delta_text:
                        delta = chunk.delta_text
                        if len(full_content) + len(delta) > MAX_ASSISTANT_CONTENT_LENGTH:
                            remaining = MAX_ASSISTANT_CONTENT_LENGTH - len(full_content)
                            delta = delta[: max(remaining, 0)] + TRUNCATION_NOTICE
                        if delta:
                            full_content += delta
                            iter_text += delta
                            append_and_commit(db, run.id, "delta", {"delta": delta})
                        if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                            locally_truncated = True
                            break
                    if chunk.tool_call is not None:
                        pending_tool_calls.append(chunk.tool_call)
                    if is_cancel_requested(db, run.id):
                        finalize_cancelled(
                            db,
                            run,
                            model,
                            resolved_key,
                            int((time.monotonic() - start_time) * 1000),
                        )
                        return {"status": "cancelled"}
                if locally_truncated or not pending_tool_calls:
                    break
                if not iter_terminal:
                    break
                turns.append(
                    Turn(
                        role="assistant",
                        content=iter_text,
                        tool_calls=tuple(pending_tool_calls),
                    )
                )
                tool_results: list[ToolResult] = []
                for tc in pending_tool_calls:
                    tool_call_index_next += 1
                    if tc.name == APP_SEARCH_TOOL_NAME:
                        args = tc.arguments or {}
                        raw_scopes = args.get("scopes")
                        scopes: list[str] = (
                            [str(s) for s in raw_scopes] if isinstance(raw_scopes, list) else []
                        )
                        run_result = execute_app_search(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                            user_message_id=run.user_message_id,
                            assistant_message_id=run.assistant_message_id,
                            scopes=scopes,
                            planned_query=str(args.get("query") or ""),
                            planned_types=["content_chunk"],
                            planned_filters={},
                            tool_call_index=tool_call_index_next,
                        )
                        start_n = citation_n_next
                        citation_n_next = _assign_citation_ordinals(
                            db,
                            tool_call_id=run_result.tool_call_id,
                            start_ordinal=citation_n_next,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            {**run_result.tool_call_event(), "status": run_result.status},
                        )
                        append_run_event(
                            db, run, "retrieval_result", run_result.retrieval_result_event()
                        )
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=_app_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == WEB_SEARCH_TOOL_NAME:
                        if web_search_provider is None:
                            tool_results.append(
                                ToolResult(
                                    call_id=tc.id,
                                    output='{"error":"web_search is not configured"}',
                                    is_error=True,
                                )
                            )
                            continue
                        args = tc.arguments or {}
                        fresh_arg = args.get("freshness_days")
                        run_result = await execute_web_search(
                            db,
                            provider=web_search_provider,
                            conversation_id=run.conversation_id,
                            user_message_id=run.user_message_id,
                            assistant_message_id=run.assistant_message_id,
                            query=str(args.get("query") or ""),
                            freshness_days=fresh_arg if isinstance(fresh_arg, int) else None,
                            tool_call_index=tool_call_index_next,
                        )
                        start_n = citation_n_next
                        citation_n_next = _assign_citation_ordinals(
                            db,
                            tool_call_id=run_result.tool_call_id,
                            start_ordinal=citation_n_next,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            {**run_result.tool_call_event(), "status": run_result.status},
                        )
                        append_run_event(
                            db, run, "retrieval_result", run_result.retrieval_result_event()
                        )
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=_web_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == READ_RESOURCE_TOOL_NAME:
                        args = tc.arguments or {}
                        read_result = execute_read_resource(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                            uri=str(args.get("uri") or ""),
                        )
                        _persist_read_resource_tool_call(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            args=args,
                            result=read_result,
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=read_result.tool_output(),
                                is_error=read_result.is_error,
                            )
                        )
                    else:
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=f'{{"error":"unknown tool: {tc.name}"}}',
                                is_error=True,
                            )
                        )
                db.commit()
                turns.append(Turn(role="tool", tool_results=tuple(tool_results)))
            else:
                logger.warning(
                    "chat_run.max_tool_iterations_exceeded",
                    run_id=str(run.id),
                    iterations=MAX_TOOL_ITERATIONS,
                )
        except LLMError as llm_error:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[llm_error.error_code].value
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    provider_error_message=llm_error.message,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": error_code}

        if not terminal_seen and not locally_truncated:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=ApiErrorCode.E_LLM_INCOMPLETE.value,
                    incomplete_reason=incomplete_reason,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    **usage_log_fields(usage),
                    provider_request_id=provider_request_id,
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value}

        if usage_tokens(usage)["total_tokens"] is None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = ApiErrorCode.E_LLM_PROVIDER_DOWN.value
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    missing_provider_usage=True,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    provider_request_id=provider_request_id,
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": error_code}

        logger.info(
            "llm.request.finished",
            **safe_kv(
                **llm_log_fields,
                outcome="success",
                latency_ms=int((time.monotonic() - llm_start) * 1000),
                **usage_log_fields(usage),
                provider_request_id=provider_request_id,
            ),
        )

        _emit_citation_index(db, run)
        latency_ms = int((time.monotonic() - start_time) * 1000)
        finalize_run(
            db,
            run_id=run.id,
            assistant_content=full_content,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            model=model,
            resolved_key=resolved_key,
            key_mode=run.key_mode,
            latency_ms=latency_ms,
            usage=usage,
            provider_request_id=provider_request_id,
            viewer_id=run.owner_user_id,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = usage_tokens(usage)["total_tokens"]
            assert actual_tokens is not None
            rate_limiter.commit_token_budget(
                run.owner_user_id, run.assistant_message_id, actual_tokens
            )
            budget_reserved = False
        return {"status": "complete"}
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(run.owner_user_id, run.assistant_message_id)
        rate_limiter.release_inflight_slot(run.owner_user_id)
