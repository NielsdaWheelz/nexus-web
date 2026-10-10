"""The chat worker: one claimed job runs its run's one generation, then publishes it.

Streamed text is coalesced into durable SSE frames; a stop is the generation's
own poll; publication is the final effect, taken under the run lock. Nothing is
replayed: a job attempt that finds its run's generation already started knows an
earlier attempt died and ends the run ``interrupted`` (or ``cancelled``).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Literal
from uuid import UUID, uuid4

from pydantic import JsonValue
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatPromptAssembly, ChatRun
from nexus.jobs.queue import JobExecutionContext, lock_running_job_claim
from nexus.logging import get_logger, set_flow_id
from nexus.services.chat_run_citations import DegradedCitations, publish_chat_citations
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    bounded_text_prefix,
    finalize_dead_run,
    finalize_run,
    is_cancel_requested,
    lock_chat_run_for_update,
    mark_running,
)
from nexus.services.generation.contract import (
    Cancelled,
    Event,
    GenerationIntent,
    GenerationSpec,
    Owner,
    Succeeded,
    TextDelta,
    Tools,
)
from nexus.services.generation.contract import text as text_output
from nexus.services.generation.ledger import generation_exists
from nexus.services.generation.run import generate
from nexus.services.generation.runtime import Runtime

logger = get_logger(__name__)

CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048


async def execute_chat_run(
    db: Session, *, run_id: UUID, context: JobExecutionContext, runtime: Runtime
) -> None:
    """Execute one claimed chat job; defects escape into queue recovery."""

    set_flow_id(str(run_id))
    try:
        await _execute(db, run_id=run_id, context=context, runtime=runtime)
    except Exception as error:
        db.rollback()
        logger.error(
            "chat_run.attempt_failed",
            run_id=str(run_id),
            job_id=str(context.job_id),
            error_type=type(error).__name__,
        )
        raise
    finally:
        set_flow_id(None)


async def _execute(
    db: Session, *, run_id: UUID, context: JobExecutionContext, runtime: Runtime
) -> None:
    from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

    run = db.get(ChatRun, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    if generation_exists(db, kind="chat_run", id=run.id):
        # An earlier attempt died after starting the generation (G1); this attempt's
        # start closed that generation, and nothing reruns it.
        locked = lock_chat_run_for_update(db, run.id)
        assert locked is not None
        finalize_dead_run(db, locked)
        db.commit()
        return
    mark_running(db, run.id)
    run = db.get(ChatRun, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    if is_cancel_requested(db, run.id):
        _finalize_cancelled(db, run=run, assistant_content="", usage=None, last_sequence=None)
        return
    spec = GenerationSpec.model_validate_json(json.dumps(run.generation_spec))
    assembly = db.scalar(select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id))
    if assembly is None or spec.tool_plan is None:
        raise AssertionError("chat run is missing its admitted prompt or tool plan")
    intent = GenerationIntent.model_validate(assembly.generation_intent)
    projection = ChatToolExecutionProjection(
        run_id=run.id, initial_citation_ordinal=_initial_citation_ordinal(db, run=run)
    )
    emitter = ChatRunEventEmitter(db, run, lease_fence=lambda: _fence(db, context))
    coalescer = _ChatTextCoalescer(emitter)
    sequence = 0

    async def on_event(event: Event) -> None:
        nonlocal sequence
        sequence += 1
        if isinstance(event, TextDelta):
            await coalescer.add(text=event.text, sequence=sequence)
            return
        await coalescer.flush()
        emitter.assistant_activity(
            phase="tool_calling", provider_event_seq_start=sequence, provider_event_seq_end=sequence
        )

    owner_user_id = run.owner_user_id
    db.commit()
    try:
        terminal = await generate(
            runtime,
            owner=Owner("chat_run", run_id, owner_user_id, context),
            operation="chat",
            selection=spec.selection,
            intent=intent,
            decode=text_output,
            tools=Tools(spec.tool_plan, frozenset(spec.tool_scope), projection),
            on_event=on_event,
            stop=lambda session: is_cancel_requested(session, run_id),
        )
    finally:
        await coalescer.flush()
    usage = None if terminal.usage is None else terminal.usage.model_dump(mode="json")
    last_sequence = sequence or None
    if isinstance(terminal, Succeeded):
        _publish(
            db,
            run=run,
            context=context,
            emitter=emitter,
            generated_markdown=terminal.value,
            usage=usage,
            last_sequence=last_sequence,
        )
        return
    # Publication order is run -> job everywhere: lock the run before deciding
    # between this terminal and a cancellation that raced it.
    locked = lock_chat_run_for_update(db, run_id)
    if locked is None:
        raise AssertionError("chat run disappeared before its terminal fold")
    if isinstance(terminal, Cancelled) or locked.cancel_requested_at is not None:
        _finalize_cancelled(
            db,
            run=locked,
            assistant_content=terminal.partial_text,
            usage=usage,
            last_sequence=last_sequence,
        )
        return
    finalize_run(
        db,
        run_id=run_id,
        status="error",
        assistant_content=terminal.partial_text,
        error_code=terminal.code,
        support_id=terminal.generation_id.hex[:12],
        usage=usage,
        last_provider_event_seq=last_sequence,
    )
    db.commit()


def _fence(db: Session, context: JobExecutionContext) -> None:
    """Lock this attempt's live claim into the caller's effect transaction."""

    if not lock_running_job_claim(db, context=context):
        db.rollback()
        raise RuntimeError(f"chat job {context.job_id} lost its claim")


def _publish(
    db: Session,
    *,
    run: ChatRun,
    context: JobExecutionContext,
    emitter: ChatRunEventEmitter,
    generated_markdown: str,
    usage: dict[str, JsonValue] | None,
    last_sequence: int | None,
) -> None:
    """Canonicalize citations and make the answer reader-visible, once."""

    # Lock the run before the queue claim so cancellation and every publication
    # effect share one global run -> job order.
    locked_run = lock_chat_run_for_update(db, run.id)
    if locked_run is None:
        raise AssertionError("chat run disappeared before publication")
    _fence(db, context)
    if locked_run.cancel_requested_at is not None:
        _finalize_cancelled(
            db,
            run=locked_run,
            assistant_content=generated_markdown,
            usage=usage,
            last_sequence=last_sequence,
        )
        return
    citations = publish_chat_citations(
        db, run=locked_run, generated_markdown=generated_markdown, emitter=emitter
    )
    support_id: str | None = None
    warning_code: Literal["CitationsUnavailable"] | None = None
    if isinstance(citations, DegradedCitations):
        support_id = uuid4().hex[:12]
        warning_code = citations.warning_code
        logger.warning(
            "chat_citations_degraded",
            chat_run_id=str(locked_run.id),
            support_id=support_id,
            detail=citations.detail,
        )
    finalize_run(
        db,
        run_id=locked_run.id,
        status="complete",
        assistant_content=citations.content_md,
        support_id=support_id,
        publication_warning_code=warning_code,
        usage=usage,
        last_provider_event_seq=last_sequence,
    )
    db.commit()


def _finalize_cancelled(
    db: Session,
    *,
    run: ChatRun,
    assistant_content: str,
    usage: dict[str, JsonValue] | None,
    last_sequence: int | None,
) -> None:
    """Keep whatever text arrived; ``cancelled`` alone drives the failure card."""

    finalize_run(
        db,
        run_id=run.id,
        status="cancelled",
        assistant_content=assistant_content,
        usage=usage,
        last_provider_event_seq=last_sequence,
    )
    db.commit()


def _initial_citation_ordinal(db: Session, *, run: ChatRun) -> int:
    """Recover the immutable attached-evidence cursor, excluding later tools."""

    value = db.scalar(
        text(
            """
            SELECT COALESCE(MAX(retrieval.citation_candidate_ordinal), 0) + 1
            FROM message_retrievals AS retrieval
            JOIN message_tool_calls AS tool_call ON tool_call.id = retrieval.tool_call_id
            WHERE tool_call.assistant_message_id = :assistant_message_id
              AND tool_call.tool_call_index = 0
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    )
    if type(value) is not int or value < 1:
        raise AssertionError("Chat attached citation cursor is invalid")
    return value


