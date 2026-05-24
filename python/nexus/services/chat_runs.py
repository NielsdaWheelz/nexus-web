"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, cast
from uuid import UUID, uuid4

import httpx
from llm_calling.errors import LLMError, LLMErrorCode, classify_provider_error
from llm_calling.types import LLMChunk, LLMRequest, LLMUsage, Turn
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session, joinedload
from web_search_tool.types import WebSearchProvider

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    Conversation,
    EvidenceSpan,
    Media,
    Message,
    MessageArtifact,
    MessageArtifactPart,
    MessageContextItem,
    MessageLLM,
    MessageToolCall,
    Model,
    ObjectLink,
    SourceManifest,
)
from nexus.errors import (
    CHAT_RESPONSE_RETRYABLE_ERROR_CODES,
    LLM_ERROR_CODE_TO_API_ERROR_CODE,
    ApiError,
    ApiErrorCode,
    NotFoundError,
)
from nexus.evidence_span_ids import (
    EvidenceSpanIdError,
    EvidenceSpanIdsDuplicateError,
    canonical_evidence_span_ids,
    trusted_evidence_span_ids,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.context_memory import SourceRef
from nexus.schemas.conversation import (
    MAX_CONTEXTS,
    MAX_MESSAGE_CONTENT_LENGTH,
    ArtifactIntentOptions,
    AssistantMessageBranchAnchorRequest,
    BranchAnchorRequest,
    ChatRunEventOut,
    ChatRunOut,
    ChatRunResponse,
    ContextItem,
    ConversationScopeRequest,
    WebSearchOptions,
    chat_run_event_payload_json,
)
from nexus.schemas.notes import ObjectRef
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.services.agent_tools.app_search import execute_app_search
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_CALL_INDEX,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    is_provider_enabled,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.context_assembler import (
    assemble_chat_context,
    load_message_context_refs,
    load_recent_history_units,
    message_context_ref_payloads,
    persist_prompt_assembly,
)
from nexus.services.context_lookup import (
    ContextLookupError,
    hydrate_context_ref,
    hydrate_source_ref,
)
from nexus.services.context_rendering import PROMPT_VERSION
from nexus.services.contexts import (
    insert_contexts_batch,
    validate_content_chunk_evidence_span_ids,
)
from nexus.services.conversation_branches import (
    active_leaf_for_viewer,
    branch_anchor_for_message,
    ensure_branch_metadata,
    load_leaf_message_path,
    load_message_path,
    persist_active_leaf,
)
from nexus.services.conversation_memory import (
    collect_memory_source_refs,
    load_active_memory_items,
    refresh_conversation_memory,
)
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    authorize_conversation_scope,
    conversation_scope_metadata,
    conversation_to_out,
    derive_conversation_title,
    get_message_count,
    load_message_artifacts_for_message_ids,
    load_message_context_snapshots_for_message_ids,
    message_to_out,
    resolve_conversation_for_scope,
    retryable_assistant_message_ids,
)
from nexus.services.locator_resolver import resolve_evidence_span
from nexus.services.message_context_snapshots import (
    context_evidence_span_ids,
    trusted_context_snapshot,
)
from nexus.services.models import get_model_catalog_metadata
from nexus.services.object_refs import hydrate_object_ref
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.retrieval_planner import build_retrieval_plan
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})
MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"
LLM_TIMEOUT_SECONDS = 45.0
ARTIFACT_OUTPUT_KINDS = frozenset(
    {
        "briefing_document",
        "study_guide",
        "faq",
        "timeline",
        "comparison_table",
        "extraction_table",
        "claim_table",
        "contradiction_report",
        "source_map",
        "concept_map",
        "outline",
        "flashcards",
        "quiz",
        "audio_overview_script",
        "audio_overview",
        "video_slide_overview_manifest",
        "bibliography",
        "citation_audit",
    }
)
GENERATED_ARTIFACT_KEY = "generated-artifact"

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
    "E_CONTEXT_TOO_LARGE": "One selected context is too large or unavailable. Remove it and try again.",
    "E_APP_SEARCH_FAILED": "The scoped content search failed. Please try again.",
    "E_CANCELLED": "Request cancelled.",
    "E_TOKEN_BUDGET_EXCEEDED": "Monthly AI token quota exceeded.",
}

LLM_INCOMPLETE_ERROR_CODE = ApiErrorCode.E_LLM_INCOMPLETE.value
REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096

VERIFICATION_FAILURE_CONTENT = (
    "I could not verify enough of the drafted answer against the available evidence."
)


@dataclass
class PreparedMessages:
    conversation: Conversation
    user_message: Message
    assistant_message: Message


@dataclass(frozen=True)
class ClaimCandidate:
    text: str
    start: int | None
    end: int | None


@dataclass(frozen=True)
class VerifiedClaim:
    candidate: ClaimCandidate
    support_status: str
    claim_kind: str
    verifier_status: str
    evidence_rows: list[dict[str, Any]]
    evidence_role: str = "supports"
    unsupported_reason: str | None = None
    confidence: float | None = None


class GeneratedArtifactPart(BaseModel):
    part_key: str | None = Field(default=None, min_length=1, max_length=128)
    part_type: str | None = Field(default=None, min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=20000)
    evidence_ordinals: list[int] = Field(default_factory=list)
    support_state: Literal["source_grounded", "not_source_grounded"] = "source_grounded"

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class GeneratedArtifactResponse(BaseModel):
    artifact_kind: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=500)
    preview_text: str | None = Field(default=None, max_length=20000)
    parts: list[GeneratedArtifactPart] = Field(min_length=1)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class ChatRunLLMRouter(Protocol):
    def generate_stream(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]: ...


def _llm_error_from_unread_stream_response(
    exc: httpx.ResponseNotRead,
    provider: str,
) -> LLMError:
    context = exc.__context__
    if isinstance(context, httpx.HTTPStatusError):
        status_code = context.response.status_code
        return LLMError(
            classify_provider_error(provider, status_code, None, None),
            f"Provider returned HTTP {status_code}",
            provider=provider,
        )
    return LLMError(
        LLMErrorCode.PROVIDER_DOWN,
        "Provider stream error response was not readable",
        provider=provider,
    )


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    if model.provider == "openai" and reasoning in {"default", "low", "medium", "high", "max"}:
        return min(REASONING_OUTPUT_TOKENS, model.max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, model.max_context_tokens)


def compute_payload_hash(
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    artifact_intent: ArtifactIntentOptions,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
) -> str:
    sorted_contexts = sorted(
        (ctx.model_dump(mode="json") for ctx in contexts),
        key=lambda payload: json.dumps(payload, sort_keys=True, separators=(",", ":")),
    )
    payload_scope = conversation_scope.model_dump(mode="json") if conversation_scope else None
    payload_anchor = branch_anchor.model_dump(mode="json")
    payload = (
        f"{conversation_id}|{parent_message_id}|{payload_anchor}|{content}|{model_id}|{reasoning}|{key_mode}|"
        f"{payload_scope}|{sorted_contexts}|{web_search.model_dump(mode='json')}|"
        f"{artifact_intent.model_dump(mode='json')}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def compute_retry_payload_hash(
    *,
    failed_assistant_message_id: UUID,
    source_run: ChatRun,
    source_user_message: Message,
    context_rows: Sequence[MessageContextItem],
) -> str:
    contexts = [
        {
            "id": str(row.id),
            "ordinal": row.ordinal,
            "context_kind": row.context_kind,
            "object_type": row.object_type,
            "object_id": str(row.object_id) if row.object_id is not None else None,
            "source_media_id": str(row.source_media_id) if row.source_media_id else None,
            "locator_json": row.locator_json,
            "context_snapshot": row.context_snapshot_json,
        }
        for row in context_rows
    ]
    payload = {
        "operation": "chat_response_retry",
        "failed_assistant_message_id": str(failed_assistant_message_id),
        "source_run_id": str(source_run.id),
        "source_conversation_id": str(source_run.conversation_id),
        "source_user_message_id": str(source_user_message.id),
        "source_user_parent_message_id": (
            str(source_user_message.parent_message_id)
            if source_user_message.parent_message_id is not None
            else None
        ),
        "source_prompt_content": source_user_message.content,
        "source_model_id": str(source_run.model_id),
        "source_reasoning": source_run.reasoning,
        "source_key_mode": source_run.key_mode,
        "source_web_search": source_run.web_search,
        "source_artifact_intent": source_run.artifact_intent,
        "source_contexts": contexts,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    artifact_intent: ArtifactIntentOptions,
    idempotency_key: str | None,
) -> ChatRunResponse:
    contexts = list(contexts)
    if (conversation_id is None) == (conversation_scope is None):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of conversation_id or conversation_scope is required",
        )
    normalized_key = _normalize_idempotency_key(idempotency_key)

    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        web_search,
        artifact_intent,
        conversation_id,
        conversation_scope,
        parent_message_id,
        branch_anchor,
    )

    existing = _get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        _raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
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
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        conversation_scope,
        parent_message_id,
        branch_anchor,
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        use_platform_key,
    )

    try:
        _lock_idempotency_key(db, viewer_id, normalized_key)
        existing = _get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            _raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            conversation_scope,
            parent_message_id,
            branch_anchor,
            content,
            model_id,
            contexts,
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
            web_search=web_search.model_dump(mode="json"),
            artifact_intent=artifact_intent.model_dump(mode="json"),
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


def retry_failed_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = _normalize_idempotency_key(idempotency_key)
    try:
        _lock_idempotency_key(db, viewer_id, normalized_key)
        assistant_message = _load_retryable_failed_assistant_message(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
        )
        source_run = _load_source_run_for_retry(
            db,
            viewer_id=viewer_id,
            assistant_message=assistant_message,
        )
        source_user_message = db.get(Message, source_run.user_message_id)
        if source_user_message is None or source_user_message.role != "user":
            raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source prompt not found")
        context_rows = _load_context_rows_for_message(db, source_user_message.id)
        payload_hash = compute_retry_payload_hash(
            failed_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
            context_rows=context_rows,
        )

        existing = _get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            _raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
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
            message_document=_message_document("user", source_user_message.content),
            status="complete",
            parent_message_id=source_user_message.parent_message_id,
            branch_root_message_id=source_user_message.branch_root_message_id,
            branch_anchor_kind=source_user_message.branch_anchor_kind,
            branch_anchor=dict(source_user_message.branch_anchor or {}),
        )
        db.add(user_message)
        db.flush()
        _copy_context_rows(
            db,
            viewer_id=viewer_id,
            source_message_id=source_user_message.id,
            target_message_id=user_message.id,
            rows=context_rows,
        )
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
            message_document=_message_document("assistant", ""),
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
            web_search=dict(source_run.web_search or {}),
            artifact_intent=dict(source_run.artifact_intent),
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
    run = _get_run_for_owner(db, viewer_id, run_id)
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
    run = _get_run_for_owner(db, viewer_id, run_id)
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
    _get_run_for_owner(db, viewer_id, run_id)
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
    run = _get_run_for_owner(db, viewer_id, run_id)
    return run.status in TERMINAL_RUN_STATUSES


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    _get_run_for_owner(db, viewer_id, run_id)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunLLMRouter,
    web_search_provider: WebSearchProvider | None,
    web_search_country: str = "US",
    web_search_language: str = "en",
    web_search_safe_search: Literal["off", "moderate", "strict"] = "moderate",
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
            web_search_country=web_search_country,
            web_search_language=web_search_language,
            web_search_safe_search=web_search_safe_search,
        )
    except ApiError as exc:
        logger.warning(
            "chat_run.api_error",
            run_id=str(run_id),
            error_code=exc.code.value,
            error=str(exc),
        )
        try:
            _finalize_run(
                db,
                run_id=run_id,
                assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=exc.code.value,
                model=None,
                resolved_key=None,
                key_mode="auto",
                latency_ms=0,
                usage=None,
                provider_request_id=None,
                viewer_id=None,
            )
            return {"status": "error", "error_code": exc.code.value}
        except Exception:
            db.rollback()
            raise
    except Exception as exc:
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            _finalize_run(
                db,
                run_id=run_id,
                assistant_content="An unexpected error occurred. Please try again.",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_INTERNAL.value,
                model=None,
                resolved_key=None,
                key_mode="auto",
                latency_ms=0,
                usage=None,
                provider_request_id=None,
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
    web_search_provider: WebSearchProvider | None,
    web_search_country: str,
    web_search_language: str,
    web_search_safe_search: Literal["off", "moderate", "strict"],
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if _has_delta_without_terminal(db, run.id):
        _finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_MODEL_NOT_AVAILABLE"],
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
            model=None,
            resolved_key=None,
            key_mode=run.key_mode,
            latency_ms=0,
            usage=None,
            provider_request_id=None,
            viewer_id=run.owner_user_id,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    _mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        _finalize_cancelled(db, run, model, None, 0)
        return {"status": "cancelled"}

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except LLMError as exc:
        error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[exc.error_code].value
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code=error_code,
            model=model,
            resolved_key=_dummy_resolved_key(model),
            key_mode=run.key_mode,
            latency_ms=0,
            usage=None,
            provider_request_id=None,
            viewer_id=run.owner_user_id,
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content="Conversation not found.",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

        scope_metadata = conversation_scope_metadata(db, conversation)
        attached_context_refs = load_message_context_refs(db, run.user_message_id)
        path_messages = load_message_path(
            db,
            conversation_id=conversation.id,
            leaf_message_id=user_message.id,
        )
        path_message_ids = [
            message.id for message in path_messages if message.id != user_message.id
        ]
        snapshot = None
        after_seq = None
        memory_items = load_active_memory_items(
            db,
            conversation_id=conversation.id,
            after_seq=after_seq,
            prompt_version=PROMPT_VERSION,
            allowed_message_ids=set(path_message_ids),
        )
        history_units = load_recent_history_units(
            db,
            conversation_id=conversation.id,
            before_seq=user_message.seq,
            after_seq=after_seq,
            path_message_ids=path_message_ids,
        )
        planner_history = [
            turn for history_unit in history_units[-4:] for turn in history_unit.turns
        ]
        attached_context_ref_payloads = message_context_ref_payloads(db, attached_context_refs)

        retrieval_plan = build_retrieval_plan(
            user_content=user_message.content,
            history=planner_history,
            scope_metadata=scope_metadata,
            attached_context_refs=attached_context_ref_payloads,
            memory_source_refs=collect_memory_source_refs(
                memory_items=memory_items,
                snapshot=snapshot,
            ),
            web_search_options=run.web_search,
        )

        if retrieval_plan.app_search.enabled:
            # justify-service-invariant-check: the planner only leaves query None
            # when app_search is disabled; an enabled plan without a query is a defect.
            planned_query = retrieval_plan.app_search.query
            if planned_query is None:
                raise AssertionError("enabled app-search plan is missing a query")
            _append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "status": "running",
                    "scope": retrieval_plan.app_search.scope,
                    "types": list(retrieval_plan.app_search.types),
                    "semantic": retrieval_plan.app_search.semantic,
                    "filters": dict(retrieval_plan.app_search.filters),
                },
            )
            app_search_run = execute_app_search(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                user_message_id=run.user_message_id,
                assistant_message_id=run.assistant_message_id,
                scope=retrieval_plan.app_search.scope,
                planned_query=planned_query,
                planned_types=retrieval_plan.app_search.types,
                planned_filters=retrieval_plan.app_search.filters,
            )
            app_result_event = app_search_run.retrieval_result_event()
            _append_and_commit(db, run.id, "retrieval_result", app_result_event)
            _append_and_commit(
                db,
                run.id,
                "source_manifest_delta",
                {
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_call_id": str(app_search_run.tool_call_id)
                    if app_search_run.tool_call_id
                    else None,
                    "tool_name": "app_search",
                    "tool_call_index": app_search_run.tool_call_index,
                    "query_hash": app_search_run.query_hash,
                    "scope": app_search_run.scope,
                    "filters": dict(app_search_run.filters),
                    "requested_types": app_search_run.requested_types,
                    "candidate_count": len(app_search_run.citations),
                    "result_count": len(app_search_run.citations),
                    "selected_count": len(app_search_run.selected_citations),
                    "included_in_prompt_count": 0,
                    "excluded_by_budget_count": 0,
                    "excluded_by_scope_count": 0,
                    "stale_count": 0,
                    "unreadable_count": 0,
                    "index_versions": [],
                    "metadata": (
                        {"empty_status": app_search_run.empty_status}
                        if app_search_run.empty_status
                        else {}
                    ),
                    "latency_ms": app_search_run.latency_ms,
                    "status": app_search_run.status,
                },
            )
            if app_search_run.status == "error" and scope_metadata.get("type") in {
                "media",
                "library",
            }:
                error_code = app_search_run.error_code or ApiErrorCode.E_APP_SEARCH_FAILED.value
                latency_ms = int((time.monotonic() - start_time) * 1000)
                _finalize_run(
                    db,
                    run_id=run.id,
                    assistant_content=ERROR_CODE_TO_MESSAGE.get(
                        error_code,
                        ERROR_CODE_TO_MESSAGE[ApiErrorCode.E_APP_SEARCH_FAILED.value],
                    ),
                    assistant_status="error",
                    run_status="error",
                    done_status="error",
                    error_code=error_code,
                    model=model,
                    resolved_key=resolved_key,
                    key_mode=run.key_mode,
                    latency_ms=latency_ms,
                    usage=None,
                    provider_request_id=None,
                    viewer_id=run.owner_user_id,
                )
                return {
                    "status": "error",
                    "error_code": error_code,
                }

        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        web_search = WebSearchOptions.model_validate(run.web_search)
        if retrieval_plan.web_search.enabled:
            _append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": WEB_SEARCH_TOOL_NAME,
                    "tool_call_index": WEB_SEARCH_TOOL_CALL_INDEX,
                    "status": "running",
                    "scope": "public_web",
                    "types": ["mixed"],
                    "semantic": False,
                    "filters": {
                        "freshness_days": web_search.freshness_days,
                        "allowed_domains": web_search.allowed_domains,
                        "blocked_domains": web_search.blocked_domains,
                    },
                },
            )
            web_search_run = await execute_web_search(
                db,
                provider=web_search_provider,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                user_message_id=run.user_message_id,
                assistant_message_id=run.assistant_message_id,
                content=user_message.content,
                options=web_search,
                country=web_search_country,
                search_lang=web_search_language,
                safe_search=web_search_safe_search,
            )
            if web_search_run is not None:
                web_result_event = web_search_run.retrieval_result_event()
                _append_and_commit(db, run.id, "retrieval_result", web_result_event)
                _append_and_commit(
                    db,
                    run.id,
                    "source_manifest_delta",
                    {
                        "assistant_message_id": str(run.assistant_message_id),
                        "tool_call_id": str(web_search_run.tool_call_id)
                        if web_search_run.tool_call_id
                        else None,
                        "tool_name": WEB_SEARCH_TOOL_NAME,
                        "tool_call_index": web_search_run.tool_call_index,
                        "query_hash": web_search_run.query_hash,
                        "scope": "public_web",
                        "filters": {
                            "freshness_days": web_search.freshness_days,
                            "allowed_domains": web_search.allowed_domains,
                            "blocked_domains": web_search.blocked_domains,
                        },
                        "requested_types": [web_search_run.result_type],
                        "candidate_count": len(web_search_run.citations),
                        "result_count": len(web_search_run.citations),
                        "selected_count": len(web_search_run.selected_citations),
                        "included_in_prompt_count": 0,
                        "excluded_by_budget_count": 0,
                        "excluded_by_scope_count": 0,
                        "stale_count": 0,
                        "unreadable_count": 0,
                        "web_search_mode": web_search.mode,
                        "index_versions": [],
                        "metadata": (
                            {"empty_status": web_search_run.empty_status}
                            if web_search_run.empty_status
                            else {}
                        ),
                        "latency_ms": web_search_run.latency_ms,
                        "status": web_search_run.status,
                    },
                )
        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
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
            )
            persist_prompt_assembly(db, run=run, assembly=assembly)
            _reconcile_prompt_retrievals(db, run=run, assembly=assembly)
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}
        except ContextLookupError as exc:
            failure = exc.result.failure
            logger.warning(
                "chat_run.context_lookup_failed",
                run_id=str(run.id),
                failure_code=failure.code if failure is not None else None,
                failure_message=failure.message if failure is not None else str(exc),
            )
            error_code = ApiErrorCode.E_CONTEXT_TOO_LARGE.value
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

        assistant_message = db.get(Message, run.assistant_message_id)
        _, prompt_evidence_rows = (
            _message_prompt_evidence_rows(
                db,
                run,
                assistant_message,
                reconcile_inclusion=False,
            )
            if assistant_message is not None
            else (None, [])
        )
        buffer_provider_deltas = (
            _is_source_backed_run(
                db,
                run=run,
                assistant_message=assistant_message,
                evidence_rows=prompt_evidence_rows,
            )
            if assistant_message is not None
            else False
        )
        artifact_intent = ArtifactIntentOptions.model_validate(run.artifact_intent)
        if artifact_intent.kind != "off" and assistant_message is not None:
            await _append_generated_artifact_delta(
                db,
                run=run,
                user_message=user_message,
                model=model,
                resolved_key=resolved_key,
                llm_router=llm_router,
                artifact_intent=artifact_intent,
                evidence_rows=prompt_evidence_rows,
                source_backed=buffer_provider_deltas,
            )
            if _is_cancel_requested(db, run.id):
                _finalize_cancelled(
                    db,
                    run,
                    model,
                    resolved_key,
                    int((time.monotonic() - start_time) * 1000),
                )
                return {"status": "cancelled"}

        llm_request = assembly.llm_request
        full_content = ""
        usage: LLMUsage | None = None
        provider_request_id: str | None = None
        incomplete_reason: str | None = None
        terminal_seen = False
        locally_truncated = False
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
            scope_type=str(assembly.scope_metadata.get("type") or "general"),
        )
        logger.info("llm.request.started", **llm_log_fields)
        try:
            async for chunk in llm_router.generate_stream(
                model.provider,
                llm_request,
                resolved_key.api_key,
                timeout_s=int(LLM_TIMEOUT_SECONDS),
            ):
                if chunk.done:
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
                        if not buffer_provider_deltas:
                            _append_and_commit(db, run.id, "delta", {"delta": delta})
                    if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                        locally_truncated = True
                        break
                if _is_cancel_requested(db, run.id):
                    _finalize_cancelled(
                        db,
                        run,
                        model,
                        resolved_key,
                        int((time.monotonic() - start_time) * 1000),
                    )
                    return {"status": "cancelled"}
        except (LLMError, httpx.ResponseNotRead) as exc:
            llm_error = (
                _llm_error_from_unread_stream_response(exc, model.provider)
                if isinstance(exc, httpx.ResponseNotRead)
                else exc
            )
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[llm_error.error_code].value
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                ),
            )
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE.get(
                    error_code,
                    "An unexpected error occurred. Please try again.",
                ),
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

        if not terminal_seen and not locally_truncated:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INTERRUPTED"],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=LLM_INCOMPLETE_ERROR_CODE,
                    incomplete_reason=incomplete_reason,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    **_usage_log_fields(usage),
                    provider_request_id=provider_request_id,
                ),
            )
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[LLM_INCOMPLETE_ERROR_CODE],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=LLM_INCOMPLETE_ERROR_CODE,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": LLM_INCOMPLETE_ERROR_CODE}

        if _usage_tokens(usage)["total_tokens"] is None:
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

        logger.info(
            "llm.request.finished",
            **safe_kv(
                **llm_log_fields,
                outcome="success",
                latency_ms=int((time.monotonic() - llm_start) * 1000),
                **_usage_log_fields(usage),
                provider_request_id=provider_request_id,
            ),
        )

        verified_content, verifier_hint = await _verified_assistant_content(
            db,
            run=run,
            model=model,
            resolved_key=resolved_key,
            llm_router=llm_router,
            assistant_content=full_content,
        )
        if buffer_provider_deltas and verified_content:
            _append_and_commit(db, run.id, "delta", {"delta": verified_content})

        latency_ms = int((time.monotonic() - start_time) * 1000)
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=verified_content,
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
            verifier_hint=verifier_hint,
        )
        refresh_conversation_memory(
            db,
            conversation_id=run.conversation_id,
            prompt_version=PROMPT_VERSION,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = _usage_tokens(usage)["total_tokens"]
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


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    use_platform_key: bool,
) -> Model:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )
    if len(contexts) > MAX_CONTEXTS:
        raise ApiError(
            ApiErrorCode.E_CONTEXT_TOO_LARGE,
            f"Maximum {MAX_CONTEXTS} context items allowed",
        )

    model = get_model_by_id(db, model_id)
    if model is None or not model.is_available:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found or not available")
    metadata = get_model_catalog_metadata(model.provider, model.model_name)
    if metadata is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model is outside the curated catalog")
    if not is_provider_enabled(model.provider):
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model provider is disabled")
    _, _, _, reasoning_modes = metadata
    if reasoning not in reasoning_modes:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning mode '{reasoning}' is not supported for {model.provider}/{model.model_name}",
        )

    try:
        resolve_api_key(db, viewer_id, model.provider, key_mode)
    except LLMError as exc:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, str(exc.message)) from exc

    for ctx in contexts:
        _validate_context_visibility(db, viewer_id, ctx)

    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    if use_platform_key:
        rate_limiter.check_token_budget(viewer_id)
    if conversation_id is not None:
        _validate_parent_anchor_for_existing_conversation(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
        )
    elif conversation_scope is not None:
        if parent_message_id is not None or branch_anchor.kind != "none":
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "conversation_scope sends cannot include a branch parent",
            )
        authorize_conversation_scope(db, viewer_id, conversation_scope)

    return model


