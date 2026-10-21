"""The per-media intelligence unit: an abstract plus grounded claims, and its readers.

A unit is built once per content fingerprint by the ``media_unit_build`` job; each claim
cites an offered evidence span (I12). ``read_single`` and ``ensure_current_many`` are
audience-gated and 404-mask or omit unreadable media; ``get_media_unit`` and
``read_batch`` serve callers that carry their own visibility. A unit whose build died
reads ``failed`` everywhere (the job's ``on_dead`` hook fails it, I16).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import NotFoundError
from nexus.logging import get_logger
from nexus.services.media_intelligence_lifecycle import (
    current_content_fingerprint,
    current_content_fingerprints,
    ensure_media_unit,
)

logger = get_logger(__name__)

MediaIntelligenceStatus = Literal["building", "ready", "stale", "failed", "not_available"]

# The candidate budget in characters (~4 per token), leaving the model room to answer.
MEDIA_UNIT_INPUT_CHAR_BUDGET = 60_000
# How many per-media builds one ensure may fan out.
ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY = 8


@dataclass(frozen=True)
class MediaClaimView:
    claim_text: str
    evidence_span_id: UUID
    ordinal: int


@dataclass(frozen=True)
class MediaUnit:
    """A ready, current unit."""

    media_id: UUID
    summary_md: str
    model_name: str
    content_fingerprint: str
    claims: list[MediaClaimView]


class NotReady(Enum):
    Missing = "missing"
    Building = "building"
    Failed = "failed"
    Stale = "stale"


@dataclass(frozen=True)
class MediaProjection:
    """The claimless view of one unit; the abstract only for ``ready`` and ``stale``."""

    media_id: UUID
    status: MediaIntelligenceStatus
    content_fingerprint: str
    summary_md: str | None
    model_name: str | None


class MediaOmissionReason(Enum):
    NotAudienceVisible = "not_audience_visible"
    NoReadyUnit = "no_ready_unit"
    ProjectionPending = "projection_pending"
    ProjectionFailed = "projection_failed"
    Budget = "budget"


@dataclass(frozen=True)
class MediaOmission:
    media_id: UUID
    reason: MediaOmissionReason


@dataclass(frozen=True)
class Candidate:
    """One indexed chunk offered to the model by its position."""

    evidence_span_id: UUID
    text: str


_HEADS_SQL = """
    SELECT id, media_id, status, summary_md, model_name, content_fingerprint
    FROM media_summaries WHERE media_id = ANY(:ids)
"""


def _head(db: Session, media_id: UUID) -> Any:
    return db.execute(text(_HEADS_SQL), {"ids": [media_id]}).first()


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Permission-free: the current unit, or why there is none."""
    head = _head(db, media_id)
    if head is None:
        return NotReady.Missing
    if head.status != "ready":
        return NotReady.Building if head.status == "building" else NotReady.Failed
    if head.content_fingerprint != current_content_fingerprint(db, media_id=media_id):
        return NotReady.Stale
    claims = db.execute(
        text("""
            SELECT claim_text, evidence_span_id, ordinal FROM media_claims
            WHERE summary_id = :s ORDER BY ordinal
        """),
        {"s": head.id},
    )
    return MediaUnit(
        media_id=media_id,
        summary_md=head.summary_md,
        model_name=head.model_name,
        content_fingerprint=head.content_fingerprint,
        claims=[MediaClaimView(*claim) for claim in claims],
    )


def read_batch(db: Session, *, media_ids: list[UUID]) -> dict[UUID, MediaProjection]:
    """The ready, current units among already-scoped ``media_ids`` (citation chips)."""
    if not media_ids:
        return {}
    current = current_content_fingerprints(db, media_ids)
    return {
        head.media_id: MediaProjection(
            head.media_id, "ready", head.content_fingerprint, head.summary_md, head.model_name
        )
        for head in db.execute(text(_HEADS_SQL), {"ids": media_ids})
        if head.status == "ready" and head.content_fingerprint == current[head.media_id]
    }


