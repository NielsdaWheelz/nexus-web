"""Black Forest Oracle service.

One file owns reading lifecycle: create, fetch, list, and worker-side
generation. Retrieval, prompt building, LLM call, citation persistence,
and SSE event emission are all linear and explicit here.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx
from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn
from sqlalchemy import desc, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.config import get_settings
from nexus.db.models import (
    OracleCorpusImage,
    OracleCorpusPassage,
    OracleCorpusSetVersion,
    OracleCorpusWork,
    OracleReading,
    OracleReadingEvent,
    OracleReadingPassage,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.oracle import (
    OracleReadingDetailOut,
    OracleReadingEventOut,
    OracleReadingImageOut,
    OracleReadingPassageOut,
    OracleReadingSummaryOut,
)
from nexus.services.chat_prompt import _hash_json as _hash_prompt_json
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.semantic_chunks import (
    build_text_embedding,
    current_transcript_embedding_model,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)

logger = get_logger(__name__)

ORACLE_PROMPT_VERSION = "oracle-v2"
ORACLE_MODEL_NAME = "claude-haiku-4-5-20251001"
ORACLE_PROVIDER = "anthropic"
ORACLE_MAX_OUTPUT_TOKENS = 2000
ORACLE_LLM_TIMEOUT_SECONDS = 45
ORACLE_PUBLIC_DOMAIN_CANDIDATES = 6
ORACLE_USER_LIBRARY_CANDIDATES = 4
ORACLE_USER_CONTENT_CHUNK_CANDIDATES = 4
ORACLE_RECENT_READINGS_LIMIT = 5
ORACLE_FOLIO_ALLOCATE_ATTEMPTS = 8
ORACLE_IMAGE_PROXY_PATH = "/api/media/image"
ORACLE_UNEXPECTED_FAILURE_MESSAGE = "The reading could not be completed. Please try again."
ORACLE_MODEL_UNAVAILABLE_MESSAGE = "The Oracle model is temporarily unavailable."
ORACLE_LLM_CONFIGURATION_MESSAGE = "The Oracle is not configured to complete readings."
ORACLE_LLM_BAD_REQUEST_MESSAGE = (
    "The reading could not be completed. Start a new reading with a simpler question."
)
ORACLE_RETRIEVAL_FAILED_MESSAGE = "The Oracle could not gather enough source material."
ORACLE_CORPUS_INCOMPLETE_MESSAGE = "The Oracle source corpus is not ready."
ORACLE_RATE_LIMITED_MESSAGE = "The Oracle is busy. Please try again soon."
ORACLE_CAPACITY_MESSAGE = "The Oracle is temporarily at capacity. Please try again later."
ORACLE_TOKEN_RE = re.compile(r"[a-z]{3,}")
ORACLE_PHASES: tuple[str, str, str] = ("descent", "ordeal", "ascent")
ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS: tuple[str, ...] = (
    "dante-inferno-longfellow",
    "milton-paradise-lost",
    "blake-songs-of-experience",
    "blake-marriage-heaven-hell",
    "poe-the-raven",
    "shelley-frankenstein",
    "shelley-ozymandias",
    "byron-darkness",
    "coleridge-rime-ancient-mariner",
    "coleridge-kubla-khan",
    "keats-ode-nightingale",
    "keats-la-belle-dame",
    "melville-moby-dick",
    "hawthorne-young-goodman-brown",
    "dickinson-selected-poems",
    "whitman-song-of-myself",
    "rossetti-goblin-market",
    "kjv-ecclesiastes",
    "kjv-revelation",
)
ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS = len(ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS)
ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES = 75
ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES = 36
ORACLE_URL_RE = re.compile(r"\b(?:https?://|www\.)", re.IGNORECASE)
ORACLE_CITATION_MARKER_RE = re.compile(
    r"(\[[0-9]+\]"
    r"|\b(?:canto|book|chapter|ch\.|verse|line|lines|page|pages|p\.|pp\.)\s+"
    r"(?:[ivxlcdm]+|\d+)"
    r"|\b[ivxlcdm]{1,8}\.\d+(?:[-–]\d+)?\b"
    r"|\b\d+:\d+(?:[-–]\d+)?\b)",
    re.IGNORECASE,
)


def _api_error_code_for_llm_error(error_code: LLMErrorCode) -> ApiErrorCode:
    if error_code == LLMErrorCode.INVALID_KEY:
        return ApiErrorCode.E_LLM_INVALID_KEY
    if error_code == LLMErrorCode.RATE_LIMIT:
        return ApiErrorCode.E_LLM_RATE_LIMIT
    if error_code == LLMErrorCode.CONTEXT_TOO_LARGE:
        return ApiErrorCode.E_LLM_CONTEXT_TOO_LARGE
    if error_code == LLMErrorCode.TIMEOUT:
        return ApiErrorCode.E_LLM_TIMEOUT
    if error_code == LLMErrorCode.PROVIDER_DOWN:
        return ApiErrorCode.E_LLM_PROVIDER_DOWN
    if error_code == LLMErrorCode.BAD_REQUEST:
        return ApiErrorCode.E_LLM_BAD_REQUEST
    if error_code == LLMErrorCode.MODEL_NOT_AVAILABLE:
        return ApiErrorCode.E_MODEL_NOT_AVAILABLE
    raise AssertionError(f"Unhandled LLM error code: {error_code!r}")


# ---------- create / fetch / list -------------------------------------------


def create_reading(
    db: Session,
    *,
    viewer_id: UUID,
    question: str,
) -> OracleReading:
    """Insert one pending reading row and enqueue its generation job."""
    cleaned = question.strip()
    if not cleaned or len(cleaned) > 280:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Oracle question must be 1-280 characters",
        )
    _validate_oracle_pre_enqueue_controls(viewer_id=viewer_id)

    for attempt in range(ORACLE_FOLIO_ALLOCATE_ATTEMPTS):
        try:
            reading = _insert_reading_with_next_folio(
                db,
                viewer_id=viewer_id,
                question=cleaned,
            )
            db.commit()
            db.refresh(reading)
            return reading
        except IntegrityError as exc:
            db.rollback()
            if not _is_oracle_folio_conflict(exc) or attempt == ORACLE_FOLIO_ALLOCATE_ATTEMPTS - 1:
                raise
        except Exception:
            db.rollback()
            raise

    raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to allocate Oracle folio")


def _insert_reading_with_next_folio(
    db: Session,
    *,
    viewer_id: UUID,
    question: str,
) -> OracleReading:
    max_folio = db.scalar(
        select(func.max(OracleReading.folio_number)).where(OracleReading.user_id == viewer_id)
    )
    next_folio = (max_folio or 0) + 1
    corpus_set_version_id = _active_corpus_set_version_id(db)

    reading = OracleReading(
        user_id=viewer_id,
        corpus_set_version_id=corpus_set_version_id,
        folio_number=next_folio,
        question_text=question,
        status="pending",
        prompt_version=ORACLE_PROMPT_VERSION,
    )
    db.add(reading)
    db.flush()

    enqueue_job(
        db,
        kind="oracle_reading_generate",
        payload={"reading_id": str(reading.id)},
    )
    return reading


def _active_corpus_set_version_id(db: Session) -> UUID:
    corpus_set_version_id = (
        db.execute(
            select(OracleCorpusSetVersion.id)
            .order_by(
                desc(OracleCorpusSetVersion.created_at),
                desc(OracleCorpusSetVersion.version),
            )
            .limit(1)
        )
        .scalars()
        .one_or_none()
    )
    if corpus_set_version_id is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Oracle corpus is not seeded")
    _ensure_corpus_seed_ready(db, corpus_set_version_id=corpus_set_version_id)
    return corpus_set_version_id


def _ensure_corpus_seed_ready(db: Session, *, corpus_set_version_id: UUID) -> None:
    """Reject a corpus version until scripts/oracle manifests have fully seeded it."""
    counts = (
        db.execute(
            select(
                func.count(func.distinct(OracleCorpusWork.id)).label("work_count"),
                func.count(func.distinct(OracleCorpusPassage.id)).label("passage_count"),
                func.count(func.distinct(OracleCorpusImage.id)).label("image_count"),
                func.count(func.distinct(OracleCorpusPassage.id))
                .filter(
                    OracleCorpusPassage.embedding.is_not(None),
                    OracleCorpusPassage.embedding_model == OracleCorpusSetVersion.embedding_model,
                )
                .label("passage_embedding_count"),
                func.count(func.distinct(OracleCorpusImage.id))
                .filter(
                    OracleCorpusImage.embedding.is_not(None),
                    OracleCorpusImage.embedding_model == OracleCorpusSetVersion.embedding_model,
                )
                .label("image_embedding_count"),
                func.count(func.distinct(OracleCorpusImage.id))
                .filter(
                    OracleCorpusImage.width <= 4096,
                    OracleCorpusImage.height <= 4096,
                )
                .label("safe_image_count"),
            )
            .select_from(OracleCorpusSetVersion)
            .outerjoin(
                OracleCorpusWork,
                OracleCorpusWork.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .outerjoin(
                OracleCorpusPassage,
                OracleCorpusPassage.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .outerjoin(
                OracleCorpusImage,
                OracleCorpusImage.corpus_set_version_id == OracleCorpusSetVersion.id,
            )
            .where(OracleCorpusSetVersion.id == corpus_set_version_id)
        )
        .mappings()
        .one()
    )
    seeded_slugs = set(
        db.execute(
            select(OracleCorpusWork.slug).where(
                OracleCorpusWork.corpus_set_version_id == corpus_set_version_id
            )
        )
        .scalars()
        .all()
    )
    missing_slugs = [
        slug for slug in ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS if slug not in seeded_slugs
    ]
    work_count = int(counts["work_count"] or 0)
    passage_count = int(counts["passage_count"] or 0)
    image_count = int(counts["image_count"] or 0)
    passage_embedding_count = int(counts["passage_embedding_count"] or 0)
    image_embedding_count = int(counts["image_embedding_count"] or 0)
    safe_image_count = int(counts["safe_image_count"] or 0)
    if (
        work_count < ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS
        or passage_count < ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES
        or image_count < ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES
        or passage_embedding_count < passage_count
        or image_embedding_count < image_count
        or safe_image_count < image_count
        or missing_slugs
    ):
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            ORACLE_CORPUS_INCOMPLETE_MESSAGE,
        )


def _is_oracle_folio_conflict(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return constraint_name == "uix_oracle_readings_user_folio"
    return "uix_oracle_readings_user_folio" in str(exc)


def get_reading_detail(
    db: Session,
    *,
    viewer_id: UUID,
    reading_id: UUID,
) -> OracleReadingDetailOut:
    """Return the full reading record with persisted events for hydration."""
    reading = _get_reading_owned_by(db, viewer_id=viewer_id, reading_id=reading_id)
    passage_rows = (
        db.execute(
            select(OracleReadingPassage).where(OracleReadingPassage.reading_id == reading_id)
        )
        .scalars()
        .all()
    )
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
        image = db.get(OracleCorpusImage, reading.image_id)
        if image is None:
            raise ApiError(
                ApiErrorCode.E_INTERNAL,
                "Oracle reading references a missing image",
            )
        image_out = _oracle_image_out(image)
    passages_sorted = sorted(
        passage_rows,
        key=lambda row: ORACLE_PHASES.index(row.phase)
        if row.phase in ORACLE_PHASES
        else len(ORACLE_PHASES),
    )
    return OracleReadingDetailOut(
        id=reading.id,
        folio_number=reading.folio_number,
        folio_title=reading.folio_title,
        argument_text=reading.argument_text,
        question_text=reading.question_text,
        status=reading.status,
        image=image_out,
        passages=[
            OracleReadingPassageOut(
                phase=row.phase,
                source_kind=row.source_kind,
                source_ref=row.source_ref,
                exact_snippet=row.exact_snippet,
                locator_label=row.locator_label,
                attribution_text=row.attribution_text,
                marginalia_text=row.marginalia_text,
                deep_link=row.deep_link,
            )
            for row in passages_sorted
        ],
        events=[_oracle_event_out(row) for row in event_rows],
        created_at=reading.created_at,
        started_at=reading.started_at,
        completed_at=reading.completed_at,
        failed_at=reading.failed_at,
        error_code=reading.error_code,
        error_message=_oracle_failure_message(reading.error_code)
        if reading.error_code is not None
        else None,
    )


def list_recent_readings(db: Session, *, viewer_id: UUID) -> list[OracleReadingSummaryOut]:
    """Return the viewer's most recent readings."""
    rows = (
        db.execute(
            select(OracleReading)
            .where(OracleReading.user_id == viewer_id)
            .order_by(desc(OracleReading.created_at))
            .limit(ORACLE_RECENT_READINGS_LIMIT)
        )
        .scalars()
        .all()
    )
    return [OracleReadingSummaryOut.model_validate(row) for row in rows]


