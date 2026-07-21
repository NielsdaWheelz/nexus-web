"""Synapse resonance engine: the sole writer of ``origin='synapse'`` edges.

A *scan* reads one source object's dossier (gathered from projections — the
    intelligence unit, a page title, a block's own body, a highlight's quote),
retrieves resonant
candidates from the whole corpus through ``search()``, asks a light-tier model
which candidates *genuinely* illuminate the source, and replace-sets the
source's ``(source, origin='synapse')`` edge set with the survivors — each
carrying a one-line rationale in the edge snapshot (``excerpt``, D2).

Current-only doctrine (D6): a successful scan owns the whole set (including
setting it empty); a failed scan leaves prior edges untouched. Dismissal
(``synapse_suppressions``) is the one memory the engine keeps — a dismissed
pair is never re-proposed in either direction (D7).

Scan state is the ``background_jobs`` row (D5): no head table, dedupe_key
``synapse_scan:<user id>:<ref uri>``, ledger owner ``synapse_scan`` = the
source id.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID, uuid4

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from provider_runtime.types import ModelCall
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import and_, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Highlight, Media, NoteBlock, Page, SynapseSuppression
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    NotFoundError,
    api_error_code_for_model_call,
)
from nexus.jobs.queue import enqueue_unique_job
from nexus.llm_catalog import require_catalog_model
from nexus.logging import get_logger
from nexus.schemas.search import (
    SearchResultContentChunkOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
)
from nexus.services.api_key_resolver import resolve_api_key, update_user_key_status
from nexus.services.chat_run_usage import usage_tokens
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner
from nexus.services.media_intelligence import NotReady, get_media_unit
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import (
    delete_edge,
    get_owned_edge,
    replace_edges_for_origin,
)
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.policy import SYNAPSE_SOURCE_SCHEMES
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import (
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
)
from nexus.services.search import search
from nexus.services.search.query import SearchQuery
from nexus.services.structured_synthesis import (
    INDEX_GROUNDING_RULE,
    StructuredSynthesisError,
    SynthesisRequest,
    build_synthesis_prompt,
    build_synthesis_request,
    ground_indices,
    run_structured_synthesis,
)

logger = get_logger(__name__)

SYNAPSE_PROVIDER = "anthropic"
SYNAPSE_MODEL_NAME = "claude-haiku-4-5-20251001"
SYNAPSE_CANDIDATE_LIMIT = 12
SYNAPSE_MAX_CONNECTIONS = 4
# Span-grain dedup lets one text-rich work fill every slot with its own spans;
# two spans of a book is passage grain, four is monologue (D9). Keyed on the
# candidate's owner media.
SYNAPSE_MAX_CONNECTIONS_PER_WORK = 2
SYNAPSE_MAX_OUTPUT_TOKENS = 1000
SYNAPSE_LLM_TIMEOUT_SECONDS = 45
SYNAPSE_QUERY_CHAR_BUDGET = 800
SYNAPSE_DOSSIER_CHAR_BUDGET = 12_000
# The pinned model must exist in MODEL_CATALOG (code/catalog mismatch is a defect).
require_catalog_model(SYNAPSE_PROVIDER, SYNAPSE_MODEL_NAME)


# ---------- public contract -------------------------------------------------


def queue_synapse_scan(db: Session, *, user_id: UUID, ref: ResourceRef, reason: str) -> bool:
    """Soft-enqueue one scan for ``ref``; never breaks the host write.

    Returns True only when a new job row was inserted: False when the engine is
    disabled, the scheme is not scannable, an identical scan is already in
    flight (AC6 — one non-terminal job per (user, ref)), or the queue insert fails
    (isolated behind a SAVEPOINT and logged, so a highlight create or page
    reindex commit survives a queue defect). Flush-only; rides the caller's
    transaction.
    """
    if not get_settings().synapse_enabled or ref.scheme not in SYNAPSE_SOURCE_SCHEMES:
        return False
    dedupe_key = _scan_dedupe_key(user_id, ref)
    try:
        with db.begin_nested():
            # Free the dedupe key from terminal rows so a fresh scan can
            # enqueue; a non-terminal row keeps the key and the enqueue
            # dedupes. 'failed' rows stay: their retry slot already covers
            # the rescan.
            db.execute(
                text(
                    "DELETE FROM background_jobs"
                    " WHERE dedupe_key = :k AND status IN ('succeeded', 'dead')"
                ),
                {"k": dedupe_key},
            )
            _, inserted = enqueue_unique_job(
                db,
                kind="synapse_scan",
                payload={"user_id": str(user_id), "ref": ref.uri, "reason": reason},
                dedupe_key=dedupe_key,
            )
        return inserted
    except SQLAlchemyError as exc:
        logger.warning("synapse_scan_enqueue_failed", ref=ref.uri, reason=reason, error=str(exc))
        return False


def scan_status(
    db: Session, *, user_id: UUID, ref: ResourceRef
) -> Literal["idle", "pending", "running"]:
    """Scan state for ``ref``: the background-job row is the scan state (D5).

    A ``failed`` row awaiting its retry slot reads as ``pending`` — work is
    still owed. Terminal rows (and no row) read as ``idle``.
    """
    status = db.execute(
        text(
            "SELECT status FROM background_jobs"
            " WHERE dedupe_key = :k AND status IN ('pending', 'running', 'failed')"
        ),
        {"k": _scan_dedupe_key(user_id, ref)},
    ).scalar_one_or_none()
    if status is None:
        return "idle"
    return "running" if status == "running" else "pending"


async def run_synapse_scan(
    db: Session, *, user_id: UUID, ref: ResourceRef, llm: ModelRuntime
) -> Literal["ok", "skipped", "failed"]:
    """Worker body: one dossier → retrieve → judge → replace-set scan.

    ``skipped`` (quiet, no edge changes): engine disabled, source missing or
    not visible, dossier unavailable (media unit not ready, page never
    indexed), or no resolvable API key. ``failed`` (queue retry ladder, prior
    edges intact): rate-limit/budget rejection or LLM/synthesis error. ``ok``
    replace-sets the ``(source, origin='synapse')`` edge set — possibly to
    empty (current-only, D6).

    The provider call is BYOK-first for the scanned object's owner and runs
    inside the shared rate-limit/budget envelope; every attempt is one
    ``llm_calls`` row (owner ``synapse_scan`` = the source object id, AC8).
    """
    if not get_settings().synapse_enabled:
        logger.info("synapse_scan_skipped", ref=ref.uri, reason="disabled")
        return "skipped"
    try:
        assert_ref_visible(db, viewer_id=user_id, ref=ref)
    except NotFoundError:
        logger.info("synapse_scan_skipped", ref=ref.uri, reason="source_missing")
        return "skipped"
    try:
        resolved_key = resolve_api_key(db, user_id, SYNAPSE_PROVIDER, "auto")
    except (ApiError, ModelCallError) as exc:
        logger.info("synapse_scan_skipped", ref=ref.uri, reason="no_api_key", error=str(exc))
        return "skipped"

    rate_limiter = get_rate_limiter()
    try:
        rate_limiter.acquire_inflight_slot(user_id)
    except ApiError as exc:
        logger.warning("synapse_scan_rate_limited", ref=ref.uri, error_code=exc.code.value)
        return "failed"
    budget_reserved = False
    estimated_tokens = 0
    # One reservation id per scan attempt: commit_token_budget charges a
    # reservation id once forever, so a stable id (ref.id) would leave every
    # rescan of the same object unmetered.
    budget_reservation_id = uuid4()
    try:
        dossier = _build_dossier(db, user_id=user_id, ref=ref)
        if dossier is None:
            logger.info("synapse_scan_skipped", ref=ref.uri, reason="dossier_unavailable")
            return "skipped"

        # Retrieval runs before any uncommitted writes in this session
        # (build_query_embedding rolls back a non-entry transaction around its
        # HTTP call); everything up to here is reads only. Over-fetch: the
        # self/kin/connected/suppressed exclusion happens after retrieval, and
        # the source's own chunks often dominate the top hits.
        response = search(
            db,
            user_id,
            SearchQuery(
                text=dossier.query
                if dossier.query is not None
                else dossier.text[:SYNAPSE_QUERY_CHAR_BUDGET],
                requested_kinds=frozenset({"documents", "notes"}),
                limit=min(50, SYNAPSE_CANDIDATE_LIMIT * 4),
            ),
        )
        candidates = _map_candidates(
            response.results,
            excluded=_excluded_refs(db, user_id=user_id, ref=ref, kin=dossier.kin_refs),
        )
        if not candidates:
            # Current-only (D6): the engine currently sees nothing.
            written = replace_edges_for_origin(
                db, viewer_id=user_id, source=ref, origin="synapse", edges=[]
            )
            db.commit()
            logger.info("synapse_scan_completed", ref=ref.uri, edges=len(written))
            return "ok"

        request = _build_llm_request(dossier.text, candidates)
        if resolved_key.mode == "platform":
            estimated_tokens = (
                estimate_tokens("\n".join(turn.content for turn in request.messages))
                + SYNAPSE_MAX_OUTPUT_TOKENS
            )
            try:
                rate_limiter.reserve_token_budget(user_id, budget_reservation_id, estimated_tokens)
                budget_reserved = True
            except ApiError as exc:
                logger.warning(
                    "synapse_scan_budget_rejected", ref=ref.uri, error_code=exc.code.value
                )
                return "failed"

        try:
            result = await run_structured_synthesis(
                llm=LedgeredLLM(
                    db=db,
                    owner=LlmCallOwner(kind="synapse_scan", id=ref.id),
                    router=llm,
                    llm_operation="synapse_scan",
                    key_mode_requested="auto",
                    key_mode_used=resolved_key.mode,
                ),
                request=SynthesisRequest(
                    provider=SYNAPSE_PROVIDER,
                    llm_request=request,
                    api_key=resolved_key.api_key,
                    timeout_s=SYNAPSE_LLM_TIMEOUT_SECONDS,
                ),
                schema=SynapseSynthesis,
            )
        except ModelCallError as exc:
            error_code = api_error_code_for_model_call(exc.error_code).value
            logger.warning("synapse_scan_llm_failure", ref=ref.uri, error_code=error_code)
            if resolved_key.mode == "byok" and error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                update_user_key_status(db, resolved_key.user_key_id, "invalid")
            # Keep the failed-attempt llm_calls rows (and any key-status flip);
            # run_llm_task only closes the session, it never commits.
            db.commit()
            return "failed"
        except StructuredSynthesisError as exc:
            logger.warning("synapse_scan_llm_failure", ref=ref.uri, error=str(exc)[:200])
            db.commit()
            return "failed"

        # Commit the per-attempt llm_calls rows now so a write failure below
        # cannot erase them (media-unit precedent).
        db.commit()
        grounded = (
            ground_indices(
                result.value.connections,
                candidates,
                index_of=lambda connection: connection.candidate_index,
                policy="drop",
            )
            or []
        )
        # Dedupe by target before the cap so a degenerate output repeating one
        # index cannot evict a distinct valid survivor.
        survivors: list[tuple[SynapseConnectionOut, _SynapseCandidate]] = []
        seen_targets: set[ResourceRef] = set()
        for connection, candidate in grounded:
            if candidate.target in seen_targets:
                continue
            seen_targets.add(candidate.target)
            survivors.append((connection, candidate))
        survivors = survivors[:SYNAPSE_MAX_CONNECTIONS]
        # Re-check exclusions in the replace-set's own transaction: a dismiss
        # or a new edge that landed during the up-to-45s provider call must
        # win over this scan, not be overwritten by it.
        recheck_excluded = _excluded_refs(db, user_id=user_id, ref=ref, kin=frozenset())
        survivors = [
            (connection, candidate)
            for connection, candidate in survivors
            if _candidate_exclusion_ref(candidate) not in recheck_excluded
        ]
        written = replace_edges_for_origin(
            db,
            viewer_id=user_id,
            source=ref,
            origin="synapse",
            edges=[
                EdgeCreate(
                    source=ref,
                    target=candidate.target,
                    kind=connection.kind,
                    origin="synapse",
                    snapshot=CitationSnapshot(title=candidate.label, excerpt=connection.rationale),
                )
                for connection, candidate in survivors
            ],
        )
        db.commit()
        if budget_reserved:
            actual_tokens = usage_tokens(result.usage)["total_tokens"]
            rate_limiter.commit_token_budget(
                user_id, budget_reservation_id, actual_tokens or estimated_tokens
            )
            budget_reserved = False
        logger.info("synapse_scan_completed", ref=ref.uri, edges=len(written))
        return "ok"
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(user_id, budget_reservation_id)
        rate_limiter.release_inflight_slot(user_id)


def dismiss_synapse_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Record a permanent suppression for the edge's pair, then delete the edge.

    Conflict-class on a non-synapse origin: the row exists and is the viewer's,
    but only the engine's own assertions are dismissible — other origins keep
    their own delete lanes (user edges via the graph DELETE route). Flush-only;
    the route commits.
    """
    edge = get_owned_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    if edge.origin != "synapse":
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE, "Only synapse edges can be dismissed"
        )
    # Suppression stays media-pair grain (D4): dismissing one span silences the
    # whole work-pair. Normalize an evidence_span target to its owner media so a
    # re-scan's media-grain exclusion (via _candidate_exclusion_ref) blocks every
    # span of that work.
    target = edge.target
    if target.scheme == "evidence_span":
        owner_media_id = db.scalar(
            text("SELECT owner_id FROM evidence_spans WHERE id = :id AND owner_kind = 'media'"),
            {"id": target.id},
        )
        if owner_media_id is not None:
            target = ResourceRef(scheme="media", id=owner_media_id)
    existing = db.execute(
        select(SynapseSuppression.user_id).where(
            SynapseSuppression.user_id == viewer_id,
            SynapseSuppression.source_scheme == edge.source.scheme,
            SynapseSuppression.source_id == edge.source.id,
            SynapseSuppression.target_scheme == target.scheme,
            SynapseSuppression.target_id == target.id,
        )
    ).scalar_one_or_none()
    if existing is None:  # SELECT-then-insert (database.md: no ON CONFLICT)
        try:
            with db.begin_nested():
                db.add(
                    SynapseSuppression(
                        user_id=viewer_id,
                        source_scheme=edge.source.scheme,
                        source_id=edge.source.id,
                        target_scheme=target.scheme,
                        target_id=target.id,
                    )
                )
                db.flush()
        except IntegrityError as exc:
            if integrity_constraint_name(exc) != "synapse_suppressions_pkey":
                raise
            # A concurrent dismiss already recorded the pair (the
            # enqueue_unique_job shape); fall through to the edge delete.
    delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)


