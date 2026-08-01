"""Finalize chat runs: persist the assistant message, run terminal facts, done event."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.schemas.conversation import (
    chat_publication_warning_from_nullable,
    chat_run_event_payload_json,
)
from nexus.schemas.presence import presence_from_nullable
from nexus.services import run_kit
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_message_blocks import message_document

MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"


def finalize_cancelled(
    db: Session,
    run: ChatRun,
    *,
    assistant_content: str = "",
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
    commit: bool = True,
) -> None:
    """Finalize a run cancelled by explicit user request. ``ChatRun`` carries no
    error_code for this status — run status ``cancelled`` alone drives the
    cancelled failure variant (schemas/llm.py `CancelledChatFailure`)."""
    finalize_run(
        db,
        run_id=run.id,
        assistant_content=assistant_content,
        assistant_status="cancelled",
        run_status="cancelled",
        done_status="cancelled",
        error_code=None,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
        cancelled=True,
        commit=commit,
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
    error_origin: str | None = None,
    support_id: str | None = None,
    publication_warning_code: Literal["CitationsUnavailable"] | None = None,
    error_detail: str | None = None,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
    cancelled: bool = False,
    commit: bool = True,
) -> None:
    """Finalize a run's terminal status.

    ``error_code``/``error_origin`` are the closed §10 codes chat_failure.py
    projects from (or ``None`` for a defect — no card, generic status +
    support_id). Written exactly once here, the sole terminal fold.
    """
    run = (
        db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().first()
    )
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        if commit:
            db.commit()
        return

    # justify-service-invariant-check: finalize_run is the shared terminal fold
    # for several distinct call sites, so the warning/run/support correlation
    # cannot be represented by one parameter type without introducing a second
    # terminal state machine.
    if publication_warning_code is not None and (
        publication_warning_code != "CitationsUnavailable"
        or assistant_status != "complete"
        or run_status != "complete"
        or done_status != "complete"
        or error_code is not None
        or support_id is None
    ):
        raise AssertionError(
            "publication warning requires a complete degraded run, no error code, and a support id"
        )
    if publication_warning_code is None and run_status == "complete" and support_id is not None:
        raise AssertionError("an ordinary published run cannot carry a support id")

    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is not None:
        content = assistant_content
        if assistant_status == "complete" and len(content) > MAX_ASSISTANT_CONTENT_LENGTH:
            content = content[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE
        assistant_message.content = content
        assistant_message.status = assistant_status
        assistant_message.updated_at = func.now()
        assistant_message.message_document = message_document("assistant", content)

    run.error_origin = error_origin
    run.support_id = support_id
    run.publication_warning_code = publication_warning_code

    done_payload: dict[str, Any] = {
        "status": done_status,
        "error_code": presence_from_nullable(error_code),
        "support_id": presence_from_nullable(support_id),
        "publication_warning": chat_publication_warning_from_nullable(publication_warning_code),
        "usage": usage,
        "final_chars": (
            len(assistant_message.content)
            if assistant_message is not None and done_status == "complete"
            else None
        ),
        "last_provider_event_seq": last_provider_event_seq,
        "cancelled": cancelled,
    }
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