def _validate_oracle_pre_enqueue_controls(*, viewer_id: UUID) -> None:
    _ensure_oracle_platform_llm_available()
    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    rate_limiter.check_token_budget(viewer_id)


def _ensure_oracle_platform_llm_available() -> str:
    settings = get_settings()
    if not settings.enable_anthropic:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, ORACLE_MODEL_UNAVAILABLE_MESSAGE)
    if not settings.anthropic_api_key:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, ORACLE_LLM_CONFIGURATION_MESSAGE)
    return settings.anthropic_api_key


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
    return [_oracle_event_out(row) for row in rows]


def is_reading_terminal(db: Session, *, reading_id: UUID) -> bool:
    status = db.execute(
        select(OracleReading.status).where(OracleReading.id == reading_id)
    ).scalar_one_or_none()
    return status in ("complete", "failed")


def fail_reading_after_worker_exception(db: Session, *, reading_id: UUID) -> dict[str, Any]:
    """Fail a nonterminal reading after an unexpected worker exception."""
    db.rollback()
    reading = _get_reading(db, reading_id)
    if reading is None:
        return {"status": "failed", "error_code": "E_NOT_FOUND", "noop": True}
    if reading.status in ("complete", "failed"):
        status = reading.status
        db.commit()
        return {"status": status, "noop": True}

    _fail(db, reading, code="E_INTERNAL")
    return {"status": "failed", "error_code": "E_INTERNAL"}