# ---------- internal: dossier -------------------------------------------------


@dataclass(frozen=True)
class _Dossier:
    """The judged source text plus its kin, gathered from projections (D4)."""

    text: str
    kin_refs: frozenset[ResourceRef]  # never-candidate refs (highlight's anchor media)
    query: str | None = None  # retrieval-query override; None -> dossier head


def _scan_dedupe_key(user_id: UUID, ref: ResourceRef) -> str:
    return f"synapse_scan:{user_id}:{ref.uri}"


def _build_dossier(db: Session, *, user_id: UUID, ref: ResourceRef) -> _Dossier | None:
    """Per-scheme source text, or ``None`` to skip. Visibility is the caller's."""
    if ref.scheme == "media":
        return _media_dossier(db, media_id=ref.id)
    if ref.scheme == "page":
        return _page_dossier(db, page_id=ref.id)
    if ref.scheme == "note_block":
        return _note_block_dossier(db, user_id=user_id, block_id=ref.id)
    return _highlight_dossier(db, user_id=user_id, highlight_id=ref.id)


def _media_dossier(db: Session, *, media_id: UUID) -> _Dossier | None:
    unit = get_media_unit(db, media_id=media_id)
    if isinstance(unit, NotReady):
        return None
    title = db.execute(select(Media.title).where(Media.id == media_id)).scalar_one_or_none()
    if title is None:
        return None
    claims = "\n".join(f"- {claim.claim_text}" for claim in unit.claims)
    return _Dossier(
        text=f"{title}\n\n{unit.summary_md}\n\n{claims}"[:SYNAPSE_DOSSIER_CHAR_BUDGET],
        kin_refs=frozenset(),
    )


