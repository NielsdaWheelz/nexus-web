"""Library-intelligence generation worker (the reduce).

The reduce IS the generation run for one ``building`` revision: it resolves the
library's targets to media (incl. podcast -> episode media), ensures a per-media
unit for each, gathers the READY units' claims, reduces over them in ONE
structured call into synthesis prose + grounded citations, and atomically
PROMOTES the draft to the head's ``current_revision_id``.

Splits the generation worker out of ``library_intelligence`` (the artifact-head
owner): that module keeps the GET read-model, ``generate_artifact``,
``promote_revision``, and the SSE read deps; this module owns the LLM REDUCE and
the promote-on-success. The two share the revision-ORM loader and the
library->media expansion, whose single owner is ``library_intelligence``.

**Grounding by construction (AC-2).** The reduce is offered an ordered list of
unit claims (each carrying its evidence span); it cites a claim only by integer
``claim_index``. After the call, out-of-range indices are dropped, so a citation
can only point at an existing resolvable span.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from llm_calling.errors import LLMError
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn
from pydantic import BaseModel, ConfigDict
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import is_serialization_failure
from nexus.db.session import use_serializable_if_available
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.services import run_kit
from nexus.services.library_intelligence import (
    resolve_library_media_ids,
    revision_orm_or_none,
)
from nexus.services.media_intelligence import (
    MediaUnit,
    ensure_media_unit,
    get_media_unit,
    run_media_unit_build,
)
from nexus.services.retrieval_citation import build_evidence_span_citation_target
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    SynthesisRequest,
    run_structured_synthesis,
)

logger = get_logger(__name__)

# The reduce is the highest-stakes synthesis in the system — a strong model.
LI_MODEL_NAME = "claude-sonnet-4-6"
LI_PROVIDER = "anthropic"
LI_MAX_OUTPUT_TOKENS = 4000
LI_LLM_TIMEOUT_SECONDS = 90
# Budget the reduce input in characters (~4 chars/token); claims past the budget
# are dropped with a warning rather than silently capped (R1-minimal).
LI_REDUCE_INPUT_CHAR_BUDGET = 120_000

_SERIALIZABLE_RETRIES = 3


# ---------- worker: run_artifact_generation (the reduce) --------------------


async def run_artifact_generation(db: Session, *, revision_id: UUID, llm: LLMRouter) -> None:
    """Worker body: reduce over per-media units into prose + grounded citations.

    Replay-safe: a no-op when the revision is missing or not ``building``. Resolves
    the library's targets to media (incl. podcast -> episode media), then makes the
    generation self-sufficient by building any not-yet-ready unit INLINE (so a
    first generate over a fresh library does not race the async unit builds),
    gathers the READY units, makes ONE structured call, drops ungrounded citations,
    then atomically promotes the draft (run_kit flips terminal first).

    A media whose unit cannot be built (no content -> ``failed``) is simply absent
    from the candidate set; only an all-empty library yields zero candidates and
    fails the revision.
    """
    revision = (
        db.execute(
            text(
                "SELECT id, artifact_id, status FROM library_intelligence_artifact_revisions "
                "WHERE id = :revision_id"
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .first()
    )
    if revision is None or revision["status"] != "building":
        return
    artifact_id = UUID(str(revision["artifact_id"]))
    library_id, owner_id = _artifact_library_and_owner(db, artifact_id=artifact_id)

    media_ids = resolve_library_media_ids(db, library_id=library_id)
    # Build each unit inline so the reduce never reads a still-building unit on a
    # fresh library. ensure_media_unit + run_media_unit_build are idempotent on the
    # content fingerprint and each own their own commit, so this runs (and stays
    # committed) BEFORE the revision-promote SERIALIZABLE tx is opened.
    for media_id in media_ids:
        ensure_media_unit(db, media_id=media_id)
        if not isinstance(get_media_unit(db, media_id=media_id), MediaUnit):
            await run_media_unit_build(db, media_id=media_id, llm=llm)
    _emit_progress(db, revision_id=revision_id, message="Reading sources")

    candidates = _gather_candidates(db, media_ids=media_ids)
    if not candidates:
        _fail_revision(db, revision_id=revision_id, reason="no_ready_units")
        return
    _emit_progress(db, revision_id=revision_id, message="Synthesizing the library overview")

    request = _build_reduce_request(candidates)
    settings = get_settings()
    api_key = settings.anthropic_api_key or ""
    try:
        result = await run_structured_synthesis(
            llm=llm,
            request=SynthesisRequest(
                provider=LI_PROVIDER,
                llm_request=request,
                api_key=api_key,
                timeout_s=LI_LLM_TIMEOUT_SECONDS,
            ),
            schema=_LiSynthesis,
        )
    except (LLMError, StructuredSynthesisError) as exc:
        logger.warning(
            "library_intelligence.reduce_failure",
            revision_id=str(revision_id),
            reason=type(exc).__name__,
        )
        _fail_revision(db, revision_id=revision_id, reason="llm_failure")
        return

    grounded = _map_li_citations(result.value, candidates)
    citations = _materialize_citations(db, owner_id=owner_id, grounded=grounded)
    covered = _build_covered_targets(db, media_ids=media_ids)
    _promote_built_revision(
        db,
        revision_id=revision_id,
        artifact_id=artifact_id,
        content_md=result.value.content_md,
        covered_targets=covered,
        citations=citations,
    )


def fail_artifact_generation_after_worker_exception(db: Session, *, revision_id: UUID) -> None:
    """Set a nonterminal revision to ``failed`` after an unexpected worker exception."""
    db.rollback()
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status in ("ready", "failed"):
        db.commit()
        return
    run_kit.mark_terminal(
        db,
        stream=run_kit.library_intelligence_revision_stream(revision),
        status="failed",
        done_payload={"error": ApiErrorCode.E_INTERNAL.value},
    )
    db.commit()


# ---------- grounding map + reduce schema (pure, unit-testable) --------------


class _LiCitationOut(BaseModel):
    """One citation in the model's strict-JSON reduce output."""

    model_config = ConfigDict(extra="forbid")

    ordinal: int
    claim_index: int
    role: str