def prepare_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    contexts: Sequence[ContextItem],
) -> PreparedMessages:
    if conversation_id is None and conversation_scope is not None:
        conversation = resolve_conversation_for_scope(db, viewer_id, conversation_scope, content)
        existing_message_count = db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation.id)
        )
        if existing_message_count:
            parent_message = _selected_path_reply_parent(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation.id,
            )
            if parent_message is None:
                raise ApiError(
                    ApiErrorCode.E_BRANCH_PATH_INVALID,
                    "Existing scoped conversation has no complete assistant parent",
                )
            branch_anchor = AssistantMessageBranchAnchorRequest(
                kind="assistant_message",
                message_id=parent_message.id,
            )
        else:
            parent_message = None
    elif conversation_id is not None and conversation_scope is None:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
        parent_message = _load_valid_parent_for_send(
            db,
            conversation_id=conversation.id,
            parent_message_id=parent_message_id,
        )
    else:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of conversation_id or conversation_scope is required",
        )

    user_seq = assign_next_message_seq(db, conversation.id)
    if user_seq == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = derive_conversation_title(content)
    branch_anchor_kind, branch_anchor_payload = branch_anchor_for_message(
        parent_message,
        branch_anchor,
    )
    branch_root_message_id = parent_message.id if parent_message is not None else None

    user_message = Message(
        conversation_id=conversation.id,
        seq=user_seq,
        role="user",
        content=content,
        message_document=_message_document("user", content),
        status="complete",
        model_id=None,
        parent_message_id=parent_message.id if parent_message is not None else None,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind=branch_anchor_kind,
        branch_anchor=branch_anchor_payload,
    )
    db.add(user_message)
    db.flush()

    insert_contexts_batch(db=db, message_id=user_message.id, contexts=contexts)
    db.flush()
    if parent_message is not None:
        ensure_branch_metadata(
            db,
            conversation_id=conversation.id,
            branch_user_message_id=user_message.id,
        )

    assistant_message = Message(
        conversation_id=conversation.id,
        seq=assign_next_message_seq(db, conversation.id),
        role="assistant",
        content="",
        message_document=_message_document("assistant", ""),
        status="pending",
        model_id=model_id,
        parent_message_id=user_message.id,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind="none",
        branch_anchor={},
    )
    db.add(assistant_message)
    db.flush()
    persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation.id,
        active_leaf_message_id=assistant_message.id,
    )

    return PreparedMessages(
        conversation=conversation,
        user_message=user_message,
        assistant_message=assistant_message,
    )


def _message_document(role: str, content: str) -> dict[str, object]:
    text = content.strip()
    return {
        "type": "message_document",
        "version": 1,
        "blocks": []
        if not text
        else [
            {
                "type": "text",
                "format": "markdown" if role == "assistant" else "plain",
                "text": content,
            }
        ],
    }


def _artifact_preview_blocks_for_run(db: Session, run_id: UUID) -> list[dict[str, object]]:
    durable_artifacts: dict[str, MessageArtifact] = {}
    for artifact in (
        db.execute(
            select(MessageArtifact)
            .options(joinedload(MessageArtifact.parts))
            .where(
                MessageArtifact.chat_run_id == run_id,
                MessageArtifact.artifact_key.is_not(None),
            )
            .order_by(
                MessageArtifact.artifact_key.asc(),
                MessageArtifact.artifact_version.asc(),
                MessageArtifact.created_at.asc(),
                MessageArtifact.id.asc(),
            )
        )
        .unique()
        .scalars()
    ):
        if artifact.artifact_key:
            durable_artifacts[artifact.artifact_key] = artifact

    rows = (
        db.execute(
            select(ChatRunEvent.payload)
            .where(ChatRunEvent.run_id == run_id, ChatRunEvent.event_type == "artifact_delta")
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    blocks: list[dict[str, object]] = []
    for payload in rows:
        if not isinstance(payload, dict):
            continue
        artifact_id = payload.get("artifact_id")
        artifact_kind = payload.get("artifact_kind")
        title = payload.get("title")
        status = payload.get("status")
        delta = payload.get("delta")
        parts = payload.get("parts")
        durable_artifact = (
            durable_artifacts.get(artifact_id) if isinstance(artifact_id, str) else None
        )
        if durable_artifact is not None:
            blocks.append(
                {
                    "type": "artifact_preview",
                    "artifact_id": str(durable_artifact.id),
                    "artifact_key": durable_artifact.artifact_key,
                    "durable_artifact_id": str(durable_artifact.id),
                    "artifact_version": durable_artifact.artifact_version,
                    "supersedes_artifact_id": str(durable_artifact.supersedes_artifact_id)
                    if durable_artifact.supersedes_artifact_id is not None
                    else None,
                    "artifact_kind": durable_artifact.artifact_kind,
                    "title": durable_artifact.title,
                    "status": durable_artifact.status,
                    "delta": durable_artifact.preview_text,
                    "parts": [
                        _durable_artifact_part_preview_for_document(part)
                        for part in durable_artifact.parts
                    ],
                }
            )
            continue
        blocks.append(
            {
                "type": "artifact_preview",
                "artifact_id": artifact_id if isinstance(artifact_id, str) else None,
                "durable_artifact_id": None,
                "artifact_kind": artifact_kind if isinstance(artifact_kind, str) else None,
                "title": title if isinstance(title, str) else None,
                "status": status if isinstance(status, str) else None,
                "delta": delta if isinstance(delta, str) else None,
                "parts": _artifact_parts_with_evidence(parts if isinstance(parts, list) else []),
            }
        )
    return blocks


def _durable_artifact_part_preview_for_document(part: MessageArtifactPart) -> dict[str, object]:
    preview: dict[str, object] = {
        "id": str(part.id),
        "artifact_id": str(part.artifact_id),
        "ordinal": part.ordinal,
        "source_version": part.source_version,
        "locator": part.locator,
    }
    if part.part_key is not None:
        preview["part_key"] = part.part_key
    if part.part_type is not None:
        preview["part_type"] = part.part_type
    if part.part_text is not None:
        preview["text"] = part.part_text
    if part.source_ref is not None:
        preview["source_ref"] = part.source_ref
    if part.context_ref is not None:
        preview["context_ref"] = part.context_ref
    if part.result_ref is not None:
        preview["result_ref"] = part.result_ref
    if part.evidence_span_id is not None:
        preview["evidence_span_id"] = str(part.evidence_span_id)
    evidence_span_ids = trusted_evidence_span_ids(part.evidence_span_ids)
    if evidence_span_ids:
        preview["evidence_span_ids"] = [
            str(evidence_span_id) for evidence_span_id in evidence_span_ids
        ]
    if part.source_refs:
        preview["source_refs"] = list(part.source_refs)
    if part.metadata_json:
        preview["metadata"] = part.metadata_json
    return preview


def _artifact_parts_with_evidence(parts: list[object]) -> list[object]:
    evidence_parts: list[object] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        metadata = part.get("metadata")
        if (
            isinstance(part.get("source_ref"), dict)
            or isinstance(part.get("context_ref"), dict)
            or isinstance(part.get("result_ref"), dict)
            or (
                isinstance(part.get("source_refs"), list)
                and len(cast(list[object], part.get("source_refs"))) > 0
            )
            or isinstance(part.get("evidence_span_id"), str)
            or (
                isinstance(part.get("evidence_span_ids"), list)
                and len(cast(list[object], part.get("evidence_span_ids"))) > 0
            )
            or (
                isinstance(metadata, dict)
                and metadata.get("support_state") == "not_source_grounded"
            )
        ):
            source_version = part.get("source_version")
            locator = part.get("locator")
            if not isinstance(source_version, str) or not isinstance(locator, dict):
                raise ValueError("artifact_delta evidence parts require source_version and locator")
            preview: dict[str, object] = {
                "source_version": source_version,
                "locator": locator,
            }
            for key in (
                "id",
                "artifact_id",
                "ordinal",
                "part_key",
                "part_type",
                "text",
                "source_ref",
                "source_refs",
                "context_ref",
                "result_ref",
                "evidence_span_id",
                "evidence_span_ids",
                "metadata",
                "created_at",
            ):
                if key in part:
                    preview[key] = cast(object, part[key])
            evidence_parts.append(preview)
    return evidence_parts


async def _append_generated_artifact_delta(
    db: Session,
    *,
    run: ChatRun,
    user_message: Message,
    model: Model,
    resolved_key: ResolvedKey,
    llm_router: ChatRunLLMRouter,
    artifact_intent: ArtifactIntentOptions,
    evidence_rows: list[dict[str, Any]],
    source_backed: bool,
) -> None:
    artifact_kind = artifact_intent.kind
    if artifact_kind == "auto":
        prompt = user_message.content.lower()
        if "timeline" in prompt:
            artifact_kind = "timeline"
        elif "table" in prompt or "compare" in prompt:
            artifact_kind = "comparison_table"
        elif "flashcard" in prompt:
            artifact_kind = "flashcards"
        elif "quiz" in prompt:
            artifact_kind = "quiz"
        elif "bibliography" in prompt or "sources" in prompt:
            artifact_kind = "bibliography"
        elif "citation" in prompt or "audit" in prompt:
            artifact_kind = "citation_audit"
        else:
            artifact_kind = "briefing_document"

    if artifact_kind not in ARTIFACT_OUTPUT_KINDS:
        return

    if source_backed and not evidence_rows:
        _append_and_commit(
            db,
            run.id,
            "artifact_delta",
            _artifact_error_delta(
                artifact_kind=artifact_kind,
                title="Artifact unavailable",
                detail="No prompt-included source evidence was available for this artifact.",
            ),
        )
        return

    generate = getattr(llm_router, "generate", None)
    if not callable(generate):
        _append_and_commit(
            db,
            run.id,
            "artifact_delta",
            _artifact_error_delta(
                artifact_kind=artifact_kind,
                title="Artifact unavailable",
                detail="The configured model adapter cannot generate structured artifacts.",
            ),
        )
        return

    selected_evidence = []
    for ordinal, row in enumerate(evidence_rows[:12]):
        selected_evidence.append(
            {
                "ordinal": ordinal,
                "label": (
                    row["source_ref"].get("label")
                    if isinstance(row.get("source_ref"), dict)
                    else None
                ),
                "exact_snippet": row.get("exact_snippet"),
                "source_version": row.get("source_version"),
                "locator": row.get("locator"),
            }
        )

    request_payload = {
        "requested_artifact_kind": artifact_kind,
        "user_request": user_message.content,
        "source_backed": source_backed,
        "selected_evidence": selected_evidence,
    }
    try:
        response = await cast(Any, generate)(
            model.provider,
            LLMRequest(
                model_name=model.model_name,
                messages=[
                    Turn(
                        role="system",
                        content=(
                            "Generate one concise artifact for the user. Return only JSON with "
                            "artifact_kind, title, preview_text, and parts. artifact_kind must "
                            "match requested_artifact_kind. parts must be an array of objects "
                            "with part_key, part_type, text, evidence_ordinals, and support_state. "
                            "Use evidence_ordinals from selected_evidence for every source-backed "
                            "factual part. Do not emit source refs, locators, or source versions; "
                            "the application will attach them. If a part is not source grounded, "
                            "use support_state=not_source_grounded and no evidence_ordinals."
                        ),
                    ),
                    Turn(
                        role="user",
                        content=json.dumps(request_payload, ensure_ascii=True),
                    ),
                ],
                max_tokens=5000,
                temperature=0,
                reasoning_effort="none",
                prompt_cache_key=None,
            ),
            resolved_key.api_key,
            timeout_s=int(LLM_TIMEOUT_SECONDS),
        )
        payload = _artifact_delta_from_model_response(
            response.text,
            artifact_kind=artifact_kind,
            run=run,
            user_message=user_message,
            evidence_rows=evidence_rows[:12],
            source_backed=source_backed,
        )
    except (LLMError, ValidationError, ValueError) as exc:
        logger.warning(
            "chat.artifact_generation.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                artifact_kind=artifact_kind,
                error_class=exc.__class__.__name__,
            ),
        )
        payload = _artifact_error_delta(
            artifact_kind=artifact_kind,
            title="Artifact unavailable",
            detail="Artifact generation failed before returning a valid artifact.",
        )

    _append_and_commit(db, run.id, "artifact_delta", payload)


def _artifact_error_delta(
    *,
    artifact_kind: str,
    title: str,
    detail: str,
) -> dict[str, Any]:
    return {
        "artifact_id": GENERATED_ARTIFACT_KEY,
        "artifact_key": GENERATED_ARTIFACT_KEY,
        "artifact_kind": artifact_kind,
        "title": title,
        "status": "error",
        "delta": detail,
        "parts": [],
    }


def _artifact_delta_from_model_response(
    raw_response: str,
    *,
    artifact_kind: str,
    run: ChatRun,
    user_message: Message,
    evidence_rows: list[dict[str, Any]],
    source_backed: bool,
) -> dict[str, Any]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = GeneratedArtifactResponse.model_validate(json.loads(raw))
    if parsed.artifact_kind != artifact_kind:
        raise ValueError("artifact response kind does not match request")

    event_parts = []
    for index, part in enumerate(parsed.parts):
        if any(ordinal < 0 or ordinal >= len(evidence_rows) for ordinal in part.evidence_ordinals):
            raise ValueError("artifact evidence ordinal is out of range")
        evidence_ordinals = sorted(set(part.evidence_ordinals))
        if source_backed and not evidence_ordinals:
            raise ValueError("source-backed artifact part missing evidence")
        if not evidence_ordinals and part.support_state != "not_source_grounded":
            raise ValueError("ungrounded artifact part must declare not_source_grounded")

        part_key = part.part_key or f"part-{index + 1}"
        part_type = part.part_type or artifact_kind

        if evidence_ordinals:
            first_row = evidence_rows[evidence_ordinals[0]]
            event_part: dict[str, Any] = {
                "part_key": part_key,
                "part_type": part_type,
                "text": part.text,
                "source_version": first_row["source_version"],
                "locator": first_row["locator"],
                "metadata": {
                    "support_state": "source_grounded",
                    "evidence_ordinals": evidence_ordinals,
                },
            }
            if isinstance(first_row.get("source_ref"), dict):
                event_part["source_ref"] = first_row["source_ref"]
            source_refs = [
                row["source_ref"]
                for ordinal in evidence_ordinals
                for row in [evidence_rows[ordinal]]
                if isinstance(row.get("source_ref"), dict)
            ]
            if source_refs:
                event_part["source_refs"] = source_refs
            if isinstance(first_row.get("context_ref"), dict):
                event_part["context_ref"] = first_row["context_ref"]
            if isinstance(first_row.get("result_ref"), dict):
                event_part["result_ref"] = first_row["result_ref"]
            evidence_span_ids = [
                str(evidence_rows[ordinal]["evidence_span_id"])
                for ordinal in evidence_ordinals
                if evidence_rows[ordinal].get("evidence_span_id") is not None
            ]
            if evidence_span_ids:
                event_part["evidence_span_ids"] = [
                    str(evidence_span_id)
                    for evidence_span_id in canonical_evidence_span_ids(evidence_span_ids)
                ]
            event_parts.append(event_part)
            continue

        event_parts.append(
            {
                "part_key": part_key,
                "part_type": part_type,
                "text": part.text,
                "source_version": f"message:{user_message.id}:v1",
                "locator": {
                    "type": "message_offsets",
                    "conversation_id": str(run.conversation_id),
                    "message_id": str(user_message.id),
                    "message_seq": user_message.seq,
                    "start_offset": 0,
                    "end_offset": len(user_message.content),
                },
                "source_ref": {"type": "message", "id": str(user_message.id)},
                "metadata": {
                    "support_state": "not_source_grounded",
                    "evidence_ordinals": [],
                },
            }
        )

    return chat_run_event_payload_json(
        "artifact_delta",
        {
            "artifact_id": GENERATED_ARTIFACT_KEY,
            "artifact_key": GENERATED_ARTIFACT_KEY,
            "artifact_kind": artifact_kind,
            "title": parsed.title,
            "status": "complete",
            "delta": parsed.preview_text or "\n\n".join(part["text"] for part in event_parts),
            "parts": event_parts,
        },
    )


def _artifact_source_ref_json(value: object, field_name: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"artifact_delta {field_name} must be an object")
    try:
        return SourceRef.model_validate(value).model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        )
    except ValidationError as exc:
        raise ValueError(f"artifact_delta {field_name} is invalid") from exc


