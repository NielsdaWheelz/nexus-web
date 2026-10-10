"""``llm_calls``: one row per generation, opened before dispatch and closed once.

Rows of one owner take dense ``generation_seq`` positions under the owner
advisory lock. A row is open (``outcome IS NULL``) only while its job attempt
runs it; a dead attempt's row closes ``interrupted`` when its job next starts an
attempt, dies or is revoked.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall
from nexus.services.generation.contract import (
    Failed,
    GenerationSpec,
    JsonValue,
    Owner,
    OwnerKind,
    Terminal,
)


@dataclass(frozen=True, slots=True)
class GenerationRef:
    id: UUID
    seq: int


def open_generation(db: Session, owner: Owner, spec: GenerationSpec) -> GenerationRef:
    """Stage the open row at the owner's next position."""

    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"{owner.kind}:{owner.id}"},
    )
    seq = db.scalar(
        select(func.coalesce(func.max(LLMCall.generation_seq), 0) + 1).where(
            LLMCall.owner_kind == owner.kind, LLMCall.owner_id == owner.id
        )
    )
    call = LLMCall(
        id=uuid4(),
        owner_kind=owner.kind,
        owner_id=owner.id,
        generation_seq=seq,
        generation_spec=spec.model_dump(mode="json"),
        job_id=owner.job.job_id,
    )
    db.add(call)
    db.flush()
    return GenerationRef(call.id, call.generation_seq)


def close_generation(
    db: Session, terminal: Terminal[object], *, route: str, evidence: dict[str, JsonValue]
) -> None:
    """Stage the one terminal write; a row already closed ``interrupted`` stays closed."""

    outcome = type(terminal).__name__
    code = terminal.code if isinstance(terminal, Failed) else None
    document: dict[str, JsonValue] = {"kind": outcome, "route": route, "evidence": evidence}
    if isinstance(terminal, Failed):
        document["failure_code"] = terminal.code
        if terminal.detail:
            document["detail"] = terminal.detail
    db.execute(
        update(LLMCall)
        .where(LLMCall.id == terminal.generation_id, LLMCall.outcome.is_(None))
        .values(
            outcome=outcome,
            failure_code=code,
            terminal=document,
            usage=None if terminal.usage is None else terminal.usage.model_dump(mode="json"),
            completed_at=func.now(),
        )
    )


def interrupt_job_generations(db: Session, *, job_id: UUID, detail: str) -> None:
    """Close every open row of one job: the attempt that opened it is gone."""

    db.execute(
        text("""
            UPDATE llm_calls SET outcome = 'Failed', failure_code = 'interrupted',
                completed_at = now(),
                terminal = jsonb_build_object('kind', 'Failed', 'failure_code', 'interrupted',
                    'detail', CAST(:detail AS text),
                    'route', generation_spec #>> '{selection,route}', 'evidence', '{}'::jsonb)
            WHERE job_id = :job_id AND outcome IS NULL
        """),
        {"job_id": job_id, "detail": detail},
    )


def generation_exists(db: Session, *, kind: OwnerKind, id: UUID) -> bool:
    return (
        db.scalar(
            select(LLMCall.id).where(LLMCall.owner_kind == kind, LLMCall.owner_id == id).limit(1)
        )
        is not None
    )


def lock_open_generation(db: Session, *, generation_id: UUID) -> bool:
    """The tool fence: a tool effect commits only while its generation is open."""

    return (
        db.scalar(
            select(LLMCall.id)
            .where(LLMCall.id == generation_id, LLMCall.outcome.is_(None))
            .with_for_update()
        )
        is not None
    )


def latest_generations(
    db: Session,
    *,
    kind: OwnerKind,
    ids: Collection[UUID],
    job_ids: Collection[UUID] | None = None,
    succeeded: bool = False,
) -> dict[UUID, LLMCall]:
    """Each owner's newest row, among those ``job_ids`` opened, succeeded with ``succeeded``."""

    if not ids:
        return {}
    query = (
        select(LLMCall)
        .where(LLMCall.owner_kind == kind, LLMCall.owner_id.in_(list(ids)))
        .order_by(LLMCall.owner_id, LLMCall.generation_seq.desc())
        .distinct(LLMCall.owner_id)
    )
    if job_ids is not None:
        query = query.where(LLMCall.job_id.in_(list(job_ids)))
    if succeeded:
        query = query.where(LLMCall.outcome == "Succeeded")
    return {call.owner_id: call for call in db.scalars(query)}


def generation_history(db: Session, generation_id: UUID) -> dict[str, object] | None:
    """One closed row's audit facts for the operator CLI; an open row is refused."""

    call = db.get(LLMCall, generation_id)
    if call is None:
        return None
    if call.outcome is None:
        raise ValueError("generation history requires a closed generation")
    return {
        "id": call.id,
        "owner_kind": call.owner_kind,
        "owner_id": call.owner_id,
        "generation_seq": call.generation_seq,
        "job_id": call.job_id,
        "generation_spec": call.generation_spec,
        "outcome": call.outcome,
        "failure_code": call.failure_code,
        "terminal": call.terminal,
        "usage": call.usage,
        "created_at": call.created_at,
        "completed_at": call.completed_at,
    }
