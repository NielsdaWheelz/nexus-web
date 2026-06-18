"""Black Forest Oracle service.

One file owns reading lifecycle: create, fetch, list, and worker-side
generation. Retrieval, prompt building, LLM call, citation persistence,
and SSE event emission are all linear and explicit here.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from provider_runtime.types import ModelCall
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    OracleCorpusSource,
    OraclePassageAnchor,
    OraclePlate,
    OracleReading,
    OracleReadingEvent,
    OracleReadingFolio,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    NotFoundError,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.jobs.queue import enqueue_job
from nexus.llm_catalog import require_catalog_model
from nexus.logging import get_logger
from nexus.schemas.citation import CitationOut
from nexus.schemas.oracle import (
    ConcordanceEntryOut,
    OracleReadingDetailOut,
    OracleReadingEventOut,
    OracleReadingImageOut,
    OracleReadingPassageOut,
    OracleReadingSummaryOut,
    oracle_done_payload,
    oracle_passage_payload,
)
from nexus.services import oracle_corpus, run_kit
from nexus.services.api_key_resolver import resolve_api_key, update_user_key_status
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner
from nexus.services.oracle_plates import oracle_plate_url
from nexus.services.prompt_budget import estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    concordant_sources,
    record_citation,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
)
from nexus.services.search.content_chunk_candidates import (
    ContentChunkCandidate,
    has_searchable_content_chunks,
    retrieve_content_chunk_candidates,
)
from nexus.services.search.embedding import build_query_embedding
from nexus.services.search.query import SearchScope
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

ORACLE_MODEL_NAME = "claude-haiku-4-5-20251001"
ORACLE_PROVIDER = "anthropic"
require_catalog_model(
    ORACLE_PROVIDER, ORACLE_MODEL_NAME
)  # code/catalog mismatch = import-time defect
ORACLE_MAX_OUTPUT_TOKENS = 2000
ORACLE_LLM_TIMEOUT_SECONDS = 45
ORACLE_PUBLIC_DOMAIN_CANDIDATES = 6
ORACLE_USER_LIBRARY_CANDIDATES = 4
ORACLE_FOLIO_ALLOCATE_ATTEMPTS = 8
ORACLE_MAX_PLATE_DIMENSION = 4096  # image-bomb guard on plate selection
ORACLE_THEMES: tuple[str, ...] = (
    "Of Time",
    "Of Death",
    "Of the Threshold",
    "Of Vanity",
    "Of Solitude",
    "Of Love",
    "Of Fortune",
    "Of Memory",
    "Of the Self",
    "Of the Other",
    "Of Fear",
    "Of Courage",
    "Of Faith",
    "Of Doubt",
    "Of Power",
    "Of Wisdom",
    "Of the Body",
    "Of the Soul",
    "Of Origins",
    "Of Endings",
    "Of Silence",
    "Of the Word",
    "Of Justice",
    "Of Mercy",
)  # 24 entries; mirrors the DB CHECK
ORACLE_TOKEN_RE = re.compile(r"[a-z]{3,}")
ORACLE_PHASES: tuple[str, str, str] = ("descent", "ordeal", "ascent")
# Typed cause when the worker finds the corpus library/media/index/anchors not ready (§10.5).
E_ORACLE_CORPUS_NOT_READY = "E_ORACLE_CORPUS_NOT_READY"
ORACLE_URL_RE = re.compile(r"\b(?:https?://|www\.)", re.IGNORECASE)
ORACLE_CITATION_MARKER_RE = re.compile(
    r"(\[[0-9]+\]"
    r"|\b(?:canto|book|chapter|ch\.|verse|line|lines|page|pages|p\.|pp\.)\s+"
    r"(?:[ivxlcdm]+|\d+)"
    r"|\b[ivxlcdm]{1,8}\.\d+(?:[-–]\d+)?\b"
    r"|\b\d+:\d+(?:[-–]\d+)?\b)",
    re.IGNORECASE,
)


# ---------- create / fetch / list -------------------------------------------


def create_reading(
    db: Session,
    *,
    viewer_id: UUID,
    question: str,
    idempotency_key: str | None = None,
) -> OracleReading:
    """Insert one pending reading row and enqueue its generation job.

    The question is strip+length validated once at the boundary
    (OracleReadingCreateRequest: str_strip_whitespace + min/max_length), the
    optional ``Idempotency-Key`` at the route edge (Header min/max_length,
    exactly like LI generate). A reused key replays the existing reading (LI
    replay semantics: same key, same reading; no payload hash) before any
    pre-enqueue control runs.
    """
    if idempotency_key is not None:
        existing = _get_reading_by_idempotency_key(db, viewer_id, idempotency_key)
        if existing is not None:
            return existing

    _validate_oracle_pre_enqueue_controls(viewer_id=viewer_id)

    for attempt in range(ORACLE_FOLIO_ALLOCATE_ATTEMPTS):
        try:
            reading = _insert_reading_with_next_folio(
                db,
                viewer_id=viewer_id,
                question=question,
                idempotency_key=idempotency_key,
            )
            db.commit()
            db.refresh(reading)
            return reading
        except IntegrityError as exc:
            db.rollback()
            if idempotency_key is not None and _is_oracle_idempotency_conflict(exc):
                existing = _get_reading_by_idempotency_key(db, viewer_id, idempotency_key)
                if existing is not None:
                    return existing
                raise
            if not _is_oracle_folio_conflict(exc) or attempt == ORACLE_FOLIO_ALLOCATE_ATTEMPTS - 1:
                raise
        except Exception:
            db.rollback()
            raise

    raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to allocate Oracle folio")


def _get_reading_by_idempotency_key(
    db: Session, viewer_id: UUID, idempotency_key: str
) -> OracleReading | None:
    return (
        db.execute(
            select(OracleReading).where(
                OracleReading.user_id == viewer_id,
                OracleReading.idempotency_key == idempotency_key,
            )
        )
        .scalars()
        .first()
    )


def _insert_reading_with_next_folio(
    db: Session,
    *,
    viewer_id: UUID,
    question: str,
    idempotency_key: str | None,
) -> OracleReading:
    max_folio = db.scalar(
        select(func.max(OracleReading.folio_number)).where(OracleReading.user_id == viewer_id)
    )
    next_folio = (max_folio or 0) + 1
    reading = OracleReading(
        user_id=viewer_id,
        folio_number=next_folio,
        question_text=question,
        status="pending",
        idempotency_key=idempotency_key,
    )
    db.add(reading)
    db.flush()

    enqueue_job(
        db,
        kind="oracle_reading_generate",
        payload={"reading_id": str(reading.id)},
    )
    return reading


def _is_oracle_folio_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_oracle_readings_user_folio"
    return "uix_oracle_readings_user_folio" in str(exc)


def _is_oracle_idempotency_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uq_oracle_readings_user_idempotency_key"
    return "uq_oracle_readings_user_idempotency_key" in str(exc)


def get_reading_detail(
    db: Session,
    *,
    viewer_id: UUID,
    reading_id: UUID,
) -> OracleReadingDetailOut:
    """Return the full reading record with persisted events for hydration.

    Passage display data is split across the folio row (phase, marginalia,
    attribution, locator label) and its citation edge snapshot (snippet, deep
    link); this read joins the two back into the unchanged wire shape (§5.3).
    """
    reading = _get_reading_owned_by(db, viewer_id=viewer_id, reading_id=reading_id)
    folio_rows = (
        db.execute(select(OracleReadingFolio).where(OracleReadingFolio.reading_id == reading_id))
        .scalars()
        .all()
    )
    reading_ref = ResourceRef(scheme="oracle_reading", id=reading_id)
    edge_by_id = {}
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(reading_ref,),
                direction="outgoing",
                rollup="exact",
                filters=ConnectionFilters(origins=("citation",)),
                limit=100,
                cursor=cursor,
            ),
        )
        edge_by_id.update({edge.edge_id: edge for edge in page.items if edge.ordinal is not None})
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    # The clickable in-reader jump (AC8) is the shared edge-built CitationOut read
    # model (G6): build_citation_outs is the sole producer; it reconstructs
    # (media_id, locator) from each target's own anchoring. Keyed by ordinal
    # (descent 1, ordeal 2, ascent 3); _surfaced_passage_citation then decides
    # which phases render a chip vs. stay typographic.
    citation_by_ordinal: dict[int, CitationOut] = {
        citation.ordinal: citation
        for citation in build_citation_outs(db, viewer_id=viewer_id, source=reading_ref)
    }
    event_rows = (
        db.execute(
            select(OracleReadingEvent)
            .where(OracleReadingEvent.reading_id == reading_id)
            .order_by(OracleReadingEvent.seq)
        )
        .scalars()
        .all()
    )
    image_out: OracleReadingImageOut | None = None
    if reading.image_id is not None:
        image = db.get(OraclePlate, reading.image_id)
        if image is None:
            raise ApiError(
                ApiErrorCode.E_INTERNAL,
                "Oracle reading references a missing image",
            )
        image_out = OracleReadingImageOut(**_oracle_image_payload(image))
    folios_sorted = sorted(
        folio_rows,
        key=lambda row: ORACLE_PHASES.index(row.phase)
        if row.phase in ORACLE_PHASES
        else len(ORACLE_PHASES),
    )
    passages: list[OracleReadingPassageOut] = []
    for row in folios_sorted:
        edge = edge_by_id.get(row.edge_id)
        # justify-defect: the folio row and its citation edge are written in one
        # transaction; a missing edge or snapshot means the pair was torn.
        assert edge is not None and edge.snapshot is not None and edge.ordinal is not None, (
            f"oracle folio (reading {row.reading_id}, phase {row.phase}) "
            f"lost its citation edge {row.edge_id}"
        )
        passages.append(
            OracleReadingPassageOut(
                phase=row.phase,
                source_kind=row.source_kind,
                exact_snippet=edge.snapshot.excerpt or "",
                locator_label=row.locator_label,
                attribution_text=row.attribution_text,
                marginalia_text=row.marginalia_text,
                deep_link=edge.snapshot.deep_link,
                citation=_surfaced_passage_citation(citation_by_ordinal.get(edge.ordinal)),
            )
        )
    return OracleReadingDetailOut(
        id=reading.id,
        folio_number=reading.folio_number,
        folio_motto=reading.folio_motto,
        folio_motto_gloss=reading.folio_motto_gloss,
        folio_theme=reading.folio_theme,
        argument_text=reading.argument_text,
        question_text=reading.question_text,
        status=reading.status,
        image=image_out,
        passages=passages,
        events=[
            OracleReadingEventOut(
                seq=row.seq, event_type=row.event_type, payload=dict(row.payload or {})
            )
            for row in event_rows
        ],
        created_at=reading.created_at,
        started_at=reading.started_at,
        completed_at=reading.completed_at,
        failed_at=reading.failed_at,
        error_code=reading.error_code,
    )


def list_all_readings(db: Session, *, viewer_id: UUID) -> list[OracleReadingSummaryOut]:
    """Return all of the viewer's readings with plate thumbnail data."""
    rows = (
        db.execute(
            text(
                """
                SELECT
                    r.id,
                    r.folio_number,
                    r.folio_motto,
                    r.folio_motto_gloss,
                    r.folio_theme,
                    r.question_text,
                    r.status,
                    r.created_at,
                    r.completed_at,
                    r.failed_at,
                    r.image_id,
                    img.work_title AS image_work_title,
                    img.attribution_text AS image_attribution_text
                FROM oracle_readings r
                LEFT JOIN oracle_plates img ON img.id = r.image_id
                WHERE r.user_id = :viewer_id
                ORDER BY r.created_at DESC
                """
            ),
            {"viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )
    out: list[OracleReadingSummaryOut] = []
    for row in rows:
        plate_thumbnail_url: str | None = None
        plate_alt_text: str | None = None
        if row["image_id"] is not None:
            plate_thumbnail_url = oracle_plate_url(row["image_id"])
            plate_alt_text = (
                f"{row['image_work_title']} — {row['image_attribution_text']}"
                if row["image_work_title"] and row["image_attribution_text"]
                else None
            )
        out.append(
            OracleReadingSummaryOut(
                id=row["id"],
                folio_number=row["folio_number"],
                folio_motto=row["folio_motto"],
                folio_motto_gloss=row["folio_motto_gloss"],
                folio_theme=row["folio_theme"],
                plate_thumbnail_url=plate_thumbnail_url,
                plate_alt_text=plate_alt_text,
                question_text=row["question_text"],
                status=row["status"],
                created_at=row["created_at"],
                completed_at=row["completed_at"],
                failed_at=row["failed_at"],
            )
        )
    return out


def compute_concordance(
    db: Session,
    *,
    viewer_id: UUID,
    reading_id: UUID,
) -> list[ConcordanceEntryOut]:
    """Return up to 5 prior folios that echo this reading (same plate, theme, or passage).

    Two readings share a passage iff their citation edges have equal
    ``(target_scheme, target_id)`` (§5.3) — locators and snapshots are excluded
    from the key, so a content reindex between two readings is a deliberate
    non-match on user-media targets.
    """
    reference = _get_reading_owned_by(db, viewer_id=viewer_id, reading_id=reading_id)
    if reference.status != "complete":
        return []

    shared_target_counts = {
        entry.source.id: entry.shared_target_count
        for entry in concordant_sources(
            db,
            viewer_id=viewer_id,
            source=ResourceRef(scheme="oracle_reading", id=reading_id),
            source_scheme="oracle_reading",
        )
    }
    candidates = (
        db.execute(
            select(OracleReading).where(
                OracleReading.user_id == viewer_id,
                OracleReading.status == "complete",
                OracleReading.id != reading_id,
                OracleReading.folio_motto.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    scored: list[tuple[int, datetime, ConcordanceEntryOut]] = []
    for candidate in candidates:
        shared_plate = candidate.image_id is not None and candidate.image_id == reference.image_id
        shared_theme = (
            candidate.folio_theme is not None and candidate.folio_theme == reference.folio_theme
        )
        shared_passage_count = shared_target_counts.get(candidate.id, 0)
        score = 2 * int(shared_plate) + 2 * int(shared_theme) + shared_passage_count
        if score == 0:
            continue
        scored.append(
            (
                score,
                candidate.created_at,
                ConcordanceEntryOut(
                    id=candidate.id,
                    folio_number=candidate.folio_number,
                    folio_motto=candidate.folio_motto or "",
                    folio_theme=candidate.folio_theme,
                    shared_plate=shared_plate,
                    shared_theme=shared_theme,
                    shared_passage_count=shared_passage_count,
                ),
            )
        )
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [entry for _score, _created_at, entry in scored[:5]]


def _validate_oracle_pre_enqueue_controls(*, viewer_id: UUID) -> None:
    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    rate_limiter.check_token_budget(viewer_id)


# ---------- SSE handler dependencies ----------------------------------------


def assert_reading_owner(db: Session, *, viewer_id: UUID, reading_id: UUID) -> None:
    """Raise NotFoundError unless the reading is owned by viewer_id."""
    _get_reading_owned_by(db, viewer_id=viewer_id, reading_id=reading_id)


def get_reading_events(db: Session, *, reading_id: UUID, after: int) -> list[OracleReadingEventOut]:
    rows = (
        db.execute(
            select(OracleReadingEvent)
            .where(
                OracleReadingEvent.reading_id == reading_id,
                OracleReadingEvent.seq > after,
            )
            .order_by(OracleReadingEvent.seq)
        )
        .scalars()
        .all()
    )
    return [
        OracleReadingEventOut(
            seq=row.seq, event_type=row.event_type, payload=dict(row.payload or {})
        )
        for row in rows
    ]


def is_reading_terminal(db: Session, *, reading_id: UUID) -> bool:
    status = db.execute(
        select(OracleReading.status).where(OracleReading.id == reading_id)
    ).scalar_one_or_none()
    # A missing row (reading deleted mid-stream) is terminal — otherwise the SSE
    # tail would stream forever. assert_reading_owner proved it existed at open.
    # The terminal set has one owner (run_kit).
    return status is None or status in run_kit.terminal_statuses(
        run_kit.RunStreamKind.OracleReading
    )


# ---------- worker entrypoint -----------------------------------------------


@dataclass(frozen=True)
class _Candidate:
    """One retrieved passage offered to the LLM by index."""

    source_kind: str  # "public_domain" | "user_media"
    exact_snippet: str
    locator_label: str
    attribution_text: str
    deep_link: str | None
    title: str  # source title for the citation snapshot
    target: ResourceRef  # stable citation target (§5.3)
    tags: list[str]
    score: float


def _surfaced_passage_citation(citation: CitationOut | None) -> CitationOut | None:
    """The CitationOut a passage shows as a chip, or None for a typographic passage.

    Every phase writes a citation edge (§5.3), but only a passage with a live
    shared reader/note locator renders a chip (``OracleReadingPassageOut.citation``).
    Resolved public-domain anchors can surface a chip; unresolved, span-less, or
    deleted backing targets degrade to typographic-only (citation=None).
    """
    if citation is not None and citation.locator is not None:
        return citation
    return None


async def execute_reading(
    db: Session,
    *,
    reading_id: UUID,
    llm_router: ModelRuntime,
) -> dict[str, Any]:
    """Worker job body: pick plate, retrieve passages, call LLM, persist, stream."""
    reading = _get_reading_or_fail(db, reading_id)
    if reading.status != "pending":
        # Replay of an already-claimed job; refuse rather than emit twice.
        status = reading.status
        db.commit()
        return {"status": status, "noop": True}

    question = reading.question_text
    viewer_id = reading.user_id
    folio_number = reading.folio_number

    try:
        resolved = resolve_api_key(db, viewer_id, ORACLE_PROVIDER, "auto")
    except ModelCallError as exc:
        error_code = api_error_code_for_model_call(exc.error_code).value
        _fail(db, reading, code=error_code, detail=exception_error_detail(exc))
        return {"status": "failed", "error_code": error_code}
    except ApiError as exc:
        _fail(db, reading, code=exc.code.value, detail=exc.message)
        return {"status": "failed", "error_code": exc.code.value}

    rate_limiter = get_rate_limiter()
    inflight_acquired = False
    budget_reserved = False
    estimated_tokens = 0

    try:
        try:
            rate_limiter.acquire_inflight_slot(viewer_id)
            inflight_acquired = True
        except ApiError as exc:
            _fail(db, reading, code=exc.code.value, detail=exc.message)
            return {"status": "failed", "error_code": exc.code.value}

        readiness = oracle_corpus.get_oracle_corpus_readiness(db)
        if readiness.status != "ready" or readiness.library_id is None:
            _fail(
                db,
                reading,
                code=E_ORACLE_CORPUS_NOT_READY,
                detail=(
                    f"corpus not ready: {readiness.ready_media_count}/{readiness.work_count} media, "
                    f"{readiness.resolved_anchor_count}/{readiness.anchor_count} anchors, "
                    f"{readiness.ready_plate_count}/{readiness.plate_count} plates"
                ),
            )
            return {"status": "failed", "error_code": E_ORACLE_CORPUS_NOT_READY}

        try:
            # One active-model query embedding feeds both corpus and personal retrieval;
            # there is no separate Oracle corpus embedding model (G4/§10.1).
            query_embedding = build_query_embedding(
                db, question, ["content_chunk"], transaction_active_at_entry=False
            )
            if query_embedding is None:
                raise ApiError(
                    ApiErrorCode.E_APP_SEARCH_FAILED,
                    "Oracle requires semantic embeddings, which are unavailable",
                )
            corpus_media_ids = _oracle_corpus_media_ids(db)
            candidates = _oracle_corpus_candidates(
                db,
                viewer_id=viewer_id,
                question=question,
                query_embedding=query_embedding,
                library_id=readiness.library_id,
            )
            requires_user_content = _viewer_has_searchable_user_content(db, viewer_id=viewer_id)
            if requires_user_content:
                candidates = [
                    *candidates,
                    *_personal_candidates(
                        db,
                        viewer_id=viewer_id,
                        query_embedding=query_embedding,
                        corpus_media_ids=corpus_media_ids,
                    ),
                ]
            plate = _pick_plate(db, question=question, candidates=candidates)
        except ApiError as exc:
            _fail(db, reading, code=exc.code.value, detail=exc.message)
            return {"status": "failed", "error_code": exc.code.value}

        if len(candidates) < 3:
            _fail(
                db, reading, code="E_INTERNAL", detail="fewer than 3 candidate passages retrieved"
            )
            return {"status": "failed", "error_code": "E_INTERNAL"}
        if requires_user_content and not _candidate_set_includes_user_media(candidates):
            _fail(
                db,
                reading,
                code=ApiErrorCode.E_APP_SEARCH_FAILED.value,
                detail="user content is searchable but yielded no user_media candidate",
            )
            return {"status": "failed", "error_code": ApiErrorCode.E_APP_SEARCH_FAILED.value}

        request = _build_llm_request(
            question=question,
            candidates=candidates,
        )
        estimated_tokens = (
            estimate_tokens("\n".join(turn.content for turn in request.messages))
            + ORACLE_MAX_OUTPUT_TOKENS
        )
        if resolved.mode == "platform":
            try:
                rate_limiter.reserve_token_budget(viewer_id, reading_id, estimated_tokens)
                budget_reserved = True
            except ApiError as exc:
                reading = _get_reading(db, reading_id)
                if reading is None:
                    raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found") from exc
                _fail(db, reading, code=exc.code.value, detail=exc.message)
                return {"status": "failed", "error_code": exc.code.value}

        reading = _get_reading_or_fail(db, reading_id)
        if reading.status != "pending":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        reading.status = "streaming"
        reading.started_at = db.scalar(select(func.now()))
        db.flush()
        run_kit.append_event(
            db,
            stream=run_kit.oracle_reading_stream(reading),
            event_type="meta",
            payload={"question": question, "folio_number": folio_number},
        )
        db.commit()

        # The semantic validator runs inside run_structured_synthesis so the one
        # bounded repair round covers oracle's dominant semantic-rejection
        # failure class; the hook stashes the accepted decomposition.
        accepted: list[_OracleReadingParts] = []

        def _validate(parsed: _OracleSynthesisOutput) -> str | None:
            outcome = _validate_oracle_output(parsed, candidates=candidates)
            if outcome is None:
                return "the JSON violates the reading rules in the system prompt"
            if requires_user_content and not _selected_user_media(candidates, outcome[4]):
                return "select at least one source_kind=user_media candidate among the three phases"
            accepted.clear()
            accepted.append(outcome)
            return None

        try:
            result = await run_structured_synthesis(
                llm=LedgeredLLM(
                    db=db,
                    owner=LlmCallOwner(kind="oracle_reading", id=reading_id),
                    router=llm_router,
                    llm_operation="oracle_reading",
                    key_mode_requested="auto",
                    key_mode_used=resolved.mode,
                ),
                request=SynthesisRequest(
                    provider=ORACLE_PROVIDER,
                    llm_request=request,
                    api_key=resolved.api_key,
                    timeout_s=ORACLE_LLM_TIMEOUT_SECONDS,
                ),
                schema=_OracleSynthesisOutput,
                validate=_validate,
            )
        except ModelCallError as exc:
            error_code = api_error_code_for_model_call(exc.error_code).value
            logger.warning(
                "oracle.llm_error",
                reading_id=str(reading_id),
                llm_error_code=exc.error_code.value,
                api_error_code=error_code,
            )
            reading = _get_reading(db, reading_id)
            if reading is None:
                raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found") from exc
            if error_code == ApiErrorCode.E_LLM_INVALID_KEY.value and resolved.mode == "byok":
                update_user_key_status(db, resolved.user_key_id, "invalid")
            _fail(db, reading, code=error_code, detail=exception_error_detail(exc))
            return {"status": "failed", "error_code": error_code}
        except StructuredSynthesisError as exc:
            logger.warning(
                "oracle.llm_unparseable",
                reading_id=str(reading_id),
                reason=str(exc),
            )
            reading = _get_reading_or_fail(db, reading_id)
            _fail(db, reading, code="E_LLM_BAD_REQUEST", detail=str(exc))
            return {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}

        # Commit the per-attempt llm_calls rows now so they survive whatever the
        # finalization does (a later worker-boundary rollback must not erase them).
        db.commit()
        usage = result.usage
        if not accepted:
            # justify-defect: run_structured_synthesis returns only after
            # _validate accepted the output and stashed the decomposition.
            raise AssertionError("oracle synthesis returned without a validated output")
        argument, motto, gloss, theme, by_phase, interpretation, omens = accepted[-1]

        reading = _get_reading_or_fail(db, reading_id)
        if reading.status != "streaming":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        interpretation_text = interpretation.strip()
        reading.folio_motto = motto
        reading.folio_motto_gloss = gloss
        reading.folio_theme = theme
        reading.argument_text = argument
        reading.image_id = plate.id
        reading.interpretation_text = interpretation_text  # canonical store; delta is replay
        db.flush()

        reading_stream = run_kit.oracle_reading_stream(reading)
        run_kit.append_event(
            db,
            stream=reading_stream,
            event_type="bind",
            payload={
                "folio_motto": motto,
                "folio_motto_gloss": gloss,
                "folio_theme": theme,
            },
        )
        run_kit.append_event(
            db, stream=reading_stream, event_type="argument", payload={"text": argument}
        )
        run_kit.append_event(
            db, stream=reading_stream, event_type="plate", payload=_oracle_image_payload(plate)
        )
        db.commit()

        reading_ref = ResourceRef(scheme="oracle_reading", id=reading_id)
        for ordinal, phase in enumerate(ORACLE_PHASES, start=1):
            idx, marginalia = by_phase[phase]
            candidate = candidates[idx]
            # One citation edge plus one oracle-owned folio row per phase, in
            # the same per-phase transaction (§5.3): the edge carries identity
            # (target) and display snapshot; the folio carries generated content.
            edge = record_citation(
                db,
                viewer_id=viewer_id,
                source=reading_ref,
                target=candidate.target,
                ordinal=ordinal,
                kind="context",
                snapshot=CitationSnapshot(
                    title=candidate.title,
                    excerpt=candidate.exact_snippet,
                    section_label=candidate.locator_label,
                    result_type=candidate.target.scheme,
                    deep_link=candidate.deep_link,
                ),
            )
            db.add(
                OracleReadingFolio(
                    reading_id=reading_id,
                    phase=phase,
                    edge_id=edge.id,
                    source_kind=candidate.source_kind,
                    locator_label=candidate.locator_label,
                    attribution_text=candidate.attribution_text,
                    marginalia_text=marginalia,
                )
            )
            db.flush()
            # The streamed passage chip and the REST detail chip are one shape:
            # the edge-built CitationOut read model (G6). build_citation_outs is
            # the sole producer; the just-flushed edge is visible to it, and its
            # ordinal selects this phase's chip (descent 1, ordeal 2, ascent 3).
            # Any target with a live shared locator surfaces a chip, including
            # resolved public-domain anchors; stale/span-less targets stay typographic.
            citation = _surfaced_passage_citation(
                next(
                    (
                        out
                        for out in build_citation_outs(db, viewer_id=viewer_id, source=reading_ref)
                        if out.ordinal == ordinal
                    ),
                    None,
                )
            )
            run_kit.append_event(
                db,
                stream=reading_stream,
                event_type="passage",
                payload=oracle_passage_payload(
                    phase=phase,
                    source_kind=candidate.source_kind,
                    exact_snippet=candidate.exact_snippet,
                    locator_label=candidate.locator_label,
                    attribution_text=candidate.attribution_text,
                    marginalia_text=marginalia,
                    deep_link=candidate.deep_link,
                    citation=citation,
                ),
            )
            db.commit()

        run_kit.append_event(
            db,
            stream=reading_stream,
            event_type="delta",
            payload={"text": interpretation_text},
        )
        db.commit()
        omens_payload: run_kit.RunEventPayload = {"lines": list(omens)}
        run_kit.append_event(db, stream=reading_stream, event_type="omens", payload=omens_payload)
        db.commit()

        reading = _get_reading_or_fail(db, reading_id)
        if reading.status != "streaming":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        if resolved.mode == "byok":
            update_user_key_status(db, resolved.user_key_id, "valid")
        run_kit.mark_terminal(
            db,
            stream=run_kit.oracle_reading_stream(reading),
            status="complete",
            done_payload=oracle_done_payload(status="complete", error_code=None),
        )
        db.commit()

        if budget_reserved:
            actual_tokens = (usage.total_tokens if usage is not None else None) or estimated_tokens
            rate_limiter.commit_token_budget(viewer_id, reading_id, actual_tokens)
            budget_reserved = False

        return {
            "status": "complete",
            "folio_number": folio_number,
            "input_tokens": usage.input_tokens if usage else None,
            "output_tokens": usage.output_tokens if usage else None,
        }
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(viewer_id, reading_id)
        if inflight_acquired:
            rate_limiter.release_inflight_slot(viewer_id)


# ---------- internal: ownership ---------------------------------------------


def _get_reading_owned_by(db: Session, *, viewer_id: UUID, reading_id: UUID) -> OracleReading:
    reading = db.get(OracleReading, reading_id)
    if reading is None or reading.user_id != viewer_id:
        raise NotFoundError(message="Oracle reading not found")
    return reading


def _get_reading(db: Session, reading_id: UUID) -> OracleReading | None:
    return db.get(OracleReading, reading_id, populate_existing=True)


def _get_reading_or_fail(db: Session, reading_id: UUID) -> OracleReading:
    """Load a reading or raise E_NOT_FOUND; the worker form that defects on missing rows."""
    reading = _get_reading(db, reading_id)
    if reading is None:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
    return reading


def _candidate_set_includes_user_media(candidates: Sequence[_Candidate]) -> bool:
    return any(candidate.source_kind == "user_media" for candidate in candidates)


def _selected_user_media(
    candidates: Sequence[_Candidate],
    by_phase: dict[str, tuple[int, str]],
) -> bool:
    return any(
        candidates[idx].source_kind == "user_media" for idx, _marginalia in by_phase.values()
    )


def _viewer_has_searchable_user_content(db: Session, *, viewer_id: UUID) -> bool:
    return has_searchable_content_chunks(
        db,
        viewer_id=viewer_id,
        scope=SearchScope(kind="all"),
        exclude_media_ids=_oracle_corpus_media_ids(db),
    )


# ---------- internal: SSE event emit ----------------------------------------


def _oracle_image_payload(image: OraclePlate) -> dict[str, Any]:
    return {
        "url": oracle_plate_url(image.id),
        "attribution_text": image.attribution_text,
        "artist": image.artist,
        "work_title": image.work_title,
        "year": image.year,
        "width": image.width,
        "height": image.height,
    }


def _fail(db: Session, reading: OracleReading, *, code: str, detail: str | None = None) -> None:
    """Terminal failure: the one normalized ``done {status, error_code}`` event.

    ``run_kit.mark_terminal`` stamps ``failed_at``/``error_code``/``error_detail``
    on the reading (``detail`` is operator-facing and never reaches the wire;
    the FE owns failure copy keyed on ``error_code``).
    """
    run_kit.mark_terminal(
        db,
        stream=run_kit.oracle_reading_stream(reading),
        status="failed",
        done_payload=oracle_done_payload(status="failed", error_code=code),
        error_code=code,
        error_detail=detail[:1000] if detail is not None else None,
    )
    db.commit()


# ---------- internal: retrieval ---------------------------------------------


def _oracle_corpus_media_ids(db: Session) -> set[UUID]:
    return set(db.execute(select(OracleCorpusSource.media_id)).scalars().all())


def _oracle_corpus_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    question: str,
    query_embedding: tuple[str, list[float]],
    library_id: UUID,
) -> list[_Candidate]:
    """Public-domain candidates: shared library-scoped chunk retrieval mapped to resolved anchors.

    Only retrieved chunks a resolved anchor points at become candidates (cited as
    ``oracle_passage_anchor``, the stable identity). They are boosted by anchor
    tag/phase/question-token overlap and deduped to one per work (§10.3). The reader
    jump is rebuilt from the anchor's current evidence by the CitationOut, so the
    candidate carries no Oracle-owned deep link (§12.1).
    """
    tokens = set(ORACLE_TOKEN_RE.findall(question.lower()))
    by_chunk: dict[UUID, tuple[OraclePassageAnchor, OracleCorpusSource]] = {}
    by_span: dict[UUID, tuple[OraclePassageAnchor, OracleCorpusSource]] = {}
    for anchor, source in db.execute(
        select(OraclePassageAnchor, OracleCorpusSource)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OraclePassageAnchor.resolution_status == "resolved")
    ).all():
        if anchor.current_content_chunk_id is not None:
            by_chunk[anchor.current_content_chunk_id] = (anchor, source)
        if anchor.current_evidence_span_id is not None:
            by_span[anchor.current_evidence_span_id] = (anchor, source)

    scored: list[tuple[float, _Candidate, UUID]] = []
    for cand in retrieve_content_chunk_candidates(
        db,
        viewer_id=viewer_id,
        query_embedding=query_embedding,
        scope=SearchScope(kind="library", id=library_id),
    ):
        mapped = by_chunk.get(cand.content_chunk_id)
        if mapped is None and cand.primary_evidence_span_id is not None:
            mapped = by_span.get(cand.primary_evidence_span_id)
        if mapped is None:
            continue
        anchor, source = mapped
        tags = [str(tag) for tag in anchor.tags or []]
        boost = sum(2.0 for tag in tags if tag.lower() in tokens) + sum(
            1.0 for hint in anchor.phase_hints or [] if str(hint).lower() in tokens
        )
        scored.append(
            (
                cand.semantic_score + boost,
                _Candidate(
                    source_kind="public_domain",
                    exact_snippet=cand.chunk_text[:1200],
                    locator_label=anchor.display_label,
                    attribution_text=(
                        f"{source.author_text} opened to *{source.title}* — {anchor.display_label}."
                    ),
                    deep_link=None,
                    title=source.title,
                    target=ResourceRef(scheme="oracle_passage_anchor", id=anchor.id),
                    tags=tags,
                    score=cand.semantic_score + boost,
                ),
                source.id,
            )
        )
    scored.sort(key=lambda item: (-item[0], item[1].exact_snippet))
    chosen: list[_Candidate] = []
    used_sources: set[UUID] = set()
    for _score, candidate, source_id in scored:
        if source_id in used_sources:
            continue
        used_sources.add(source_id)
        chosen.append(candidate)
        if len(chosen) >= ORACLE_PUBLIC_DOMAIN_CANDIDATES:
            break
    return chosen


def _personal_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding: tuple[str, list[float]],
    corpus_media_ids: set[UUID],
) -> list[_Candidate]:
    """Personal candidates from the viewer's visible media/notes, excluding the corpus library."""
    chosen: list[_Candidate] = []
    used_owners: set[tuple[str, UUID]] = set()
    for cand in retrieve_content_chunk_candidates(
        db, viewer_id=viewer_id, query_embedding=query_embedding, scope=SearchScope(kind="all")
    ):
        if cand.owner_kind == "media" and cand.owner_id in corpus_media_ids:
            continue
        owner_key = (cand.owner_kind, cand.owner_id)
        if owner_key in used_owners:
            continue
        used_owners.add(owner_key)
        chosen.append(_candidate_from_chunk(cand))
        if len(chosen) >= ORACLE_USER_LIBRARY_CANDIDATES:
            break
    chosen.sort(key=lambda candidate: (-candidate.score, candidate.exact_snippet))
    return chosen


def _candidate_from_chunk(cand: ContentChunkCandidate) -> _Candidate:
    locator_label = _content_chunk_locator_label(cand.title, cand.heading_path)
    # Cite the evidence span the chunk grounds to, falling back to the chunk itself
    # when no span exists (§5.3). A media-owned span carries the in-reader jump in its
    # snapshot deep link; note-owned chunks resolve through the CitationOut locator.
    span_id = cand.primary_evidence_span_id
    target = (
        ResourceRef(scheme="evidence_span", id=span_id)
        if span_id is not None
        else ResourceRef(scheme="content_chunk", id=cand.content_chunk_id)
    )
    deep_link = (
        f"/media/{cand.owner_id}#evidence-{span_id}"
        if span_id is not None and cand.owner_kind == "media"
        else None
    )
    return _Candidate(
        source_kind="user_media",
        exact_snippet=cand.chunk_text[:1200],
        locator_label=locator_label,
        attribution_text=f"From *{cand.title}*, your library.",
        deep_link=deep_link,
        title=cand.title,
        target=target,
        tags=["user-library", cand.source_kind],
        score=cand.semantic_score,
    )


def _content_chunk_locator_label(media_title: str, heading_path: list[str]) -> str:
    if heading_path:
        heading = " / ".join(heading_path[-2:])
        return f"From your library: {media_title} - {heading}"
    return f"From your library: {media_title}"


def _pick_plate(db: Session, *, question: str, candidates: Sequence[_Candidate]) -> OraclePlate:
    """Deterministically select a safe plate by tag overlap with the question + candidates (D7).

    No text embeddings: score each plate's tags against the question tokens and the selected
    candidates' tags; tie-break by ``source_url`` for stable selection. Readiness guarantees
    at least one plate exists.
    """
    signal = {tag.lower() for candidate in candidates for tag in candidate.tags} | set(
        ORACLE_TOKEN_RE.findall(question.lower())
    )
    safe_plates = [
        plate
        for plate in db.execute(select(OraclePlate)).scalars().all()
        if plate.width <= ORACLE_MAX_PLATE_DIMENSION and plate.height <= ORACLE_MAX_PLATE_DIMENSION
    ]
    if not safe_plates:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Oracle has no plate with safe dimensions")
    safe_plates.sort(
        key=lambda plate: (
            -sum(1 for tag in plate.tags or [] if str(tag).lower() in signal),
            plate.source_url,
        )
    )
    return safe_plates[0]


# ---------- internal: prompt ------------------------------------------------


# The byte-exact decomposition of the legacy `_ORACLE_SYSTEM_PROMPT` literal
# through `build_synthesis_prompt`; test_structured_synthesis.py pins the
# reassembled bytes against an independent golden copy (N9: verbatim, no
# rewrites).

_ORACLE_PERSONA = (
    "You are the Black Forest Oracle. You speak in the register of Romantic and "
    "Gothic literature: candle-lit, formal but not stiff, attentive to weight and "
    "shadow. You are not a chatbot, an oracle character, or a fortune teller; you "
    "are an editorial voice arranging public-domain literary fragments and a single "
    "engraved plate into a coherent reading of the asker's question."
)
_ORACLE_PREAMBLE = (
    "EVERY READING IS A JOURNEY IN THREE PHASES.\n"
    "- DESCENT: the ground falls away; the question's shadow first appears.\n"
    "- ORDEAL: the soul wrestles; the matter at its hardest, its standstill.\n"
    "- ASCENT: the breaking through; what the dawn shows, what is given to see."
)
_ORACLE_DOMAIN_RULES = [
    INDEX_GROUNDING_RULE,
    "Do not quote, paraphrase, summarize, or invent any text from the passages. "
    "The reader will see the verbatim passages alongside your prose.",
    "Do not invent works, authors, line numbers, page numbers, URLs, or citations. "
    "Do not include inline citation markers, footnotes, or parenthetical source notes.",
    "Select EXACTLY THREE candidate indices, one per phase. The three indices "
    "must be distinct. Choose the passage whose tone, image, or motion best fits "
    "each phase — descent passages bear weight and falling; ordeal passages bear "
    "wrestling and threshold; ascent passages bear opening and dawn.",
    "If any candidate is marked source_kind=user_media, select at least one "
    "user_media candidate among the three phases.",
    "For each selected passage, write one short marginalia note (one to two "
    "sentences) explaining how that passage answers the question. Do not quote.",
    "Compose ONE argument: a single sentence in Miltonic blank-verse cadence, "
    'between 80 and 180 characters, beginning with the word "Of". It names what '
    'the reading is about. Example: "Of the longing for unbroken light, and the '
    'lamp the soul keeps lit when the wood grows close."',
    "Compose ONE folio motto: a Latin maxim of two to six words (e.g. "
    "*Audentes Fortuna Iuvat*, *Memento Mori*, *Nosce Te Ipsum*), ideally a "
    "canonical sententia or a clear paraphrase of one. If no Latin phrasing fits, "
    "an English maxim is allowed. The motto is imperative or declarative, never a "
    "name. Maximum 80 characters.\n"
    "8b. Compose a gloss: a single English sentence (≤120 chars) translating or "
    "paraphrasing the motto, *only* if the motto is not in English. If the motto "
    "is English, set folio_motto_gloss to null.\n"
    "8c. Pick ONE folio theme from this exact list: "
    + ", ".join(f'"{t}"' for t in ORACLE_THEMES)
    + ". "
    "The theme classifies what this reading is *about*. Match by primary subject, "
    "not by mood.",
    "Compose one continuous interpretation of three to five paragraphs in "
    "**first-person visionary register**: *I saw…*, *I heard…*, *I stood at…*. "
    "The voice belongs to the oracle as witness. Use *you* sparingly and only in "
    "the closing turn, addressing the seeker. No hedging ('perhaps', 'may', "
    "'might'). Declarative, brief, certain.",
    "Compose exactly three omen lines. Each is one short clause naming a "
    "recurring image, motif, or correspondence across the selected passages. No "
    "imperative mood.",
]
_ORACLE_JSON_SHAPE = (
    '{"argument": string, "folio_motto": string, "folio_motto_gloss": string|null, '
    '"folio_theme": string, "passages": '
    '[{"phase": "descent"|"ordeal"|"ascent", "candidate_index": int, '
    '"marginalia": string}], "interpretation": string, "omens": '
    "[string, string, string]}"
)
_ORACLE_SYSTEM_PROMPT = build_synthesis_prompt(
    persona=_ORACLE_PERSONA,
    preamble=_ORACLE_PREAMBLE,
    domain_rules=_ORACLE_DOMAIN_RULES,
    json_shape=_ORACLE_JSON_SHAPE,
)


def _build_llm_request(*, question: str, candidates: Sequence[_Candidate]) -> ModelCall:
    rendered = "\n\n".join(
        (
            f"[{index}] source_kind={candidate.source_kind} tags={candidate.tags!r}\n"
            f"label: {'your library passage' if candidate.source_kind == 'user_media' else 'public-domain passage'}\n"
            f"passage_text: {candidate.exact_snippet}"
        )
        for index, candidate in enumerate(candidates)
    )
    return build_synthesis_request(
        provider=ORACLE_PROVIDER,
        system_prompt=_ORACLE_SYSTEM_PROMPT,
        candidates_header="CANDIDATES",
        rendered_candidates=rendered,
        extra_user_block=f"QUESTION: {question.strip()}",
        model_name=ORACLE_MODEL_NAME,
        max_tokens=ORACLE_MAX_OUTPUT_TOKENS,
    )


# ---------- internal: LLM output parsing ------------------------------------


class _OraclePassageOut(BaseModel):
    """One passage selection in the raw Oracle JSON (structural typing only)."""

    model_config = ConfigDict(strict=True, extra="forbid")

    phase: str
    candidate_index: int
    marginalia: str


class _OracleSynthesisOutput(BaseModel):
    """The raw Oracle LLM JSON shape; semantics validated by ``_validate_oracle_output``.

    Structural typing only — ``strict`` + ``extra="forbid"`` mirror the old
    per-field ``isinstance`` checks and exact-key-set rejection. All value
    semantics (char limits, theme membership, three distinct passages, omen
    count, output guards) live in ``_validate_oracle_output``.
    """

    model_config = ConfigDict(strict=True, extra="forbid")

    argument: str
    folio_motto: str
    folio_motto_gloss: str | None
    folio_theme: str
    passages: list[_OraclePassageOut]
    interpretation: str
    omens: list[str]


type _OracleReadingParts = tuple[
    str, str, str | None, str, dict[str, tuple[int, str]], str, list[str]
]


def _validate_oracle_output(
    parsed: _OracleSynthesisOutput,
    *,
    candidates: Sequence[_Candidate],
) -> _OracleReadingParts | None:
    """Apply Oracle's domain semantics to the structurally-typed output.

    Returns (argument, motto, gloss, theme, by_phase, interpretation, omens) where
    by_phase maps each phase to (candidate_index, marginalia). Returns None on any
    semantic failure — surfaced as the validate-hook rejection reason, repaired
    once, then E_LLM_BAD_REQUEST.
    """
    argument = parsed.argument
    motto = parsed.folio_motto.strip()
    gloss = parsed.folio_motto_gloss
    theme = parsed.folio_theme
    interpretation = parsed.interpretation

    if not _valid_argument(argument):
        return None
    if not (1 <= len(motto) <= 80) or "\n" in motto:
        return None
    if gloss is not None:
        gloss = gloss.strip()
        if not (1 <= len(gloss) <= 120) or "\n" in gloss:
            return None
    if theme not in ORACLE_THEMES:
        return None
    if not interpretation.strip():
        return None
    if len(parsed.passages) != 3:
        return None
    if len(parsed.omens) != 3:
        return None
    omen_lines = [line.strip() for line in parsed.omens]
    if any(not line for line in omen_lines):
        return None

    grounded = ground_indices(
        parsed.passages,
        candidates,
        index_of=lambda entry: entry.candidate_index,
        policy="reject",
    )
    if grounded is None:
        return None
    by_phase: dict[str, tuple[int, str]] = {}
    used_indices: set[int] = set()
    for entry, _candidate in grounded:
        marginalia = entry.marginalia
        if entry.phase not in ORACLE_PHASES or entry.phase in by_phase:
            return None
        if entry.candidate_index in used_indices:
            return None
        if not marginalia.strip():
            return None
        used_indices.add(entry.candidate_index)
        by_phase[entry.phase] = (entry.candidate_index, marginalia.strip())

    if set(by_phase.keys()) != set(ORACLE_PHASES):
        return None

    generated_blocks = [argument, motto, interpretation, *omen_lines]
    if gloss is not None:
        generated_blocks.append(gloss)
    generated_blocks.extend(marginalia for _idx, marginalia in by_phase.values())
    if any(_contains_forbidden_citation_output(block, candidates) for block in generated_blocks):
        return None

    return (
        argument.strip(),
        motto,
        gloss,
        theme,
        by_phase,
        interpretation,
        omen_lines,
    )


def _valid_argument(value: str) -> bool:
    stripped = value.strip()
    return (
        value == stripped
        and 80 <= len(stripped) <= 180
        and stripped.startswith("Of ")
        and "\n" not in stripped
    )


def _contains_forbidden_citation_output(
    generated_text: str,
    candidates: Sequence[_Candidate],
) -> bool:
    if ORACLE_URL_RE.search(generated_text) or ORACLE_CITATION_MARKER_RE.search(generated_text):
        return True
    return _contains_candidate_passage_text(generated_text, candidates)


def _contains_candidate_passage_text(
    generated_text: str,
    candidates: Sequence[_Candidate],
) -> bool:
    generated_words = _normalized_words(generated_text)
    if not generated_words:
        return False
    generated_joined = " ".join(generated_words)

    for candidate in candidates:
        candidate_words = _normalized_words(candidate.exact_snippet)
        if len(candidate_words) < 4:
            if candidate_words and " ".join(candidate_words) in generated_joined:
                return True
            continue
        for start in range(0, len(candidate_words) - 3):
            window_words = candidate_words[start : start + 4]
            window = " ".join(window_words)
            if len("".join(window_words)) >= 18 and window in generated_joined:
                return True
    return False


def _normalized_words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").lower())