def _artifact_context_ref_json(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("artifact_delta context_ref must be an object")
    try:
        return retrieval_context_ref_json(value)
    except ValidationError as exc:
        raise ValueError("artifact_delta context_ref is invalid") from exc


def _artifact_result_ref_json(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("artifact_delta result_ref must be an object")
    try:
        return retrieval_result_ref_json(value)
    except ValidationError as exc:
        raise ValueError("artifact_delta result_ref is invalid") from exc


def _artifact_part_has_evidence(
    *,
    source_ref: dict[str, Any] | None,
    context_ref: dict[str, Any] | None,
    result_ref: dict[str, Any] | None,
    evidence_span_id: UUID | None,
    evidence_span_ids: list[str],
    source_refs: list[dict[str, Any]],
    metadata: object,
) -> bool:
    if (
        source_ref is not None
        or context_ref is not None
        or result_ref is not None
        or evidence_span_id is not None
        or evidence_span_ids
        or source_refs
    ):
        return True
    return isinstance(metadata, dict) and metadata.get("support_state") == "not_source_grounded"


def _validate_artifact_part_refs_readable(
    db: Session,
    *,
    viewer_id: UUID,
    source_ref: dict[str, Any] | None,
    context_ref: dict[str, Any] | None,
    result_ref: dict[str, Any] | None,
    evidence_span_ids: list[str],
    source_refs: list[dict[str, Any]],
) -> None:
    for ref in ([source_ref] if source_ref is not None else []) + source_refs:
        result = hydrate_source_ref(db, viewer_id=viewer_id, source_ref=ref)
        if not result.resolved:
            raise ValueError("artifact_delta source_ref is not readable")

    if context_ref is not None:
        result = hydrate_context_ref(db, viewer_id=viewer_id, context_ref=context_ref)
        if not result.resolved:
            raise ValueError("artifact_delta context_ref is not readable")

    if result_ref is not None:
        nested_context_ref = result_ref.get("context_ref")
        if isinstance(nested_context_ref, dict) and nested_context_ref.get("type") != "web_result":
            result = hydrate_context_ref(db, viewer_id=viewer_id, context_ref=nested_context_ref)
            if not result.resolved:
                raise ValueError("artifact_delta result_ref context is not readable")

    for raw_id in evidence_span_ids:
        parsed = _payload_uuid(raw_id)
        if parsed is None:
            raise ValueError("artifact_delta evidence_span_ids must be UUID strings")
        media_id = db.scalar(select(EvidenceSpan.media_id).where(EvidenceSpan.id == parsed))
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise ValueError("artifact_delta evidence_span_id is not readable")


def _artifact_delta_evidence_span_ids(
    *,
    evidence_span_id: UUID | None,
    raw_evidence_span_ids: object,
) -> list[str]:
    if raw_evidence_span_ids is None:
        raw_evidence_span_ids = []
    if not isinstance(raw_evidence_span_ids, list):
        raise ValueError("artifact_delta evidence_span_ids must be an array")
    values: list[UUID | str] = []
    for value in raw_evidence_span_ids:
        if not isinstance(value, str) or not value:
            raise ValueError("artifact_delta evidence_span_ids must be UUID strings")
        values.append(value)
    try:
        evidence_span_ids = trusted_evidence_span_ids(values)
    except EvidenceSpanIdsDuplicateError as exc:
        raise ValueError("artifact_delta evidence_span_ids must not contain duplicates") from exc
    except EvidenceSpanIdError as exc:
        raise ValueError("artifact_delta evidence_span_ids must be UUID strings") from exc
    if evidence_span_id is not None:
        if evidence_span_id in evidence_span_ids:
            raise ValueError("artifact_delta evidence_span_id must not duplicate evidence_span_ids")
        evidence_span_ids.append(evidence_span_id)
    return [str(evidence_span_id) for evidence_span_id in evidence_span_ids]


def _persist_artifact_deltas_for_message(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message,
) -> None:
    rows = db.execute(
        select(ChatRunEvent.seq, ChatRunEvent.payload)
        .where(ChatRunEvent.run_id == run.id, ChatRunEvent.event_type == "artifact_delta")
        .order_by(ChatRunEvent.seq.asc())
    ).all()
    if not rows:
        return

    artifacts: dict[str, dict[str, Any]] = {}
    for seq, payload in rows:
        if not isinstance(payload, dict):
            raise ValueError("artifact_delta payload must be an object")
        artifact_key = payload.get("artifact_id")
        if not isinstance(artifact_key, str) or not artifact_key.strip():
            raise ValueError("artifact_delta payload missing artifact_id")
        artifact_key = artifact_key.strip()
        artifact = artifacts.setdefault(
            artifact_key,
            {
                "artifact_key": artifact_key,
                "artifact_kind": None,
                "title": None,
                "status": "complete",
                "preview_text": None,
                "parts": [],
                "event_seqs": [],
            },
        )
        artifact["event_seqs"].append(seq)

        artifact_kind = payload.get("artifact_kind")
        if isinstance(artifact_kind, str) and artifact_kind.strip():
            artifact["artifact_kind"] = artifact_kind.strip()
        elif artifact_kind is not None:
            raise ValueError("artifact_delta artifact_kind must be a string")

        title = payload.get("title")
        if isinstance(title, str):
            artifact["title"] = title.strip() or None
        elif title is not None:
            raise ValueError("artifact_delta title must be a string")

        status = payload.get("status")
        if status in {"streaming", "complete", "error"}:
            artifact["status"] = status
        elif status is not None:
            raise ValueError("artifact_delta status is invalid")

        delta = payload.get("delta")
        if isinstance(delta, str):
            artifact["preview_text"] = delta[:20000]
        elif delta is not None:
            raise ValueError("artifact_delta delta must be a string")

        parts = payload.get("parts")
        if isinstance(parts, list):
            existing_parts = artifact["parts"]
            for part in parts:
                if not isinstance(part, dict):
                    existing_parts.append(part)
                    continue
                part_key = part.get("id") or part.get("part_key")
                if not isinstance(part_key, str) or not part_key:
                    existing_parts.append(part)
                    continue
                replaced = False
                for index, existing_part in enumerate(existing_parts):
                    if (
                        isinstance(existing_part, dict)
                        and (existing_part.get("id") or existing_part.get("part_key")) == part_key
                    ):
                        existing_parts[index] = part
                        replaced = True
                        break
                if not replaced:
                    existing_parts.append(part)
        elif parts is not None:
            raise ValueError("artifact_delta parts must be an array")

    insert_artifact = text(
        """
        INSERT INTO message_artifacts (
            conversation_id,
            message_id,
            chat_run_id,
            artifact_key,
            artifact_version,
            supersedes_artifact_id,
            artifact_kind,
            title,
            status,
            preview_text,
            metadata
        )
        VALUES (
            :conversation_id,
            :message_id,
            :chat_run_id,
            :artifact_key,
            :artifact_version,
            :supersedes_artifact_id,
            :artifact_kind,
            :title,
            :status,
            :preview_text,
            :metadata
        )
        RETURNING id
        """
    ).bindparams(bindparam("metadata", type_=JSONB))
    insert_part = text(
        """
        INSERT INTO message_artifact_parts (
            id,
            artifact_id,
            ordinal,
            part_key,
            part_type,
            text,
            source_version,
            locator,
            source_ref,
            context_ref,
            result_ref,
            evidence_span_id,
            evidence_span_ids,
            source_refs,
            metadata
        )
        VALUES (
            :id,
            :artifact_id,
            :ordinal,
            :part_key,
            :part_type,
            :part_text,
            :source_version,
            :locator,
            :source_ref,
            :context_ref,
            :result_ref,
            :evidence_span_id,
            :evidence_span_ids,
            :source_refs,
            :metadata
        )
        """
    ).bindparams(
        bindparam("locator", type_=JSONB),
        bindparam("source_ref", type_=JSONB(none_as_null=True)),
        bindparam("context_ref", type_=JSONB(none_as_null=True)),
        bindparam("result_ref", type_=JSONB(none_as_null=True)),
        bindparam("evidence_span_ids", type_=JSONB),
        bindparam("source_refs", type_=JSONB),
        bindparam("metadata", type_=JSONB),
    )

    db.execute(
        select(Message.id).where(Message.id == assistant_message.id).with_for_update()
    ).scalar_one()
    for artifact in artifacts.values():
        artifact_kind = artifact["artifact_kind"]
        if not isinstance(artifact_kind, str) or not artifact_kind:
            raise ValueError("artifact_delta payload missing artifact_kind")
        status = artifact["status"]
        previous = db.execute(
            text(
                """
                SELECT id,
                       artifact_version
                FROM message_artifacts
                WHERE message_id = :message_id
                  AND artifact_key = :artifact_key
                ORDER BY artifact_version DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ),
            {
                "message_id": assistant_message.id,
                "artifact_key": artifact["artifact_key"],
            },
        ).first()
        artifact_version = int(previous[1]) + 1 if previous is not None else 1
        artifact_row = db.execute(
            insert_artifact,
            {
                "conversation_id": assistant_message.conversation_id,
                "message_id": assistant_message.id,
                "chat_run_id": run.id,
                "artifact_key": artifact["artifact_key"],
                "artifact_version": artifact_version,
                "supersedes_artifact_id": previous[0] if previous is not None else None,
                "artifact_kind": artifact_kind,
                "title": artifact["title"],
                "status": "complete" if status == "streaming" else status,
                "preview_text": artifact["preview_text"],
                "metadata": {
                    "source": "chat_run_artifact_delta",
                    "run_event_seqs": artifact["event_seqs"],
                },
            },
        ).one()
        for ordinal, part in enumerate(artifact["parts"]):
            if not isinstance(part, dict):
                raise ValueError("artifact_delta part must be an object")
            evidence_span_id = _payload_uuid(part.get("evidence_span_id"))
            evidence_span_ids = _artifact_delta_evidence_span_ids(
                evidence_span_id=evidence_span_id,
                raw_evidence_span_ids=part.get("evidence_span_ids"),
            )

            raw_source_refs = part.get("source_refs")
            if raw_source_refs is None:
                raw_source_refs = []
            if not isinstance(raw_source_refs, list):
                raise ValueError("artifact_delta source_refs must be an array of objects")
            source_refs: list[dict[str, Any]] = []
            for value in raw_source_refs:
                source_ref_json = _artifact_source_ref_json(value, "source_refs")
                if source_ref_json is not None:
                    source_refs.append(source_ref_json)

            source_ref = _artifact_source_ref_json(part.get("source_ref"), "source_ref")
            context_ref = _artifact_context_ref_json(part.get("context_ref"))
            result_ref = _artifact_result_ref_json(part.get("result_ref"))

            part_key = part.get("part_key")
            if part_key is None and isinstance(part.get("id"), str):
                part_key = part["id"]
            if part_key is not None and (not isinstance(part_key, str) or not part_key.strip()):
                raise ValueError("artifact_delta part_key must be a non-empty string")
            part_type = part.get("part_type")
            if part_type is not None and (not isinstance(part_type, str) or not part_type.strip()):
                raise ValueError("artifact_delta part_type must be a non-empty string")
            part_text = part.get("text")
            if part_text is not None and not isinstance(part_text, str):
                raise ValueError("artifact_delta text must be a string")
            raw_metadata = part.get("metadata")
            if raw_metadata is not None and not isinstance(raw_metadata, dict):
                raise ValueError("artifact_delta metadata must be an object")
            if not _artifact_part_has_evidence(
                source_ref=source_ref,
                context_ref=context_ref,
                result_ref=result_ref,
                evidence_span_id=evidence_span_id,
                evidence_span_ids=evidence_span_ids,
                source_refs=source_refs,
                metadata=raw_metadata,
            ):
                raise ValueError("artifact_delta factual parts require evidence refs")
            _validate_artifact_part_refs_readable(
                db,
                viewer_id=run.owner_user_id,
                source_ref=source_ref,
                context_ref=context_ref,
                result_ref=result_ref,
                evidence_span_ids=evidence_span_ids,
                source_refs=source_refs,
            )
            part_id = uuid4()
            locator = retrieval_locator_json(
                {
                    "type": "artifact_part_ref",
                    "artifact_id": str(artifact_row[0]),
                    "artifact_part_id": str(part_id),
                    "message_id": str(assistant_message.id),
                    "conversation_id": str(assistant_message.conversation_id),
                    "part_key": part_key.strip() if isinstance(part_key, str) else None,
                }
            )
            if locator is None:
                raise ValueError("artifact_delta part locator is invalid")
            source_provenance = {
                "source_version": part["source_version"],
                "locator": part["locator"],
            }
            db.execute(
                insert_part,
                {
                    "id": part_id,
                    "artifact_id": artifact_row[0],
                    "ordinal": ordinal,
                    "part_key": part_key.strip() if isinstance(part_key, str) else None,
                    "part_type": part_type.strip() if isinstance(part_type, str) else None,
                    "part_text": part_text,
                    "source_version": f"artifact_part:{part_id}:v1",
                    "locator": locator,
                    "source_ref": source_ref,
                    "context_ref": context_ref,
                    "result_ref": result_ref,
                    "evidence_span_id": evidence_span_id,
                    "evidence_span_ids": evidence_span_ids,
                    "source_refs": source_refs,
                    "metadata": {
                        **(raw_metadata if isinstance(raw_metadata, dict) else {}),
                        "source_provenance": source_provenance,
                        **{
                            key: value
                            for key, value in part.items()
                            if key
                            not in {
                                "context_ref",
                                "evidence_span_id",
                                "evidence_span_ids",
                                "id",
                                "metadata",
                                "part_key",
                                "part_type",
                                "result_ref",
                                "source_version",
                                "locator",
                                "source_ref",
                                "source_refs",
                                "text",
                                "type",
                            }
                        },
                    },
                },
            )


def _source_manifest_blocks_for_run(db: Session, run_id: UUID) -> list[dict[str, object]]:
    rows = (
        db.execute(
            select(SourceManifest)
            .where(SourceManifest.chat_run_id == run_id)
            .order_by(
                SourceManifest.tool_call_index.asc(),
                SourceManifest.created_at.desc(),
                SourceManifest.id.desc(),
            )
        )
        .scalars()
        .all()
    )
    blocks: list[dict[str, object]] = []
    seen_tool_call_indexes: set[int] = set()
    for manifest in rows:
        if manifest.tool_call_index in seen_tool_call_indexes:
            continue
        seen_tool_call_indexes.add(manifest.tool_call_index)
        blocks.append(
            {
                "type": "source_manifest",
                "assistant_message_id": str(manifest.assistant_message_id),
                "tool_call_id": str(manifest.tool_call_id) if manifest.tool_call_id else None,
                "tool_name": manifest.tool_name,
                "tool_call_index": manifest.tool_call_index,
                "query_hash": manifest.query_hash,
                "scope": manifest.scope,
                "filters": manifest.filters,
                "requested_types": manifest.requested_types,
                "candidate_count": manifest.candidate_count,
                "result_count": manifest.result_count,
                "selected_count": manifest.selected_count,
                "included_in_prompt_count": manifest.included_in_prompt_count,
                "excluded_by_budget_count": manifest.excluded_by_budget_count,
                "excluded_by_scope_count": manifest.excluded_by_scope_count,
                "stale_count": manifest.stale_count,
                "unreadable_count": manifest.unreadable_count,
                "web_search_mode": manifest.web_search_mode,
                "index_versions": manifest.index_versions,
                "metadata": manifest.metadata_json,
                "latency_ms": manifest.latency_ms,
                "status": manifest.status,
            }
        )
    return blocks


def _message_document_with_run_components(
    db: Session,
    *,
    run_id: UUID,
    role: str,
    content: str,
) -> dict[str, object]:
    document = _message_document(role, content)
    run = db.get(ChatRun, run_id)
    document["blocks"] = [
        *cast(list[dict[str, object]], document["blocks"]),
        *(
            _verification_summary_blocks_for_message(
                db, assistant_message_id=run.assistant_message_id
            )
            if run is not None
            else []
        ),
        *(
            _citation_audit_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _claim_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _claim_evidence_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *(
            _retrieval_result_blocks_for_message(db, assistant_message_id=run.assistant_message_id)
            if run is not None
            else []
        ),
        *_source_manifest_blocks_for_run(db, run_id),
        *_artifact_preview_blocks_for_run(db, run_id),
    ]
    return document


def _citation_audit_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    row = db.execute(
        text(
            """
            SELECT id,
                   chat_run_id,
                   verifier_run_id,
                   supported_claim_count,
                   supported_claims_with_valid_offsets_count,
                   supported_claims_with_citation_count,
                   missing_locator_count,
                   missing_source_version_count,
                   supported_claims_have_valid_offsets,
                   supported_claims_have_citation_placement,
                   claim_evidence_has_required_locators,
                   claim_evidence_has_source_versions,
                   details,
                   created_at
            FROM assistant_message_citation_audits
            WHERE message_id = :assistant_message_id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).first()
    if row is None:
        return []
    return [
        {
            "type": "citation_audit",
            "id": str(row[0]),
            "message_id": str(assistant_message_id),
            "chat_run_id": str(row[1]) if row[1] is not None else None,
            "verifier_run_id": str(row[2]) if row[2] is not None else None,
            "supported_claim_count": row[3],
            "supported_claims_with_valid_offsets_count": row[4],
            "supported_claims_with_citation_count": row[5],
            "missing_locator_count": row[6],
            "missing_source_version_count": row[7],
            "supported_claims_have_valid_offsets": row[8],
            "supported_claims_have_citation_placement": row[9],
            "claim_evidence_has_required_locators": row[10],
            "claim_evidence_has_source_versions": row[11],
            "details": row[12],
            "created_at": row[13].isoformat() if row[13] is not None else None,
        }
    ]


def _verification_summary_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    row = db.execute(
        text(
            """
            SELECT id,
                   scope_type,
                   scope_ref,
                   retrieval_status,
                   support_status,
                   verifier_status,
                   verifier_run_id,
                   claim_count,
                   supported_claim_count,
                   unsupported_claim_count,
                   not_enough_evidence_count,
                   prompt_assembly_id,
                   created_at,
                   updated_at
            FROM assistant_message_evidence_summaries
            WHERE message_id = :assistant_message_id
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).first()
    if row is None:
        return []
    return [
        {
            "type": "verification_summary",
            "id": str(row[0]),
            "message_id": str(assistant_message_id),
            "scope_type": row[1],
            "scope_ref": row[2],
            "retrieval_status": row[3],
            "support_status": row[4],
            "verifier_status": row[5],
            "claim_count": row[7],
            "supported_claim_count": row[8],
            "unsupported_claim_count": row[9],
            "not_enough_evidence_count": row[10],
            "prompt_assembly_id": str(row[11]) if row[11] is not None else None,
            "verifier_run_id": str(row[6]) if row[6] is not None else None,
            "created_at": row[12].isoformat() if row[12] is not None else None,
            "updated_at": row[13].isoformat() if row[13] is not None else None,
        }
    ]


def _claim_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT c.id,
                   c.ordinal,
                   c.claim_text,
                   c.answer_start_offset,
                   c.answer_end_offset,
                   c.claim_kind,
                   c.support_status,
                   c.unsupported_reason,
                   c.confidence,
                   c.verifier_status,
                   c.verifier_run_id,
                   c.created_at,
                   COALESCE(array_agg(e.id ORDER BY e.ordinal) FILTER (WHERE e.id IS NOT NULL), '{}')
            FROM assistant_message_claims c
            LEFT JOIN assistant_message_claim_evidence e ON e.claim_id = c.id
            WHERE c.message_id = :assistant_message_id
            GROUP BY c.id
            ORDER BY c.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    return [
        {
            "type": "claim",
            "claim_id": str(row[0]),
            "message_id": str(assistant_message_id),
            "ordinal": row[1],
            "claim_text": row[2],
            "answer_start_offset": row[3],
            "answer_end_offset": row[4],
            "claim_kind": row[5],
            "support_status": row[6],
            "unsupported_reason": row[7],
            "confidence": float(row[8]) if row[8] is not None else None,
            "verifier_status": row[9],
            "created_at": row[11].isoformat() if row[11] is not None else None,
            "evidence_ids": [str(evidence_id) for evidence_id in row[12]],
        }
        for row in rows
    ]


def _claim_evidence_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT e.id,
                   e.claim_id,
                   e.ordinal,
                   e.evidence_role,
                   e.source_ref,
                   e.retrieval_id,
                   e.evidence_span_id,
                   e.context_ref,
                   e.result_ref,
                   e.exact_snippet,
                   e.snippet_prefix,
                   e.snippet_suffix,
                   e.locator,
                   e.deep_link,
                   e.score,
                   e.retrieval_status,
                   e.selected,
                   e.included_in_prompt,
                   e.source_version,
                   e.created_at
            FROM assistant_message_claim_evidence e
            JOIN assistant_message_claims c ON c.id = e.claim_id
            WHERE c.message_id = :assistant_message_id
            ORDER BY c.ordinal ASC, e.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    return [
        {
            "type": "claim_evidence",
            "id": str(row[0]),
            "claim_id": str(row[1]),
            "ordinal": row[2],
            "evidence_role": row[3],
            "source_ref": row[4],
            "retrieval_id": str(row[5]) if row[5] is not None else None,
            "evidence_span_id": str(row[6]) if row[6] is not None else None,
            "context_ref": row[7],
            "result_ref": row[8],
            "exact_snippet": row[9],
            "snippet_prefix": row[10],
            "snippet_suffix": row[11],
            "locator": row[12],
            "deep_link": row[13],
            "score": float(row[14]) if row[14] is not None else None,
            "retrieval_status": row[15],
            "selected": row[16],
            "included_in_prompt": row[17],
            "source_version": row[18],
            "created_at": row[19].isoformat() if row[19] is not None else None,
        }
        for row in rows
    ]


def _retrieval_result_blocks_for_message(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT mr.id,
                   mr.tool_call_id,
                   mr.ordinal,
                   mr.result_type,
                   mr.source_id,
                   mr.media_id,
                   mr.evidence_span_id,
                   mr.context_ref,
                   mr.result_ref,
                   mr.deep_link,
                   mr.score,
                   mr.selected,
                   mr.source_title,
                   mr.section_label,
                   mr.exact_snippet,
                   mr.snippet_prefix,
                   mr.snippet_suffix,
                   mr.locator,
                   mr.retrieval_status,
                   mr.included_in_prompt,
                   mr.source_version,
                   mr.created_at
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    blocks: list[dict[str, object]] = []
    for row in rows:
        blocks.append(
            {
                "type": "retrieval_result",
                "id": str(row[0]),
                "tool_call_id": str(row[1]),
                "ordinal": row[2],
                "result_type": row[3],
                "source_id": row[4],
                "media_id": str(row[5]) if row[5] is not None else None,
                "evidence_span_id": str(row[6]) if row[6] is not None else None,
                "context_ref": row[7],
                "result_ref": row[8],
                "deep_link": row[9],
                "score": row[10],
                "selected": bool(row[11]),
                "source_title": row[12],
                "section_label": row[13],
                "exact_snippet": row[14],
                "snippet_prefix": row[15],
                "snippet_suffix": row[16],
                "locator": row[17],
                "retrieval_status": row[18],
                "included_in_prompt": bool(row[19]),
                "source_version": row[20],
                "created_at": row[21].isoformat() if row[21] is not None else None,
            }
        )
    return blocks


def _selected_path_reply_parent(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> Message | None:
    active_leaf_id = active_leaf_for_viewer(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
    )
    if active_leaf_id is None:
        return None
    active_leaf = db.get(Message, active_leaf_id)
    if active_leaf is not None and active_leaf.role == "assistant":
        if active_leaf.status == "pending":
            raise ApiError(
                ApiErrorCode.E_CONVERSATION_BUSY,
                "Conversation already has a pending assistant response",
            )
        if active_leaf.status not in {"complete", "error"}:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"Unsupported assistant message status: {active_leaf.status}",
            )

    path = load_leaf_message_path(
        db,
        conversation_id=conversation_id,
        leaf_message_id=active_leaf_id,
    )
    for message in reversed(path):
        if message.role == "assistant" and message.status == "complete":
            return message
    return None


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    seq = run.next_event_seq
    payload = chat_run_event_payload_json(event_type, payload)
    db.add(ChatRunEvent(run_id=run.id, seq=seq, event_type=event_type, payload=payload))
    if event_type == "source_manifest_delta":
        _persist_source_manifest_delta(db, run=run, payload=payload)
    run.next_event_seq = seq + 1
    run.updated_at = datetime.now(UTC)
    db.flush()


def _payload_uuid(value: object) -> UUID | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _persist_source_manifest_delta(
    db: Session,
    *,
    run: ChatRun,
    payload: dict[str, Any],
) -> None:
    assistant_message_id = UUID(str(payload["assistant_message_id"]))
    tool_call_index = int(payload["tool_call_index"])
    tool_call_id = _payload_uuid(payload.get("tool_call_id"))
    latency_ms = payload["latency_ms"]
    manifest = (
        db.execute(
            select(SourceManifest)
            .where(
                SourceManifest.chat_run_id == run.id,
                SourceManifest.tool_call_index == tool_call_index,
            )
            .order_by(SourceManifest.created_at.desc(), SourceManifest.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if manifest is None:
        manifest = SourceManifest(
            conversation_id=run.conversation_id,
            assistant_message_id=assistant_message_id,
            chat_run_id=run.id,
            tool_call_id=tool_call_id,
            tool_call_index=tool_call_index,
            tool_name=str(payload["tool_name"]),
        )
        db.add(manifest)
    manifest.conversation_id = run.conversation_id
    manifest.assistant_message_id = assistant_message_id
    manifest.chat_run_id = run.id
    manifest.tool_call_id = tool_call_id
    manifest.tool_call_index = tool_call_index
    manifest.tool_name = str(payload["tool_name"])
    manifest.query_hash = payload["query_hash"]
    manifest.scope = str(payload["scope"])
    manifest.filters = dict(payload["filters"])
    manifest.requested_types = list(payload["requested_types"])
    manifest.candidate_count = int(payload["candidate_count"])
    manifest.result_count = int(payload["result_count"])
    manifest.selected_count = int(payload["selected_count"])
    manifest.included_in_prompt_count = int(payload["included_in_prompt_count"])
    manifest.excluded_by_budget_count = int(payload["excluded_by_budget_count"])
    manifest.excluded_by_scope_count = int(payload["excluded_by_scope_count"])
    manifest.stale_count = int(payload["stale_count"])
    manifest.unreadable_count = int(payload["unreadable_count"])
    manifest.web_search_mode = payload["web_search_mode"]
    manifest.index_versions = list(payload["index_versions"])
    manifest.metadata_json = dict(payload["metadata"])
    manifest.latency_ms = latency_ms if isinstance(latency_ms, int) else None
    manifest.status = str(payload["status"])
    manifest.updated_at = datetime.now(UTC)


def build_chat_run_response(db: Session, viewer_id: UUID, run: ChatRun) -> ChatRunResponse:
    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    assistant_message = db.get(Message, run.assistant_message_id)
    if conversation is None or user_message is None or assistant_message is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")

    message_ids = [user_message.id, assistant_message.id]
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    artifacts_by_message_id = load_message_artifacts_for_message_ids(db, message_ids)
    retryable_message_ids = retryable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    user_message_out = message_to_out(
        user_message,
        contexts_by_message_id.get(user_message.id, []),
        artifacts_by_message_id.get(user_message.id, []),
        can_retry_response=user_message.id in retryable_message_ids,
    )
    assistant_message_out = message_to_out(
        assistant_message,
        contexts_by_message_id.get(assistant_message.id, []),
        artifacts_by_message_id.get(assistant_message.id, []),
        can_retry_response=assistant_message.id in retryable_message_ids,
    )
    return ChatRunResponse(
        run=ChatRunOut.model_validate(run),
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=user_message_out,
        assistant_message=assistant_message_out,
    )


def _normalize_idempotency_key(idempotency_key: str | None) -> str:
    normalized_key = (idempotency_key or "").strip()
    if not normalized_key:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(normalized_key) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")
    return normalized_key


def _get_run_for_owner(db: Session, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def _load_retryable_failed_assistant_message(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> Message:
    message = db.get(Message, assistant_message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    conversation = db.get(Conversation, message.conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    if message.role != "assistant" or message.status != "error":
        raise ApiError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Only failed assistant messages can be retried",
        )
    return message


def _load_source_run_for_retry(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message: Message,
) -> ChatRun:
    run = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id == assistant_message.id,
            )
            .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
        )
        .scalars()
        .first()
    )
    if run is None:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run not found")
    if run.conversation_id != assistant_message.conversation_id:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run is invalid")
    if run.status != "error":
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run is not failed")
    if run.error_code not in CHAT_RESPONSE_RETRYABLE_ERROR_CODES:
        raise ApiError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "Assistant response is not retryable")
    return run


def _load_context_rows_for_message(db: Session, message_id: UUID) -> list[MessageContextItem]:
    return list(
        db.execute(
            select(MessageContextItem)
            .where(MessageContextItem.message_id == message_id)
            .order_by(MessageContextItem.ordinal.asc(), MessageContextItem.id.asc())
        )
        .scalars()
        .all()
    )


def _copy_context_rows(
    db: Session,
    *,
    viewer_id: UUID,
    source_message_id: UUID,
    target_message_id: UUID,
    rows: Sequence[MessageContextItem],
) -> None:
    for row in rows:
        db.add(
            MessageContextItem(
                message_id=target_message_id,
                user_id=viewer_id,
                context_kind=row.context_kind,
                object_type=row.object_type,
                object_id=row.object_id,
                source_media_id=row.source_media_id,
                locator_json=row.locator_json,
                ordinal=row.ordinal,
                context_snapshot_json=row.context_snapshot_json,
            )
        )
    links = db.scalars(
        select(ObjectLink).where(
            ObjectLink.user_id == viewer_id,
            ObjectLink.relation_type == "used_as_context",
            or_(
                (ObjectLink.a_type == "message") & (ObjectLink.a_id == source_message_id),
                (ObjectLink.b_type == "message") & (ObjectLink.b_id == source_message_id),
            ),
        )
    ).all()
    for link in links:
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type=link.relation_type,
                a_type=link.a_type,
                a_id=target_message_id
                if link.a_type == "message" and link.a_id == source_message_id
                else link.a_id,
                b_type=link.b_type,
                b_id=target_message_id
                if link.b_type == "message" and link.b_id == source_message_id
                else link.b_id,
                a_order_key=link.a_order_key,
                b_order_key=link.b_order_key,
                a_locator_json=(
                    dict(link.a_locator_json) if link.a_locator_json is not None else None
                ),
                b_locator_json=(
                    dict(link.b_locator_json) if link.b_locator_json is not None else None
                ),
                metadata_json=dict(link.metadata_json or {}),
            )
        )
    db.flush()


def _get_run_by_idempotency_key(
    db: Session, viewer_id: UUID, idempotency_key: str
) -> ChatRun | None:
    return (
        db.execute(
            select(ChatRun).where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.idempotency_key == idempotency_key,
            )
        )
        .scalars()
        .first()
    )


def _raise_if_payload_mismatch(
    run: ChatRun,
    payload_hash: str,
    viewer_id: UUID,
    idempotency_key: str,
) -> None:
    if run.payload_hash == payload_hash:
        return
    logger.warning(
        "chat_run.idempotency_mismatch",
        **safe_kv(idempotency_key=idempotency_key, viewer_id=str(viewer_id)),
    )
    raise ApiError(
        ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
        "Idempotency key reused with different payload",
    )


def _lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"chat_run:{viewer_id}:{idempotency_key}"},
    )


def _append_and_commit(db: Session, run_id: UUID, event_type: str, payload: dict[str, Any]) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    append_run_event(db, run, event_type, payload)
    db.commit()


def _mark_running(db: Session, run_id: UUID) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status == "queued":
        run.status = "running"
        run.started_at = run.started_at or datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
    db.commit()


def _is_cancel_requested(db: Session, run_id: UUID) -> bool:
    run = db.get(ChatRun, run_id)
    return run is not None and run.cancel_requested_at is not None


def _has_delta_without_terminal(db: Session, run_id: UUID) -> bool:
    rows = db.execute(
        text(
            """
            SELECT event_type
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('delta', 'done')
            """
        ),
        {"run_id": run_id},
    ).fetchall()
    event_types = {row[0] for row in rows}
    return "delta" in event_types and "done" not in event_types


def _finalize_interrupted(db: Session, run: ChatRun) -> None:
    model = db.get(Model, run.model_id)
    _finalize_run(
        db,
        run_id=run.id,
        assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INTERRUPTED"],
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
        model=model,
        resolved_key=_dummy_resolved_key(model) if model is not None else None,
        key_mode=run.key_mode,
        latency_ms=0,
        usage=None,
        provider_request_id=None,
        viewer_id=run.owner_user_id,
    )


def _finalize_cancelled(
    db: Session,
    run: ChatRun,
    model: Model,
    resolved_key: ResolvedKey | None,
    latency_ms: int,
) -> None:
    _finalize_run(
        db,
        run_id=run.id,
        assistant_content=ERROR_CODE_TO_MESSAGE["E_CANCELLED"],
        assistant_status="error",
        run_status="cancelled",
        done_status="cancelled",
        error_code=ApiErrorCode.E_CANCELLED.value,
        model=model,
        resolved_key=resolved_key,
        key_mode=run.key_mode,
        latency_ms=latency_ms,
        usage=None,
        provider_request_id=None,
        viewer_id=run.owner_user_id,
    )


def _usage_tokens(usage: LLMUsage | None) -> dict[str, int | None]:
    """Token breakdown keyed by MessageLLM column names.

    Cache fields default to 0 when usage is present; None when usage is None.
    Total falls back to input + output + reasoning when the provider omits it.
    """

    def _int(name: str) -> int | None:
        if usage is None:
            return None
        value = getattr(usage, name, None)
        return value if isinstance(value, int) else None

    input_t = _int("input_tokens")
    output_t = _int("output_tokens")
    reasoning_t = _int("reasoning_tokens")
    total_t = _int("total_tokens")
    if total_t is None and input_t is not None and output_t is not None:
        total_t = input_t + output_t + (reasoning_t or 0)
    cache_default = None if usage is None else 0
    return {
        "input_tokens": input_t,
        "output_tokens": output_t,
        "total_tokens": total_t,
        "reasoning_tokens": reasoning_t,
        "cache_write_input_tokens": _int("cache_write_input_tokens") or cache_default,
        "cache_read_input_tokens": _int("cache_read_input_tokens") or cache_default,
        "cached_input_tokens": _int("cached_input_tokens") or cache_default,
    }


def _usage_log_fields(usage: LLMUsage | None) -> dict[str, int | None]:
    """Token breakdown for log events (uses `tokens_*` keys for the basic counts)."""
    tokens = _usage_tokens(usage)
    return {
        "tokens_input": tokens["input_tokens"],
        "tokens_output": tokens["output_tokens"],
        "tokens_total": tokens["total_tokens"],
        "tokens_reasoning": tokens["reasoning_tokens"],
        "cache_write_input_tokens": tokens["cache_write_input_tokens"],
        "cache_read_input_tokens": tokens["cache_read_input_tokens"],
        "cached_input_tokens": tokens["cached_input_tokens"],
    }


def _usage_provider_json(usage: LLMUsage | None) -> dict[str, object] | None:
    if usage is None:
        return None
    provider_usage = getattr(usage, "provider_usage", None)
    if isinstance(provider_usage, dict):
        return provider_usage
    return dict(_usage_tokens(usage))


def _prompt_assembly_metadata(
    db: Session,
    *,
    run_id: UUID,
) -> tuple[str | None, str | None]:
    row = db.execute(
        text(
            """
            SELECT prompt_plan_version, stable_prefix_hash
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run_id},
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


def _reconcile_prompt_retrievals(db: Session, *, run: ChatRun, assembly: Any) -> None:
    included_ids = [str(retrieval_id) for retrieval_id in assembly.ledger.included_retrieval_ids]
    dropped_ids = [
        item["key"].split(":", 1)[1]
        for item in assembly.ledger.dropped_items
        if item.get("lane") in {"retrieved_evidence", "web_evidence"}
        and isinstance(item.get("key"), str)
        and ":" in item["key"]
        and item["key"].split(":", 1)[0] in {"retrieved_evidence", "web_evidence"}
    ]
    if included_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = true,
                    retrieval_status = CASE
                        WHEN result_type = 'web_result' THEN 'web_result'
                        ELSE 'included_in_prompt'
                    END
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator,
                    source_version
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       true,
                       'included_in_prompt',
                       'prompt_assembly',
                       result_ref,
                       locator,
                       source_version
                FROM message_retrievals
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
    if dropped_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = false,
                    retrieval_status = 'excluded_by_budget'
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator,
                    source_version
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       false,
                       'excluded_by_budget',
                       'prompt_assembly',
                       result_ref,
                       locator,
                       source_version
                FROM message_retrievals
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )

    existing_manifest_rows = (
        db.execute(
            select(ChatRunEvent.payload)
            .where(
                ChatRunEvent.run_id == run.id,
                ChatRunEvent.event_type == "source_manifest_delta",
            )
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    manifest_payloads: dict[str, dict[str, Any]] = {}
    for payload in existing_manifest_rows:
        if not isinstance(payload, dict):
            continue
        key = str(payload.get("tool_call_id") or payload.get("tool_call_index") or "")
        if key:
            manifest_payloads[key] = payload

    rows = db.execute(
        text(
            """
            SELECT mtc.id,
                   mtc.tool_name,
                   mtc.tool_call_index,
                   mtc.query_hash,
                   mtc.scope,
                   mtc.requested_types,
                   mtc.status,
                   mtc.latency_ms,
                   count(mr.id),
                   count(mr.id) FILTER (WHERE mr.selected),
                   count(mr.id) FILTER (WHERE mr.included_in_prompt),
                   count(mr.id) FILTER (
                       WHERE mr.retrieval_status = 'excluded_by_budget'
                   ),
                   count(mr.id) FILTER (
                       WHERE mr.retrieval_status = 'excluded_by_scope'
                   )
            FROM message_tool_calls mtc
            LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
            WHERE mtc.assistant_message_id = :assistant_message_id
            GROUP BY mtc.id
            ORDER BY mtc.tool_call_index ASC
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    ).fetchall()
    for row in rows:
        manifest_key = str(row[0])
        existing_manifest = manifest_payloads.get(manifest_key) or manifest_payloads.get(
            str(row[2])
        )
        filters = {}
        if existing_manifest is not None and isinstance(existing_manifest.get("filters"), dict):
            filters = existing_manifest["filters"]
        manifest = {
            "assistant_message_id": str(run.assistant_message_id),
            "tool_call_id": str(row[0]),
            "tool_name": row[1],
            "tool_call_index": row[2],
            "query_hash": row[3],
            "scope": row[4],
            "filters": filters,
            "requested_types": row[5] or [],
            "candidate_count": row[8],
            "result_count": row[8],
            "selected_count": row[9],
            "included_in_prompt_count": row[10],
            "excluded_by_budget_count": row[11],
            "excluded_by_scope_count": row[12],
            "stale_count": existing_manifest.get("stale_count", 0)
            if existing_manifest is not None
            else 0,
            "unreadable_count": existing_manifest.get("unreadable_count", 0)
            if existing_manifest is not None
            else 0,
            "latency_ms": row[7],
            "status": row[6],
            "index_versions": [],
            "metadata": {},
        }
        if existing_manifest is not None:
            if "web_search_mode" in existing_manifest:
                manifest["web_search_mode"] = existing_manifest.get("web_search_mode")
            if isinstance(existing_manifest.get("index_versions"), list):
                manifest["index_versions"] = existing_manifest["index_versions"]
            if isinstance(existing_manifest.get("metadata"), dict):
                manifest["metadata"] = existing_manifest["metadata"]
        append_run_event(
            db,
            run,
            "source_manifest_delta",
            manifest,
        )


def _failed_claim_statuses(
    claim_candidates: list[ClaimCandidate],
    *,
    unsupported_reason: str = "claim was not verified against source evidence",
) -> list[dict[str, Any]]:
    return [
        {
            "ordinal": ordinal,
            "text": claim.text,
            "answer_start_offset": claim.start,
            "answer_end_offset": claim.end,
            "support_status": "not_enough_evidence",
            "verifier_status": "failed",
            "evidence_ordinals": [],
            "unsupported_reason": unsupported_reason,
        }
        for ordinal, claim in enumerate(claim_candidates)
    ]


def _failed_verifier_hint(
    *,
    verifier_name: str,
    status_detail: str,
    claim_candidates: list[ClaimCandidate],
    evidence_count: int,
    source_backed: bool,
    parse_failed: bool,
) -> dict[str, Any]:
    claim_statuses = _failed_claim_statuses(claim_candidates)
    return {
        "verifier_name": verifier_name,
        "verifier_version": "v1",
        "verifier_status": "parse_failed" if parse_failed else "failed",
        "metadata": {
            "verifier": verifier_name,
            "status_detail": status_detail,
            "draft_claim_count": len(claim_candidates),
            "evidence_count": evidence_count,
            "claim_statuses": claim_statuses,
            "draft_claim_statuses": [dict(item) for item in claim_statuses],
            "removed_claim_statuses": [dict(item) for item in claim_statuses],
            "unsupported_claim_statuses": [dict(item) for item in claim_statuses],
            "draft_unsupported_claim_count": len(claim_statuses),
            "unsupported_claim_count": len(claim_statuses),
            "removed_claim_count": len(claim_statuses),
            "rewrote_answer": True,
            "source_backed": source_backed,
        },
    }


def _is_source_backed_run(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message | None,
    evidence_rows: list[dict[str, Any]],
) -> bool:
    if evidence_rows:
        return True
    conversation = db.get(Conversation, run.conversation_id)
    if conversation is not None and conversation.scope_type in {"media", "library"}:
        return True
    if assistant_message is None:
        return False
    tool_call_count = db.execute(
        select(func.count(MessageToolCall.id)).where(
            MessageToolCall.assistant_message_id == assistant_message.id
        )
    ).scalar_one()
    return bool(tool_call_count)


def _scope_constraints_for_run(db: Session, run: ChatRun) -> dict[str, object]:
    conversation = db.get(Conversation, run.conversation_id)
    if conversation is None:
        return {"type": "general"}
    if conversation.scope_type == "media" and conversation.scope_media_id is not None:
        return {"type": "media", "media_id": str(conversation.scope_media_id)}
    if conversation.scope_type == "library" and conversation.scope_library_id is not None:
        return {"type": "library", "library_id": str(conversation.scope_library_id)}
    return {"type": conversation.scope_type}


async def _verified_assistant_content(
    db: Session,
    *,
    run: ChatRun,
    model: Model,
    resolved_key: ResolvedKey,
    llm_router: ChatRunLLMRouter,
    assistant_content: str,
) -> tuple[str, dict[str, Any] | None]:
    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is None:
        return assistant_content, None

    _, evidence_rows = _message_prompt_evidence_rows(
        db,
        run,
        assistant_message,
        reconcile_inclusion=False,
    )
    source_backed = _is_source_backed_run(
        db,
        run=run,
        assistant_message=assistant_message,
        evidence_rows=evidence_rows,
    )
    generate = getattr(llm_router, "generate", None)
    if not source_backed and not callable(generate):
        return assistant_content, None
    if source_backed and not evidence_rows:
        verifier_hint = _failed_verifier_hint(
            verifier_name="source_evidence_gate",
            status_detail="missing_evidence",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=False,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    if not callable(generate):
        verifier_hint = _failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="missing_claim_extractor",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=False,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    try:
        claim_candidates = await _extract_claim_candidates(
            generate=generate,
            model=model,
            resolved_key=resolved_key,
            assistant_content=assistant_content,
        )
    except (LLMError, ValueError) as exc:
        logger.warning(
            "chat.claim_extractor.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                error_class=exc.__class__.__name__,
            ),
        )
        if not source_backed:
            verifier_hint = _failed_verifier_hint(
                verifier_name="llm_claim_extractor",
                status_detail="claim_extractor_failed",
                claim_candidates=[],
                evidence_count=0,
                source_backed=False,
                parse_failed=True,
            )
            verifier_hint["metadata"]["rewrote_answer"] = False
            return assistant_content, verifier_hint
        verifier_hint = _failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="claim_extractor_failed",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=True,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint
    if not claim_candidates:
        if not source_backed:
            verifier_hint = _failed_verifier_hint(
                verifier_name="llm_claim_extractor",
                status_detail="missing_claim_candidates",
                claim_candidates=[],
                evidence_count=0,
                source_backed=False,
                parse_failed=True,
            )
            verifier_hint["metadata"]["rewrote_answer"] = False
            return assistant_content, verifier_hint
        verifier_hint = _failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="missing_claim_candidates",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=True,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    if not source_backed:
        claim_statuses = [
            {
                "ordinal": ordinal,
                "text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "support_status": "not_source_grounded",
                "verifier_status": "llm_verified",
                "evidence_ordinals": [],
                "supporting_evidence_ordinals": [],
                "contradicting_evidence_ordinals": [],
                "context_evidence_ordinals": [],
                "unsupported_reason": "assistant answer was not grounded in retrieved or attached sources",
                "confidence": None,
            }
            for ordinal, claim in enumerate(claim_candidates)
        ]
        return assistant_content, {
            "verifier_name": "llm_claim_extractor",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "verifier": "llm_claim_extractor",
                "provider": model.provider,
                "model_name": model.model_name,
                "limited_no_model": False,
                "draft_claim_count": len(claim_candidates),
                "classified_claim_count": len(claim_candidates),
                "evidence_count": 0,
                "evidence_count_sent": 0,
                "source_backed": False,
                "source_manifest": _source_manifest_blocks_for_run(db, run.id),
                "scope_constraints": _scope_constraints_for_run(db, run),
                "claim_statuses": claim_statuses,
                "answer_claim_statuses": claim_statuses,
                "draft_claim_statuses": [dict(item) for item in claim_statuses],
                "removed_claim_statuses": [],
                "unsupported_claim_statuses": [dict(item) for item in claim_statuses],
                "draft_unsupported_claim_count": len(claim_statuses),
                "unsupported_claim_count": len(claim_statuses),
                "removed_claim_count": 0,
                "rewrote_answer": False,
            },
        }

    verifier_name = "llm_claim_classifier"
    evidence_payload = []
    for ordinal, row in enumerate(evidence_rows):
        locator = row.get("locator")
        source_version = row.get("source_version")
        evidence_payload.append(
            {
                "ordinal": ordinal,
                "retrieval_id": str(row["retrieval_id"]) if row.get("retrieval_id") else None,
                "evidence_span_id": str(row["evidence_span_id"])
                if row.get("evidence_span_id")
                else None,
                "source_ref": row.get("source_ref")
                if isinstance(row.get("source_ref"), dict)
                else None,
                "context_ref": row.get("context_ref")
                if isinstance(row.get("context_ref"), dict)
                else None,
                "result_ref": row.get("result_ref")
                if isinstance(row.get("result_ref"), dict)
                else None,
                "exact_snippet": row["exact_snippet"],
                "snippet_prefix": row.get("snippet_prefix"),
                "snippet_suffix": row.get("snippet_suffix"),
                "locator": locator if isinstance(locator, dict) and locator else None,
                "source_version": source_version
                if isinstance(source_version, str) and source_version.strip()
                else None,
                "retrieval_status": row["retrieval_status"],
                "selected": bool(row["selected"]),
                "included_in_prompt": bool(row["included_in_prompt"]),
                "strictly_citable": isinstance(locator, dict)
                and bool(locator)
                and isinstance(source_version, str)
                and bool(source_version.strip())
                and isinstance(row.get("exact_snippet"), str)
                and bool(str(row.get("exact_snippet")).strip()),
            }
        )
    claim_payload = [
        {
            "ordinal": ordinal,
            "text": claim.text,
            "answer_start_offset": claim.start,
            "answer_end_offset": claim.end,
        }
        for ordinal, claim in enumerate(claim_candidates)
    ]
    verifier_request = {
        "answer_draft": assistant_content,
        "claims": claim_payload,
        "selected_evidence": evidence_payload,
        "source_manifest": _source_manifest_blocks_for_run(db, run.id),
        "scope_constraints": _scope_constraints_for_run(db, run),
    }
    try:
        response = await cast(Any, generate)(
            model.provider,
            LLMRequest(
                model_name=model.model_name,
                messages=[
                    Turn(
                        role="system",
                        content=(
                            "Classify every answer claim against the selected evidence. "
                            "Return only JSON with a claims array. Each item must include "
                            "ordinal, answer_start_offset, answer_end_offset, support_status, "
                            "evidence_ordinals, unsupported_reason, and confidence. Use "
                            "supporting_evidence_ordinals for evidence "
                            "that supports the claim, contradicting_evidence_ordinals for "
                            "conflicting evidence, and context_evidence_ordinals for scope "
                            "context. support_status must be one of supported, "
                            "partially_supported, contradicted, not_enough_evidence, or "
                            "out_of_scope, or not_source_grounded. supported, "
                            "partially_supported, and contradicted claims must cite "
                            "evidence_ordinals that point to strictly_citable evidence. "
                            "Contradicted claims must include both "
                            "supporting_evidence_ordinals and contradicting_evidence_ordinals. "
                            "Mark supported only when the evidence directly supports the whole claim."
                        ),
                    ),
                    Turn(
                        role="user",
                        content=json.dumps(verifier_request, ensure_ascii=True),
                    ),
                ],
                max_tokens=min(8000, max(1200, len(claim_payload) * 160)),
                temperature=0,
                reasoning_effort="none",
                prompt_cache_key=None,
            ),
            resolved_key.api_key,
            timeout_s=int(LLM_TIMEOUT_SECONDS),
        )
        classified_claims = _parse_claim_verifier_response(
            response.text,
            claim_count=len(claim_payload),
            evidence_count=len(evidence_payload),
        )
        claim_statuses = []
        for item in classified_claims:
            candidate = claim_candidates[item["ordinal"]]
            start = item["answer_start_offset"]
            end = item["answer_end_offset"]
            if (
                start != candidate.start
                or end != candidate.end
                or assistant_content[start:end] != candidate.text
            ):
                raise ValueError("claim verifier returned offsets that do not match the draft")
            claim_statuses.append(
                {
                    **item,
                    "text": candidate.text,
                    "verifier_status": "llm_verified",
                }
            )
        verifier_status = "llm_verified"
        metadata = {
            "verifier": "llm_claim_classifier",
            "provider": model.provider,
            "model_name": model.model_name,
            "limited_no_model": False,
            "draft_claim_count": len(claim_candidates),
            "classified_claim_count": len(classified_claims),
            "evidence_count": len(evidence_rows),
            "evidence_count_sent": len(evidence_payload),
            "source_backed": True,
            "source_manifest": verifier_request["source_manifest"],
            "scope_constraints": verifier_request["scope_constraints"],
            "claim_statuses": claim_statuses,
            "supported_claims": [
                {
                    "text": claim_candidates[item["ordinal"]].text,
                    "evidence_ordinals": item["evidence_ordinals"],
                }
                for item in classified_claims
                if item["support_status"] == "supported" and item["evidence_ordinals"]
            ],
        }
    except (LLMError, ValueError) as exc:
        logger.warning(
            "chat.claim_verifier.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                error_class=exc.__class__.__name__,
            ),
        )
        verifier_status = "parse_failed"
        metadata = {
            "verifier": "llm_claim_classifier",
            "provider": model.provider,
            "model_name": model.model_name,
            "draft_claim_count": len(claim_candidates),
            "evidence_count": len(evidence_rows),
            "claim_statuses": _failed_claim_statuses(
                claim_candidates,
                unsupported_reason="claim verifier failed before returning a complete classification",
            ),
            "source_backed": True,
            "error_class": exc.__class__.__name__,
        }

    claim_statuses = [item for item in metadata.get("claim_statuses", []) if isinstance(item, dict)]
    draft_claim_statuses = [dict(item) for item in claim_statuses]
    support_like_statuses = {"supported", "partially_supported"}
    cite_required_statuses = {"supported", "partially_supported", "contradicted"}
    for item in claim_statuses:
        if item.get("support_status") not in cite_required_statuses:
            continue
        evidence_ordinals = item.get("evidence_ordinals")
        if not isinstance(evidence_ordinals, list) or not evidence_ordinals:
            item["support_status"] = "not_enough_evidence"
            item["evidence_ordinals"] = []
            item["unsupported_reason"] = item.get("unsupported_reason") or (
                "claim verifier returned no citeable evidence"
            )
            continue
        if any(
            not isinstance(index, int)
            or index < 0
            or index >= len(evidence_payload)
            or evidence_payload[index].get("strictly_citable") is not True
            for index in evidence_ordinals
        ):
            item["support_status"] = "not_enough_evidence"
            item["evidence_ordinals"] = []
            item["unsupported_reason"] = item.get("unsupported_reason") or (
                "supporting evidence is missing a locator, source version, or snippet"
            )
    unsupported_count = sum(
        1
        for item in claim_statuses
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    )
    verified_content = assistant_content
    removed_claim_count = 0
    rewrote_answer = False
    removed_claim_statuses: list[dict[str, Any]] = []
    supported_items: list[dict[str, Any]] = []
    unsupported_items: list[dict[str, Any]] = []
    trustworthy_offsets = True
    for item in claim_statuses:
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        text_value = item.get("text")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or not isinstance(text_value, str)
            or start < 0
            or end <= start
            or end > len(assistant_content)
            or assistant_content[start:end] != text_value
        ):
            trustworthy_offsets = False
            break
        if item.get("support_status") in support_like_statuses and item.get("evidence_ordinals"):
            supported_items.append(item)
        else:
            unsupported_items.append(item)
    if trustworthy_offsets:
        removed_claim_statuses = [dict(item) for item in unsupported_items]

    if trustworthy_offsets and supported_items:
        verified_content = "\n\n".join(str(item["text"]).strip() for item in supported_items)
    if not trustworthy_offsets or not supported_items or not verified_content:
        verified_content = VERIFICATION_FAILURE_CONTENT
        supported_items = []

    answer_claim_statuses = []
    for ordinal, item in enumerate(supported_items):
        text_value = cast(str, item["text"]).strip()
        start = sum(
            len(str(previous["text"]).strip()) + 2 for previous in supported_items[:ordinal]
        )
        next_item = {**item}
        next_item["text"] = text_value
        next_item["ordinal"] = ordinal
        next_item["answer_start_offset"] = start
        next_item["answer_end_offset"] = start + len(text_value)
        answer_claim_statuses.append(next_item)
    removed_claim_count = unsupported_count
    rewrote_answer = verified_content != assistant_content

    if removed_claim_count and not removed_claim_statuses:
        removed_claim_statuses = [
            dict(item)
            for item in draft_claim_statuses
            if item.get("support_status") not in support_like_statuses
            or not item.get("evidence_ordinals")
        ]
    final_claim_statuses = [*answer_claim_statuses]
    for item in removed_claim_statuses:
        next_item = {**item}
        next_item["ordinal"] = len(final_claim_statuses)
        next_item["answer_start_offset"] = None
        next_item["answer_end_offset"] = None
        next_item["claim_kind"] = "insufficient_evidence"
        final_claim_statuses.append(next_item)
    metadata["claim_statuses"] = final_claim_statuses
    metadata["answer_claim_statuses"] = answer_claim_statuses
    metadata["draft_claim_statuses"] = draft_claim_statuses
    metadata["removed_claim_statuses"] = removed_claim_statuses
    metadata["unsupported_claim_statuses"] = [
        dict(item)
        for item in draft_claim_statuses
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    ]
    metadata["draft_unsupported_claim_count"] = unsupported_count
    metadata["final_unsupported_claim_count"] = sum(
        1
        for item in metadata["claim_statuses"]
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    )
    metadata["unsupported_claim_count"] = unsupported_count
    metadata["removed_claim_count"] = removed_claim_count
    metadata["rewrote_answer"] = rewrote_answer
    verifier_hint = {
        "verifier_name": verifier_name,
        "verifier_version": "v1",
        "verifier_status": verifier_status,
        "metadata": metadata,
    }
    return verified_content, verifier_hint


async def _extract_claim_candidates(
    *,
    generate: Any,
    model: Model,
    resolved_key: ResolvedKey,
    assistant_content: str,
) -> list[ClaimCandidate]:
    response = await cast(Any, generate)(
        model.provider,
        LLMRequest(
            model_name=model.model_name,
            messages=[
                Turn(
                    role="system",
                    content=(
                        "Extract every atomic factual claim from the answer. "
                        "Split compound sentences into separately verifiable claims. "
                        "Return only JSON with a claims array. Each item must include "
                        "text, answer_start_offset, and answer_end_offset. Offsets must "
                        "point to the exact substring in answer_draft. Do not add claims "
                        "that are questions, instructions, caveats, or purely conversational text."
                    ),
                ),
                Turn(
                    role="user",
                    content=json.dumps(
                        {"answer_draft": assistant_content},
                        ensure_ascii=True,
                    ),
                ),
            ],
            max_tokens=min(8000, max(1200, len(assistant_content) // 2)),
            temperature=0,
            reasoning_effort="none",
            prompt_cache_key=None,
        ),
        resolved_key.api_key,
        timeout_s=int(LLM_TIMEOUT_SECONDS),
    )
    return _parse_claim_extractor_response(response.text, assistant_content=assistant_content)


def _parse_claim_extractor_response(
    raw_response: str,
    *,
    assistant_content: str,
) -> list[ClaimCandidate]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("claims"), list):
        raise ValueError("claim extractor response must be an object with a claims array")

    claims: list[ClaimCandidate] = []
    seen_ranges: set[tuple[int, int]] = set()
    for item in parsed["claims"]:
        if not isinstance(item, dict):
            raise ValueError("claim extractor item must be an object")
        text_value = item.get("text")
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        if (
            not isinstance(text_value, str)
            or not text_value.strip()
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or end <= start
            or end > len(assistant_content)
        ):
            raise ValueError("claim extractor item has invalid text or offsets")
        if assistant_content[start:end] != text_value:
            raise ValueError("claim extractor offsets do not match the answer draft")
        claim_range = (start, end)
        if claim_range in seen_ranges:
            raise ValueError("claim extractor returned duplicate offsets")
        seen_ranges.add(claim_range)
        claims.append(ClaimCandidate(text_value, start, end))
    return sorted(claims, key=lambda claim: (claim.start or 0, claim.end or 0))


def _parse_claim_verifier_response(
    raw_response: str,
    *,
    claim_count: int,
    evidence_count: int,
) -> list[dict[str, Any]]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("claims"), list):
        raise ValueError("claim verifier response must be an object with a claims array")

    statuses = {
        "supported",
        "partially_supported",
        "contradicted",
        "not_enough_evidence",
        "out_of_scope",
        "not_source_grounded",
    }
    classified_claims: list[dict[str, Any]] = []
    seen_ordinals: set[int] = set()
    for item in parsed["claims"]:
        if not isinstance(item, dict):
            raise ValueError("claim verifier item must be an object")
        ordinal = item.get("ordinal")
        support_status = item.get("support_status")
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        evidence_ordinals = item.get("evidence_ordinals", [])
        supporting_evidence_ordinals = item.get("supporting_evidence_ordinals", [])
        contradicting_evidence_ordinals = item.get("contradicting_evidence_ordinals", [])
        context_evidence_ordinals = item.get("context_evidence_ordinals", [])
        if not isinstance(ordinal, int) or ordinal < 0 or ordinal >= claim_count:
            raise ValueError("claim verifier ordinal is out of range")
        if ordinal in seen_ordinals:
            raise ValueError("claim verifier duplicate ordinal")
        if support_status not in statuses:
            raise ValueError("claim verifier support_status is invalid")
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start:
            raise ValueError("claim verifier answer offsets are invalid")
        ordinal_lists = [
            evidence_ordinals,
            supporting_evidence_ordinals,
            contradicting_evidence_ordinals,
            context_evidence_ordinals,
        ]
        if any(
            not isinstance(values, list)
            or any(
                not isinstance(index, int) or index < 0 or index >= evidence_count
                for index in values
            )
            for values in ordinal_lists
        ):
            raise ValueError("claim verifier evidence ordinal is out of range")
        if not evidence_ordinals:
            evidence_ordinals = [
                *supporting_evidence_ordinals,
                *contradicting_evidence_ordinals,
                *context_evidence_ordinals,
            ]
        if (
            support_status in {"supported", "partially_supported"}
            and not supporting_evidence_ordinals
        ):
            supporting_evidence_ordinals = list(evidence_ordinals)
        if support_status == "contradicted" and (
            not supporting_evidence_ordinals or not contradicting_evidence_ordinals
        ):
            raise ValueError(
                "claim verifier contradicted item missing support or conflict evidence"
            )
        if (
            support_status
            in {
                "supported",
                "partially_supported",
                "contradicted",
            }
            and not evidence_ordinals
        ):
            raise ValueError(
                "claim verifier supported, partial, or contradicted item missing evidence"
            )
        seen_ordinals.add(ordinal)
        claim = {
            "ordinal": ordinal,
            "answer_start_offset": start,
            "answer_end_offset": end,
            "support_status": support_status,
            "evidence_ordinals": sorted(set(evidence_ordinals)),
            "supporting_evidence_ordinals": sorted(set(supporting_evidence_ordinals)),
            "contradicting_evidence_ordinals": sorted(set(contradicting_evidence_ordinals)),
            "context_evidence_ordinals": sorted(set(context_evidence_ordinals)),
        }
        unsupported_reason = item.get("unsupported_reason")
        if isinstance(unsupported_reason, str) and unsupported_reason.strip():
            claim["unsupported_reason"] = unsupported_reason.strip()
        elif support_status in {
            "not_enough_evidence",
            "out_of_scope",
            "not_source_grounded",
        }:
            raise ValueError("claim verifier unsupported item missing unsupported_reason")
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            claim["confidence"] = max(0.0, min(float(confidence), 1.0))
        classified_claims.append(claim)

    if len(seen_ordinals) != claim_count:
        raise ValueError("claim verifier did not classify every claim")
    return sorted(classified_claims, key=lambda item: item["ordinal"])


def _finalize_run(
    db: Session,
    *,
    run_id: UUID,
    assistant_content: str,
    assistant_status: str,
    run_status: str,
    done_status: str,
    error_code: str | None,
    model: Model | None,
    resolved_key: ResolvedKey | None,
    key_mode: str,
    latency_ms: int,
    usage: LLMUsage | None,
    provider_request_id: str | None,
    viewer_id: UUID | None,
    verifier_hint: dict[str, Any] | None = None,
) -> None:
    run = (
        db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().first()
    )
    if run is None or run.status in TERMINAL_RUN_STATUSES:
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
        assistant_message.updated_at = datetime.now(UTC)
        if assistant_status == "complete":
            _persist_artifact_deltas_for_message(db, run=run, assistant_message=assistant_message)
            claim_events, claim_evidence_events = _finalize_message_evidence(
                db,
                run,
                assistant_message,
                verifier_hint,
            )
            assistant_message.message_document = _message_document_with_run_components(
                db,
                run_id=run.id,
                role="assistant",
                content=content,
            )
            for claim_event in claim_events:
                append_run_event(db, run, "claim", claim_event)
            for claim_evidence_event in claim_evidence_events:
                append_run_event(db, run, "claim_evidence", claim_evidence_event)
        else:
            assistant_message.message_document = _message_document_with_run_components(
                db,
                run_id=run.id,
                role="assistant",
                content=content,
            )

    key = resolved_key or (model and _dummy_resolved_key(model))
    if assistant_message is not None and model is not None and key is not None:
        existing_llm = db.get(MessageLLM, assistant_message.id)
        target = existing_llm or MessageLLM(message_id=assistant_message.id)
        tokens = _usage_tokens(usage)
        prompt_plan_version, stable_prefix_hash = _prompt_assembly_metadata(db, run_id=run.id)
        target.provider = model.provider
        target.model_name = model.model_name
        target.input_tokens = tokens["input_tokens"]
        target.output_tokens = tokens["output_tokens"]
        target.total_tokens = tokens["total_tokens"]
        target.reasoning_tokens = tokens["reasoning_tokens"]
        target.cache_write_input_tokens = tokens["cache_write_input_tokens"]
        target.cache_read_input_tokens = tokens["cache_read_input_tokens"]
        target.cached_input_tokens = tokens["cached_input_tokens"]
        target.key_mode_requested = key_mode
        target.key_mode_used = key.mode
        target.latency_ms = latency_ms
        target.error_class = error_code if assistant_status == "error" else None
        target.provider_request_id = provider_request_id
        target.prompt_version = PROMPT_VERSION
        target.prompt_plan_version = prompt_plan_version
        target.stable_prefix_hash = stable_prefix_hash
        target.provider_usage = _usage_provider_json(usage)
        if existing_llm is None:
            db.add(target)

        if key.mode == "byok":
            if assistant_status == "complete":
                update_user_key_status(db, key.user_key_id, "valid")
            elif error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                update_user_key_status(db, key.user_key_id, "invalid")

    run.status = run_status
    run.error_code = error_code
    run.completed_at = datetime.now(UTC)
    run.updated_at = datetime.now(UTC)
    done_payload: dict[str, Any] = {"status": done_status}
    if error_code is not None:
        done_payload["error_code"] = error_code
    if assistant_message is not None and done_status == "complete":
        done_payload["final_chars"] = len(assistant_message.content)
    append_run_event(db, run, "done", done_payload)
    db.commit()


def _message_prompt_evidence_rows(
    db: Session,
    run: ChatRun,
    assistant_message: Message,
    *,
    reconcile_inclusion: bool = True,
) -> tuple[UUID | None, list[dict[str, Any]]]:
    assembly_row = db.execute(
        text(
            """
            SELECT id, included_retrieval_ids
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run.id},
    ).first()
    prompt_assembly_id = assembly_row[0] if assembly_row is not None else None
    included_retrieval_ids = {
        str(retrieval_id) for retrieval_id in (assembly_row[1] if assembly_row else [])
    }
    if reconcile_inclusion:
        for retrieval_id in included_retrieval_ids:
            db.execute(
                text(
                    """
                    UPDATE message_retrievals
                    SET included_in_prompt = true,
                        retrieval_status = CASE
                            WHEN result_type = 'web_result' THEN 'web_result'
                            ELSE 'included_in_prompt'
                        END
                    WHERE id = :retrieval_id
                    """
                ),
                {"retrieval_id": retrieval_id},
            )

    retrieval_rows = db.execute(
        text(
            """
            SELECT mr.id,
                   mr.result_type,
                   mr.source_id,
                   mr.media_id,
                   mr.context_ref,
                   mr.result_ref,
                   mr.deep_link,
                   mr.score,
                   mr.selected,
                   mr.source_title,
                   mr.exact_snippet,
                   mr.snippet_prefix,
                   mr.snippet_suffix,
                   mr.locator,
                   mr.retrieval_status,
                   mr.included_in_prompt,
                   mr.source_version,
                   mr.evidence_span_id
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
              AND mr.selected = true
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message.id},
    ).fetchall()

    evidence_rows: list[dict[str, Any]] = []
    for row in retrieval_rows:
        if str(row[0]) not in included_retrieval_ids:
            continue
        if not isinstance(row[4], dict) or not isinstance(row[5], dict):
            continue
        try:
            context_ref = retrieval_context_ref_json(row[4])
            result_ref = retrieval_result_ref_json(row[5])
            locator = retrieval_locator_json(row[13]) if isinstance(row[13], dict) else None
        except ValidationError:
            continue
        if result_ref.get("type") != row[1]:
            continue
        snippet = row[10] or result_ref.get("snippet")
        if not isinstance(snippet, str) or not snippet.strip():
            continue
        source_version = row[16]
        if not isinstance(source_version, str) or not source_version.strip():
            continue
        if locator is None:
            continue
        result_source_version = result_ref.get("source_version")
        if not isinstance(result_source_version, str) or result_source_version != source_version:
            continue
        result_locator = result_ref.get("locator")
        if not isinstance(result_locator, dict) or result_locator != locator:
            continue
        result_context_ref = result_ref.get("context_ref")
        if (
            not isinstance(result_context_ref, dict)
            or result_context_ref.get("type") != context_ref["type"]
        ):
            continue
        if (
            row[3] is not None
            and row[17] is not None
            and not _canonical_evidence_span_matches(
                db,
                viewer_id=run.owner_user_id,
                media_id=row[3],
                evidence_span_id=row[17],
                source_version=source_version,
                locator=locator,
                exact_snippet=snippet,
            )
        ):
            continue
        retrieval_status = row[14]
        if row[1] == "web_result":
            retrieval_status = "web_result"
        else:
            retrieval_status = "included_in_prompt"
        source_ref = {
            "type": "message_retrieval",
            "id": str(row[0]),
            "retrieval_id": str(row[0]),
            "label": row[9] or result_ref.get("title") or result_ref.get("source_label"),
            "context_ref": context_ref,
            "result_ref": result_ref,
            "deep_link": row[6],
            "source_version": source_version,
        }
        if row[3] is not None:
            source_ref["media_id"] = str(row[3])
        if row[17] is not None:
            source_ref["evidence_span_id"] = str(row[17])
        evidence_rows.append(
            {
                "retrieval_id": row[0],
                "evidence_span_id": row[17],
                "source_ref": source_ref,
                "context_ref": context_ref,
                "result_ref": result_ref,
                "exact_snippet": snippet.strip(),
                "snippet_prefix": row[11],
                "snippet_suffix": row[12],
                "locator": locator,
                "deep_link": row[6],
                "score": row[7],
                "retrieval_status": retrieval_status,
                "selected": bool(row[8]),
                "included_in_prompt": True,
                "source_version": source_version,
            }
        )
    context_rows = db.execute(
        text(
            """
            SELECT id,
                   context_kind,
                   object_type,
                   object_id,
                   source_media_id,
                   locator_json,
                   context_snapshot
            FROM message_context_items
            WHERE message_id = :user_message_id
            ORDER BY ordinal ASC, id ASC
            """
        ),
        {"user_message_id": run.user_message_id},
    ).fetchall()
    for row in context_rows:
        try:
            snapshot = trusted_context_snapshot(row[6])
        except ValueError:
            continue
        locator = row[5] if isinstance(row[5], dict) else snapshot.get("locator")
        if not isinstance(locator, dict):
            continue
        try:
            locator = retrieval_locator_json(locator)
        except ValidationError:
            continue
        if locator is None:
            continue
        source_version = snapshot.get("source_version")
        if not isinstance(source_version, str) or not source_version.strip():
            continue
        evidence_span_ids = context_evidence_span_ids(snapshot)
        context_ref: dict[str, object]
        if row[1] == "reader_selection":
            if snapshot.get("evidence_verification") != "source_text_exact_match_v1":
                continue
            snippet = snapshot.get("exact")
            if not isinstance(snippet, str) or not snippet.strip():
                continue
            if row[4] is None:
                continue
            context_ref = {
                "type": "media",
                "id": str(row[4]),
            }
        else:
            if row[2] is None or row[3] is None:
                continue
            context_ref = {"type": str(row[2]), "id": str(row[3])}
            if str(row[2]) == "content_chunk" and evidence_span_ids:
                context_ref["evidence_span_ids"] = [
                    str(evidence_span_id) for evidence_span_id in evidence_span_ids
                ]
            lookup = hydrate_context_ref(
                db,
                viewer_id=run.owner_user_id,
                context_ref=context_ref,
            )
            if not lookup.resolved or not lookup.evidence_text.strip():
                continue
            snippet = lookup.evidence_text
        try:
            context_ref = retrieval_context_ref_json(context_ref)
        except ValidationError:
            continue
        evidence_span_id = evidence_span_ids[0] if evidence_span_ids else None
        if (
            row[4] is not None
            and evidence_span_id is not None
            and not _canonical_evidence_span_matches(
                db,
                viewer_id=run.owner_user_id,
                media_id=row[4],
                evidence_span_id=evidence_span_id,
                source_version=source_version,
                locator=locator,
                exact_snippet=snippet,
            )
        ):
            continue
        source_ref = {
            "type": "message_context",
            "id": str(row[0]),
            "message_context_id": str(row[0]),
            "label": snapshot.get("title") or snapshot.get("media_title") or row[2] or row[1],
            "context_ref": context_ref,
            "source_version": source_version,
        }
        if row[4] is not None:
            source_ref["media_id"] = str(row[4])
        evidence_rows.append(
            {
                "retrieval_id": None,
                "evidence_span_id": evidence_span_id,
                "source_ref": source_ref,
                "context_ref": context_ref,
                "result_ref": None,
                "exact_snippet": snippet.strip(),
                "snippet_prefix": snapshot.get("prefix")
                if isinstance(snapshot.get("prefix"), str)
                else None,
                "snippet_suffix": snapshot.get("suffix")
                if isinstance(snapshot.get("suffix"), str)
                else None,
                "locator": locator,
                "deep_link": snapshot.get("route")
                if isinstance(snapshot.get("route"), str)
                else None,
                "score": None,
                "retrieval_status": "attached_context",
                "selected": True,
                "included_in_prompt": True,
                "source_version": source_version,
            }
        )
    return prompt_assembly_id, evidence_rows


def _canonical_evidence_span_matches(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
    source_version: str,
    locator: dict[str, Any],
    exact_snippet: str,
) -> bool:
    try:
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            evidence_span_id=evidence_span_id,
        )
        resolver = resolution.get("resolver")
        if not isinstance(resolver, dict) or resolver.get("status") != "resolved":
            return False
        if resolution.get("source_version") != source_version:
            return False
        canonical_locator = _locator_from_evidence_resolution(
            resolution,
            media_id=media_id,
            existing_locator=locator,
        )
    except (AssertionError, NotFoundError, ValueError, ValidationError):
        return False

    return canonical_locator == locator and _snippet_matches_canonical_span(
        exact_snippet,
        str(resolution.get("span_text") or ""),
    )


def _locator_from_evidence_resolution(
    resolution: dict[str, Any],
    *,
    media_id: UUID,
    existing_locator: dict[str, Any],
) -> dict[str, Any]:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict):
        raise AssertionError("Resolved evidence is missing resolver")
    selector = resolver.get("selector")
    if not isinstance(selector, dict):
        raise AssertionError("Resolved evidence is missing selector")

    raw_quote = selector.get("text_quote")
    quote = raw_quote if isinstance(raw_quote, dict) else {}
    exact = str(quote.get("exact") or resolution.get("span_text") or "")
    prefix = quote.get("prefix") if isinstance(quote.get("prefix"), str) else None
    suffix = quote.get("suffix") if isinstance(quote.get("suffix"), str) else None
    quote_selector = {"exact": exact, "prefix": prefix, "suffix": suffix}

    kind = resolver.get("kind")
    if kind == "web":
        locator: dict[str, Any] = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "text_quote_selector": quote_selector,
        }
        _copy_existing_locator_string(existing_locator, locator, "media_kind")
    elif kind == "epub":
        locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(media_id),
            "section_id": selector.get("section_id")
            if isinstance(selector.get("section_id"), str)
            else None,
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "text_quote_selector": quote_selector,
        }
        _copy_existing_locator_string(existing_locator, locator, "media_kind")
    elif kind == "pdf":
        raw_geometry = selector.get("geometry")
        geometry = raw_geometry if isinstance(raw_geometry, dict) else {}
        locator = {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": selector.get("page_number"),
            "quads": geometry.get("quads") if isinstance(geometry.get("quads"), list) else [],
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
            "text_quote_selector": quote_selector,
        }
    elif kind == "transcript":
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": selector.get("t_start_ms"),
            "t_end_ms": selector.get("t_end_ms"),
            "text_quote_selector": quote_selector,
        }
        if isinstance(existing_locator.get("transcript_version_id"), str):
            _copy_existing_locator_string(existing_locator, locator, "transcript_version_id")
    else:
        raise AssertionError("Resolved evidence has unsupported resolver kind")

    validated = retrieval_locator_json(locator)
    if validated is None:
        raise AssertionError("Resolved evidence locator is required")
    return validated


def _copy_existing_locator_string(
    source: dict[str, Any],
    target: dict[str, Any],
    key: str,
) -> None:
    value = source.get(key)
    if isinstance(value, str):
        target[key] = value


def _snippet_matches_canonical_span(snippet: str, canonical_span: str) -> bool:
    snippet_text = _normalized_evidence_text(snippet)
    canonical_text = _normalized_evidence_text(canonical_span)
    if not snippet_text or not canonical_text:
        return False
    return (
        snippet_text == canonical_text
        or snippet_text in canonical_text
        or canonical_text in snippet_text
    )


def _normalized_evidence_text(value: str) -> str:
    stripped = re.sub(r"</?b>", "", value)
    stripped = stripped.replace("...", " ")
    return " ".join(stripped.split())


def _finalize_message_evidence(
    db: Session,
    run: ChatRun,
    assistant_message: Message,
    verifier_hint: dict[str, Any] | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    db.execute(
        text(
            """
            DELETE FROM assistant_message_claim_evidence
            WHERE claim_id IN (
                SELECT id
                FROM assistant_message_claims
                WHERE message_id = :message_id
            )
            """
        ),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_claims WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_evidence_summaries WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )

    conversation = db.get(Conversation, run.conversation_id)
    scope_type = conversation.scope_type if conversation is not None else "general"
    scope_ref: dict[str, object] | None = None
    if conversation is not None and scope_type == "media" and conversation.scope_media_id:
        scope_ref = {"type": "media", "media_id": str(conversation.scope_media_id)}
    elif conversation is not None and scope_type == "library" and conversation.scope_library_id:
        scope_ref = {"type": "library", "library_id": str(conversation.scope_library_id)}

    prompt_assembly_id, evidence_rows = _message_prompt_evidence_rows(db, run, assistant_message)
    verifier_name = "source_evidence_gate"
    verifier_version = "v1"
    hinted_verifier_status = None
    verifier_metadata: dict[str, Any] = {
        "status_detail": "missing_verifier_hint",
    }
    if verifier_hint is not None:
        hint_name = verifier_hint.get("verifier_name")
        hint_version = verifier_hint.get("verifier_version")
        hint_status = verifier_hint.get("verifier_status")
        hint_metadata = verifier_hint.get("metadata")
        if isinstance(hint_name, str) and hint_name:
            verifier_name = hint_name
        if isinstance(hint_version, str) and hint_version:
            verifier_version = hint_version
        if hint_status in {"llm_verified", "parse_failed", "failed"}:
            hinted_verifier_status = hint_status
        if isinstance(hint_metadata, dict):
            verifier_metadata = {**verifier_metadata, **hint_metadata}

    answer = assistant_message.content.strip()
    source_backed = (
        _is_source_backed_run(
            db,
            run=run,
            assistant_message=assistant_message,
            evidence_rows=evidence_rows,
        )
        or verifier_metadata.get("source_backed") is True
    )
    claim_status_items = verifier_metadata.get("claim_statuses")
    claim_statuses = (
        claim_status_items
        if (
            hinted_verifier_status in {"llm_verified", "parse_failed", "failed"}
            and isinstance(claim_status_items, list)
        )
        else []
    )
    if evidence_rows or claim_statuses:
        verified_claims = []
        if claim_statuses:
            for item in claim_statuses:
                if not isinstance(item, dict):
                    continue
                text_value = item.get("text")
                support_status_value = item.get("support_status")
                evidence_ordinals = item.get("evidence_ordinals")
                if (
                    not isinstance(text_value, str)
                    or support_status_value
                    not in {
                        "supported",
                        "partially_supported",
                        "contradicted",
                        "not_enough_evidence",
                        "out_of_scope",
                        "not_source_grounded",
                    }
                    or not isinstance(evidence_ordinals, list)
                ):
                    continue

                answer_statuses = {"supported", "partially_supported"}
                cite_required_statuses = {"supported", "partially_supported", "contradicted"}
                indexes = [
                    index
                    for index in evidence_ordinals
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                support_indexes = [
                    index
                    for index in item.get("supporting_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                contradict_indexes = [
                    index
                    for index in item.get("contradicting_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                context_indexes = [
                    index
                    for index in item.get("context_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                if not (support_indexes or contradict_indexes or context_indexes):
                    if support_status_value in {"supported", "partially_supported"}:
                        support_indexes = indexes
                if not indexes:
                    indexes = sorted(set([*support_indexes, *contradict_indexes, *context_indexes]))
                unsupported_reason = item.get("unsupported_reason")
                if isinstance(unsupported_reason, str) and unsupported_reason.strip():
                    unsupported_reason = unsupported_reason.strip()
                else:
                    unsupported_reason = None
                confidence = item.get("confidence")
                if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
                    confidence = max(0.0, min(float(confidence), 1.0))
                else:
                    confidence = None

                if (
                    hinted_verifier_status != "llm_verified"
                    and support_status_value in cite_required_statuses
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason or "claim verifier did not complete successfully"
                    )
                if support_status_value in cite_required_statuses and not indexes:
                    support_status_value = "not_enough_evidence"
                    unsupported_reason = (
                        unsupported_reason or "claim verifier returned no citeable evidence"
                    )
                if (
                    support_status_value in {"supported", "partially_supported"}
                    and not support_indexes
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason or "claim verifier returned no supporting evidence"
                    )
                if support_status_value == "contradicted" and (
                    not support_indexes or not contradict_indexes
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason
                        or "claim verifier returned no supporting and conflicting evidence"
                    )

                evidence_for_claim = []
                if support_status_value in cite_required_statuses:
                    seen_indexes: set[tuple[str, int]] = set()
                    for role, role_indexes in (
                        ("supports", support_indexes),
                        ("contradicts", contradict_indexes),
                        ("context", context_indexes),
                    ):
                        for index in role_indexes:
                            if (role, index) in seen_indexes:
                                continue
                            seen_indexes.add((role, index))
                            evidence_for_claim.append(
                                {**evidence_rows[index], "_evidence_role": role}
                            )
                    if any(
                        not isinstance(row.get("locator"), dict)
                        or not row.get("locator")
                        or not isinstance(row.get("source_version"), str)
                        or not str(row.get("source_version")).strip()
                        or not isinstance(row.get("exact_snippet"), str)
                        or not str(row.get("exact_snippet")).strip()
                        for row in evidence_for_claim
                    ):
                        support_status_value = "not_enough_evidence"
                        evidence_for_claim = []
                        unsupported_reason = (
                            unsupported_reason
                            or "supporting evidence is missing a locator, source version, or snippet"
                        )

                verifier_status_value = item.get("verifier_status")
                if verifier_status_value not in {"llm_verified", "parse_failed", "failed"}:
                    verifier_status_value = (
                        "llm_verified" if hinted_verifier_status == "llm_verified" else "failed"
                    )

                start = item.get("answer_start_offset")
                end = item.get("answer_end_offset")
                if not (
                    isinstance(start, int)
                    and isinstance(end, int)
                    and start >= 0
                    and end > start
                    and assistant_message.content[start:end] == text_value
                ):
                    if support_status_value in answer_statuses:
                        support_status_value = "not_enough_evidence"
                        evidence_for_claim = []
                        unsupported_reason = (
                            unsupported_reason
                            or "claim verifier offsets did not match the final answer"
                        )
                        verifier_status_value = "failed"
                    start = None
                    end = None

                if support_status_value == "not_enough_evidence":
                    verifier_status_value = "failed"

                verified_claims.append(
                    VerifiedClaim(
                        ClaimCandidate(text_value, start, end),
                        support_status_value,
                        "answer"
                        if support_status_value in answer_statuses
                        else "insufficient_evidence",
                        verifier_status_value,
                        evidence_for_claim,
                        unsupported_reason=unsupported_reason,
                        confidence=confidence,
                    )
                )
        if not verified_claims:
            fallback_status = "not_enough_evidence" if source_backed else "not_source_grounded"
            verified_claims = [
                VerifiedClaim(
                    ClaimCandidate(
                        answer or "Assistant answer requires verification.",
                        None,
                        None,
                    ),
                    fallback_status,
                    "insufficient_evidence",
                    "failed",
                    [],
                    unsupported_reason=(
                        "source-backed answer had no complete verifier classification"
                        if source_backed
                        else "assistant answer was not grounded in retrieved or attached sources"
                    ),
                )
            ]
        retrieval_status = (
            "web_result"
            if evidence_rows
            and all(row["retrieval_status"] == "web_result" for row in evidence_rows)
            else "included_in_prompt"
            if evidence_rows
            else "retrieved"
        )
        claim_count = len(verified_claims)
        supported_count = sum(1 for claim in verified_claims if claim.support_status == "supported")
        unsupported_count = claim_count - supported_count
        not_enough_count = sum(
            1 for claim in verified_claims if claim.support_status == "not_enough_evidence"
        )
        contradicted_count = sum(
            1 for claim in verified_claims if claim.support_status == "contradicted"
        )
        partially_supported_count = sum(
            1 for claim in verified_claims if claim.support_status == "partially_supported"
        )
        out_of_scope_count = sum(
            1 for claim in verified_claims if claim.support_status == "out_of_scope"
        )
        not_source_grounded_count = sum(
            1 for claim in verified_claims if claim.support_status == "not_source_grounded"
        )
        verifier_metadata["support_status_counts"] = {
            "supported": supported_count,
            "partially_supported": partially_supported_count,
            "contradicted": contradicted_count,
            "not_enough_evidence": not_enough_count,
            "out_of_scope": out_of_scope_count,
            "not_source_grounded": not_source_grounded_count,
        }
        if supported_count == claim_count:
            support_status = "supported"
        elif supported_count > 0 or partially_supported_count > 0:
            support_status = "partially_supported"
        elif contradicted_count > 0:
            support_status = "contradicted"
        elif out_of_scope_count == claim_count:
            support_status = "out_of_scope"
        elif not_source_grounded_count == claim_count:
            support_status = "not_source_grounded"
        else:
            support_status = "not_enough_evidence"
        if hinted_verifier_status == "parse_failed":
            verifier_status = "parse_failed"
        elif hinted_verifier_status == "llm_verified" and (evidence_rows or not source_backed):
            verifier_status = "llm_verified"
        else:
            verifier_status = "failed"
    elif source_backed:
        verified_claims = [
            VerifiedClaim(
                ClaimCandidate(answer or "Not enough evidence in this scope.", None, None),
                "not_enough_evidence",
                "insufficient_evidence",
                "failed",
                [],
                unsupported_reason="source-backed answer had no selected evidence",
            )
        ]
        support_status = "not_enough_evidence"
        retrieval_status = "retrieved"
        claim_count = 1
        supported_count = 0
        unsupported_count = 1
        not_enough_count = 1
        verifier_status = "failed"
    else:
        verified_claims = [
            VerifiedClaim(
                ClaimCandidate(answer or "Assistant answer was not source-grounded.", None, None),
                "not_source_grounded",
                "insufficient_evidence",
                "failed",
                [],
                unsupported_reason="assistant answer was not grounded in retrieved or attached sources",
            )
        ]
        support_status = "not_source_grounded"
        retrieval_status = "retrieved"
        claim_count = 1
        supported_count = 0
        unsupported_count = 1
        not_enough_count = 0
        verifier_status = "failed"

    if "support_status_counts" not in verifier_metadata:
        verifier_metadata["support_status_counts"] = {
            "supported": sum(1 for claim in verified_claims if claim.support_status == "supported"),
            "partially_supported": sum(
                1 for claim in verified_claims if claim.support_status == "partially_supported"
            ),
            "contradicted": sum(
                1 for claim in verified_claims if claim.support_status == "contradicted"
            ),
            "not_enough_evidence": sum(
                1 for claim in verified_claims if claim.support_status == "not_enough_evidence"
            ),
            "out_of_scope": sum(
                1 for claim in verified_claims if claim.support_status == "out_of_scope"
            ),
            "not_source_grounded": sum(
                1 for claim in verified_claims if claim.support_status == "not_source_grounded"
            ),
        }

    verifier_metadata["claim_evidence_snapshot"] = [
        {
            "ordinal": ordinal,
            "claim_text": claim.candidate.text,
            "answer_start_offset": claim.candidate.start,
            "answer_end_offset": claim.candidate.end,
            "claim_kind": claim.claim_kind,
            "support_status": claim.support_status,
            "unsupported_reason": claim.unsupported_reason,
            "confidence": claim.confidence,
            "verifier_status": claim.verifier_status,
            "evidence": [
                {
                    "evidence_role": row.get("_evidence_role", claim.evidence_role),
                    "retrieval_id": str(row["retrieval_id"]) if row.get("retrieval_id") else None,
                    "evidence_span_id": str(row["evidence_span_id"])
                    if row.get("evidence_span_id")
                    else None,
                    "source_ref": row.get("source_ref"),
                    "context_ref": row.get("context_ref"),
                    "result_ref": row.get("result_ref"),
                    "exact_snippet": row.get("exact_snippet"),
                    "locator": row.get("locator"),
                    "deep_link": row.get("deep_link"),
                    "score": row.get("score"),
                    "retrieval_status": row.get("retrieval_status"),
                    "selected": row.get("selected"),
                    "included_in_prompt": row.get("included_in_prompt"),
                    "source_version": row.get("source_version"),
                }
                for row in claim.evidence_rows
            ],
        }
        for ordinal, claim in enumerate(verified_claims)
    ]

    verifier_run_row = db.execute(
        text(
            """
            INSERT INTO assistant_message_verifier_runs (
                message_id,
                chat_run_id,
                prompt_assembly_id,
                verifier_name,
                verifier_version,
                verifier_status,
                support_status,
                claim_count,
                supported_claim_count,
                unsupported_claim_count,
                not_enough_evidence_count,
                metadata
            )
            VALUES (
                :message_id,
                :chat_run_id,
                :prompt_assembly_id,
                :verifier_name,
                :verifier_version,
                :verifier_status,
                :support_status,
                :claim_count,
                :supported_claim_count,
                :unsupported_claim_count,
                :not_enough_evidence_count,
                :metadata
            )
            RETURNING id
            """
        ).bindparams(bindparam("metadata", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "chat_run_id": run.id,
            "prompt_assembly_id": prompt_assembly_id,
            "verifier_name": verifier_name,
            "verifier_version": verifier_version,
            "verifier_status": verifier_status,
            "support_status": support_status,
            "claim_count": claim_count,
            "supported_claim_count": supported_count,
            "unsupported_claim_count": unsupported_count,
            "not_enough_evidence_count": not_enough_count,
            "metadata": verifier_metadata,
        },
    ).one()
    verifier_run_id = verifier_run_row[0]

    db.execute(
        text(
            """
            INSERT INTO assistant_message_evidence_summaries (
                message_id,
                scope_type,
                scope_ref,
                retrieval_status,
                support_status,
                verifier_status,
                verifier_run_id,
                claim_count,
                supported_claim_count,
                unsupported_claim_count,
                not_enough_evidence_count,
                prompt_assembly_id
            )
            VALUES (
                :message_id,
                :scope_type,
                :scope_ref,
                :retrieval_status,
                :support_status,
                :verifier_status,
                :verifier_run_id,
                :claim_count,
                :supported_claim_count,
                :unsupported_claim_count,
                :not_enough_evidence_count,
                :prompt_assembly_id
            )
            """
        ).bindparams(bindparam("scope_ref", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "scope_type": scope_type,
            "scope_ref": scope_ref,
            "retrieval_status": retrieval_status,
            "support_status": support_status,
            "verifier_run_id": verifier_run_id,
            "claim_count": claim_count,
            "supported_claim_count": supported_count,
            "unsupported_claim_count": unsupported_count,
            "not_enough_evidence_count": not_enough_count,
            "prompt_assembly_id": prompt_assembly_id,
            "verifier_status": verifier_status,
        },
    )

    if claim_count == 0:
        _persist_message_citation_audit(
            db,
            run=run,
            assistant_message=assistant_message,
            verifier_run_id=verifier_run_id,
        )
        return [], []

    insert_claim = text(
        """
        INSERT INTO assistant_message_claims (
            message_id,
            ordinal,
            claim_text,
            answer_start_offset,
            answer_end_offset,
            claim_kind,
            support_status,
            unsupported_reason,
            confidence,
            verifier_status,
            verifier_run_id
        )
        VALUES (
            :message_id,
            :ordinal,
            :claim_text,
            :answer_start_offset,
            :answer_end_offset,
            :claim_kind,
            :support_status,
            :unsupported_reason,
            :confidence,
            :verifier_status,
            :verifier_run_id
        )
        RETURNING id, created_at
        """
    )

    insert_evidence = text(
        """
        INSERT INTO assistant_message_claim_evidence (
            claim_id,
            ordinal,
            evidence_role,
            source_ref,
            retrieval_id,
            evidence_span_id,
            context_ref,
            result_ref,
            exact_snippet,
            snippet_prefix,
            snippet_suffix,
            locator,
            deep_link,
            score,
            retrieval_status,
            selected,
            included_in_prompt,
            source_version
        )
        VALUES (
            :claim_id,
            :ordinal,
            :evidence_role,
            :source_ref,
            :retrieval_id,
            :evidence_span_id,
            :context_ref,
            :result_ref,
            :exact_snippet,
            :snippet_prefix,
            :snippet_suffix,
            :locator,
            :deep_link,
            :score,
            :retrieval_status,
            :selected,
            :included_in_prompt,
            :source_version
        )
        RETURNING id, created_at
        """
    ).bindparams(
        bindparam("source_ref", type_=JSONB),
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    claim_events: list[dict[str, object]] = []
    claim_evidence_events: list[dict[str, object]] = []
    for claim_ordinal, verified_claim in enumerate(verified_claims):
        claim = verified_claim.candidate
        claim_row = db.execute(
            insert_claim,
            {
                "message_id": assistant_message.id,
                "ordinal": claim_ordinal,
                "claim_text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "claim_kind": verified_claim.claim_kind,
                "support_status": verified_claim.support_status,
                "unsupported_reason": verified_claim.unsupported_reason,
                "confidence": verified_claim.confidence,
                "verifier_status": verified_claim.verifier_status,
                "verifier_run_id": verifier_run_id,
            },
        ).one()
        claim_id = claim_row[0]
        claim_events.append(
            {
                "id": str(claim_id),
                "message_id": str(assistant_message.id),
                "ordinal": claim_ordinal,
                "claim_text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "claim_kind": verified_claim.claim_kind,
                "support_status": verified_claim.support_status,
                "unsupported_reason": verified_claim.unsupported_reason,
                "confidence": verified_claim.confidence,
                "verifier_status": verified_claim.verifier_status,
                "verifier_run_id": str(verifier_run_id),
                "created_at": claim_row[1].isoformat(),
            }
        )
        for evidence_ordinal, row in enumerate(verified_claim.evidence_rows):
            evidence_role = row.get("_evidence_role")
            if evidence_role not in {"supports", "contradicts", "context", "scope_boundary"}:
                evidence_role = verified_claim.evidence_role
            clean_row = {key: value for key, value in row.items() if key != "_evidence_role"}
            evidence_row = db.execute(
                insert_evidence,
                {
                    "claim_id": claim_id,
                    "ordinal": evidence_ordinal,
                    "evidence_role": evidence_role,
                    **clean_row,
                },
            ).one()
            claim_evidence_events.append(
                {
                    "id": str(evidence_row[0]),
                    "claim_id": str(claim_id),
                    "ordinal": evidence_ordinal,
                    "evidence_role": evidence_role,
                    "source_ref": clean_row["source_ref"],
                    "retrieval_id": str(clean_row["retrieval_id"])
                    if clean_row.get("retrieval_id")
                    else None,
                    "evidence_span_id": str(clean_row["evidence_span_id"])
                    if clean_row.get("evidence_span_id")
                    else None,
                    "context_ref": clean_row.get("context_ref"),
                    "result_ref": clean_row.get("result_ref"),
                    "exact_snippet": clean_row.get("exact_snippet"),
                    "snippet_prefix": clean_row.get("snippet_prefix"),
                    "snippet_suffix": clean_row.get("snippet_suffix"),
                    "locator": clean_row.get("locator"),
                    "deep_link": clean_row.get("deep_link"),
                    "score": clean_row.get("score"),
                    "retrieval_status": clean_row.get("retrieval_status"),
                    "selected": clean_row.get("selected"),
                    "included_in_prompt": clean_row.get("included_in_prompt"),
                    "source_version": clean_row.get("source_version"),
                    "created_at": evidence_row[1].isoformat(),
                }
            )
    _persist_message_citation_audit(
        db,
        run=run,
        assistant_message=assistant_message,
        verifier_run_id=verifier_run_id,
    )
    return claim_events, claim_evidence_events


def _persist_message_citation_audit(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message,
    verifier_run_id: UUID,
) -> None:
    rows = db.execute(
        text(
            """
            SELECT c.id AS claim_id,
                   c.ordinal AS claim_ordinal,
                   c.claim_text,
                   c.answer_start_offset,
                   c.answer_end_offset,
                   c.support_status,
                   e.id AS evidence_id,
                   e.evidence_role,
                   e.locator,
                   e.source_version,
                   e.exact_snippet
            FROM assistant_message_claims c
            LEFT JOIN assistant_message_claim_evidence e ON e.claim_id = c.id
            WHERE c.message_id = :message_id
              AND c.verifier_run_id = :verifier_run_id
            ORDER BY c.ordinal ASC, e.ordinal ASC
            """
        ),
        {"message_id": assistant_message.id, "verifier_run_id": verifier_run_id},
    ).mappings()

    supported_claims: dict[UUID, dict[str, object]] = {}
    supported_claim_evidence: dict[UUID, int] = {}
    contradiction_pairs: list[dict[str, object]] = []
    missing_locator_evidence_ids: list[str] = []
    missing_source_version_evidence_ids: list[str] = []
    missing_snippet_evidence_ids: list[str] = []
    partially_supported_claim_ids: list[str] = []
    contradicted_claim_ids: list[str] = []
    for row in rows:
        claim_id = row["claim_id"]
        if row["support_status"] in {"supported", "partially_supported"}:
            supported_claims[claim_id] = {
                "id": claim_id,
                "ordinal": row["claim_ordinal"],
                "claim_text": row["claim_text"],
                "answer_start_offset": row["answer_start_offset"],
                "answer_end_offset": row["answer_end_offset"],
            }
        evidence_id = row["evidence_id"]
        if evidence_id is None:
            continue
        if row["support_status"] == "partially_supported":
            partially_supported_claim_ids.append(str(claim_id))
        if row["support_status"] == "contradicted":
            contradicted_claim_ids.append(str(claim_id))
        if (
            row["support_status"] in {"supported", "partially_supported"}
            and row["evidence_role"] == "supports"
        ):
            supported_claim_evidence[claim_id] = supported_claim_evidence.get(claim_id, 0) + 1
        if row["support_status"] == "contradicted" and row["evidence_role"] == "contradicts":
            contradiction_pairs.append(
                {
                    "claim_id": str(claim_id),
                    "claim_ordinal": row["claim_ordinal"],
                    "evidence_id": str(evidence_id),
                }
            )
        locator = row["locator"]
        if not isinstance(locator, dict) or not locator:
            missing_locator_evidence_ids.append(str(evidence_id))
        source_version = row["source_version"]
        if not isinstance(source_version, str) or not source_version.strip():
            missing_source_version_evidence_ids.append(str(evidence_id))
        exact_snippet = row["exact_snippet"]
        if row["evidence_role"] in {"supports", "contradicts"} and (
            not isinstance(exact_snippet, str) or not exact_snippet.strip()
        ):
            missing_snippet_evidence_ids.append(str(evidence_id))

    invalid_offset_claim_ids: list[str] = []
    missing_citation_claim_ids: list[str] = []
    valid_offset_count = 0
    citation_count = 0
    for claim_id, claim in supported_claims.items():
        has_valid_offset = _claim_has_valid_answer_offsets(assistant_message.content, claim)
        if has_valid_offset:
            valid_offset_count += 1
        else:
            invalid_offset_claim_ids.append(str(claim_id))
        if has_valid_offset and supported_claim_evidence.get(claim_id, 0) > 0:
            citation_count += 1
        else:
            missing_citation_claim_ids.append(str(claim_id))

    supported_claim_count = len(supported_claims)
    details = {
        "invalid_offset_claim_ids": invalid_offset_claim_ids[:20],
        "missing_citation_claim_ids": missing_citation_claim_ids[:20],
        "missing_locator_evidence_ids": missing_locator_evidence_ids[:20],
        "missing_source_version_evidence_ids": missing_source_version_evidence_ids[:20],
        "missing_snippet_count": len(missing_snippet_evidence_ids),
        "missing_snippet_evidence_ids": missing_snippet_evidence_ids[:20],
        "partially_supported_claim_ids": sorted(set(partially_supported_claim_ids))[:20],
        "contradicted_claim_ids": sorted(set(contradicted_claim_ids))[:20],
        "contradiction_pairs": contradiction_pairs[:20],
    }
    details = {key: value for key, value in details.items() if value}

    db.execute(
        text(
            """
            INSERT INTO assistant_message_citation_audits (
                message_id,
                chat_run_id,
                verifier_run_id,
                supported_claim_count,
                supported_claims_with_valid_offsets_count,
                supported_claims_with_citation_count,
                missing_locator_count,
                missing_source_version_count,
                supported_claims_have_valid_offsets,
                supported_claims_have_citation_placement,
                claim_evidence_has_required_locators,
                claim_evidence_has_source_versions,
                details
            )
            VALUES (
                :message_id,
                :chat_run_id,
                :verifier_run_id,
                :supported_claim_count,
                :supported_claims_with_valid_offsets_count,
                :supported_claims_with_citation_count,
                :missing_locator_count,
                :missing_source_version_count,
                :supported_claims_have_valid_offsets,
                :supported_claims_have_citation_placement,
                :claim_evidence_has_required_locators,
                :claim_evidence_has_source_versions,
                :details
            )
            """
        ).bindparams(bindparam("details", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "chat_run_id": run.id,
            "verifier_run_id": verifier_run_id,
            "supported_claim_count": supported_claim_count,
            "supported_claims_with_valid_offsets_count": valid_offset_count,
            "supported_claims_with_citation_count": citation_count,
            "missing_locator_count": len(missing_locator_evidence_ids),
            "missing_source_version_count": len(missing_source_version_evidence_ids),
            "supported_claims_have_valid_offsets": valid_offset_count == supported_claim_count,
            "supported_claims_have_citation_placement": citation_count == supported_claim_count,
            "claim_evidence_has_required_locators": not missing_locator_evidence_ids,
            "claim_evidence_has_source_versions": not missing_source_version_evidence_ids,
            "details": details,
        },
    )


def _claim_has_valid_answer_offsets(answer: str, claim: dict[str, object]) -> bool:
    start = claim.get("answer_start_offset")
    end = claim.get("answer_end_offset")
    text_value = claim.get("claim_text")
    if not isinstance(start, int) or not isinstance(end, int) or not isinstance(text_value, str):
        return False
    if start < 0 or end <= start or end > len(answer):
        return False
    return answer[start:end].strip() == text_value.strip()


def _dummy_resolved_key(model: Model) -> ResolvedKey:
    return ResolvedKey(api_key="", mode="platform", provider=model.provider, user_key_id=None)


def _validate_context_visibility(db: Session, viewer_id: UUID, ctx: ContextItem) -> None:
    if ctx.kind == "reader_selection":
        media = db.get(Media, ctx.media_id)
        if media is None or not can_read_media(db, viewer_id, ctx.media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "media":
        media = db.get(Media, ctx.id)
        if media is None or not can_read_media(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "highlight":
        if not can_read_highlight(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    hydrate_object_ref(db, viewer_id, ObjectRef(object_type=ctx.type, object_id=ctx.id))
    if ctx.type == "content_chunk" and ctx.evidence_span_ids:
        validate_content_chunk_evidence_span_ids(db, ctx.id, ctx.evidence_span_ids)


def _validate_parent_anchor_for_existing_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
) -> None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    parent = _load_valid_parent_for_send(
        db,
        conversation_id=conversation_id,
        parent_message_id=parent_message_id,
    )
    branch_anchor_for_message(parent, branch_anchor)


def _load_valid_parent_for_send(
    db: Session,
    *,
    conversation_id: UUID,
    parent_message_id: UUID | None,
) -> Message | None:
    if parent_message_id is None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "Existing conversations require parent_message_id",
        )
    parent = db.get(Message, parent_message_id)
    if parent is None or parent.conversation_id != conversation_id:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Parent message not found")
    if parent.role != "assistant" or parent.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "parent_message_id must point to a complete assistant message",
        )
    return parent
