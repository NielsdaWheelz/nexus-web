"""Finalize chat runs: persist assistant message, MessageLLM usage, and the done event."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from llm_calling.types import LLMUsage
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message, MessageLLM, Model
from nexus.errors import ApiErrorCode
from nexus.services.api_key_resolver import ResolvedKey, update_user_key_status
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES, append_run_event
from nexus.services.chat_run_evidence import finalize_message_evidence
from nexus.services.chat_run_message_blocks import message_document_with_run_components
from nexus.services.chat_run_prompt_tracking import prompt_assembly_metadata
from nexus.services.chat_run_usage import usage_provider_json, usage_tokens
from nexus.services.context_rendering import PROMPT_VERSION

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
    "E_CONTEXT_TOO_LARGE": "One selected context is too large or unavailable. Remove it and try again.",
    "E_APP_SEARCH_FAILED": "The scoped content search failed. Please try again.",
    "E_CANCELLED": "Request cancelled.",
    "E_TOKEN_BUDGET_EXCEEDED": "Monthly AI token quota exceeded.",
}


def dummy_resolved_key(model: Model) -> ResolvedKey:
    return ResolvedKey(api_key="", mode="platform", provider=model.provider, user_key_id=None)


def finalize_error(
    db: Session,
    *,
    run_id: UUID,
    error_code: str,
    viewer_id: UUID | None,
    model: Model | None = None,
    resolved_key: ResolvedKey | None = None,
    key_mode: str = "auto",
    latency_ms: int = 0,
    usage: LLMUsage | None = None,
    provider_request_id: str | None = None,
    assistant_content: str | None = None,
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
        model=model,
        resolved_key=resolved_key,
        key_mode=key_mode,
        latency_ms=latency_ms,
        usage=usage,
        provider_request_id=provider_request_id,
        viewer_id=viewer_id,
    )


def finalize_interrupted(db: Session, run: ChatRun) -> None:
    model = db.get(Model, run.model_id)
    finalize_error(
        db,
        run_id=run.id,
        error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
        viewer_id=run.owner_user_id,
        model=model,
        resolved_key=dummy_resolved_key(model) if model is not None else None,
        key_mode=run.key_mode,
    )


def finalize_cancelled(
    db: Session,
    run: ChatRun,
    model: Model,
    resolved_key: ResolvedKey | None,
    latency_ms: int,
) -> None:
    finalize_run(
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


def finalize_run(
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
            claim_events, claim_evidence_events = finalize_message_evidence(
                db,
                run,
                assistant_message,
                verifier_hint,
            )
            assistant_message.message_document = message_document_with_run_components(
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
            assistant_message.message_document = message_document_with_run_components(
                db,
                run_id=run.id,
                role="assistant",
                content=content,
            )

    key = resolved_key or (model and dummy_resolved_key(model))
    if assistant_message is not None and model is not None and key is not None:
        existing_llm = db.get(MessageLLM, assistant_message.id)
        target = existing_llm or MessageLLM(message_id=assistant_message.id)
        tokens = usage_tokens(usage)
        prompt_plan_version, stable_prefix_hash = prompt_assembly_metadata(db, run_id=run.id)
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
        target.provider_usage = usage_provider_json(usage)
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