class _LiSynthesis(BaseModel):
    """The strict-JSON reduce shape: prose plus its inline citations."""

    model_config = ConfigDict(extra="forbid")

    content_md: str
    citations: list[_LiCitationOut]


@dataclass(frozen=True)
class _Candidate:
    """One unit claim offered to the reduce by integer index."""

    global_index: int
    media_id: UUID
    evidence_span_id: UUID
    claim_text: str
    summary_md: str


@dataclass(frozen=True)
class _GroundedCitation:
    """A reduce citation mapped back to its evidence span."""

    ordinal: int
    role: str
    media_id: UUID
    evidence_span_id: UUID


def _map_li_citations(
    synthesis: _LiSynthesis, candidates: list[_Candidate]
) -> list[_GroundedCitation]:
    """Map each citation's ``claim_index`` to a span, dropping ungrounded ones.

    Out-of-range ``claim_index`` is dropped (AC-2: the model cannot cite a claim it
    was not given). The model's emitted ``ordinal`` is kept (the prose ``[N]``
    references it); a duplicate ordinal collision keeps the first and drops the
    rest. Roles other than the three allowed map to ``context``.
    """
    by_index = {c.global_index: c for c in candidates}
    seen_ordinals: set[int] = set()
    grounded: list[_GroundedCitation] = []
    for citation in synthesis.citations:
        candidate = by_index.get(citation.claim_index)
        if candidate is None:
            continue
        if citation.ordinal in seen_ordinals:
            logger.warning(
                "library_intelligence.duplicate_citation_ordinal", ordinal=citation.ordinal
            )
            continue
        seen_ordinals.add(citation.ordinal)
        role = (
            citation.role if citation.role in ("supports", "contradicts", "context") else "context"
        )
        grounded.append(
            _GroundedCitation(
                ordinal=citation.ordinal,
                role=role,
                media_id=candidate.media_id,
                evidence_span_id=candidate.evidence_span_id,
            )
        )
    return grounded


# ---------- internal: candidates / persistence ------------------------------


