"""The ``media_unit_build`` job: one grounded synthesis per content fingerprint (I12).

An attempt writes only the head it was enqueued for, while that head is building at its
fingerprint under this attempt's claim: one that lost it (a re-index re-ensured the head, a
deletion dropped it, the job was reclaimed) writes nothing. A retry generates again. A head
whose index moved on before its build ran fails, as does one whose job dies (I16).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import JobExecutionContext
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
from nexus.services.media_intelligence import Candidate, load_candidates
from nexus.services.media_intelligence_lifecycle import current_content_fingerprint
from nexus.services.resource_graph.refs import ResourceRef


# The docstrings below are model-facing (schema descriptions, kept verbatim); notes are comments.
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

# The head this attempt owns: building at its fingerprint, under this exact claim.
_OWNED_HEAD = """
    WHERE id = :summary_id AND status = 'building' AND content_fingerprint = :fingerprint
      AND EXISTS (SELECT 1 FROM background_jobs
                  WHERE id = :job_id AND status = 'running' AND execution_id = :execution_id)
"""

type _Outcome = Literal["ok", "failed"]


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> dict:
    media_id = UUID(payload["media_id"])
    fence = {
        "summary_id": UUID(payload["summary_id"]),
        "fingerprint": payload["content_fingerprint"],
        "job_id": context.job_id,
        "execution_id": context.execution_id,
    }

    async def handler(db: Session, runtime: Runtime) -> dict:
        outcome = await _build(db, runtime, context, media_id, fence)
        # A modeled failure is a completed job, not a queue failure.
        return {"status": "ok", "outcome": outcome, "media_id": str(media_id)}

    return run_generation_job("media_unit_build", context, handler)


async def _build(
    db: Session,
    runtime: Runtime,
    context: JobExecutionContext,
    media_id: UUID,
    fence: dict[str, Any],
) -> _Outcome:
    owned = db.scalar(text("SELECT 1 FROM media_summaries " + _OWNED_HEAD), fence)
    if owned is None:
        db.rollback()
        return "ok"
    if current_content_fingerprint(db, media_id=media_id) != fence["fingerprint"]:
        db.rollback()  # the index moved on (marked pending, or published without text)
        return _fail(db, fence, "superseded", None)
    owner = db.scalar(text("SELECT created_by_user_id FROM media WHERE id = :m"), {"m": media_id})
    candidates = [] if owner is None else load_candidates(db, media_id=media_id)
    db.commit()  # every request-shaping read is done: no transaction spans the model call
    if owner is None:
        return _fail(
            db, fence, "no_owner", "media has no owning user to attribute the generation to"
        )
    if not candidates:
        return _fail(db, fence, "no_candidates", "media has no indexed chunks with evidence spans")
    terminal = await generate(
        runtime,
        owner=Owner("media_summary", fence["summary_id"], owner, context),
        operation="media_summary",
        intent=build_synthesis_intent(
            system_prompt=_SYSTEM_PROMPT,
            user_content=build_synthesis_user_content(
                candidates_header="CANDIDATES",
                rendered_candidates="\n\n".join(
                    f"[{index}] {candidate.text}" for index, candidate in enumerate(candidates)
                ),
                extra_user_block=None,
            ),
            schema=MediaUnitSynthesis,
        ),
        decode=strict(MediaUnitSynthesis, lambda value: _ground(value, candidates)),
    )
    if isinstance(terminal, Failed):
        return _fail(db, fence, terminal.code, terminal.detail)
    if not isinstance(terminal, Succeeded):
        return _fail(db, fence, "cancelled", None)
    summary_md, claims = terminal.value

    def publish() -> None:
        updated: Any = db.execute(
            text(
                "UPDATE media_summaries SET summary_md = :summary_md, status = 'ready',"
                " error_code = NULL, error_detail = NULL, updated_at = now()" + _OWNED_HEAD
            ),
            {**fence, "summary_md": summary_md},
        )
        if updated.rowcount == 0:  # superseded during the model call: write nothing
            db.rollback()
            return
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :s"), {"s": fence["summary_id"]}
        )
        if claims:
            db.execute(
                text("""
                    INSERT INTO media_claims (media_id, summary_id, claim_text, evidence_span_id,
                        ordinal)
                    VALUES (:media_id, :summary_id, :claim_text, :span_id, :ordinal)
                """),
                [{"media_id": media_id, "summary_id": fence["summary_id"], **c} for c in claims],
            )
        queue_connection_discovery_scan(
            db,
            user_id=owner,
            ref=ResourceRef(scheme="media", id=media_id),
            reason="media_unit_ready",
        )
        db.commit()

    retry_serializable(db, "media_unit_publish", publish)
    return "ok"


def _ground(
    value: MediaUnitSynthesis, candidates: list[Candidate]
) -> tuple[str, list[dict[str, Any]]]:
    """Every claim cites an offered passage; survivors take dense ordinals in order."""
    grounded = ground_indices(
        value.claims, candidates, index_of=lambda claim: claim.candidate_index
    )
    if grounded is None:
        raise InvalidOutput(
            "media summary output references a candidate index that was not offered"
        )
    return value.summary_md, [
        {"claim_text": claim.claim_text, "span_id": candidate.evidence_span_id, "ordinal": ordinal}
        for ordinal, (claim, candidate) in enumerate(grounded)
    ]


def _fail(db: Session, fence: dict[str, Any], code: str, detail: str | None) -> _Outcome:
    """A modeled failure on the owned head; ``error_detail`` is operator-only, never rendered."""

    def op() -> None:
        db.execute(
            text(
                "UPDATE media_summaries SET status = 'failed', error_code = :code,"
                " error_detail = :detail, updated_at = now()" + _OWNED_HEAD
            ),
            {**fence, "code": code, "detail": detail},
        )
        db.commit()

    retry_serializable(db, "media_unit_fail", op)
    return "failed"