# ---------- worker entrypoint -----------------------------------------------


@dataclass(frozen=True)
class _Candidate:
    """One retrieved passage offered to the LLM by index. Citation fields
    flow only from this record into persistence — never from the LLM."""

    source_kind: str  # "public_domain" | "user_media"
    exact_snippet: str
    locator_label: str
    attribution_text: str
    deep_link: str | None
    source_ref: dict[str, Any]
    tags: list[str]
    score: float


async def execute_reading(
    db: Session,
    *,
    reading_id: UUID,
    llm_router: LLMRouter,
) -> dict[str, Any]:
    """Worker job body: pick plate, retrieve passages, call LLM, persist, stream."""
    reading = _get_reading(db, reading_id)
    if reading is None:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
    if reading.status != "pending":
        # Replay of an already-claimed job; refuse rather than emit twice.
        status = reading.status
        db.commit()
        return {"status": status, "noop": True}

    question = reading.question_text
    viewer_id = reading.user_id
    folio_number = reading.folio_number
    corpus_set_version_id = reading.corpus_set_version_id

    try:
        api_key = _ensure_oracle_platform_llm_available()
    except ApiError as exc:
        _fail(db, reading, code=exc.code.value)
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
            _fail(db, reading, code=exc.code.value)
            return {"status": "failed", "error_code": exc.code.value}

        try:
            _ensure_corpus_seed_ready(db, corpus_set_version_id=corpus_set_version_id)
        except ApiError:
            _fail(
                db,
                reading,
                code="E_ORACLE_CORPUS_INCOMPLETE",
            )
            return {"status": "failed", "error_code": "E_ORACLE_CORPUS_INCOMPLETE"}

        try:
            corpus_query_embedding_model = _corpus_embedding_model(
                db,
                corpus_set_version_id=corpus_set_version_id,
            )
            corpus_query_embedding_model, corpus_query_embedding = _build_query_embedding_for_model(
                question,
                embedding_model=corpus_query_embedding_model,
            )
            plate = _pick_plate(
                db,
                corpus_set_version_id=corpus_set_version_id,
                query_embedding_model=corpus_query_embedding_model,
                query_embedding=corpus_query_embedding,
            )
            requires_user_media = _viewer_has_searchable_media(db, viewer_id=viewer_id)
            user_query_embedding_model = None
            user_query_embedding = None
            if requires_user_media:
                user_query_embedding_model, user_query_embedding = _build_query_embedding_for_model(
                    question,
                    embedding_model=current_transcript_embedding_model(),
                )
            candidates = _retrieve_candidates(
                db,
                viewer_id=viewer_id,
                corpus_set_version_id=corpus_set_version_id,
                question=question,
                corpus_query_embedding_model=corpus_query_embedding_model,
                corpus_query_embedding=corpus_query_embedding,
                user_query_embedding_model=user_query_embedding_model,
                user_query_embedding=user_query_embedding,
            )
        except ApiError as exc:
            _fail(db, reading, code=exc.code.value)
            return {"status": "failed", "error_code": exc.code.value}

        if len(candidates) < 3:
            _fail(db, reading, code="E_INTERNAL")
            return {"status": "failed", "error_code": "E_INTERNAL"}
        if requires_user_media and not _candidate_set_includes_user_media(candidates):
            _fail(
                db,
                reading,
                code=ApiErrorCode.E_APP_SEARCH_FAILED.value,
            )
            return {"status": "failed", "error_code": ApiErrorCode.E_APP_SEARCH_FAILED.value}

        request = _build_llm_request(
            question=question,
            candidates=candidates,
        )
        provider_request_hash = _provider_request_hash(request)
        estimated_tokens = _estimate_llm_request_tokens(request)
        try:
            rate_limiter.reserve_token_budget(viewer_id, reading_id, estimated_tokens)
            budget_reserved = True
        except ApiError as exc:
            reading = _get_reading(db, reading_id)
            if reading is None:
                raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found") from exc
            _fail(db, reading, code=exc.code.value)
            return {"status": "failed", "error_code": exc.code.value}

        reading = _get_reading(db, reading_id)
        if reading is None:
            raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
        if reading.status != "pending":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        reading.status = "streaming"
        reading.started_at = db.scalar(select(func.now()))
        reading.provider_request_hash = provider_request_hash
        db.flush()
        _append_event(
            db,
            reading_id,
            "meta",
            {"question": question, "folio_number": folio_number},
        )
        db.commit()

        try:
            response = await llm_router.generate(
                ORACLE_PROVIDER,
                request,
                api_key,
                timeout_s=ORACLE_LLM_TIMEOUT_SECONDS,
            )
        except LLMError as exc:
            error_code = _api_error_code_for_llm_error(exc.error_code).value
            logger.warning(
                "oracle.llm_error",
                reading_id=str(reading_id),
                llm_error_code=exc.error_code.value,
                api_error_code=error_code,
            )
            reading = _get_reading(db, reading_id)
            if reading is None:
                raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found") from exc
            _fail(db, reading, code=error_code)
            return {"status": "failed", "error_code": error_code}

        parsed = _parse_llm_output(response.text, candidates=candidates)
        if parsed is None:
            logger.warning(
                "oracle.llm_unparseable",
                reading_id=str(reading_id),
                output_preview=response.text[:200],
            )
            reading = _get_reading(db, reading_id)
            if reading is None:
                raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
            _fail(
                db,
                reading,
                code="E_LLM_BAD_REQUEST",
            )
            return {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}

        argument, folio_title, by_phase, interpretation, omens = parsed
        if requires_user_media and not _selected_user_media(candidates, by_phase):
            logger.warning("oracle.llm_missing_user_media", reading_id=str(reading_id))
            reading = _get_reading(db, reading_id)
            if reading is None:
                raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
            _fail(
                db,
                reading,
                code="E_LLM_BAD_REQUEST",
            )
            return {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}

        reading = _get_reading(db, reading_id)
        if reading is None:
            raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
        if reading.status != "streaming":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        reading.folio_title = folio_title
        reading.argument_text = argument
        reading.image_id = plate.id
        db.flush()

        _append_event(db, reading_id, "bind", {"folio_title": folio_title})
        _append_event(db, reading_id, "argument", {"text": argument})
        _append_event(
            db,
            reading_id,
            "plate",
            _oracle_image_payload(plate),
        )
        db.commit()

        for phase in ORACLE_PHASES:
            idx, marginalia = by_phase[phase]
            candidate = candidates[idx]
            passage_row = OracleReadingPassage(
                reading_id=reading_id,
                phase=phase,
                source_kind=candidate.source_kind,
                source_ref=candidate.source_ref,
                exact_snippet=candidate.exact_snippet,
                locator_label=candidate.locator_label,
                locator=candidate.source_ref["locator"],
                source=candidate.source_ref["source"],
                attribution_text=candidate.attribution_text,
                marginalia_text=marginalia,
                deep_link=candidate.deep_link,
            )
            db.add(passage_row)
            db.flush()
            _append_event(
                db,
                reading_id,
                "passage",
                {
                    "phase": phase,
                    "source_kind": candidate.source_kind,
                    "source_ref": candidate.source_ref,
                    "exact_snippet": candidate.exact_snippet,
                    "locator_label": candidate.locator_label,
                    "attribution_text": candidate.attribution_text,
                    "marginalia_text": marginalia,
                    "deep_link": candidate.deep_link,
                },
            )
            db.commit()

        _append_event(db, reading_id, "delta", {"text": interpretation.strip()})
        db.commit()
        _append_event(db, reading_id, "omens", {"lines": omens})
        db.commit()

        reading = _get_reading(db, reading_id)
        if reading is None:
            raise ApiError(ApiErrorCode.E_NOT_FOUND, "Oracle reading not found")
        if reading.status != "streaming":
            status = reading.status
            db.commit()
            return {"status": status, "noop": True}
        reading.status = "complete"
        reading.completed_at = db.scalar(select(func.now()))
        db.flush()
        _append_event(db, reading_id, "done", {})
        db.commit()

        if budget_reserved:
            actual_tokens = _usage_total_tokens(response.usage) or estimated_tokens
            rate_limiter.commit_token_budget(viewer_id, reading_id, actual_tokens)
            budget_reserved = False

        return {
            "status": "complete",
            "folio_number": folio_number,
            "input_tokens": response.usage.input_tokens if response.usage else None,
            "output_tokens": response.usage.output_tokens if response.usage else None,
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


def _candidate_set_includes_user_media(candidates: Sequence[_Candidate]) -> bool:
    return any(candidate.source_kind == "user_media" for candidate in candidates)


def _selected_user_media(
    candidates: Sequence[_Candidate],
    by_phase: dict[str, tuple[int, str]],
) -> bool:
    return any(
        candidates[idx].source_kind == "user_media" for idx, _marginalia in by_phase.values()
    )


def _viewer_has_searchable_media(db: Session, *, viewer_id: UUID) -> bool:
    return bool(
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT EXISTS (
                    SELECT 1
                    FROM visible_media vm
                    JOIN media_content_index_states mcis ON mcis.media_id = vm.media_id
                        AND mcis.status = 'ready'
                        AND mcis.active_run_id IS NOT NULL
                    JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                        AND active_run.state = 'ready'
                        AND active_run.deactivated_at IS NULL
                    JOIN content_chunks cc ON cc.media_id = vm.media_id
                        AND cc.index_run_id = mcis.active_run_id
                    WHERE btrim(cc.chunk_text) <> ''
                    LIMIT 1
                )
                """
            ),
            {"viewer_id": viewer_id},
        ).scalar_one()
    )


def _estimate_llm_request_tokens(request: LLMRequest) -> int:
    prompt_chars = sum(len(str(message.content or "")) for message in request.messages)
    return max(1, prompt_chars // 4 + int(request.max_tokens or 0))


def _usage_total_tokens(usage: Any) -> int | None:
    if usage is None:
        return None
    total_tokens = getattr(usage, "total_tokens", None)
    if isinstance(total_tokens, int):
        return total_tokens
    input_tokens = getattr(usage, "input_tokens", None)
    output_tokens = getattr(usage, "output_tokens", None)
    reasoning_tokens = getattr(usage, "reasoning_tokens", None)
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return None
    return (
        input_tokens
        + output_tokens
        + (reasoning_tokens if isinstance(reasoning_tokens, int) else 0)
    )


# ---------- internal: SSE event emit ----------------------------------------


def _oracle_image_proxy_url(source_url: str) -> str:
    if source_url.startswith(f"{ORACLE_IMAGE_PROXY_PATH}?url="):
        return source_url
    if source_url.startswith("/media/image?url="):
        return f"/api{source_url}"
    return f"{ORACLE_IMAGE_PROXY_PATH}?url={quote(source_url, safe='')}"


def _oracle_image_payload(image: OracleCorpusImage) -> dict[str, Any]:
    return {
        "source_url": _oracle_image_proxy_url(image.source_url),
        "attribution_text": image.attribution_text,
        "artist": image.artist,
        "work_title": image.work_title,
        "year": image.year,
        "width": image.width,
        "height": image.height,
    }


def _oracle_image_out(image: OracleCorpusImage) -> OracleReadingImageOut:
    return OracleReadingImageOut(**_oracle_image_payload(image))


def _oracle_event_out(row: OracleReadingEvent) -> OracleReadingEventOut:
    payload = dict(row.payload or {})
    if row.event_type == "plate":
        raw_source_url = payload.get("source_url")
        if isinstance(raw_source_url, str):
            payload["source_url"] = _oracle_image_proxy_url(raw_source_url)
    elif row.event_type == "error":
        code = str(payload.get("code") or "E_INTERNAL")
        payload = {"code": code, "message": _oracle_failure_message(code)}
    return OracleReadingEventOut(seq=row.seq, event_type=row.event_type, payload=payload)


def _oracle_failure_message(code: str) -> str:
    if code == ApiErrorCode.E_LLM_NO_KEY.value:
        return ORACLE_LLM_CONFIGURATION_MESSAGE
    if code == ApiErrorCode.E_MODEL_NOT_AVAILABLE.value:
        return ORACLE_MODEL_UNAVAILABLE_MESSAGE
    if code == ApiErrorCode.E_LLM_BAD_REQUEST.value:
        return ORACLE_LLM_BAD_REQUEST_MESSAGE
    if code == ApiErrorCode.E_APP_SEARCH_FAILED.value:
        return ORACLE_RETRIEVAL_FAILED_MESSAGE
    if code == "E_ORACLE_CORPUS_INCOMPLETE":
        return ORACLE_CORPUS_INCOMPLETE_MESSAGE
    if code == ApiErrorCode.E_RATE_LIMITED.value:
        return ORACLE_RATE_LIMITED_MESSAGE
    if code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED.value:
        return ORACLE_CAPACITY_MESSAGE
    if code == ApiErrorCode.E_LLM_RATE_LIMIT.value:
        return ORACLE_RATE_LIMITED_MESSAGE
    if code in (
        ApiErrorCode.E_LLM_INVALID_KEY.value,
        ApiErrorCode.E_LLM_PROVIDER_DOWN.value,
        ApiErrorCode.E_LLM_TIMEOUT.value,
        ApiErrorCode.E_LLM_CONTEXT_TOO_LARGE.value,
        ApiErrorCode.E_LLM_INCOMPLETE.value,
    ):
        return ORACLE_MODEL_UNAVAILABLE_MESSAGE
    return ORACLE_UNEXPECTED_FAILURE_MESSAGE


def _append_event(
    db: Session,
    reading_id: UUID,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    next_seq = db.execute(
        text(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM oracle_reading_events "
            "WHERE reading_id = :reading_id"
        ),
        {"reading_id": reading_id},
    ).scalar_one()
    db.add(
        OracleReadingEvent(
            reading_id=reading_id,
            seq=int(next_seq),
            event_type=event_type,
            payload=payload,
        )
    )
    db.flush()


def _fail(db: Session, reading: OracleReading, *, code: str) -> None:
    message = _oracle_failure_message(code)
    reading.status = "failed"
    reading.failed_at = db.scalar(select(func.now()))
    reading.error_code = code
    reading.error_message = message
    db.flush()
    _append_event(db, reading.id, "error", {"code": code, "message": message})
    db.commit()


# ---------- internal: retrieval ---------------------------------------------


def _build_query_embedding_for_model(
    question: str,
    *,
    embedding_model: str,
) -> tuple[str, list[float]]:
    embedding_dims = transcript_embedding_dimensions()
    if embedding_model == f"test_hash_v2_{embedding_dims}":
        return embedding_model, _test_hash_embedding(question, embedding_dims)

    try:
        returned_embedding_model, query_embedding = build_text_embedding(question)
    except ApiError as exc:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            f"Oracle embeddings unavailable: {exc.message}",
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle embeddings unavailable for semantic retrieval",
        ) from exc

    if returned_embedding_model != embedding_model:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle query embedding does not match the requested embedding model",
        )
    if len(query_embedding) != embedding_dims:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle query embedding has the wrong dimensionality",
        )
    return returned_embedding_model, query_embedding


def _test_hash_embedding(text_value: str, dimensions: int) -> list[float]:
    tokens = ORACLE_TOKEN_RE.findall(str(text_value or "").lower())
    vector = [0.0] * dimensions
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        sign = -1.0 if digest[4] % 2 else 1.0
        weight = ((int.from_bytes(digest[5:7], "big") % 1000) + 1) / 1000.0
        vector[bucket] += sign * weight

    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0.0:
        return vector
    return [component / norm for component in vector]


def _retrieve_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    corpus_set_version_id: UUID,
    question: str,
    corpus_query_embedding_model: str,
    corpus_query_embedding: list[float],
    user_query_embedding_model: str | None,
    user_query_embedding: list[float] | None,
) -> list[_Candidate]:
    public_domain = _retrieve_corpus_passages(
        db,
        corpus_set_version_id=corpus_set_version_id,
        question=question,
        query_embedding_model=corpus_query_embedding_model,
        query_embedding=corpus_query_embedding,
    )
    if user_query_embedding_model is None or user_query_embedding is None:
        return public_domain
    user_library = _retrieve_user_library_passages(
        db,
        viewer_id=viewer_id,
        query_embedding_model=user_query_embedding_model,
        query_embedding=user_query_embedding,
    )
    return [*public_domain, *user_library]


def _retrieve_corpus_passages(
    db: Session,
    *,
    corpus_set_version_id: UUID,
    question: str,
    query_embedding_model: str,
    query_embedding: list[float],
) -> list[_Candidate]:
    tokens = set(ORACLE_TOKEN_RE.findall(question.lower()))
    embedding_dims = transcript_embedding_dimensions()
    corpus_embedding_model = _corpus_embedding_model(
        db,
        corpus_set_version_id=corpus_set_version_id,
    )
    if corpus_embedding_model != query_embedding_model:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle corpus embeddings do not match the query embedding model",
        )
    rows = (
        db.execute(
            text(
                f"""
                WITH query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                )
                SELECT
                    ocp.id AS passage_id,
                    ocp.work_id,
                    ocp.passage_index,
                    ocp.canonical_text,
                    ocp.locator_label,
                    ocp.locator,
                    ocp.source,
                    ocp.tags,
                    ocw.slug AS work_slug,
                    ocw.title AS work_title,
                    ocw.author AS work_author,
                    ocw.year AS work_year,
                    ocw.edition_label AS edition_label,
                    ocw.source_repository AS source_repository,
                    ocw.source_url AS source_url,
                    (1 - (ocp.embedding <=> qe.embedding)) AS semantic_score
                FROM oracle_corpus_passages ocp
                JOIN oracle_corpus_works ocw ON ocw.id = ocp.work_id
                JOIN query_embedding qe ON true
                WHERE ocp.corpus_set_version_id = :corpus_set_version_id
                  AND ocw.corpus_set_version_id = :corpus_set_version_id
                  AND ocp.embedding_model = :embedding_model
                  AND ocp.embedding IS NOT NULL
                ORDER BY ocp.embedding <=> qe.embedding ASC, ocw.slug ASC, ocp.passage_index ASC
                LIMIT 200
                """
            ),
            {
                "corpus_set_version_id": corpus_set_version_id,
                "embedding_model": query_embedding_model,
                "query_embedding": to_pgvector_literal(query_embedding),
            },
        )
        .mappings()
        .all()
    )
    if not rows:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle corpus passage embeddings are unavailable",
        )
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        tags = [str(tag) for tag in row["tags"] or []]
        tag_score = sum(2.0 for tag in tags if tag.lower() in tokens)
        scored.append((float(row["semantic_score"] or 0.0) + tag_score, dict(row)))
    scored.sort(key=lambda pair: (-pair[0], str(pair[1]["work_slug"]), pair[1]["passage_index"]))
    chosen: list[_Candidate] = []
    used_works: set[UUID] = set()
    for score, row in scored:
        work_id = row["work_id"]
        if work_id in used_works:
            continue
        used_works.add(work_id)
        chosen.append(
            _Candidate(
                source_kind="public_domain",
                exact_snippet=str(row["canonical_text"]),
                locator_label=str(row["locator_label"]),
                attribution_text=(
                    f"{row['work_author']}, *{row['work_title']}*. {row['edition_label']}."
                ),
                deep_link=str(row["source_url"]),
                source_ref=_public_domain_source_ref_from_row(
                    corpus_set_version_id=corpus_set_version_id,
                    row=row,
                ),
                tags=[str(tag) for tag in row["tags"] or []],
                score=score,
            )
        )
        if len(chosen) >= ORACLE_PUBLIC_DOMAIN_CANDIDATES:
            break
    return chosen


def _retrieve_user_library_passages(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding_model: str,
    query_embedding: list[float],
) -> list[_Candidate]:
    content_chunks = _retrieve_user_content_chunks(
        db,
        viewer_id=viewer_id,
        query_embedding_model=query_embedding_model,
        query_embedding=query_embedding,
    )
    chosen: list[_Candidate] = []
    used_media: set[str] = set()
    ranked = sorted(
        content_chunks,
        key=lambda candidate: (-candidate.score, candidate.exact_snippet),
    )
    for candidate in ranked:
        media_id = str(candidate.source_ref.get("media_id") or "")
        if media_id and media_id in used_media:
            continue
        if media_id:
            used_media.add(media_id)
        chosen.append(candidate)
        if len(chosen) >= ORACLE_USER_LIBRARY_CANDIDATES:
            break
    return chosen


def _retrieve_user_content_chunks(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding_model: str,
    query_embedding: list[float],
) -> list[_Candidate]:
    semantic_rows = _retrieve_user_content_chunks_by_embedding(
        db,
        viewer_id=viewer_id,
        query_embedding_model=query_embedding_model,
        query_embedding=query_embedding,
    )
    chosen: list[_Candidate] = []
    used_semantic_media: set[str] = set()
    for row in semantic_rows:
        media_id = str(row["media_id"])
        if media_id in used_semantic_media:
            continue
        used_semantic_media.add(media_id)
        chosen.append(
            _candidate_from_content_chunk_row(
                row,
                score=float(row["semantic_score"] or 0.0),
            )
        )
        if len(chosen) >= ORACLE_USER_CONTENT_CHUNK_CANDIDATES:
            break
    return chosen


def _retrieve_user_content_chunks_by_embedding(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding_model: str,
    query_embedding: list[float],
) -> list[dict[str, Any]]:
    embedding_dims = transcript_embedding_dimensions()
    rows = (
        db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    query_embedding AS (
                        SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                    )
                SELECT
                    cc.id AS content_chunk_id,
                    cc.media_id,
                    cc.chunk_idx,
                    cc.chunk_text,
                    cc.source_kind,
                    cc.heading_path,
                    cc.summary_locator,
                    cc.primary_evidence_span_id,
                    m.title AS media_title,
                    (1 - (ce.embedding_vector <=> qe.embedding)) AS semantic_score
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = cc.media_id
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.active_run_id = cc.index_run_id
                    AND mcis.status = 'ready'
                JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                JOIN content_embeddings ce ON ce.chunk_id = cc.id
                    AND ce.embedding_provider = mcis.active_embedding_provider
                    AND ce.embedding_model = mcis.active_embedding_model
                    AND ce.embedding_version = mcis.active_embedding_version
                    AND ce.embedding_config_hash = mcis.active_embedding_config_hash
                    AND ce.embedding_dimensions = :embedding_dims
                    AND ce.embedding_vector IS NOT NULL
                JOIN query_embedding qe ON true
                WHERE btrim(cc.chunk_text) <> ''
                  AND mcis.active_embedding_model = :query_embedding_model
                ORDER BY ce.embedding_vector <=> qe.embedding ASC, cc.id ASC
                LIMIT 200
                """
            ),
            {
                "viewer_id": viewer_id,
                "query_embedding_model": query_embedding_model,
                "query_embedding": to_pgvector_literal(query_embedding),
                "embedding_dims": embedding_dims,
            },
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