def _page_dossier(db: Session, *, page_id: UUID) -> _Dossier | None:
    title = db.execute(select(Page.title).where(Page.id == page_id)).scalar_one_or_none()
    if title is None:
        return None
    return _Dossier(
        text=str(title)[:SYNAPSE_DOSSIER_CHAR_BUDGET],
        kin_refs=frozenset(),
    )


def _note_block_dossier(db: Session, *, user_id: UUID, block_id: UUID) -> _Dossier | None:
    block = db.execute(
        select(NoteBlock).where(NoteBlock.id == block_id, NoteBlock.user_id == user_id)
    ).scalar_one_or_none()
    if block is None:
        return None
    return _Dossier(
        text=str(block.body_text or "")[:SYNAPSE_DOSSIER_CHAR_BUDGET],
        kin_refs=frozenset(),
    )


def _highlight_dossier(db: Session, *, user_id: UUID, highlight_id: UUID) -> _Dossier | None:
    highlight = db.execute(
        select(Highlight).where(Highlight.id == highlight_id, Highlight.user_id == user_id)
    ).scalar_one_or_none()
    if highlight is None or highlight.anchor_media_id is None:
        return None
    title = db.execute(
        select(Media.title).where(Media.id == highlight.anchor_media_id)
    ).scalar_one_or_none()
    if title is None:
        return None
    notes = linked_note_blocks_for_highlights(db, user_id, [highlight_id]).get(highlight_id, [])
    note_text = "\n".join(block.body_text for block in notes)
    source_text = (
        f'Highlight from "{title}":\n{highlight.prefix}{highlight.exact}{highlight.suffix}'
    )
    if note_text:
        source_text += f"\n\nReader note:\n{note_text}"
    return _Dossier(
        text=source_text[:SYNAPSE_DOSSIER_CHAR_BUDGET],
        kin_refs=frozenset({ResourceRef(scheme="media", id=highlight.anchor_media_id)}),
    )


