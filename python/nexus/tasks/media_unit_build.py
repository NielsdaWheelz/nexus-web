"""The per-media intelligence unit build: one grounded synthesis per fingerprint.

The claimed job attempt generates once and writes the head it owns. Both head
writes are fenced on the captured content fingerprint and this exact running
lease, so a superseded attempt can neither publish nor fail the live head. A
retry after a dead worker generates again from scratch.
"""

from __future__ import annotations

from typing import Any, Literal, NamedTuple, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import JobExecutionContext, get_job, running_job_claim_is_current
from nexus.services.connection_discovery import queue_connection_discovery_scan
from nexus.services.generation.contract import Failed, InvalidOutput, Owner, Succeeded
from nexus.services.generation.run import generate
from nexus.services.generation.runtime import Runtime, run_generation_job
from nexus.services.generation.synthesis import (
    INDEX_GROUNDING_RULE,
    build_synthesis_intent,
    build_synthesis_prompt,
    build_synthesis_user_content,
    ground_indices,
    strict,
)
from nexus.services.media_intelligence import Candidate, load_candidates, media_summary_orm_or_none
from nexus.services.media_intelligence_lifecycle import current_content_fingerprint
from nexus.services.resource_graph.refs import ResourceRef


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
    """The outcome of one unit synthesis, applied to the head this attempt owns."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["success", "failure"]
    summary_md: str = ""
    claims: tuple[_Claim, ...] = ()
    error_code: str = ""
    error_detail: str | None = None


class _Head(NamedTuple):
    """The unit head version this attempt owns."""

    media_id: UUID
    summary_id: UUID
    content_fingerprint: str


def media_unit_build(
    *, media_id: str, content_fingerprint: str, context: JobExecutionContext
) -> dict:
    """Worker entry: synthesize one media unit."""
    media_uuid = UUID(media_id)

    async def handler(db: Session, runtime: Runtime) -> dict:
        outcome = await _build(
            db,
            media_id=media_uuid,
            content_fingerprint=content_fingerprint,
            ctx=context,
            runtime=runtime,
        )
        # A modeled domain failure is a completed durable job, not a queue
        # infrastructure failure.
        return {"status": "ok", "outcome": outcome, "media_id": media_id}

    return run_generation_job("media_unit_build", context, handler)


async def _build(
    db: Session,
    *,
    media_id: UUID,
    content_fingerprint: str,
    ctx: JobExecutionContext,
    runtime: Runtime,
) -> Literal["ok", "failed"]:
    job = get_job(db, ctx.job_id)
    if job is None:
        return "ok"
    head = _Head(media_id, UUID(str(job.payload["summary_id"])), content_fingerprint)
    if not running_job_claim_is_current(db, context=ctx):
        db.rollback()
        return "ok"
    current = media_summary_orm_or_none(db, media_id=head.media_id)
    if (
        current is None
        or current.id != head.summary_id
        or current.status != "building"
        or current.content_fingerprint != head.content_fingerprint
        or current_content_fingerprint(db, media_id=head.media_id) != head.content_fingerprint
    ):
        db.commit()
        return "ok"
    owner_row = db.execute(
        text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
        {"media_id": head.media_id},
    ).scalar_one_or_none()
    candidates = [] if owner_row is None else load_candidates(db, media_id=head.media_id)
    if owner_row is None or not candidates:
        _fail_head(
            db,
            ctx=ctx,
            head=head,
            memo=_Memo(
                kind="failure",
                error_code="no_owner",
                error_detail="media has no owning user to attribute the generation to",
            )
            if owner_row is None
            else _Memo(
                kind="failure",
                error_code="no_candidates",
                error_detail="media has no indexed content chunks with evidence spans",
            ),
        )
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
    # Every request-shaping read is complete; no transaction crosses the model call.
    db.commit()
    terminal = await generate(
        runtime,
        owner=Owner("media_summary", head.summary_id, owner_user_id, ctx),
        operation="media_summary",
        intent=intent,
        decode=strict(MediaUnitSynthesis, lambda value: _accept(value, candidates)),
    )
    if isinstance(terminal, Succeeded):
        memo = terminal.value
    elif isinstance(terminal, Failed):
        memo = _Memo(kind="failure", error_code=terminal.code, error_detail=terminal.detail)
    else:
        memo = _Memo(kind="failure", error_code="cancelled")
    return _apply(db, ctx=ctx, head=head, owner_user_id=owner_user_id, memo=memo)


def _accept(value: MediaUnitSynthesis, candidates: list[Candidate]) -> _Memo:
    """Ground every claim on an offered passage; survivors take dense ordinals in order."""
    grounded = ground_indices(
        value.claims, candidates, index_of=lambda claim: claim.candidate_index
    )
    if grounded is None:
        raise InvalidOutput(
            "media summary output references a candidate index that was not offered"
        )
    return _Memo(
        kind="success",
        summary_md=value.summary_md,
        claims=tuple(
            _Claim(claim.claim_text, candidate.evidence_span_id, ordinal)
            for ordinal, (claim, candidate) in enumerate(grounded)
        ),
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
        queue_connection_discovery_scan(
            db,
            user_id=owner_user_id,
            ref=ResourceRef(scheme="media", id=head.media_id),
            reason="media_unit_ready",
        )
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
