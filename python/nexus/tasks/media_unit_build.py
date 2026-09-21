"""The per-media intelligence unit build: one grounded synthesis per fingerprint.

The claimed job attempt owns one stable ``(media_id, fingerprint, synthesis)``
generation: Prepared, then Uncertain immediately before dispatch, then Completed
with a normalized memo. A Completed replay re-applies that memo without
redispatching; an Uncertain replay is operator-owned. Both head writes are
fenced on the captured content fingerprint and this exact running lease, so a
superseded attempt can neither publish nor fail the live head.
"""

from __future__ import annotations

from typing import Any, Literal, NamedTuple, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import MediaSummary
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    lock_jobs_for_payload,
    running_job_claim_is_current,
)
from nexus.schemas.presence import Present
from nexus.services import durable_step_journal as step_journal
from nexus.services import generation_policy
from nexus.services.atlas_projection import try_enqueue_atlas_project
from nexus.services.codex_generation_contract import GenerationTerminal
from nexus.services.generation_spec import ImmutablePromptPayloadRef, generation_fact_digest
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationFailureCode,
    GenerationUncertain,
    JobGenerationJournal,
    admit_job_generation,
    cancel_prepared_generation_without_dispatch_in_current_transaction,
    codex_terminal_evidence,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.media_intelligence import Candidate, load_candidates, media_summary_orm_or_none
from nexus.services.media_intelligence_lifecycle import (
    MEDIA_UNIT_JOB_KIND,
    MEDIA_UNIT_OPERATION,
    current_content_fingerprint,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StructuredSynthesisError,
    build_synthesis_intent,
    build_synthesis_prompt,
    build_synthesis_user_content,
    decode_structured_synthesis,
    ground_indices,
    outcome_failure_facts,
)
from nexus.services.synapse import queue_synapse_scan
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

_STEP_PATH = "synthesis"
_TASK = LlmTaskSpec(label="media_unit_build")


class MediaUnitClaimOut(BaseModel):
    """One claim in the model's strict-JSON output."""

    model_config = ConfigDict(extra="forbid")

    claim_text: str
    candidate_index: int


class MediaUnitSynthesis(BaseModel):
    """The strict-JSON unit synthesis shape."""

    model_config = ConfigDict(extra="forbid")

    summary_md: str
    claims: list[MediaUnitClaimOut]


_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=(
        "You are a careful research assistant building a reusable unit for one "
        "document: a concise summary plus a set of atomic, grounded claims."
    ),
    preamble=None,
    domain_rules=[
        INDEX_GROUNDING_RULE + " Do not invent passages, indices, sources, or quotations.",
        "Write summary_md: a faithful markdown abstract of the document "
        "(2-5 sentences), based only on the candidate passages.",
        "Write claims: each is one atomic, self-contained factual statement the "
        "document makes, paired with the candidate_index of the single passage that "
        "best supports it. Only emit a claim you can ground in a provided candidate.",
    ],
    json_shape='{"summary_md": string, "claims": [{"claim_text": string, "candidate_index": int}]}',
)


class _Claim(NamedTuple):
    claim_text: str
    evidence_span_id: UUID
    ordinal: int


