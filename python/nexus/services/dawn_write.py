"""Dawn write generation service.

Assembles three content signals (yesterday's highlights, overnight Synapse
resonances, stale library dossiers) and generates a two-paragraph machine
morning brief for the user's daily note page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import DawnWrite
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    lock_job,
    lock_running_job_claim,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present, absent, present
from nexus.services import durable_step_journal as step_journal
from nexus.services import generation_policy
from nexus.services.artifacts.dossier_types import SubjectResource
from nexus.services.artifacts.engine import read_head
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationTerminal,
    NormalizedFailureCode,
    request_fingerprint,
)
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    CompletedGeneration,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationDispatchAborted,
    GenerationExecutionRequest,
    GenerationUncertain,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import outcome_failure_facts

logger = get_logger(__name__)

DAWN_WRITE_OPERATION = "dawn_write"
_CAPACITY_WAIT_DELAYS_SECONDS = (30, 60, 120, 300, 600)

_SYSTEM_PROMPT = """\
You are the dawn writer for a reading system. You have access to one user's
reading activity from yesterday. Write exactly two short paragraphs — no
headers, no lists, no markdown except paragraph breaks. Total ≤200 words.

Paragraph 1: what the reader engaged with yesterday — highlights made, their
text, the source titles. Be specific and concrete; quote brief phrases.

Paragraph 2: what the system noticed overnight — Synapse resonances (new
connections with rationales), stale library dossiers that need refresh.
If either category is empty, fold it into a single paragraph.