def _candidate_from_content_chunk_row(row: dict[str, Any], *, score: float) -> _Candidate:
    media_title = str(row["media_title"] or "Untitled")
    summary_locator = dict(row["summary_locator"] or {})
    heading_path = [str(part) for part in row["heading_path"] or [] if str(part).strip()]
    locator_label = _content_chunk_locator_label(media_title, heading_path)
    return _Candidate(
        source_kind="user_media",
        exact_snippet=str(row["chunk_text"] or "")[:1200],
        locator_label=locator_label,
        attribution_text=f"From *{media_title}*, your library.",
        deep_link=None,
        source_ref=_user_content_chunk_source_ref(
            row,
            media_title=media_title,
            locator_label=locator_label,
            summary_locator=summary_locator,
            heading_path=heading_path,
        ),
        tags=["user-library", str(row["source_kind"])],
        score=score,
    )


def _content_chunk_locator_label(media_title: str, heading_path: list[str]) -> str:
    if heading_path:
        heading = " / ".join(heading_path[-2:])
        return f"From your library: {media_title} - {heading}"
    return f"From your library: {media_title}"


def _public_domain_source_ref_from_row(
    *,
    corpus_set_version_id: UUID,
    row: dict[str, Any],
) -> dict[str, Any]:
    locator = dict(row["locator"] or {})
    if not locator:
        locator = _structured_locator(str(row["locator_label"]), int(row["passage_index"]))
    source = dict(row["source"] or {})
    if not source:
        source = {
            "type": "public_domain_work",
            "repository": str(row["source_repository"]),
            "url": str(row["source_url"]),
            "work_slug": str(row["work_slug"]),
            "title": str(row["work_title"]),
            "author": str(row["work_author"]),
            "edition_label": str(row["edition_label"]),
            "year": row["work_year"],
        }
    citation_key = _stable_citation_key(
        {
            "type": "oracle_corpus_passage",
            "corpus_set_version_id": str(corpus_set_version_id),
            "work_slug": str(row["work_slug"]),
            "passage_index": int(row["passage_index"]),
            "text_sha256": hashlib.sha256(str(row["canonical_text"]).encode("utf-8")).hexdigest(),
        }
    )
    return {
        "type": "oracle_corpus_passage",
        "citation_key": citation_key,
        "corpus_set_version_id": str(corpus_set_version_id),
        "work_id": str(row["work_id"]),
        "work_slug": str(row["work_slug"]),
        "passage_id": str(row["passage_id"]),
        "passage_index": int(row["passage_index"]),
        "locator": locator,
        "source": source,
        "citation": {
            "citation_key": citation_key,
            "locator_label": str(row["locator_label"]),
            "source_title": str(row["work_title"]),
            "source_author": str(row["work_author"]),
            "source_url": str(row["source_url"]),
        },
    }