class _Memo(BaseModel):
    """The durable replay memo of one unit synthesis."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["success", "failure", "skip"]
    summary_md: str = ""
    claims: tuple[_Claim, ...] = ()
    error_code: str = ""
    error_detail: str | None = None
    reason: str = ""


class _Head(NamedTuple):
    """The unit head version this attempt owns."""

    media_id: UUID
    summary_id: UUID
    content_fingerprint: str


class _UncertainMediaUnitTurn(RuntimeError):
    """A dispatch may have landed and has no reconciliation key."""


def media_unit_build(
    *, media_id: str, content_fingerprint: str, context: JobExecutionContext
) -> dict | RescheduleRequested:
    """Worker entry: synthesize (or replay) one media unit."""
    media_uuid = UUID(media_id)

    async def handler(db: Session, runtime: ExecutionRuntime) -> dict | RescheduleRequested:
        outcome = await _build(
            db,
            media_id=media_uuid,
            content_fingerprint=content_fingerprint,
            ctx=context,
            runtime=runtime,
        )
        if isinstance(outcome, RescheduleRequested):
            return outcome
        # A modeled domain failure is a completed durable job, not a queue
        # infrastructure failure.
        return {"status": "ok", "outcome": outcome, "media_id": media_id}

    return run_llm_task(_TASK, handler)


async def _build(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    ctx: JobExecutionContext,
    runtime: ExecutionRuntime,
) -> Literal["ok", "failed"] | RescheduleRequested:
    job = get_job(db, ctx.job_id)
    if job is None:
        return "ok"
    head = _Head(media_id, UUID(str(job.payload["summary_id"])), content_fingerprint)
    owner = LlmCallOwner(kind="media_summary", id=head.summary_id)
    if not running_job_claim_is_current(
        db, job_id=ctx.job_id, worker_id=ctx.worker_id, attempt_no=ctx.attempt_no
    ):
        db.rollback()
        return "ok"

    state = step_journal.read_step_states(job).get(_STEP_PATH)
    if state is not None and state.dispatch_phase is step_journal.Uncertain:
        raise _UncertainMediaUnitTurn(f"media unit {head.summary_id} synthesis is uncertain")

    def terminalize(memo: _Memo) -> bool:
        """Close a Prepared start that will not dispatch; commit either way.

        The admission may have written Prepared after this attempt read its
        state, so the phase is re-read here rather than captured above.
        """
        prepared = get_job(db, ctx.job_id)
        live = None if prepared is None else step_journal.read_step_states(prepared).get(_STEP_PATH)
        if live is None or live.dispatch_phase is not step_journal.Prepared:
            db.commit()
            return True
        return _complete_prepared(db, owner=owner, ctx=ctx, state=live, memo=memo)

    current = media_summary_orm_or_none(db, media_id=head.media_id)
    if (
        current is None
        or current.id != head.summary_id
        or current.status != "building"
        or current.content_fingerprint != head.content_fingerprint
        or current_content_fingerprint(db, media_id=head.media_id) != head.content_fingerprint
    ):
        terminalize(_Memo(kind="skip", reason="summary_superseded"))
        return "ok"

    owner_row = db.execute(
        text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
        {"media_id": head.media_id},
    ).scalar_one_or_none()
    candidates = [] if owner_row is None else load_candidates(db, media_id=head.media_id)
    if owner_row is None or not candidates:
        memo = (
            _Memo(
                kind="failure",
                error_code="no_owner",
                error_detail="media has no owning user to attribute the generation to",
            )
            if owner_row is None
            else _Memo(
                kind="failure",
                error_code="no_candidates",
                error_detail="media has no indexed content chunks with evidence spans",
            )
        )
        if not terminalize(memo):
            return "ok"
        _fail_head(db, ctx=ctx, head=head, memo=memo)
        return "failed"
    owner_user_id = UUID(str(owner_row))

    intent = build_synthesis_intent(
        system_prompt=_SYSTEM_PROMPT,
        user_content=build_synthesis_user_content(
            candidates_header="CANDIDATES",
            rendered_candidates="\n\n".join(
                f"[{index}] {candidate.text}" for index, candidate in enumerate(candidates)
            ),
            extra_user_block=None,
        ),
        schema=MediaUnitSynthesis,
    )
    if state is not None and state.dispatch_phase is step_journal.Completed:
        stored = state.terminal_result
        if not isinstance(stored, Present):
            raise AssertionError("Completed synthesis step has no terminal result")
        db.commit()
        return _apply(
            db,
            ctx=ctx,
            head=head,
            owner_user_id=owner_user_id,
            memo=step_journal.decode_step_result(stored.value, _Memo),
        )

    def lock_dispatch(dispatch_db: Session) -> JobRow | None:
        locked = dispatch_db.scalar(
            select(MediaSummary).where(MediaSummary.id == head.summary_id).with_for_update()
        )
        jobs = lock_jobs_for_payload(
            dispatch_db,
            kind=MEDIA_UNIT_JOB_KIND,
            expected_payload_match={
                "media_id": str(head.media_id),
                "content_fingerprint": head.content_fingerprint,
            },
        )
        if (
            locked is None
            or locked.status != "building"
            or locked.content_fingerprint != head.content_fingerprint
            or current_content_fingerprint(dispatch_db, media_id=head.media_id)
            != head.content_fingerprint
        ):
            return None
        return next((candidate for candidate in jobs if candidate.id == ctx.job_id), None)

    # Every request-shaping read is complete; no transaction may cross the
    # generation host's I/O boundary.
    db.commit()
    revision = generation_policy.operation_revision(MEDIA_UNIT_OPERATION)
    try:
        request = await admit_job_generation(
            owner=owner,
            generation_id=step_journal.stable_generation_id(
                head.media_id, f"{head.content_fingerprint}:{_STEP_PATH}"
            ),
            operation="media_summary",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="media_summary",
                owner_id=str(head.summary_id),
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=JobGenerationJournal(
                context=ctx, step_path=_STEP_PATH, lock_dispatch=lock_dispatch
            ),
            session_factory=get_session_factory(),
            runtime=runtime,
        )
        result = await execute_generation(
            request,
            session_factory=get_session_factory(),
            runtime=runtime,
            encode_terminal=lambda terminal: _encode_terminal(
                codex_terminal_evidence(terminal), candidates=candidates
            ),
            encode_failure=_encode_failure,
        )
    except GenerationAdmissionInputsChanged:
        terminalize(_Memo(kind="skip", reason="request_fingerprint_changed"))
        return "ok"
    except GenerationDispatchAborted:
        terminalize(_Memo(kind="skip", reason="dispatch_aborted"))
        return "ok"
    except GenerationUncertain as exc:
        raise _UncertainMediaUnitTurn(str(exc)) from exc
    if isinstance(result, RescheduleRequested):
        return result
    return _apply(
        db,
        ctx=ctx,
        head=head,
        owner_user_id=owner_user_id,
        memo=step_journal.decode_step_result(result.terminal_result, _Memo),
    )


def _complete_prepared(
    db: Session,
    *,
    owner: LlmCallOwner,
    ctx: JobExecutionContext,
    state: step_journal.StepReplayState,
    memo: _Memo,
) -> bool:
    """Atomically cancel a Prepared start and complete the owner journal."""
    # Earlier owner checks are snapshot reads: start a fresh transaction so the
    # generation-owner advisory lock stays the first lock of this transition.
    db.rollback()
    next_state = cancel_prepared_generation_without_dispatch_in_current_transaction(
        db, owner=owner, state=state, terminal_result=step_journal.encode_step_result(memo)
    )
    job = get_job(db, ctx.job_id)
    if job is None or step_journal.read_step_states(job).get(_STEP_PATH) != state:
        db.rollback()
        return False
    if not step_journal.checkpoint_step_state(
        db, ctx=ctx, job=job, step_path=_STEP_PATH, state=next_state
    ):
        db.rollback()
        return False
    db.commit()
    return True


def _encode_terminal(
    terminal: GenerationTerminal, *, candidates: list[Candidate]
) -> EncodedGenerationTerminal:
    """Normalize one terminal into the replay memo, grounding every claim."""
    accepted_failure: AcceptedGenerationFailure | None = None
    if terminal.status != "succeeded":
        code, detail = outcome_failure_facts(terminal)
        memo = _Memo(kind="failure", error_code=code, error_detail=detail)
    else:
        try:
            value = decode_structured_synthesis(terminal, schema=MediaUnitSynthesis)
            grounded = (
                ground_indices(
                    value.claims,
                    candidates,
                    index_of=lambda claim: claim.candidate_index,
                    policy="drop",
                )
                or []
            )
            if len(grounded) != len(value.claims):
                raise StructuredSynthesisError(
                    "media summary output references a candidate index that was not offered"
                )
        except StructuredSynthesisError as exc:
            memo = _Memo(kind="failure", error_code="invalid_output", error_detail=str(exc))
            accepted_failure = AcceptedGenerationFailure(code="invalid_output", detail=str(exc))
        else:
            # Survivors keep model order and take dense ordinals 0..M.
            memo = _Memo(
                kind="success",
                summary_md=value.summary_md,
                claims=tuple(
                    _Claim(claim.claim_text, candidate.evidence_span_id, ordinal)
                    for ordinal, (claim, candidate) in enumerate(grounded)
                ),
            )
    return EncodedGenerationTerminal(
        terminal_result=step_journal.encode_step_result(memo),
        accepted_failure=accepted_failure,
    )


def _encode_failure(code: GenerationFailureCode, detail: str) -> str:
    return step_journal.encode_step_result(
        _Memo(kind="failure", error_code=code, error_detail=detail)
    )


def _apply(
    db: Session,
    *,
    ctx: JobExecutionContext,
    head: _Head,
    owner_user_id: UUID,
    memo: _Memo,
) -> Literal["ok", "failed"]:
    """Write the memo's outcome to the head this attempt owns."""
    if memo.kind == "skip":
        return "ok"
    if memo.kind == "failure":
        _fail_head(db, ctx=ctx, head=head, memo=memo)
        return "failed"

    def op() -> None:
        if not _update_head(
            db,
            ctx=ctx,
            head=head,
            assignments=(
                "summary_md = :summary_md, status = 'ready', error_code = NULL, error_detail = NULL"
            ),
            values={"summary_md": memo.summary_md},
        ):
            db.rollback()
            return
        queue_synapse_scan(
            db,
            user_id=owner_user_id,
            ref=ResourceRef(scheme="media", id=head.media_id),
            reason="media_unit_ready",
        )
        # Re-project the grand atlas once the unpositioned backlog is meaningful
        # (soft, dedupes, rides this transaction).
        try_enqueue_atlas_project(db, user_id=owner_user_id)
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
            {"summary_id": head.summary_id},
        )
        if memo.claims:
            db.execute(
                text(
                    """
                    INSERT INTO media_claims (
                        media_id, summary_id, claim_text, evidence_span_id, ordinal
                    )
                    VALUES (:media_id, :summary_id, :claim_text, :evidence_span_id, :ordinal)
                    """
                ),
                [
                    {
                        "media_id": head.media_id,
                        "summary_id": head.summary_id,
                        "claim_text": claim.claim_text,
                        "evidence_span_id": claim.evidence_span_id,
                        "ordinal": claim.ordinal,
                    }
                    for claim in memo.claims
                ],
            )
        db.commit()

    retry_serializable(db, "media_unit_publish", op)
    return "ok"


