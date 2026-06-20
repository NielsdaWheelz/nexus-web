"""Finalize chat runs: persist the assistant message, key-status feedback, done event."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.errors import ApiErrorCode
from nexus.schemas.conversation import chat_run_event_payload_json
from nexus.services import run_kit
from nexus.services.api_key_resolver import ResolvedKey, update_user_key_status
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
    finalize_error(db, run_id=run.id, error_code=ApiErrorCode.E_LLM_INTERRUPTED.value)


def finalize_cancelled(
    db: Session,
    run: ChatRun,
    resolved_key: ResolvedKey | None,
    *,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
) -> None:
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