def _gather_candidates(db: Session, *, media_ids: list[UUID]) -> list[_Candidate]:
    """Flatten every ready unit's claims into an indexed candidate list (R1 cap)."""
    candidates: list[_Candidate] = []
    used_chars = 0
    truncated = False
    for media_id in media_ids:
        unit = get_media_unit(db, media_id=media_id)
        if not isinstance(unit, MediaUnit):
            continue
        for claim in unit.claims:
            piece = len(claim.claim_text) + len(unit.summary_md)
            if used_chars + piece > LI_REDUCE_INPUT_CHAR_BUDGET and candidates:
                truncated = True
                break
            used_chars += piece
            candidates.append(
                _Candidate(
                    global_index=len(candidates),
                    media_id=media_id,
                    evidence_span_id=claim.evidence_span_id,
                    claim_text=claim.claim_text,
                    summary_md=unit.summary_md,
                )
            )
        if truncated:
            break
    if truncated:
        logger.warning(
            "library_intelligence.reduce_truncated",
            kept=len(candidates),
            char_budget=LI_REDUCE_INPUT_CHAR_BUDGET,
        )
    return candidates


def _materialize_citations(
    db: Session, *, owner_id: UUID, grounded: list[_GroundedCitation]
) -> list[dict[str, object]]:
    """Resolve each grounded citation to a stored locator + deep-link snapshot.

    A span that no longer resolves at write time is skipped with a warning
    (defensive; claims carry freshly-extracted not-null spans, so this is rare).
    """
    citations: list[dict[str, object]] = []
    for citation in grounded:
        try:
            locator, snapshot = build_evidence_span_citation_target(
                db,
                viewer_id=owner_id,
                media_id=citation.media_id,
                evidence_span_id=citation.evidence_span_id,
            )
        except NotFoundError:
            logger.warning(
                "library_intelligence.citation_span_unresolvable",
                evidence_span_id=str(citation.evidence_span_id),
            )
            continue
        citations.append(
            {
                "ordinal": citation.ordinal,
                "role": citation.role,
                "target_type": "evidence_span",
                "target_id": citation.evidence_span_id,
                "locator": locator,
                "snapshot": snapshot,
            }
        )
    return citations


def _build_covered_targets(db: Session, *, media_ids: list[UUID]) -> list[dict[str, object]]:
    """Snapshot every resolved library media's current content fingerprint.

    Records ALL resolved media (even those without a unit -> fingerprint null), so
    the live<->covered comparison is symmetric (AC-6/AC-7).
    """
    if not media_ids:
        return []
    rows = (
        db.execute(
            text(
                "SELECT media_id, content_fingerprint FROM media_summaries "
                "WHERE media_id = ANY(:ids)"
            ),
            {"ids": media_ids},
        )
        .mappings()
        .all()
    )
    fingerprints = {str(row["media_id"]): row["content_fingerprint"] for row in rows}
    return [
        {
            "kind": "media",
            "id": str(media_id),
            "fingerprint": fingerprints.get(str(media_id)),
        }
        for media_id in media_ids
    ]


def _promote_built_revision(
    db: Session,
    *,
    revision_id: UUID,
    artifact_id: UUID,
    content_md: str,
    covered_targets: list[dict[str, object]],
    citations: list[dict[str, object]],
) -> None:
    """Atomically mark the revision ready (run_kit) and promote it to current.

    Order inside one SERIALIZABLE tx (run_kit stays the SOLE finalizer): re-load
    the revision ORM, guard ``building``, ``mark_terminal(ready)`` FIRST (sets
    status + completed_at + emits ``done``), THEN write content/covered/promoted,
    (re)insert citations, and point the head at this revision (last-promote-wins).
    """
    for attempt in range(_SERIALIZABLE_RETRIES):
        use_serializable_if_available(db)
        try:
            revision = revision_orm_or_none(db, revision_id=revision_id)
            if revision is None or revision.status != "building":
                db.rollback()
                return
            run_kit.mark_terminal(
                db,
                stream=run_kit.library_intelligence_revision_stream(revision),
                status="ready",
                done_payload={"revision_id": str(revision_id)},
            )
            db.execute(
                text(
                    """
                    UPDATE library_intelligence_artifact_revisions
                    SET content_md = :content_md,
                        covered_targets = :covered_targets,
                        promoted_at = now()
                    WHERE id = :revision_id
                    """
                ).bindparams(bindparam("covered_targets", type_=JSONB)),
                {
                    "content_md": content_md,
                    "covered_targets": covered_targets,
                    "revision_id": revision_id,
                },
            )
            db.execute(
                text("DELETE FROM library_intelligence_citations WHERE revision_id = :revision_id"),
                {"revision_id": revision_id},
            )
            for citation in citations:
                db.execute(
                    text(
                        """
                        INSERT INTO library_intelligence_citations (
                            revision_id, ordinal, role, target_type, target_id, locator, snapshot
                        )
                        VALUES (
                            :revision_id, :ordinal, :role, :target_type, :target_id,
                            :locator, :snapshot
                        )
                        """
                    ).bindparams(
                        bindparam("locator", type_=JSONB),
                        bindparam("snapshot", type_=JSONB),
                    ),
                    {"revision_id": revision_id, **citation},
                )
            db.execute(
                text(
                    "UPDATE library_intelligence_artifacts "
                    "SET current_revision_id = :revision_id, updated_at = now() "
                    "WHERE id = :artifact_id"
                ),
                {"revision_id": revision_id, "artifact_id": artifact_id},
            )
            db.commit()
            return
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == _SERIALIZABLE_RETRIES - 1:
                raise
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError("_promote_built_revision retry loop exhausted")


