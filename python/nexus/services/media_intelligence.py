"""The per-media intelligence unit: read model and owner facade.

A *media unit* is one markdown abstract plus a set of grounded claims, each
bound to an existing ``evidence_spans`` row, built once per content fingerprint
by the ``media_unit_build`` job. The facade reads (``read_single`` /
``read_batch`` / ``ensure_current_many``) are audience-gated and 404-mask
unreadable media before resolving any id; ``get_media_unit`` is permission-free
for callers that carry their own visibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import MediaSummary
from nexus.errors import NotFoundError
from nexus.logging import get_logger
from nexus.schemas.media import MediaIntelligenceStatus
from nexus.services.media_intelligence_lifecycle import (
    MEDIA_UNIT_JOB_KIND,
    current_content_fingerprint,
    ensure_media_unit,
    media_unit_dedupe_key,
)

logger = get_logger(__name__)

# The candidate context budget in characters (~4 chars/token), leaving output
# headroom in the model window; chunks past it are dropped with one warning.
MEDIA_UNIT_INPUT_CHAR_BUDGET = 60_000
# The binding-owned ceiling on how many per-media builds one collect fans out.
ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY = 8


@dataclass(frozen=True)
class MediaClaimView:
    """One grounded claim of a ready unit."""

    claim_text: str
    evidence_span_id: UUID
    ordinal: int


@dataclass(frozen=True)
class MediaUnit:
    """A ready, current unit: its abstract and its grounded claims."""

    media_id: UUID
    summary_md: str
    model_name: str
    content_fingerprint: str
    claims: list[MediaClaimView]


class NotReady(Enum):
    """Why a unit cannot be returned as a :class:`MediaUnit`."""

    Missing = "missing"
    Building = "building"
    Failed = "failed"
    Stale = "stale"


@dataclass(frozen=True)
class MediaProjection:
    """The compact, claimless projection of one media's unit state.

    ``summary_md`` / ``model_name`` carry the abstract for ``ready`` and
    ``stale`` heads and are null otherwise.
    """

    media_id: UUID
    status: MediaIntelligenceStatus
    content_fingerprint: str
    summary_md: str | None
    model_name: str | None


class MediaOmissionReason(Enum):
    """Why an ``ensure_current_many`` subject yielded no usable projection."""

    NotAudienceVisible = "not_audience_visible"
    NoReadyUnit = "no_ready_unit"
    ProjectionPending = "projection_pending"
    ProjectionFailed = "projection_failed"
    ProjectionSuspended = "projection_suspended"
    Budget = "budget"


@dataclass(frozen=True)
class MediaOmission:
    """One omitted ``ensure_current_many`` subject (feeds binding coverage)."""

    media_id: UUID
    reason: MediaOmissionReason


@dataclass(frozen=True)
class Candidate:
    """One indexed chunk offered to the model by integer index."""

    evidence_span_id: UUID
    text: str


def media_summary_orm_or_none(db: Session, *, media_id: UUID) -> MediaSummary | None:
    """Load the unit head ORM by media id (the one home for head-ORM access)."""
    return db.scalars(
        select(MediaSummary)
        .where(MediaSummary.media_id == media_id)
        .execution_options(populate_existing=True)
    ).first()


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Permission-free single read: the current unit or why it is not ready."""
    head = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if head is None:
        return NotReady.Missing
    if head["status"] == "building":
        return NotReady.Building
    if head["status"] == "failed":
        return NotReady.Failed
    if head["content_fingerprint"] != current_content_fingerprint(db, media_id=media_id):
        return NotReady.Stale
    claims = (
        db.execute(
            text(
                """
                SELECT claim_text, evidence_span_id, ordinal
                FROM media_claims
                WHERE summary_id = :summary_id
                ORDER BY ordinal
                """
            ),
            {"summary_id": head["id"]},
        )
        .mappings()
        .all()
    )
    return MediaUnit(
        media_id=media_id,
        summary_md=str(head["summary_md"]),
        model_name=str(head["model_name"]),
        content_fingerprint=str(head["content_fingerprint"]),
        claims=[
            MediaClaimView(
                claim_text=str(row["claim_text"]),
                evidence_span_id=UUID(str(row["evidence_span_id"])),
                ordinal=int(row["ordinal"]),
            )
            for row in claims
        ],
    )


def read_batch(db: Session, *, media_ids: list[UUID]) -> dict[UUID, MediaProjection]:
    """Projections for the ready, current units among ``media_ids``.

    The set read behind citation-chip enrichment: a re-ingested-but-not-rebuilt
    unit is withheld and ``summary_md`` is always populated for what is
    returned. Audience filtering is the caller's; the ids are already scoped.
    """
    if not media_ids:
        return {}
    rows = (
        db.execute(
            text(
                """
                SELECT media_id, summary_md, model_name, content_fingerprint
                FROM media_summaries
                WHERE media_id = ANY(:media_ids) AND status = 'ready'
                """
            ),
            {"media_ids": media_ids},
        )
        .mappings()
        .all()
    )
    projections: dict[UUID, MediaProjection] = {}
    for row in rows:
        media_id = UUID(str(row["media_id"]))
        fingerprint = str(row["content_fingerprint"])
        if fingerprint == current_content_fingerprint(db, media_id=media_id):
            projections[media_id] = MediaProjection(
                media_id=media_id,
                status="ready",
                content_fingerprint=fingerprint,
                summary_md=str(row["summary_md"]),
                model_name=str(row["model_name"]),
            )
    return projections


