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
``claim_index``. After the call, out-of-range indices are dropped, and citation
marker parity prevents prose that still references them from promoting.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from provider_runtime.types import ModelCall
from pydantic import BaseModel, ConfigDict
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.llm_catalog import require_catalog_model
from nexus.logging import get_logger
from nexus.schemas.library_intelligence import LibraryIntelligenceDoneEventPayload
from nexus.services import run_kit
from nexus.services.api_key_resolver import ResolvedKey, resolve_api_key, update_user_key_status
from nexus.services.chat_run_usage import usage_tokens
from nexus.services.library_intelligence import (
    resolve_library_media_ids,
    revision_orm_or_none,
)
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner
from nexus.services.locator_resolver import resolve_evidence_span
from nexus.services.media_intelligence import (
    MediaUnit,
    ensure_media_unit,
    get_media_unit,
    run_media_unit_build,
)
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.citations import (
    replace_citations_for_output,
    validate_generated_markdown_citations,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot, EdgeKind
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    SynthesisRequest,
    build_synthesis_prompt,
    build_synthesis_request,
    ground_indices,
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

# The pinned model must exist in MODEL_CATALOG (code/catalog mismatch is a defect).
require_catalog_model(LI_PROVIDER, LI_MODEL_NAME)


# ---------- worker: run_artifact_generation (the reduce) --------------------


async def run_artifact_generation(db: Session, *, revision_id: UUID, llm: ModelRuntime) -> None:
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

    The reduce call is attributed to the artifact owner (``resolve_api_key``,
    BYOK-first) and runs inside the rate-limit/budget envelope; each attempt is
    ledgered as one ``llm_calls`` row (owner ``li_revision`` — the revision IS
    the run). Expected failures land on the revision via the error floor
    (``error_code``/``error_detail``).
    """
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status != "building":
        return
    artifact_id = revision.artifact_id
    custom_instruction = revision.custom_instruction
    library_id, owner_id = _artifact_library_and_owner(db, artifact_id=artifact_id)

    try:
        resolved_key = resolve_api_key(db, owner_id, LI_PROVIDER, "auto")
    except ApiError as exc:
        _fail_revision(
            db, revision_id=revision_id, error_code=exc.code.value, error_detail=exc.message
        )
        return
    except ModelCallError as exc:
        _fail_revision(
            db,
            revision_id=revision_id,
            error_code=api_error_code_for_model_call(exc.error_code).value,
            error_detail=exception_error_detail(exc),
        )
        return

    rate_limiter = get_rate_limiter()
    try:
        rate_limiter.acquire_inflight_slot(owner_id)
    except ApiError as exc:
        _fail_revision(
            db, revision_id=revision_id, error_code=exc.code.value, error_detail=exc.message
        )
        return
    budget_reserved = False
    estimated_tokens = 0
    try:
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

        candidates, coverage_by_media = _gather_candidates(db, media_ids=media_ids)
        if not candidates:
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code="no_ready_units",
                error_detail="no library media has a ready intelligence unit with claims",
            )
            return
        _emit_progress(db, revision_id=revision_id, message="Synthesizing the library overview")

        request = _build_reduce_request(candidates, custom_instruction=custom_instruction)
        if resolved_key.mode == "platform":
            estimated_tokens = (
                estimate_tokens("\n".join(turn.content for turn in request.messages))
                + LI_MAX_OUTPUT_TOKENS
            )
            try:
                rate_limiter.reserve_token_budget(owner_id, revision_id, estimated_tokens)
                budget_reserved = True
            except ApiError as exc:
                _fail_revision(
                    db,
                    revision_id=revision_id,
                    error_code=exc.code.value,
                    error_detail=exc.message,
                )
                return

        try:
            result = await run_structured_synthesis(
                llm=LedgeredLLM(
                    db=db,
                    owner=LlmCallOwner(kind="li_revision", id=revision_id),
                    router=llm,
                    llm_operation="li_reduce",
                    key_mode_requested="auto",
                    key_mode_used=resolved_key.mode,
                ),
                request=SynthesisRequest(
                    provider=LI_PROVIDER,
                    llm_request=request,
                    api_key=resolved_key.api_key,
                    timeout_s=LI_LLM_TIMEOUT_SECONDS,
                ),
                schema=_LiSynthesis,
            )
        except ModelCallError as exc:
            error_code = api_error_code_for_model_call(exc.error_code).value
            logger.warning(
                "library_intelligence.reduce_failure",
                revision_id=str(revision_id),
                error_code=error_code,
            )
            if resolved_key.mode == "byok" and error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                update_user_key_status(db, resolved_key.user_key_id, "invalid")
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=error_code,
                error_detail=exception_error_detail(exc),
            )
            return
        except StructuredSynthesisError as exc:
            logger.warning(
                "library_intelligence.reduce_failure",
                revision_id=str(revision_id),
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
            )
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                error_detail=exception_error_detail(exc),
            )
            return

        # Commit the per-attempt llm_calls rows now so they survive whatever the
        # promote does (a later worker-boundary rollback must not erase them).
        db.commit()
        grounded = _map_li_citations(result.value, candidates)
        citations = _materialize_citations(db, owner_id=owner_id, grounded=grounded)
        try:
            validate_generated_markdown_citations(result.value.content_md, citations)
        except InvalidRequestError as exc:
            logger.warning(
                "library_intelligence.citation_parity_failure",
                revision_id=str(revision_id),
                error_detail=exc.message,
            )
            _fail_revision(
                db,
                revision_id=revision_id,
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                error_detail=exc.message,
            )
            return
        covered = _build_covered_targets(
            db, media_ids=media_ids, coverage_by_media=coverage_by_media
        )
        _promote_built_revision(
            db,
            revision_id=revision_id,
            artifact_id=artifact_id,
            owner_id=owner_id,
            content_md=result.value.content_md,
            covered_targets=covered,
            citations=citations,
            resolved_key=resolved_key,
        )
        if budget_reserved:
            actual_tokens = usage_tokens(result.usage)["total_tokens"]
            rate_limiter.commit_token_budget(
                owner_id, revision_id, actual_tokens or estimated_tokens
            )
            budget_reserved = False
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(owner_id, revision_id)
        rate_limiter.release_inflight_slot(owner_id)


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

    The bounds check is :func:`ground_indices` (policy ``"drop"``; AC-2: the
    model cannot cite a claim it was not given — ``global_index`` equals list
    position by construction). The model's emitted ``ordinal`` is kept (the
    prose ``[N]`` references it); a duplicate ordinal collision keeps the first
    and drops the rest. Marker parity later rejects any prose that still exposes
    a dropped ordinal. Roles other than the three allowed map to ``context``.
    """
    pairs = (
        ground_indices(
            synthesis.citations,
            candidates,
            index_of=lambda citation: citation.claim_index,
            policy="drop",
        )
        or []
    )
    seen_ordinals: set[int] = set()
    grounded: list[_GroundedCitation] = []
    for citation, candidate in pairs:
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


def _gather_candidates(
    db: Session, *, media_ids: list[UUID]
) -> tuple[list[_Candidate], dict[UUID, str]]:
    """Flatten ready unit claims and record source-level coverage."""
    candidates: list[_Candidate] = []
    coverage_by_media: dict[UUID, str] = {}
    used_chars = 0
    for media_id in media_ids:
        unit = get_media_unit(db, media_id=media_id)
        if not isinstance(unit, MediaUnit) or not unit.claims:
            coverage_by_media[media_id] = "no_ready_unit"
            continue
        media_chars = sum(len(claim.claim_text) + len(unit.summary_md) for claim in unit.claims)
        if candidates and used_chars + media_chars > LI_REDUCE_INPUT_CHAR_BUDGET:
            coverage_by_media[media_id] = "omitted_budget"
            continue
        coverage_by_media[media_id] = "included"
        used_chars += media_chars
        for claim in unit.claims:
            candidates.append(
                _Candidate(
                    global_index=len(candidates),
                    media_id=media_id,
                    evidence_span_id=claim.evidence_span_id,
                    claim_text=claim.claim_text,
                    summary_md=unit.summary_md,
                )
            )
    omitted = sum(1 for coverage in coverage_by_media.values() if coverage != "included")
    if omitted:
        logger.warning(
            "library_intelligence.partial_coverage",
            kept=len(candidates),
            omitted_sources=omitted,
            char_budget=LI_REDUCE_INPUT_CHAR_BUDGET,
        )
    return candidates, coverage_by_media


def _materialize_citations(
    db: Session, *, owner_id: UUID, grounded: list[_GroundedCitation]
) -> list[CitationInput]:
    """Resolve each grounded citation to a citation-edge input with a display snapshot.

    The snapshot carries what the chip renders (title/excerpt/section_label) plus
    the canonical ``#evidence-`` deep link; position lives in the evidence-span
    target, never on the edge (D11). A span that no longer resolves at write time
    is skipped with a warning (defensive; claims carry freshly-extracted not-null
    spans, so this is rare).
    """
    citations: list[CitationInput] = []
    for citation in grounded:
        try:
            resolution = resolve_evidence_span(
                db, viewer_id=owner_id, evidence_span_id=citation.evidence_span_id
            )
        except NotFoundError:
            logger.warning(
                "library_intelligence.citation_span_unresolvable",
                evidence_span_id=str(citation.evidence_span_id),
            )
            continue
        title = db.execute(
            text("SELECT title FROM media WHERE id = :media_id"),
            {"media_id": citation.media_id},
        ).scalar_one()
        citations.append(
            CitationInput(
                target=ResourceRef(scheme="evidence_span", id=citation.evidence_span_id),
                ordinal=citation.ordinal,
                kind=cast("EdgeKind", citation.role),
                snapshot=CitationSnapshot(
                    title=str(title) if title is not None else None,
                    excerpt=str(resolution.get("span_text") or "")[:600],
                    section_label=str(resolution.get("citation_label") or "") or None,
                    result_type="evidence_span",
                    deep_link=f"/media/{citation.media_id}#evidence-{citation.evidence_span_id}",
                ),
            )
        )
    return citations


def _build_covered_targets(
    db: Session, *, media_ids: list[UUID], coverage_by_media: dict[UUID, str]
) -> list[dict[str, object]]:
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
            "coverage": coverage_by_media.get(media_id, "no_ready_unit"),
        }
        for media_id in media_ids
    ]


