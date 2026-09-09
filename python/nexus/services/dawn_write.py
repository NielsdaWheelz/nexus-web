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
    replace_dead_job_payload,
    requeue_dead_job,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present
from nexus.services import durable_step_journal as step_journal
from nexus.services import generation_policy
from nexus.services.artifacts.dossier_types import SubjectResource
from nexus.services.artifacts.engine import read_head
from nexus.services.codex_generation_contract import (
    GenerationTerminal,
)
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.generation_spec import ImmutablePromptPayloadRef, generation_fact_digest
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    CompletedGeneration,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationDispatchAborted,
    GenerationFailureCode,
    GenerationUncertain,
    GenerationUncertainResolution,
    JobGenerationJournal,
    admit_job_generation,
    cancel_prepared_generation_without_dispatch_in_current_transaction,
    codex_terminal_evidence,
    execute_generation,
    prove_uncertain_generation_not_dispatched_in_current_transaction,
)
from nexus.services.llm_ledger import LlmCallOwner, lock_generation_owner_in_current_transaction
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import outcome_failure_facts

logger = get_logger(__name__)

DAWN_WRITE_OPERATION = "dawn_write"
_DAWN_WRITE_WORKLIST_KEY = "dawn_write_worklist"

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


class _DawnWriteReconciliationWorkItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    user_id: UUID
    time_zone: str = Field(min_length=1)
    local_date: date


_DAWN_WRITE_RECONCILIATION_WORKLIST: TypeAdapter[tuple[_DawnWriteReconciliationWorkItem, ...]] = (
    TypeAdapter(tuple[_DawnWriteReconciliationWorkItem, ...])
)


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


