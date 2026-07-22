"""Finalize chat runs: persist the assistant message, run terminal facts, done event."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import ChatRun, Message
from nexus.schemas.conversation import chat_run_event_payload_json
from nexus.services import run_kit
from nexus.services.chat_run_event_store import TERMINAL_RUN_STATUSES
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.llm_ledger import terminalize_defect

MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"


def finalize_cancelled(
    db: Session,
    run: ChatRun,
    *,
    assistant_content: str = "",
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
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
    )


def finalize_defect(
    db: Session, *, run_id: UUID, error_detail: str | None = None, commit: bool = True
) -> str:
    """Finalize a run as a generic defect: no closed §10 code, no error_origin —
    just a fresh support_id for operator correlation (chat_failure.py: "a
    defect exposes no failure variant ... generic, non-rerunnable card").

    Used for entitlement-precheck denial (no llm_calls row exists at all — it
    is not in the §9/§10 ExpectedModelFailure taxonomy) and for any unhandled
    exception reaching the chat-run worker boundary. Returns the support_id.
    """
    support_id = uuid4().hex[:12]
    finalize_run(
        db,
        run_id=run_id,
        assistant_content="",
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=None,
        error_origin=None,
        support_id=support_id,
        error_detail=error_detail,
        commit=commit,
    )
    return support_id


def finalize_interrupted(
    db: Session, run: ChatRun, *, session_factory: sessionmaker[Session]
) -> None:
    """Crashed/interrupted recovery: the worker died mid-stream after provider
    output was observed but before a terminal event arrived
    (``has_provider_output_without_terminal``). Terminalizes the crashed
    llm_calls row (if any is still open) as
    {outcome=failed, origin=provider_stream, code=stream_interrupted}, then
    folds the SAME pair onto the run — a rerunnable variant, not a defect.
    """
    generation_id = db.execute(
        text(
            "SELECT id FROM llm_calls WHERE owner_kind = 'chat_run' AND owner_id = :run_id "
            "AND outcome IS NULL ORDER BY call_seq DESC LIMIT 1"
        ),
        {"run_id": run.id},
    ).scalar_one_or_none()
    support_id = generation_id.hex[:12] if generation_id is not None else None
    if generation_id is not None:
        terminalize_defect(
            session_factory,
            generation_id=generation_id,
            origin="provider_stream",
            code="stream_interrupted",
            detail="worker crashed with provider output observed but no terminal event",
        )
    finalize_run(
        db,
        run_id=run.id,
        assistant_content="",
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code="stream_interrupted",
        error_origin="provider_stream",
        support_id=support_id,
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
    error_detail: str | None = None,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
    cancelled: bool | None = None,
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