def _fail_revision(db: Session, *, revision_id: UUID, reason: str) -> None:
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status in ("ready", "failed"):
        db.commit()
        return
    run_kit.mark_terminal(
        db,
        stream=run_kit.library_intelligence_revision_stream(revision),
        status="failed",
        done_payload={"error": reason},
    )
    db.commit()


def _emit_progress(db: Session, *, revision_id: UUID, message: str) -> None:
    """Append + commit one coarse ``progress`` event for the "Generating… {msg}" line.

    Best-effort and committed on its own so the SSE tail surfaces it before the
    (longer) reduce + promote tx; a no-op if the revision vanished mid-build.
    """
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None:
        return
    run_kit.append_event(
        db,
        stream=run_kit.library_intelligence_revision_stream(revision),
        event_type="progress",
        payload={"message": message},
    )
    db.commit()


# ---------- internal: prompt / schema ---------------------------------------


_LI_SYSTEM_PROMPT = (
    "You are a careful research assistant writing a whole-library synthesis from "
    "per-document claims. Each claim is offered by integer index.\n\n"
    "RULES.\n"
    "1. Write content_md: faithful markdown synthesis prose covering an overview, "
    "key topics, key sources, a reading path, cross-source tensions, and open "
    "questions. Use prose, not rigid sections. Base every statement only on the "
    "provided claims.\n"
    "2. Place inline citation markers [N] in the prose where a claim supports the "
    "statement, where N is the ordinal you assign in citations.\n"
    "3. Write citations: for each [N], one entry {ordinal:N, claim_index:int, "
    "role:'supports'|'contradicts'|'context'} where claim_index is the integer "
    "index of the single provided claim it cites. Never cite an index you were not "
    "given.\n"
    '4. Output strict JSON of the form: {"content_md": string, "citations": '
    '[{"ordinal": int, "claim_index": int, "role": string}]}. No markdown '
    "fences, no extra keys, no commentary outside the JSON."
)


def _build_reduce_request(candidates: list[_Candidate]) -> LLMRequest:
    rendered = "\n\n".join(
        f"[{c.global_index}] (media {c.media_id})\nsummary: {c.summary_md}\nclaim: {c.claim_text}"
        for c in candidates
    )
    user_content = f"UNIT CLAIMS:\n{rendered}\n\nRespond with the strict JSON object as instructed."
    return LLMRequest(
        model_name=LI_MODEL_NAME,
        messages=[
            Turn(role="system", content=_LI_SYSTEM_PROMPT, cache_ttl="5m"),
            Turn(role="user", content=user_content, cache_ttl="none"),
        ],
        max_tokens=LI_MAX_OUTPUT_TOKENS,
        reasoning_effort="none",
        prompt_cache_key=None,
    )


# ---------- internal: worker-side loader ------------------------------------


def _artifact_library_and_owner(db: Session, *, artifact_id: UUID) -> tuple[UUID, UUID]:
    row = db.execute(
        text(
            "SELECT library_id, user_id FROM library_intelligence_artifacts WHERE id = :artifact_id"
        ),
        {"artifact_id": artifact_id},
    ).one()
    return UUID(str(row[0])), UUID(str(row[1]))