def _user_content_chunk_source_ref(
    row: dict[str, Any],
    *,
    media_title: str,
    locator_label: str,
    summary_locator: dict[str, Any],
    heading_path: list[str],
) -> dict[str, Any]:
    evidence_span_id = (
        str(row["primary_evidence_span_id"])
        if row["primary_evidence_span_id"] is not None
        else None
    )
    source = {
        "type": "user_media",
        "media_id": str(row["media_id"]),
        "title": media_title,
        "content_source_kind": str(row["source_kind"]),
    }
    locator = {
        "type": "content_chunk",
        "label": locator_label,
        "chunk_idx": int(row["chunk_idx"]),
        "heading_path": heading_path,
        "summary_locator": summary_locator,
        "evidence_span_id": evidence_span_id,
    }
    citation_key = _stable_citation_key(
        {
            "type": "content_chunk",
            "media_id": str(row["media_id"]),
            "content_chunk_id": str(row["content_chunk_id"]),
            "chunk_idx": int(row["chunk_idx"]),
        }
    )
    return {
        "type": "content_chunk",
        "citation_key": citation_key,
        "content_chunk_id": str(row["content_chunk_id"]),
        "evidence_span_id": evidence_span_id,
        "media_id": str(row["media_id"]),
        "media_title": media_title,
        "content_source_kind": str(row["source_kind"]),
        "chunk_idx": int(row["chunk_idx"]),
        "summary_locator": summary_locator,
        "locator": locator,
        "source": source,
        "citation": {
            "citation_key": citation_key,
            "locator_label": locator_label,
            "source_title": media_title,
            "media_id": str(row["media_id"]),
        },
    }