# =============================================================================


class _ChatTextCoalescer:
    """The one bounded host-frame to durable-SSE text fold.

    Frames flush at 512 chars, 2048 bytes, or 33 ms, whichever comes first.
    """

    def __init__(self, emitter: ChatRunEventEmitter) -> None:
        self._emitter = emitter
        self._text = ""
        self._sequence_start: int | None = None
        self._sequence_end: int | None = None
        self._timer: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None

    async def add(self, *, text: str, sequence: int) -> None:
        self._raise_if_failed()
        if not text:
            return
        remaining = text
        while remaining:
            prefix = bounded_text_prefix(
                remaining,
                max_chars=CHAT_TEXT_FLUSH_MAX_CHARS - len(self._text),
                max_bytes=CHAT_TEXT_FLUSH_MAX_BYTES - len(self._text.encode("utf-8")),
            )
            if not prefix:
                await self.flush()
                continue
            if self._sequence_start is None:
                self._sequence_start = sequence
            self._sequence_end = sequence
            self._text += prefix
            remaining = remaining[len(prefix) :]
            if (
                remaining
                or len(self._text) == CHAT_TEXT_FLUSH_MAX_CHARS
                or len(self._text.encode("utf-8")) == CHAT_TEXT_FLUSH_MAX_BYTES
            ):
                await self.flush()
        if self._text and self._timer is None:
            self._timer = asyncio.create_task(self._flush_after_interval())

    async def flush(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
            with suppress(asyncio.CancelledError):
                await timer
        self._raise_if_failed()
        self._flush_now()

    async def _flush_after_interval(self) -> None:
        try:
            await asyncio.sleep(CHAT_TEXT_FLUSH_INTERVAL_MS / 1_000)
            self._timer = None
            self._flush_now()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            self._failure = exc

    def _flush_now(self) -> None:
        if not self._text:
            return
        if self._sequence_start is None or self._sequence_end is None:
            raise AssertionError("buffered Chat text has no provider sequence")
        self._emitter.assistant_text_delta(
            text=self._text,
            provider_event_seq_start=self._sequence_start,
            provider_event_seq_end=self._sequence_end,
        )
        self._text = ""
        self._sequence_start = None
        self._sequence_end = None

    def _raise_if_failed(self) -> None:
        if self._failure is not None:
            raise RuntimeError("Chat SSE text flush failed") from self._failure