def read_single(db: Session, *, media_id: UUID, requester_user_id: UUID) -> MediaProjection:
    """The authorized projection for one media; unreadable media 404-mask."""
    if not can_read_media(db, requester_user_id, media_id):
        raise NotFoundError(message="Media not found")
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    head = (
        db.execute(
            text(
                "SELECT status, summary_md, model_name, content_fingerprint "
                "FROM media_summaries WHERE media_id = :media_id"
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if head is None:
        return MediaProjection(media_id, "not_available", fingerprint, None, None)
    if head["status"] == "ready":
        # A stale head still shows the previous content version's abstract.
        current = head["content_fingerprint"] == fingerprint
        return MediaProjection(
            media_id,
            "ready" if current else "stale",
            fingerprint,
            str(head["summary_md"]),
            str(head["model_name"]),
        )
    status: MediaIntelligenceStatus = "failed"
    if head["status"] == "building":
        status = (
            "suspended"
            if media_unit_build_is_suspended(db, media_id=media_id, content_fingerprint=fingerprint)
            else "building"
        )
    return MediaProjection(media_id, status, fingerprint, None, None)


def ensure_current_many(
    db: Session,
    *,
    media_ids: list[UUID],
    requester_user_id: UUID,
    max_concurrency: int = ENSURE_CURRENT_MANY_DEFAULT_CONCURRENCY,
) -> list[MediaProjection | MediaOmission]:
    """Bounded ensure + usability projection over an audience-filtered set.

    One item per distinct media in subject order, every step non-blocking.
    """
    if max_concurrency < 1:
        raise ValueError("ensure_current_many requires max_concurrency >= 1")
    return [
        _ensure_one(
            db,
            media_id=media_id,
            requester_user_id=requester_user_id,
            over_budget=index >= max_concurrency,
        )
        for index, media_id in enumerate(dict.fromkeys(media_ids))
    ]


def _ensure_one(
    db: Session, *, media_id: UUID, requester_user_id: UUID, over_budget: bool
) -> MediaProjection | MediaOmission:
    """A usable projection — readable, ready, current, at least one claim — or why not.

    A pending subject has its build enqueued as a side effect and is reported
    pending; a ready but claimless unit is not usable.
    """

    def omit(reason: MediaOmissionReason) -> MediaOmission:
        return MediaOmission(media_id=media_id, reason=reason)

    if over_budget:
        return omit(MediaOmissionReason.Budget)
    if not can_read_media(db, requester_user_id, media_id):
        return omit(MediaOmissionReason.NotAudienceVisible)
    unit = get_media_unit(db, media_id=media_id)
    if isinstance(unit, MediaUnit) and unit.claims:
        return MediaProjection(
            media_id=media_id,
            status="ready",
            content_fingerprint=unit.content_fingerprint,
            summary_md=unit.summary_md,
            model_name=unit.model_name,
        )
    if isinstance(unit, MediaUnit) or not load_candidates(db, media_id=media_id):
        return omit(MediaOmissionReason.NoReadyUnit)
    if unit is NotReady.Failed:
        return omit(MediaOmissionReason.ProjectionFailed)
    if unit is NotReady.Building and media_unit_build_is_suspended(
        db,
        media_id=media_id,
        content_fingerprint=current_content_fingerprint(db, media_id=media_id),
    ):
        return omit(MediaOmissionReason.ProjectionSuspended)
    ensure_media_unit(db, media_id=media_id)
    return omit(MediaOmissionReason.ProjectionPending)


def media_unit_build_is_suspended(db: Session, *, media_id: UUID, content_fingerprint: str) -> bool:
    """Whether no queue row can still finish this media's current build.

    A missing or terminal exact job is operator-owned: enqueue uniqueness is
    global by dedupe key, so a replacement could double-dispatch billed work.
    """
    runnable = db.execute(
        text(
            """
            SELECT CASE
                WHEN status IN ('pending', 'failed') THEN true
                WHEN status = 'running'
                     AND (lease_expires_at > now() OR attempts < max_attempts) THEN true
                ELSE false
            END
            FROM background_jobs
            WHERE kind = :kind AND dedupe_key = :dedupe_key
            """
        ),
        {
            "kind": MEDIA_UNIT_JOB_KIND,
            "dedupe_key": media_unit_dedupe_key(media_id, content_fingerprint),
        },
    ).scalar_one_or_none()
    return runnable is not True


def load_candidates(db: Session, *, media_id: UUID) -> list[Candidate]:
    """The media's indexed chunks, in order, bounded by the context budget."""
    rows = (
        db.execute(
            text(
                """
                SELECT cc.chunk_text, es.span_text, cc.primary_evidence_span_id
                FROM content_chunks cc
                JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                  AND cc.primary_evidence_span_id IS NOT NULL
                ORDER BY cc.chunk_idx
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    candidates: list[Candidate] = []
    used_chars = 0
    for row in rows:
        candidate_text = str(row["span_text"] or row["chunk_text"] or "")
        if used_chars + len(candidate_text) > MEDIA_UNIT_INPUT_CHAR_BUDGET and candidates:
            logger.warning(
                "media_unit_build.candidates_truncated",
                media_id=str(media_id),
                kept=len(candidates),
                dropped=len(rows) - len(candidates),
                char_budget=MEDIA_UNIT_INPUT_CHAR_BUDGET,
            )
            break
        used_chars += len(candidate_text)
        candidates.append(
            Candidate(
                evidence_span_id=UUID(str(row["primary_evidence_span_id"])),
                text=candidate_text,
            )
        )
    return candidates