def _structured_locator(locator_label: str, passage_index: int) -> dict[str, Any]:
    locator: dict[str, Any] = {
        "type": "manifest_locator",
        "label": locator_label,
        "passage_index": int(passage_index),
    }
    section_line = re.search(
        r"\b(?P<section>[IVXLCDM]+|\d+)\.(?P<start>\d+)(?:[-–](?P<end>\d+))?\b",
        locator_label,
        re.IGNORECASE,
    )
    if section_line is not None:
        locator["section"] = section_line.group("section")
        locator["start"] = int(section_line.group("start"))
        if section_line.group("end"):
            locator["end"] = int(section_line.group("end"))
    return locator


def _stable_citation_key(payload: dict[str, Any]) -> str:
    stable = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(stable.encode("utf-8")).hexdigest()


def _corpus_embedding_model(db: Session, *, corpus_set_version_id: UUID) -> str:
    embedding_model = db.scalar(
        select(OracleCorpusSetVersion.embedding_model).where(
            OracleCorpusSetVersion.id == corpus_set_version_id
        )
    )
    if embedding_model is None:
        raise ApiError(ApiErrorCode.E_APP_SEARCH_FAILED, "Oracle corpus version is missing")
    return embedding_model


def _pick_plate(
    db: Session,
    *,
    corpus_set_version_id: UUID,
    query_embedding_model: str,
    query_embedding: list[float],
) -> OracleCorpusImage:
    corpus_embedding_model = _corpus_embedding_model(
        db,
        corpus_set_version_id=corpus_set_version_id,
    )
    if corpus_embedding_model != query_embedding_model:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle image embeddings do not match the query embedding model",
        )
    embedding_dims = transcript_embedding_dimensions()
    image_id = db.execute(
        text(
            f"""
                WITH query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                )
                SELECT oci.id
                FROM oracle_corpus_images oci
                JOIN query_embedding qe ON true
                WHERE oci.corpus_set_version_id = :corpus_set_version_id
                  AND oci.embedding_model = :embedding_model
                  AND oci.embedding IS NOT NULL
                  AND oci.width <= 4096
                  AND oci.height <= 4096
                ORDER BY oci.embedding <=> qe.embedding ASC, oci.source_url ASC
                LIMIT 1
                """
        ),
        {
            "corpus_set_version_id": corpus_set_version_id,
            "embedding_model": query_embedding_model,
            "query_embedding": to_pgvector_literal(query_embedding),
        },
    ).scalar_one_or_none()
    if image_id is None:
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED,
            "Oracle image embeddings are unavailable",
        )
    image = db.get(OracleCorpusImage, image_id)
    if image is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Oracle image index returned a missing row")
    return image