# ---------- internal: candidates + exclusions ---------------------------------


@dataclass(frozen=True)
class _SynapseCandidate:
    """One judged object: a span/object-grain target plus its display fields (D3).

    ``owner_media_id`` is the containing media for span/media targets (``None``
    for note-block targets); exclusion and the per-work diversity cap compare at
    this containing-work grain, not the span target ref (F-04, §4.2).
    """

    target: ResourceRef
    label: str
    snippet: str
    owner_media_id: UUID | None = None


def _candidate_exclusion_ref(candidate: _SynapseCandidate) -> ResourceRef:
    """The containing-work-grain ref an exclusion set compares against.

    ``_excluded_refs`` collects self/kin/connected/suppressed at ``media``/
    ``note_block`` grain; a span candidate must be tested by its owner media, or
    a suppressed/connected work would not block its evidence-span children.
    """
    if candidate.owner_media_id is not None:
        return ResourceRef(scheme="media", id=candidate.owner_media_id)
    return candidate.target


def _excluded_refs(
    db: Session, *, user_id: UUID, ref: ResourceRef, kin: frozenset[ResourceRef]
) -> set[ResourceRef]:
    """Targets the judge must never see: self, kin, connected, suppressed (D7/D8)."""
    excluded = {ref, *kin}
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=user_id,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(),
                limit=100,
                cursor=cursor,
            ),
        )
        for edge in page.items:
            if edge.origin == "synapse" and edge.source_ref == ref:
                # This scan's own replace-set: keepable targets must stay
                # proposable (AC2); every other edge's pair is already connected.
                continue
            excluded.add(edge.other.ref)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    suppressions = (
        db.execute(
            select(SynapseSuppression).where(
                SynapseSuppression.user_id == user_id,
                or_(
                    and_(
                        SynapseSuppression.source_scheme == ref.scheme,
                        SynapseSuppression.source_id == ref.id,
                    ),
                    and_(
                        SynapseSuppression.target_scheme == ref.scheme,
                        SynapseSuppression.target_id == ref.id,
                    ),
                ),
            )
        )
        .scalars()
        .all()
    )
    for row in suppressions:
        if row.source_scheme == ref.scheme and row.source_id == ref.id:
            other = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
        else:
            other = ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id)
        excluded.add(other)
    return excluded