Rules:
1. Only state what the data contains. Do not invent, extrapolate, or recommend.
2. No "You highlighted…" preamble. Begin mid-sentence, as apparatus, not address.
3. No score, no rating, no count of items. Name things, not numbers.\
"""


@dataclass
class _HighlightSignal:
    exact: str
    media_title: str
    created_at: datetime


@dataclass
class _SynapseSignal:
    excerpt: str | None
    source_scheme: str
    target_scheme: str
    created_at: datetime


@dataclass
class _StaleLibrarySignal:
    name: str


@dataclass
class DawnWriteSignals:
    highlights: list[_HighlightSignal] = field(default_factory=list)
    synapse_edges: list[_SynapseSignal] = field(default_factory=list)
    stale_libraries: list[_StaleLibrarySignal] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.highlights and not self.synapse_edges and not self.stale_libraries


def _tz_midnight_utc(local_date: date, tz_name: str) -> datetime:
    """Return the UTC instant corresponding to midnight on *local_date* in *tz_name*.

    Falls back to UTC when the timezone name is unknown to the system.
    """
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
    local_midnight = datetime(local_date.year, local_date.month, local_date.day, tzinfo=tz)
    return local_midnight.astimezone(UTC)


def collect_signals(
    db: Session, *, user_id: UUID, local_date: date, tz: str
) -> DawnWriteSignals | None:
    """Query the three content signals for *user_id* relative to *local_date*.

    Returns None when all signals are empty (skip-generation sentinel).
    """
    today_utc = _tz_midnight_utc(local_date, tz)
    yesterday_utc = _tz_midnight_utc(local_date - timedelta(days=1), tz)

    # Signal A — yesterday's highlights.
    highlight_rows = db.execute(
        text(
            "SELECT h.exact, m.title AS media_title, h.created_at"
            " FROM highlights h"
            " JOIN media m ON m.id = h.anchor_media_id"
            " WHERE h.user_id = :uid"
            "   AND h.anchor_media_id IS NOT NULL"
            "   AND h.created_at >= :yesterday_start_utc"
            "   AND h.created_at <  :today_start_utc"
            " ORDER BY h.created_at"
            " LIMIT 10"
        ),
        {"uid": str(user_id), "yesterday_start_utc": yesterday_utc, "today_start_utc": today_utc},
    ).fetchall()

    highlights = [
        _HighlightSignal(exact=row.exact, media_title=row.media_title, created_at=row.created_at)
        for row in highlight_rows
    ]

    # Signal B — Synapse resonances since the prior account-local midnight.
    synapse_rows = db.execute(
        text(
            "SELECT re.snapshot, re.source_scheme, re.target_scheme, re.created_at"
            " FROM resource_edges re"
            " WHERE re.user_id = :uid"
            "   AND re.origin = 'synapse'"
            "   AND re.created_at >= :yesterday_start_utc"
            " ORDER BY re.created_at DESC"
            " LIMIT 5"
        ),
        {"uid": str(user_id), "yesterday_start_utc": yesterday_utc},
    ).fetchall()

    synapse_edges = [
        _SynapseSignal(
            excerpt=(row.snapshot or {}).get("excerpt") if row.snapshot else None,
            source_scheme=row.source_scheme,
            target_scheme=row.target_scheme,
            created_at=row.created_at,
        )
        for row in synapse_rows
    ]

    # Signal C — stale library dossiers.
    library_rows = db.execute(
        text(
            "SELECT DISTINCT lib.id AS library_id, lib.name"
            " FROM artifacts art"
            " JOIN libraries lib ON lib.id = art.subject_id"
            " JOIN memberships mem"
            "   ON mem.library_id = lib.id AND mem.user_id = :uid"
            " WHERE art.subject_scheme = 'library'"
            "   AND art.audience_scheme = 'library'"
            "   AND art.audience_id = art.subject_id::text"
            "   AND art.current_revision_id IS NOT NULL"
        ),
        {"uid": str(user_id)},
    ).fetchall()

    stale_libraries = [
        _StaleLibrarySignal(name=row.name)
        for row in library_rows
        if read_head(
            db,
            locator=SubjectResource(
                ref=ResourceRef(scheme="library", id=UUID(str(row.library_id)))
            ),
            requester_user_id=user_id,
        ).freshness
        == "stale"
    ]

    signals = DawnWriteSignals(
        highlights=highlights,
        synapse_edges=synapse_edges,
        stale_libraries=stale_libraries,
    )
    return None if signals.is_empty else signals


def _render_signals(signals: DawnWriteSignals) -> str:
    """Render the three signal categories as plain text for the model user turn."""
    parts: list[str] = []

    if signals.highlights:
        lines = ["HIGHLIGHTS FROM YESTERDAY:"]
        for h in signals.highlights:
            lines.append(f'  "{h.exact}" — {h.media_title}')
        parts.append("\n".join(lines))

    if signals.synapse_edges:
        lines = ["SYNAPSE RESONANCES (overnight):"]
        for e in signals.synapse_edges:
            excerpt = e.excerpt or "(no rationale)"
            lines.append(f"  {e.source_scheme} ↔ {e.target_scheme}: {excerpt}")
        parts.append("\n".join(lines))

    if signals.stale_libraries:
        lines = ["STALE LIBRARY DOSSIERS:"]
        for lib in signals.stale_libraries:
            lines.append(f"  {lib.name}")
        parts.append("\n".join(lines))

    return "\n\n".join(parts)


class _CompletedDawnWriteSuccess(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["success"] = "success"
    body_md: str


class _CompletedDawnWriteFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["failure"] = "failure"
    error_code: str
    error_detail: str | None = None


type _CompletedDawnWrite = Annotated[
    _CompletedDawnWriteSuccess | _CompletedDawnWriteFailure,
    Field(discriminator="outcome"),
]
_COMPLETED_DAWN_WRITE_ADAPTER: TypeAdapter[_CompletedDawnWrite] = TypeAdapter(_CompletedDawnWrite)


def _dawn_write_step_path(*, user_id: UUID, local_date: date) -> str:
    return f"generation/{user_id}/{local_date.isoformat()}"


def _dawn_write_command(*, generation_id: UUID, user_content: str) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "request_id": generation_id,
            "operation": {
                "kind": DAWN_WRITE_OPERATION,
                "revision": generation_policy.operation_revision(DAWN_WRITE_OPERATION),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": GenerationIntent(
                instructions=_SYSTEM_PROMPT,
                input=user_content,
                output=TextOutput(),
            ),
        }
    )


def _encode_dawn_write_terminal(
    terminal: GenerationTerminal,
) -> EncodedGenerationTerminal:
    accepted_failure: AcceptedGenerationFailure | None = None
    if terminal.status == "succeeded":
        body = terminal.final_text.strip()
        if body:
            completed: _CompletedDawnWrite = _CompletedDawnWriteSuccess(body_md=body)
        else:
            detail = "dawn write generation returned empty text"
            completed = _CompletedDawnWriteFailure(
                error_code="invalid_output",
                error_detail=detail,
            )
            accepted_failure = AcceptedGenerationFailure(
                code="invalid_output",
                detail=detail,
            )
    else:
        code, detail = outcome_failure_facts(terminal)
        completed = _CompletedDawnWriteFailure(
            error_code=code,
            error_detail=detail,
        )
    return EncodedGenerationTerminal(
        terminal_result=_COMPLETED_DAWN_WRITE_ADAPTER.dump_json(completed).decode("utf-8"),
        accepted_failure=accepted_failure,
    )


def _encode_dawn_write_preaccept_failure(
    code: NormalizedFailureCode,
    detail: str,
) -> str:
    return _COMPLETED_DAWN_WRITE_ADAPTER.dump_json(
        _CompletedDawnWriteFailure(error_code=code, error_detail=detail)
    ).decode("utf-8")


def _apply_completed_dawn_write(
    db: Session,
    *,
    generation_id: UUID,
    user_id: UUID,
    local_date: date,
    context: JobExecutionContext,
    completed: _CompletedDawnWrite,
) -> DawnWrite | None:
    if isinstance(completed, _CompletedDawnWriteFailure):
        db.commit()
        logger.warning(
            "dawn_write_llm_failure",
            user_id=str(user_id),
            error_code=completed.error_code,
        )
        return None

    def publish() -> DawnWrite | None:
        if not lock_running_job_claim(db, context=context):
            db.rollback()
            return None
        existing = db.scalar(
            select(DawnWrite)
            .where(
                DawnWrite.user_id == user_id,
                DawnWrite.local_date == local_date,
            )
            .with_for_update()
        )
        if existing is not None:
            db.commit()
            return existing
        row = DawnWrite(
            id=generation_id,
            user_id=user_id,
            local_date=local_date,
            body_md=completed.body_md,
        )
        db.add(row)
        db.commit()
        logger.info(
            "dawn_write_generated",
            user_id=str(user_id),
            local_date=str(local_date),
            write_id=str(row.id),
        )
        return row

    return retry_serializable(db, "dawn_write.publish", publish)


async def generate_dawn_write(
    db: Session,
    *,
    user_id: UUID,
    local_date: date,
    tz: str,
    context: JobExecutionContext,
    runtime: ExecutionRuntime,
) -> DawnWrite | None | RescheduleRequested:
    """Generate and persist a dawn write for *user_id* on *local_date*.

    Returns None when signals are empty (nothing to say), concurrency admission
    rejects the call, or generation does not succeed. Callers must check for an
    existing row before calling.
    """
    if not get_settings().dawn_write_enabled:
        logger.info("dawn_write_skipped", reason="disabled", user_id=str(user_id))
        return None

    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError(f"dawn write job {context.job_id} disappeared")
    if job.kind != "dawn_write_job":
        raise AssertionError("dawn write generation has the wrong job kind")
    capacity_wait_index = job.payload.get("capacity_wait_index")
    if type(capacity_wait_index) is not int or not 0 <= capacity_wait_index <= len(
        _CAPACITY_WAIT_DELAYS_SECONDS
    ):
        raise AssertionError("dawn write job has an invalid capacity_wait_index")
    step_path = _dawn_write_step_path(user_id=user_id, local_date=local_date)
    generation_id = step_journal.stable_generation_id(context.job_id, step_path)
    state = step_journal.read_step_states(job).get(step_path)
    if state is not None and state.generation_id != generation_id:
        raise AssertionError("dawn write generation identity changed")
    if state is not None and state.dispatch_phase is step_journal.Completed:
        if not isinstance(state.terminal_result, Present):
            raise AssertionError("Completed dawn write generation has no result")
        completed = _COMPLETED_DAWN_WRITE_ADAPTER.validate_json(state.terminal_result.value)
        return _apply_completed_dawn_write(
            db,
            generation_id=generation_id,
            user_id=user_id,
            local_date=local_date,
            context=context,
            completed=completed,
        )
    if state is not None and state.dispatch_phase is step_journal.Uncertain:
        db.commit()
        raise GenerationUncertain(
            f"dawn write generation {generation_id} has an unresolved dispatch"
        )

    signals = collect_signals(db, user_id=user_id, local_date=local_date, tz=tz)
    if signals is None:
        logger.info("dawn_write_skipped", reason="no_signals", user_id=str(user_id))
        return None

    user_content = _render_signals(signals)
    command = _dawn_write_command(
        generation_id=generation_id,
        user_content=user_content,
    )
    fingerprint = request_fingerprint(command)
    if state is None:
        if not step_journal.checkpoint_step_state(
            db,
            ctx=context,
            job=job,
            step_path=step_path,
            state=step_journal.StepReplayState(
                generation_id=generation_id,
                dispatch_phase=step_journal.Prepared,
                request_fingerprint=present(fingerprint),
                terminal_result=absent(),
            ),
        ):
            db.rollback()
            return None
        db.commit()
        job = get_job(db, context.job_id)
        if job is None:
            raise AssertionError(f"dawn write job {context.job_id} disappeared after prepare")
    elif not isinstance(state.request_fingerprint, Present):
        raise AssertionError("Prepared dawn write generation has no fingerprint")
    elif state.request_fingerprint.value != fingerprint:
        raise AssertionError("Prepared dawn write generation input changed")
    else:
        db.commit()

    rate_limiter = get_rate_limiter()
    try:
        rate_limiter.acquire_inflight_slot(user_id)
    except ApiError as exc:
        logger.info(
            "dawn_write_skipped",
            reason="llm_rejected",
            user_id=str(user_id),
            error=str(exc),
        )
        return None
    try:

        def lock_dispatch(dispatch_db: Session) -> JobRow | None:
            locked_job = lock_job(dispatch_db, context.job_id)
            if locked_job is None or locked_job.kind != "dawn_write_job":
                return None
            existing = dispatch_db.scalar(
                select(DawnWrite.id).where(
                    DawnWrite.user_id == user_id,
                    DawnWrite.local_date == local_date,
                )
            )
            return None if existing is not None else locked_job

        try:
            execution_result = await execute_generation(
                GenerationExecutionRequest(
                    owner=LlmCallOwner(kind="dawn_write", id=generation_id),
                    command=command,
                    journal=JobGenerationJournal(
                        context=context,
                        step_path=step_path,
                        capacity_wait_index=capacity_wait_index,
                        lock_dispatch=lock_dispatch,
                    ),
                    capacity_wait_index=capacity_wait_index,
                    capacity_wait_delays_seconds=_CAPACITY_WAIT_DELAYS_SECONDS,
                ),
                session_factory=get_session_factory(),
                runtime=runtime,
                encode_terminal=_encode_dawn_write_terminal,
                encode_preaccept_failure=_encode_dawn_write_preaccept_failure,
            )
        except GenerationDispatchAborted:
            return None
        if isinstance(execution_result, RescheduleRequested):
            return execution_result
        if not isinstance(execution_result, CompletedGeneration):
            raise AssertionError("dawn write generation result is not exhaustive")
        completed = _COMPLETED_DAWN_WRITE_ADAPTER.validate_json(execution_result.terminal_result)
        return _apply_completed_dawn_write(
            db,
            generation_id=generation_id,
            user_id=user_id,
            local_date=local_date,
            context=context,
            completed=completed,
        )
    finally:
        rate_limiter.release_inflight_slot(user_id)