# ---------- internal: prompt ------------------------------------------------


_ORACLE_SYSTEM_PROMPT = (
    "You are the Black Forest Oracle. You speak in the register of Romantic and "
    "Gothic literature: candle-lit, formal but not stiff, attentive to weight and "
    "shadow. You are not a chatbot, an oracle character, or a fortune teller; you "
    "are an editorial voice arranging public-domain literary fragments and a single "
    "engraved plate into a coherent reading of the asker's question.\n\n"
    "EVERY READING IS A JOURNEY IN THREE PHASES.\n"
    "- DESCENT: the ground falls away; the question's shadow first appears.\n"
    "- ORDEAL: the soul wrestles; the matter at its hardest, its standstill.\n"
    "- ASCENT: the breaking through; what the dawn shows, what is given to see.\n\n"
    "RULES.\n"
    "1. Refer to candidate passages only by their integer index.\n"
    "2. Do not quote, paraphrase, summarize, or invent any text from the passages. "
    "The reader will see the verbatim passages alongside your prose.\n"
    "3. Do not invent works, authors, line numbers, page numbers, URLs, or citations. "
    "Do not include inline citation markers, footnotes, or parenthetical source notes.\n"
    "4. Select EXACTLY THREE candidate indices, one per phase. The three indices "
    "must be distinct. Choose the passage whose tone, image, or motion best fits "
    "each phase — descent passages bear weight and falling; ordeal passages bear "
    "wrestling and threshold; ascent passages bear opening and dawn.\n"
    "5. If any candidate is marked source_kind=user_media, select at least one "
    "user_media candidate among the three phases.\n"
    "6. For each selected passage, write one short marginalia note (one to two "
    "sentences) explaining how that passage answers the question. Do not quote.\n"
    "7. Compose ONE argument: a single sentence in Miltonic blank-verse cadence, "
    'between 80 and 180 characters, beginning with the word "Of". It names what '
    'the reading is about. Example: "Of the longing for unbroken light, and the '
    'lamp the soul keeps lit when the wood grows close."\n'
    "8. Compose ONE folio title: two to four words, evocative, no leading article "
    'constraint relaxed ("The Solitary Lamp" is fine; so is "Shoreline of '
    'Sleep"). Capitalize like a book title.\n'
    "9. Compose one continuous interpretation of three to five paragraphs. Do not "
    "address the reader as 'you'. Do not give advice or instructions. Refuse to "
    "predict the future. Refuse to make medical, legal, or financial claims.\n"
    "10. Compose exactly three omen lines. Each is one short clause naming a "
    "recurring image, motif, or correspondence across the selected passages. No "
    "imperative mood.\n"
    "11. Output strict JSON of the form: "
    '{"argument": string, "folio_title": string, "passages": '
    '[{"phase": "descent"|"ordeal"|"ascent", "candidate_index": int, '
    '"marginalia": string}], "interpretation": string, "omens": '
    "[string, string, string]}. No markdown fences, no extra keys, no commentary "
    "outside the JSON."
)