def _map_candidates(
    results: Sequence[SearchResultOut],
    *,
    excluded: set[ResourceRef],
) -> list[_SynapseCandidate]:
    """Map retrieval hits to deduped candidates, best score first.

    ``content_chunk`` hits map to their chunk's ``evidence_span`` (passage grain,
    §4.2), falling back to ``media`` when the chunk carries no span; ``note_block``
    hits stay block-grain (D3). Results arrive score-sorted, so the first hit per
    target keeps the best snippet. Two chunks of one work dedupe to distinct spans
    (distinct sidenotes), capped at ``SYNAPSE_MAX_CONNECTIONS_PER_WORK`` per work
    (D9) so a text-rich work cannot fill every slot.
    """
    candidates: list[_SynapseCandidate] = []
    seen: set[ResourceRef] = set()
    per_work: dict[UUID, int] = {}
    for result in results:
        if isinstance(result, SearchResultContentChunkOut):
            span_id = result.evidence_span_ids[0] if result.evidence_span_ids else None
            owner_media_id = result.source.media_id
            target = (
                ResourceRef(scheme="evidence_span", id=span_id)
                if span_id is not None
                else ResourceRef(scheme="media", id=owner_media_id)
            )
            candidate = _SynapseCandidate(
                target=target,
                label=result.source.title,
                # Chunk snippets carry ts_headline <b>…</b> markup — noise to
                # the judge.
                snippet=result.snippet.replace("<b>", "").replace("</b>", ""),
                owner_media_id=owner_media_id,
            )
        elif isinstance(result, SearchResultNoteBlockOut):
            body = result.body_text.strip()
            candidate = _SynapseCandidate(
                target=ResourceRef(scheme="note_block", id=result.id),
                label=body.splitlines()[0][:80] if body else "Note",
                # Note bodies are unbounded; clamp to snippet scale.
                snippet=result.body_text[:600],
            )
        else:
            continue
        if _candidate_exclusion_ref(candidate) in excluded or candidate.target in seen:
            continue
        if candidate.owner_media_id is not None:
            if per_work.get(candidate.owner_media_id, 0) >= SYNAPSE_MAX_CONNECTIONS_PER_WORK:
                continue
            per_work[candidate.owner_media_id] = per_work.get(candidate.owner_media_id, 0) + 1
        seen.add(candidate.target)
        candidates.append(candidate)
    return candidates[:SYNAPSE_CANDIDATE_LIMIT]