def _fail_head(db: Session, *, ctx: JobExecutionContext, head: _Head, memo: _Memo) -> None:
    """Record the modeled failure; ``error_detail`` is operator-only, never rendered."""

    def op() -> None:
        _update_head(
            db,
            ctx=ctx,
            head=head,
            assignments=(
                "status = 'failed', error_code = :error_code, error_detail = :error_detail"
            ),
            values={"error_code": memo.error_code, "error_detail": memo.error_detail},
        )
        db.commit()

    retry_serializable(db, "media_unit_fail", op)


def _update_head(
    db: Session,
    *,
    ctx: JobExecutionContext,
    head: _Head,
    assignments: str,
    values: dict[str, object],
) -> bool:
    """Update the owned head version, or match nothing and write nothing.

    A concurrent re-ingest commits a new fingerprint (replacing the evidence
    spans the claims reference) or a deletion drops the head during the model
    window: the fence then matches no row, so a superseded attempt bails before
    its FK-violating claim inserts and never clobbers the live head.
    """
    result = cast(
        "Any",
        db.execute(
            text(
                f"""
                UPDATE media_summaries
                SET {assignments}, updated_at = now()
                WHERE id = :summary_id
                  AND media_id = :media_id
                  AND status = 'building'
                  AND content_fingerprint = :expected_fingerprint
                  AND EXISTS (
                      SELECT 1 FROM background_jobs
                      WHERE id = :job_id AND status = 'running' AND claimed_by = :worker_id
                        AND attempts = :attempt_no AND lease_expires_at > now()
                  )
                """
            ),
            {
                **values,
                "summary_id": head.summary_id,
                "media_id": head.media_id,
                "expected_fingerprint": head.content_fingerprint,
                "job_id": ctx.job_id,
                "worker_id": ctx.worker_id,
                "attempt_no": ctx.attempt_no,
            },
        ),
    )
    return result.rowcount > 0