def _promote_built_revision(
    db: Session,
    *,
    revision_id: UUID,
    artifact_id: UUID,
    owner_id: UUID,
    content_md: str,
    covered_targets: list[dict[str, object]],
    citations: list[CitationInput],
    resolved_key: ResolvedKey,
) -> None:
    """Atomically mark the revision ready (run_kit) and promote it to current.

    Order inside one SERIALIZABLE tx (run_kit stays the SOLE finalizer): re-load
    the revision ORM, guard ``building``, ``mark_terminal(ready)`` FIRST (sets
    status + completed_at + emits ``done``), THEN write content/covered/promoted,
    write the revision's citation edges, and point the head at this revision
    (last-promote-wins). A grounding drop that leaves a gapped ordinal set is
    rejected by the dense-1..N citation contract and fails the revision through
    the worker's exception handler. BYOK key-status feedback rides the terminal
    write (chat precedent).
    """

    def op() -> None:
        revision = revision_orm_or_none(db, revision_id=revision_id)
        if revision is None or revision.status != "building":
            db.rollback()
            return
        run_kit.mark_terminal(
            db,
            stream=run_kit.library_intelligence_revision_stream(revision),
            status="ready",
            done_payload=LibraryIntelligenceDoneEventPayload(
                status="ready", revision_id=revision_id
            ).model_dump(mode="json"),
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
        replace_citations_for_output(
            db,
            viewer_id=owner_id,
            source=ResourceRef(scheme="library_intelligence_revision", id=revision_id),
            citations=citations,
        )
        db.execute(
            text(
                "UPDATE library_intelligence_artifacts "
                "SET current_revision_id = :revision_id, updated_at = now() "
                "WHERE id = :artifact_id"
            ),
            {"revision_id": revision_id, "artifact_id": artifact_id},
        )
        if resolved_key.mode == "byok":
            update_user_key_status(db, resolved_key.user_key_id, "valid")
        db.commit()

    retry_serializable(db, "_promote_built_revision", op)


def _fail_revision(
    db: Session, *, revision_id: UUID, error_code: str, error_detail: str | None
) -> None:
    """Mark a nonterminal revision ``failed`` with the error floor and commit."""
    revision = revision_orm_or_none(db, revision_id=revision_id)
    if revision is None or revision.status in ("ready", "failed"):
        db.commit()
        return
    run_kit.mark_terminal(
        db,
        stream=run_kit.library_intelligence_revision_stream(revision),
        status="failed",
        done_payload=LibraryIntelligenceDoneEventPayload(
            status="failed", error_code=error_code, revision_id=revision_id
        ).model_dump(mode="json"),
        error_code=error_code,
        error_detail=error_detail,
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


# Prompt decomposition for the shared synthesis scaffold; the assembled bytes
# are pinned (golden) in tests/test_structured_synthesis.py.
_LI_PERSONA = (
    "You are a careful research assistant writing a whole-library synthesis from "
    "per-document claims. Each claim is offered by integer index."
)
_LI_DOMAIN_RULES = [
    "Write content_md: faithful markdown synthesis prose covering an overview, "
    "key topics, key sources, a reading path, cross-source tensions, and open "
    "questions. Use prose, not rigid sections. Base every statement only on the "
    "provided claims.",
    "Place inline citation markers [N] in the prose where a claim supports the "
    "statement, where N is the ordinal you assign in citations.",
    "Write citations: for each [N], one entry {ordinal:N, claim_index:int, "
    "role:'supports'|'contradicts'|'context'} where claim_index is the integer "
    "index of the single provided claim it cites. Never cite an index you were not "
    "given.",
]
_LI_JSON_SHAPE = (
    '{"content_md": string, "citations": [{"ordinal": int, "claim_index": int, "role": string}]}'
)
_LI_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=_LI_PERSONA,
    preamble=None,
    domain_rules=_LI_DOMAIN_RULES,
    json_shape=_LI_JSON_SHAPE,
)


def _build_reduce_request(
    candidates: list[_Candidate], *, custom_instruction: str | None
) -> ModelCall:
    rendered = "\n\n".join(
        f"[{c.global_index}] (media {c.media_id})\nsummary: {c.summary_md}\nclaim: {c.claim_text}"
        for c in candidates
    )
    extra_user_block = (
        f"CUSTOM INSTRUCTION:\n{custom_instruction}" if custom_instruction is not None else None
    )
    return build_synthesis_request(
        provider=LI_PROVIDER,
        system_prompt=_LI_SYSTEM_PROMPT,
        candidates_header="UNIT CLAIMS",
        rendered_candidates=rendered,
        extra_user_block=extra_user_block,
        model_name=LI_MODEL_NAME,
        max_tokens=LI_MAX_OUTPUT_TOKENS,
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