# ---------- internal: prompt + schema -----------------------------------------


class SynapseConnectionOut(BaseModel):
    """One proposed connection in the model's strict-JSON output."""

    model_config = ConfigDict(extra="forbid")

    candidate_index: int
    kind: Literal["context", "supports", "contradicts"]
    rationale: str

    @field_validator("rationale")
    @classmethod
    def _bounded_rationale(cls, value: str) -> str:
        # Former Field(min_length=1, max_length=240) — kept out of the emitted
        # JSON schema (canonical subset carries no length keywords).
        if not 1 <= len(value) <= 240:
            raise ValueError("rationale must be 1-240 characters")
        return value


class SynapseSynthesis(BaseModel):
    """The strict-JSON resonance judgment shape."""

    model_config = ConfigDict(extra="forbid")

    connections: list[SynapseConnectionOut]


_SYNAPSE_PERSONA = (
    "You are the resonance engine of a personal knowledge system: given one "
    "source object and candidate passages from the user's own corpus, you "
    "judge which candidates genuinely illuminate the source."
)
_SYNAPSE_DOMAIN_RULES = [
    INDEX_GROUNDING_RULE + " Do not invent candidates, indices, or quotations.",
    "Propose only connections where remembering the candidate genuinely "
    "illuminates the source — a shared argument, a direct contradiction, the "
    "same idea in different words, a concrete example; reject mere topical "
    "overlap.",
    f"Propose at most {SYNAPSE_MAX_CONNECTIONS} connections — only the strongest; fewer is better.",
    'Use kind "supports" or "contradicts" only when the relation is genuinely '
    'argued; otherwise use "context".',
    "rationale: one sentence to the user naming the specific resonance, under 200 characters.",
    "Write each rationale so it reads correctly from either object; never use "
    "the words 'source', 'candidate', or indices.",
    "An empty list is a good answer.",
]
_SYNAPSE_JSON_SHAPE = (
    '{"connections": [{"candidate_index": int, '
    '"kind": "context" | "supports" | "contradicts", "rationale": string}]}'
)
_SYNAPSE_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=_SYNAPSE_PERSONA,
    preamble=None,
    domain_rules=_SYNAPSE_DOMAIN_RULES,
    json_shape=_SYNAPSE_JSON_SHAPE,
)


def _build_llm_request(source_text: str, candidates: list[_SynapseCandidate]) -> ModelCall:
    rendered = "\n\n".join(
        f"[{index}] {candidate.label}: {candidate.snippet}"
        for index, candidate in enumerate(candidates)
    )
    return build_synthesis_request(
        provider=SYNAPSE_PROVIDER,
        system_prompt=_SYNAPSE_SYSTEM_PROMPT,
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=f"SOURCE:\n{source_text}",
        model_name=SYNAPSE_MODEL_NAME,
        max_tokens=SYNAPSE_MAX_OUTPUT_TOKENS,
    )
