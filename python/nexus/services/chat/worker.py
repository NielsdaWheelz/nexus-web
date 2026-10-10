"""The chat job: run the run's one generation, stream it, publish it. Nothing replays.

An attempt that finds its run's generation already started knows an earlier attempt
died, and ends the run ``interrupted`` (``cancelled`` when a stop was asked). Streamed
frames commit on a worker thread, each in its own session, so a slow write stalls
neither the generation's loop (its stop poll, claim check and deadline) nor the
model's event stream.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import ChatRunAssistantTextDeltaEventPayload
from nexus.services.chat import citations, events, reads
from nexus.services.generation.contract import (
    Cancelled,
    Event,
    GenerationIntent,
    Owner,
    Succeeded,
    TextDelta,
    Tools,
)
from nexus.services.generation.contract import text as text_output
from nexus.services.generation.ledger import generation_exists, interrupt_job_generations
from nexus.services.generation.run import generate
from nexus.services.generation.runtime import Runtime, run_generation_job
from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

logger = get_logger(__name__)

FLUSH_SECONDS = 0.033
FLUSH_CHARS = 512
FLUSH_BYTES = 2048


def chat_run(run_id: str, *, context: JobExecutionContext) -> None:
    """The ``chat_run`` job; a defect escapes into the queue's retry."""

    async def work(db: Session, runtime: Runtime) -> None:
        job = get_job(db, context.job_id)
        if job is None or str(job.payload.get("run_id")) != run_id:
            raise AssertionError("claimed chat job does not match its run payload")
        set_flow_id(run_id)
        try:
            await _execute(db, UUID(run_id), context, runtime)
        except Exception as error:
            db.rollback()
            logger.error(
                "chat_run.attempt_failed",
                run_id=run_id,
                job_id=str(context.job_id),
                error_type=type(error).__name__,
            )
            raise
        finally:
            set_flow_id(None)

    run_generation_job("chat_run", context, work)


def on_dead_letter(db: Session, job: JobRow) -> None:
    """A dead job ends its run: ``cancelled`` if asked, else ``interrupted``."""

    run_id = UUID(str(job.payload["run_id"]))
    interrupt_job_generations(db, job_id=job.id, detail="its chat job died")
    # The queue holds the job row: never wait on a run a cancel has locked (run -> job).
    # That cancel finds this dead job once the transition commits, and ends the run.
    run = db.scalar(
        select(ChatRun)
        .where(ChatRun.id == run_id)
        .execution_options(populate_existing=True)
        .with_for_update(skip_locked=True)
    )
    if run is not None:
        events.finalize_dead(db, run)
    logger.warning(
        "chat_run_dead_lettered",
        run_id=str(run_id),
        job_id=str(job.id),
        attempts=job.attempts,
        error_code=job.error_code,
    )