def _build_llm_request(*, question: str, candidates: Sequence[_Candidate]) -> LLMRequest:
    rendered = "\n\n".join(
        (
            f"[{index}] source_kind={candidate.source_kind} tags={candidate.tags!r}\n"
            f"label: {'your library passage' if candidate.source_kind == 'user_media' else 'public-domain passage'}\n"
            f"passage_text: {candidate.exact_snippet}"
        )
        for index, candidate in enumerate(candidates)
    )
    user_content = (
        f"CANDIDATES:\n{rendered}\n\n"
        f"QUESTION: {question.strip()}\n\n"
        "Respond with the strict JSON object as instructed."
    )
    return LLMRequest(
        model_name=ORACLE_MODEL_NAME,
        messages=[
            Turn(role="system", content=_ORACLE_SYSTEM_PROMPT, cache_ttl="5m"),
            Turn(role="user", content=user_content, cache_ttl="none"),
        ],
        max_tokens=ORACLE_MAX_OUTPUT_TOKENS,
        reasoning_effort="none",
        prompt_cache_key=ORACLE_PROMPT_VERSION,
    )


def _provider_request_hash(request: LLMRequest) -> str:
    return _hash_prompt_json(
        {
            "version": "oracle-provider-request-v1",
            "provider": ORACLE_PROVIDER,
            "model_name": request.model_name,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "reasoning_effort": request.reasoning_effort,
            "prompt_cache_key": request.prompt_cache_key,
            "messages": [
                {
                    "role": message.role,
                    "content": message.content,
                    "cache_ttl": message.cache_ttl,
                }
                for message in request.messages
            ],
        }
    )


# ---------- internal: LLM output parsing ------------------------------------


def _parse_llm_output(
    raw: str,
    *,
    candidates: Sequence[_Candidate],
) -> tuple[str, str, dict[str, tuple[int, str]], str, list[str]] | None:
    """Validate and unpack the LLM JSON.

    Returns (argument, folio_title, by_phase, interpretation, omens) where
    by_phase maps each phase to (candidate_index, marginalia). Returns None
    on any shape failure — caller fails the reading with E_LLM_BAD_REQUEST.
    """
    cleaned = raw.strip()
    if not cleaned.startswith("{") or not cleaned.endswith("}"):
        return None
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    if set(parsed.keys()) != {"argument", "folio_title", "passages", "interpretation", "omens"}:
        return None

    argument = parsed.get("argument")
    folio_title = parsed.get("folio_title")
    interpretation = parsed.get("interpretation")
    passages = parsed.get("passages")
    omens = parsed.get("omens")

    if not isinstance(argument, str) or not _valid_argument(argument):
        return None
    if not isinstance(folio_title, str) or not _valid_folio_title(folio_title):
        return None
    if not isinstance(interpretation, str) or not interpretation.strip():
        return None
    if not isinstance(passages, list) or len(passages) != 3:
        return None
    if not isinstance(omens, list) or len(omens) != 3:
        return None
    omen_lines = [line.strip() for line in omens if isinstance(line, str)]
    if len(omen_lines) != 3 or any(not line for line in omen_lines):
        return None

    by_phase: dict[str, tuple[int, str]] = {}
    used_indices: set[int] = set()
    candidate_count = len(candidates)
    for entry in passages:
        if not isinstance(entry, dict):
            return None
        if set(entry.keys()) != {"phase", "candidate_index", "marginalia"}:
            return None
        phase = entry.get("phase")
        idx = entry.get("candidate_index")
        marginalia = entry.get("marginalia")
        if phase not in ORACLE_PHASES or phase in by_phase:
            return None
        if not isinstance(idx, int) or idx < 0 or idx >= candidate_count:
            return None
        if idx in used_indices:
            return None
        if not isinstance(marginalia, str) or not marginalia.strip():
            return None
        used_indices.add(idx)
        by_phase[phase] = (idx, marginalia.strip())

    if set(by_phase.keys()) != set(ORACLE_PHASES):
        return None

    generated_blocks = [argument, folio_title, interpretation, *omen_lines]
    generated_blocks.extend(marginalia for _idx, marginalia in by_phase.values())
    if any(_contains_forbidden_citation_output(block, candidates) for block in generated_blocks):
        return None

    return (
        argument.strip(),
        folio_title.strip(),
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


def _valid_folio_title(value: str) -> bool:
    stripped = value.strip()
    words = stripped.split()
    return (
        value == stripped
        and 2 <= len(words) <= 4
        and len(stripped) <= 80
        and "\n" not in stripped
        and all(word[:1].isupper() for word in words if word[:1].isalpha())
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
