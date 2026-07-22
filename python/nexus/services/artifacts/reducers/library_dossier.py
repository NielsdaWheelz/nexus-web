"""The library-dossier reducer (the relocated whole-library reduce).

Reduces the library's per-media unit claims into one grounded synthesis. The reduce
*loop* (key resolve, rate limit, ground, promote) is the engine's; this module owns
only the dossier-specific inputs, prompt/schema, model, citations, and fingerprint.

**Grounding by construction (AC-8).** The reduce is offered an ordered list of unit
claims (each carrying its evidence span); it cites a claim only by integer
``claim_index``. Out-of-range indices are dropped via :func:`ground_indices`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.logging import get_logger
from nexus.services import library_entries
from nexus.services.artifacts.base import ArtifactReducer
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.locator_resolver import resolve_evidence_span
from nexus.services.media_intelligence import (
    MediaUnit,
    ensure_media_unit,
    get_media_unit,
    run_media_unit_build,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot, EdgeKind
from nexus.services.structured_synthesis import (
    build_synthesis_prompt,
    build_synthesis_user_content,
    ground_indices,
)

logger = get_logger(__name__)

LI_MAX_OUTPUT_TOKENS = 4000
# Budget the reduce input in characters (~4 chars/token); claims past the budget
# are dropped with a warning rather than silently capped (R1-minimal).
LI_REDUCE_INPUT_CHAR_BUDGET = 120_000


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
    ordinal: int
    role: str
    media_id: UUID
    evidence_span_id: UUID


@dataclass(frozen=True)
class DossierInputs:
    candidates: list[_Candidate]
    media_ids: list[UUID]
    coverage_by_media: dict[UUID, str]


class _LiCitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    claim_index: int
    role: str


class _LiSynthesis(BaseModel):
    """The strict-JSON reduce shape: prose plus its inline citations."""

    model_config = ConfigDict(extra="forbid")

    content_md: str
    citations: list[_LiCitationOut]


# ---------- shared expansion (single owner) ---------------------------------


def resolve_library_media_ids(db: Session, *, library_id: UUID, viewer_id: UUID) -> list[UUID]:
    """Expand the library's current entries to a media set: the personal virtual
    relation (spec §4.1) for direct media, plus the existing podcast-episode
    expansion (the Default library can never hold a podcast entry per §4.3, so
    that branch is moot there and unchanged for non-default libraries).

    Ordering: a virtual-media row keeps this SPECIFIC library's own entry
    position where one exists (the common case — direct filing, and every
    non-default library, whose virtual set is exactly its own entries); a media
    id reachable only via a DIFFERENT membership (the Default "personal All"
    branch) has no native position here and sorts after every positioned entry
    (NULLS LAST), tie-broken by media_id for determinism.
    """
    rows = (
        db.execute(
            text(
                f"""
                SELECT media_id FROM (
                    SELECT le2.position AS position, virtual_media.media_id AS media_id
                    FROM ({library_entries.library_media_ids_cte_sql()}) virtual_media
                    LEFT JOIN library_entries le2
                        ON le2.library_id = :library_id AND le2.media_id = virtual_media.media_id
                    UNION
                    SELECT le.position AS position, pe.media_id AS media_id
                    FROM library_entries le
                    JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
                    WHERE le.library_id = :library_id AND le.podcast_id IS NOT NULL
                ) expanded
                WHERE media_id IS NOT NULL
                GROUP BY media_id
                ORDER BY MIN(position), media_id
                """
            ),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )
    return [UUID(str(row["media_id"])) for row in rows]


# ---------- reducer functions -----------------------------------------------


async def _collect(
    db: Session, subject_ref: ResourceRef, viewer_id: UUID | None, runtime: ExecutionRuntime
) -> DossierInputs:
    """Resolve the library to media, build any not-yet-ready unit inline, gather claims.

    ``ensure_media_unit`` + ``run_media_unit_build`` are idempotent on the content
    fingerprint and each own their commit, so this stays committed BEFORE the promote
    SERIALIZABLE tx is opened.

    The library dossier's media set is viewer-scoped (spec §4.1) — the engine must
    always resolve a real viewer (the library's owner) for a ``library`` subject; a
    missing viewer here is a caller bug, not a legitimate anonymous-collect case.
    """
    if viewer_id is None:
        raise ValueError("library_dossier collect requires a resolved viewer_id")
    library_id = subject_ref.id
    media_ids = resolve_library_media_ids(db, library_id=library_id, viewer_id=viewer_id)
    for media_id in media_ids:
        ensure_media_unit(db, media_id=media_id)
        if not isinstance(get_media_unit(db, media_id=media_id), MediaUnit):
            await run_media_unit_build(db, media_id=media_id, runtime=runtime)
    candidates, coverage_by_media = _gather_candidates(db, media_ids=media_ids)
    return DossierInputs(
        candidates=candidates, media_ids=media_ids, coverage_by_media=coverage_by_media
    )


def _gather_candidates(
    db: Session, *, media_ids: list[UUID]
) -> tuple[list[_Candidate], dict[UUID, str]]:
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
            "library_dossier.partial_coverage",
            kept=len(candidates),
            omitted_sources=omitted,
            char_budget=LI_REDUCE_INPUT_CHAR_BUDGET,
        )
    return candidates, coverage_by_media


def _build_user_content(inputs: DossierInputs, custom_instruction: str | None) -> str:
    rendered = "\n\n".join(
        f"[{c.global_index}] (media {c.media_id})\nsummary: {c.summary_md}\nclaim: {c.claim_text}"
        for c in inputs.candidates
    )
    extra_user_block = (
        f"CUSTOM INSTRUCTION:\n{custom_instruction}" if custom_instruction is not None else None
    )
    return build_synthesis_user_content(
        candidates_header="UNIT CLAIMS",
        rendered_candidates=rendered,
        extra_user_block=extra_user_block,
    )


def _map_li_citations(
    synthesis: _LiSynthesis, candidates: list[_Candidate]
) -> list[_GroundedCitation]:
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
            logger.warning("library_dossier.duplicate_citation_ordinal", ordinal=citation.ordinal)
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


def _materialize(
    db: Session, owner_id: UUID, _subject_ref: ResourceRef, inputs: DossierInputs, result: BaseModel
) -> tuple[str, list[CitationInput]]:
    value = cast("_LiSynthesis", result)
    grounded = _map_li_citations(value, inputs.candidates)
    citations: list[CitationInput] = []
    for citation in grounded:
        try:
            resolution = resolve_evidence_span(
                db, viewer_id=owner_id, evidence_span_id=citation.evidence_span_id
            )
        except NotFoundError:
            logger.warning(
                "library_dossier.citation_span_unresolvable",
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
    return value.content_md, citations


def _fingerprint(db: Session, inputs: DossierInputs) -> list[dict[str, object]]:
    """Snapshot every resolved media's content fingerprint + coverage."""
    if not inputs.media_ids:
        return []
    fingerprints = _media_fingerprints(db, inputs.media_ids)
    return [
        {
            "kind": "media",
            "id": str(media_id),
            "fingerprint": fingerprints.get(str(media_id)),
            "coverage": inputs.coverage_by_media.get(media_id, "no_ready_unit"),
        }
        for media_id in inputs.media_ids
    ]


def _live_fingerprint(
    db: Session, subject_ref: ResourceRef, viewer_id: UUID | None
) -> list[dict[str, object]]:
    if viewer_id is None:
        raise ValueError("library_dossier live_fingerprint requires a resolved viewer_id")
    media_ids = resolve_library_media_ids(db, library_id=subject_ref.id, viewer_id=viewer_id)
    fingerprints = _media_fingerprints(db, media_ids)
    return [
        {"kind": "media", "id": str(media_id), "fingerprint": fingerprints.get(str(media_id))}
        for media_id in media_ids
    ]


def _media_fingerprints(db: Session, media_ids: list[UUID]) -> dict[str, str | None]:
    if not media_ids:
        return {}
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
    found = {str(row["media_id"]): row["content_fingerprint"] for row in rows}
    return {
        str(media_id): (str(found[str(media_id)]) if found.get(str(media_id)) is not None else None)
        for media_id in media_ids
    }


def media_fingerprint_map(covered_targets: object) -> dict[str, str | None]:
    """Extract {media_id: fingerprint} from a covered_targets list (dossier freshness)."""
    result: dict[str, str | None] = {}
    if not isinstance(covered_targets, list):
        return result
    for record in covered_targets:
        if not isinstance(record, dict) or record.get("kind") != "media":
            continue
        fingerprint = record.get("fingerprint")
        result[str(record["id"])] = str(fingerprint) if isinstance(fingerprint, str) else None
    return result


def live_media_fingerprint_map(
    db: Session, *, library_id: UUID, viewer_id: UUID
) -> dict[str, str | None]:
    media_ids = resolve_library_media_ids(db, library_id=library_id, viewer_id=viewer_id)
    return _media_fingerprints(db, media_ids)


def _freshness_signature(covered_targets: object) -> frozenset[tuple[str, str | None]]:
    return frozenset(media_fingerprint_map(covered_targets).items())


# ---------- prompt (bytes pinned in tests/test_structured_synthesis.py) ------

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


LIBRARY_DOSSIER_REDUCER = ArtifactReducer(
    kind="library_dossier",
    llm_operation="library_dossier",
    max_output_tokens=LI_MAX_OUTPUT_TOKENS,
    system_prompt=_LI_SYSTEM_PROMPT,
    collect=_collect,
    is_empty=lambda inputs: not inputs.candidates,
    empty_error=(
        "no_ready_units",
        "no library media has a ready intelligence unit with claims",
    ),
    build_user_content=_build_user_content,
    schema=_LiSynthesis,
    materialize=_materialize,
    fingerprint=_fingerprint,
    live_fingerprint=_live_fingerprint,
    freshness_signature=_freshness_signature,
)