async def _execute(
    db: Session, run_id: UUID, context: JobExecutionContext, runtime: Runtime
) -> None:
    # Before the generation: one locked transaction decides whether it runs at all.
    run = events.lock_run(db, run_id)
    if run is None or run.status in events.TERMINAL:
        db.commit()
        return
    if generation_exists(db, kind="chat_run", id=run_id):
        # An earlier attempt died after starting it; this attempt's start closed it.
        events.finalize_dead(db, run)
        db.commit()
        return
    if run.cancel_requested_at is not None:
        events.finalize(db, run, status="cancelled", content="")
        db.commit()
        return
    run.status = "running"
    run.started_at = run.started_at or func.now()
    spec = reads.spec(run)
    intent = GenerationIntent.model_validate(run.generation_intent)
    owner = Owner("chat_run", run_id, run.owner_user_id, context)
    db.commit()

    def write(chunk: str) -> None:
        frame = ChatRunAssistantTextDeltaEventPayload(text=chunk)
        events.append_live(runtime.session_factory, run_id, frame, context)

    streamed = _Text(write)

    async def on_event(event: Event) -> None:
        if isinstance(event, TextDelta):
            streamed.add(event.text)
        else:
            await streamed.flush()  # text before a tool call lands before the call's frames

    try:
        terminal = await generate(
            runtime,
            owner=owner,
            operation="chat",
            selection=spec.selection,
            intent=intent,
            decode=text_output,
            tools=Tools(
                cast(str, spec.tool_plan),  # admission always freezes a plan
                frozenset(spec.tool_scope),
                ChatToolExecutionProjection(run_id),
            ),
            on_event=on_event,
            stop=lambda session: events.cancel_requested(session, run_id),
        )
        await streamed.flush()
    finally:
        streamed.close()
    # After it: lock the run, then the claim, and fold the outcome once.
    usage = terminal.usage.model_dump(mode="json") if terminal.usage else None
    run = events.lock_run(db, run_id)
    if run is None:  # deleted mid-generation, together with its job
        db.commit()
        return
    events.fence(db, context)
    if isinstance(terminal, Cancelled) or run.cancel_requested_at is not None:
        content = terminal.value if isinstance(terminal, Succeeded) else terminal.partial_text
        events.finalize(db, run, status="cancelled", content=content, usage=usage)
    elif isinstance(terminal, Succeeded):
        published = citations.publish(db, run, terminal.value)
        support_id = None
        if isinstance(published, citations.Degraded):
            support_id = uuid4().hex[:12]
            logger.warning(
                "chat_citations_degraded",
                chat_run_id=str(run_id),
                support_id=support_id,
                detail=published.detail,
            )
        events.finalize(
            db,
            run,
            status="complete",
            content=published.content,
            support_id=support_id,
            warning="CitationsUnavailable" if support_id else None,
            usage=usage,
        )
    else:
        events.finalize(
            db,
            run,
            status="error",
            content=terminal.partial_text,
            error_code=terminal.code,
            support_id=terminal.generation_id.hex[:12],
            usage=usage,
        )
    db.commit()


class _Text:
    """Streamed text to durable frames of at most 512 chars and 2048 bytes, in order.

    ``add`` never waits on the database: the model's event stream runs on a finite
    buffer, so a frame write that stalls must not stall it. Sealed frames queue in
    memory and one writer task commits them in order on a worker thread, gathering
    what arrives within 33 ms. ``flush`` returns once every frame is written; a failed
    write surfaces on the next add or flush.
    """

    def __init__(self, write: Callable[[str], None]) -> None:
        self._write = write
        self._frames: list[str] = []
        self._buffer = ""
        self._bytes = 0
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._writer: asyncio.Task[None] | None = None
        self._failure: Exception | None = None

    def add(self, chunk: str) -> None:
        self._raise_failure()
        for char in chunk:
            width = len(char.encode())
            if len(self._buffer) == FLUSH_CHARS or self._bytes + width > FLUSH_BYTES:
                self._seal()
            self._buffer += char
            self._bytes += width
        if self._writer is None:
            self._writer = asyncio.create_task(self._run())
        self._wake.set()

    async def flush(self) -> None:
        self._seal()
        await self._drain()
        self._raise_failure()

    def close(self) -> None:
        if self._writer is not None:
            self._writer.cancel()

    def _seal(self) -> None:
        if self._buffer:
            self._frames.append(self._buffer)
            self._buffer, self._bytes = "", 0

    async def _drain(self) -> None:
        async with self._lock:
            while self._frames and self._failure is None:
                frame = self._frames.pop(0)
                try:
                    await asyncio.to_thread(self._write, frame)
                except Exception as error:  # justify-ignore-error: raised by the next add or flush
                    self._failure = error

    async def _run(self) -> None:
        while self._failure is None:
            await self._wake.wait()
            self._wake.clear()
            await asyncio.sleep(FLUSH_SECONDS)
            self._seal()
            await self._drain()

    def _raise_failure(self) -> None:
        if self._failure is not None:
            raise RuntimeError("a streamed chat frame failed to commit") from self._failure