def reconcile_uncertain_dawn_write_generation(
    db: Session,
    *,
    job_id: UUID,
    user_id: UUID,
    local_date: date,
    resolution: GenerationUncertainResolution,
) -> None:
    """Return one frozen dawn-write work item to Prepared and requeue its job.

    The sweep retains its frozen account/date worklist, but deliberately does
    not retain the raw highlights, Synapse edges, and dossier facts rendered
    into the prompt.  Those projections can change, so only an exact
    prove-not-dispatched recovery is safe here.
    """

    if not isinstance(resolution, step_journal.ProveNotDispatched):
        raise ValueError(
            "dawn write generation attachment requires durable rendered signals, which are absent"
        )
    step_path = _dawn_write_step_path(user_id=user_id, local_date=local_date)
    generation_id = step_journal.stable_generation_id(job_id, step_path)

    def op() -> None:
        owner = LlmCallOwner(kind="dawn_write", id=generation_id)
        # Canonical order: owner advisory lock, materialized daily write, job.
        lock_generation_owner_in_current_transaction(db, owner)
        db.scalar(
            select(DawnWrite.id)
            .where(DawnWrite.user_id == user_id, DawnWrite.local_date == local_date)
            .with_for_update()
        )
        job = lock_job(db, job_id)
        if job is None or job.kind != "dawn_write_job" or job.status != "dead":
            raise ValueError("dawn write has no matching suspended generation job")
        try:
            worklist = _DAWN_WRITE_RECONCILIATION_WORKLIST.validate_python(
                job.payload[_DAWN_WRITE_WORKLIST_KEY]
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise AssertionError("suspended dawn write job has no frozen worklist") from exc
        matches = [
            item for item in worklist if item.user_id == user_id and item.local_date == local_date
        ]
        if len(matches) != 1:
            raise ValueError("dawn write work item is not uniquely frozen in the suspended job")
        state = step_journal.read_step_states(job).get(step_path)
        if state is None or state.dispatch_phase is not step_journal.Uncertain:
            raise ValueError("dawn write generation is not uncertain")
        if state.generation_id != generation_id:
            raise AssertionError("dawn write reconciliation generation identity changed")
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("dawn write reconciliation has no request fingerprint")
        next_state = prove_uncertain_generation_not_dispatched_in_current_transaction(
            db,
            owner=owner,
            state=state,
        )
        payload = step_journal.payload_with_step_state(
            job.payload,
            step_path=step_path,
            state=next_state,
        )
        if not replace_dead_job_payload(db, job_id=job.id, payload=payload):
            raise AssertionError("suspended dawn write job changed while locked")
        if not requeue_dead_job(db, job_id=job.id):
            raise AssertionError("suspended dawn write job could not be requeued")
        db.commit()

    retry_serializable(db, "reconcile_uncertain_dawn_write_generation", op)


class _CompletedDawnWriteSuccess(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["success"] = "success"
    body_md: str


class _CompletedDawnWriteFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["failure"] = "failure"
    error_code: str
    error_detail: str | None = None


type DawnWriteSkipReason = Literal[
    "disabled",
    "no_signals",
    "llm_rejected",
    "already_exists",
    "signals_changed",
    "pre_dispatch_aborted",
]


class _CompletedDawnWriteSkipped(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    outcome: Literal["skipped"] = "skipped"
    reason: DawnWriteSkipReason


type _CompletedDawnWrite = Annotated[
    _CompletedDawnWriteSuccess | _CompletedDawnWriteFailure | _CompletedDawnWriteSkipped,
    Field(discriminator="outcome"),
]
_COMPLETED_DAWN_WRITE_ADAPTER: TypeAdapter[_CompletedDawnWrite] = TypeAdapter(_CompletedDawnWrite)


def _dawn_write_step_path(*, user_id: UUID, local_date: date) -> str:
    return f"generation/{user_id}/{local_date.isoformat()}"


def _dawn_write_intent(*, user_content: str) -> GenerationIntent:
    return GenerationIntent(
        instructions=_SYSTEM_PROMPT,
        input=user_content,
        output=TextOutput(),
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


def _encode_dawn_write_failure(
    code: GenerationFailureCode,
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
    if isinstance(completed, _CompletedDawnWriteSkipped):
        db.commit()
        return None
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


def complete_prepared_dawn_write_without_dispatch(
    db: Session,
    *,
    user_id: UUID,
    local_date: date,
    context: JobExecutionContext,
    reason: DawnWriteSkipReason,
) -> bool:
    """Stage Dawn's exact no-dispatch memo; the caller owns the commit."""

    step_path = _dawn_write_step_path(user_id=user_id, local_date=local_date)
    generation_id = step_journal.stable_generation_id(context.job_id, step_path)
    owner = LlmCallOwner(kind="dawn_write", id=generation_id)
    lock_generation_owner_in_current_transaction(db, owner)
    db.scalar(
        select(DawnWrite.id)
        .where(DawnWrite.user_id == user_id, DawnWrite.local_date == local_date)
        .with_for_update()
    )
    if not lock_running_job_claim(db, context=context):
        return False
    job = get_job(db, context.job_id)
    if job is None or job.kind != "dawn_write_job":
        raise AssertionError("dawn write job disappeared at cancellation")
    state = step_journal.read_step_states(job).get(step_path)
    if state is None:
        return False
    if state.dispatch_phase is step_journal.Completed:
        return False
    if state.dispatch_phase is not step_journal.Prepared:
        raise GenerationUncertain(
            f"dawn write generation {generation_id} became uncertain before cancellation"
        )
    completed = _CompletedDawnWriteSkipped(reason=reason)
    next_state = cancel_prepared_generation_without_dispatch_in_current_transaction(
        db,
        owner=owner,
        state=state,
        terminal_result=_COMPLETED_DAWN_WRITE_ADAPTER.dump_json(completed).decode("utf-8"),
        reason=f"dawn write {reason.replace('_', ' ')} before dispatch",
    )
    if not step_journal.checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=step_path,
        state=next_state,
    ):
        raise GenerationUncertain(
            f"dawn write generation {generation_id} lost its claim at cancellation"
        )
    return True


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
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError(f"dawn write job {context.job_id} disappeared")
    if job.kind != "dawn_write_job":
        raise AssertionError("dawn write generation has the wrong job kind")
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

    if not get_settings().dawn_write_enabled:
        logger.info("dawn_write_skipped", reason="disabled", user_id=str(user_id))
        if state is not None:
            db.rollback()
            complete_prepared_dawn_write_without_dispatch(
                db,
                user_id=user_id,
                local_date=local_date,
                context=context,
                reason="disabled",
            )
            db.commit()
        return None

    signals = collect_signals(db, user_id=user_id, local_date=local_date, tz=tz)
    if signals is None:
        logger.info("dawn_write_skipped", reason="no_signals", user_id=str(user_id))
        if state is not None:
            db.rollback()
            complete_prepared_dawn_write_without_dispatch(
                db,
                user_id=user_id,
                local_date=local_date,
                context=context,
                reason="no_signals",
            )
            db.commit()
        return None

    user_content = _render_signals(signals)
    intent = _dawn_write_intent(user_content=user_content)
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
        complete_prepared_dawn_write_without_dispatch(
            db,
            user_id=user_id,
            local_date=local_date,
            context=context,
            reason="llm_rejected",
        )
        db.commit()
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

        journal = JobGenerationJournal(
            context=context,
            step_path=step_path,
            lock_dispatch=lock_dispatch,
        )

        try:
            execution_request = await admit_job_generation(
                owner=LlmCallOwner(kind="dawn_write", id=generation_id),
                generation_id=generation_id,
                operation="dawn_write",
                intent=intent,
                prompt_template_revision=generation_policy.operation_revision(DAWN_WRITE_OPERATION),
                prompt_payload_ref=ImmutablePromptPayloadRef(
                    owner_kind="dawn_write",
                    owner_id=str(generation_id),
                    revision=generation_policy.operation_revision(DAWN_WRITE_OPERATION),
                    payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
                ),
                journal=journal,
                session_factory=get_session_factory(),
                runtime=runtime,
            )
            execution_result = await execute_generation(
                execution_request,
                session_factory=get_session_factory(),
                runtime=runtime,
                encode_terminal=lambda terminal: _encode_dawn_write_terminal(
                    codex_terminal_evidence(terminal)
                ),
                encode_failure=_encode_dawn_write_failure,
            )
        except GenerationDispatchAborted:
            complete_prepared_dawn_write_without_dispatch(
                db,
                user_id=user_id,
                local_date=local_date,
                context=context,
                reason="pre_dispatch_aborted",
            )
            db.commit()
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