def read_single(db: Session, *, media_id: UUID, requester_user_id: UUID) -> MediaProjection:
    """The authorized projection; a stale unit still shows its previous abstract."""
    if not can_read_media(db, requester_user_id, media_id):
        raise NotFoundError(message="Media not found")
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    head = _head(db, media_id)
    if head is None:
        return MediaProjection(media_id, "not_available", fingerprint, None, None)
    if head.status != "ready":
        return MediaProjection(media_id, head.status, fingerprint, None, None)
    status = "ready" if head.content_fingerprint == fingerprint else "stale"
    return MediaProjection(media_id, status, fingerprint, head.summary_md, head.model_name)


def ensure_current_many(
    db: Session,
    *,
    media_ids: list[UUID],
    requester_user_id: UUID,
    max_concurrency: int = ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY,
) -> list[MediaProjection | MediaOmission]:
    """One usable projection (readable, ready, current, with a claim) or omission per
    distinct media, in order; a buildable subject is enqueued and reported pending."""
    return [
        _ensure_one(db, media_id, requester_user_id)
        if index < max_concurrency
        else MediaOmission(media_id, MediaOmissionReason.Budget)
        for index, media_id in enumerate(dict.fromkeys(media_ids))
    ]


def _ensure_one(db: Session, media_id: UUID, requester: UUID) -> MediaProjection | MediaOmission:
    if not can_read_media(db, requester, media_id):
        return MediaOmission(media_id, MediaOmissionReason.NotAudienceVisible)
    unit = get_media_unit(db, media_id=media_id)
    if isinstance(unit, MediaUnit):
        if not unit.claims:
            return MediaOmission(media_id, MediaOmissionReason.NoReadyUnit)
        return MediaProjection(
            media_id, "ready", unit.content_fingerprint, unit.summary_md, unit.model_name
        )
    if not load_candidates(db, media_id=media_id):
        # Text still being indexed builds its unit when its index publishes (D4).
        indexing = db.scalar(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM content_index_states s JOIN background_jobs j
                      ON j.kind = 'media_content_reindex_job'
                     AND j.status IN ('pending', 'running', 'failed')
                     AND j.payload @> jsonb_build_object(
                         'media_id', s.owner_id::text, 'revision', s.revision)
                    WHERE s.owner_kind = 'media' AND s.owner_id = :m
                      AND s.status IN ('pending', 'indexing'))
            """),
            {"m": media_id},
        )
        reason = (
            MediaOmissionReason.ProjectionPending if indexing else MediaOmissionReason.NoReadyUnit
        )
        return MediaOmission(media_id, reason)
    if unit is NotReady.Failed:
        return MediaOmission(media_id, MediaOmissionReason.ProjectionFailed)
    ensure_media_unit(db, media_id=media_id)
    return MediaOmission(media_id, MediaOmissionReason.ProjectionPending)


def load_candidates(db: Session, *, media_id: UUID) -> list[Candidate]:
    """Own passages, or a thread's ordered primary post passages, within the budget.

    Thread claims cite canonical post spans; contextual posts never enter its prose.
    """
    rows = db.execute(
        text("""
            SELECT cc.primary_evidence_span_id, coalesce(nullif(es.span_text, ''), cc.chunk_text, '')
            FROM content_chunks cc JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            JOIN content_index_states s ON s.owner_kind = cc.owner_kind
              AND s.owner_id = cc.owner_id AND s.status = 'ready' AND s.lexical_revision = s.revision
            LEFT JOIN x_thread_posts tp ON tp.thread_media_id = :m AND tp.post_media_id = cc.owner_id
            WHERE cc.owner_kind = 'media' AND (
                tp.id IS NOT NULL OR (cc.owner_id = :m
                    AND NOT EXISTS (SELECT 1 FROM x_thread_sources WHERE media_id = :m)))
            ORDER BY tp.ordinal NULLS FIRST, cc.chunk_idx
        """),
        {"m": media_id},
    ).all()
    candidates: list[Candidate] = []
    used = 0
    for span_id, passage in rows:
        if candidates and used + len(passage) > MEDIA_UNIT_INPUT_CHAR_BUDGET:
            logger.warning(
                "media_unit_build.candidates_truncated",
                media_id=str(media_id),
                kept=len(candidates),
                dropped=len(rows) - len(candidates),
                char_budget=MEDIA_UNIT_INPUT_CHAR_BUDGET,
            )
            break
        used += len(passage)
        candidates.append(Candidate(span_id, passage))
    return candidates
