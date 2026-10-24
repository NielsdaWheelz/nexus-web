"""The per-media intelligence unit: an abstract plus grounded claims, and its readers.

A unit is built once per content fingerprint by the ``media_unit_build`` job; each claim
cites an offered evidence span (I12). ``get_media_unit`` serves discovery callers that
carry their own visibility. A unit whose build died reads ``failed`` (the job's
``on_dead`` hook fails it, I16).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger
from nexus.services.media_intelligence_lifecycle import current_content_fingerprint

logger = get_logger(__name__)

# The candidate budget in characters (~4 per token), leaving the model room to answer.
MEDIA_UNIT_INPUT_CHAR_BUDGET = 60_000


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
class Candidate:
    """One indexed chunk offered to the model by its position."""

    evidence_span_id: UUID
    text: str


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Permission-free: the current unit, or why there is none."""
    head = db.execute(
        text("""
            SELECT id, status, summary_md, model_name, content_fingerprint
            FROM media_summaries WHERE media_id = :media_id
        """),
        {"media_id": media_id},
    ).first()
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


def load_candidates(db: Session, *, media_id: UUID) -> list[Candidate]:
    """Own passages, or a thread's ordered primary post passages, within the budget.

    Thread claims cite canonical post spans; contextual posts never enter its prose.
    """
    rows = db.execute(
        text("""
            SELECT cc.primary_evidence_span_id, coalesce(nullif(es.span_text, ''), cc.chunk_text, '')
            FROM content_chunks cc JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            JOIN content_index_states s ON s.owner_kind = cc.owner_kind
              AND s.owner_id = cc.owner_id AND s.status = 'ready'
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
