"""Stored word-count projections for canonical media text."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.presence import Presence, absent, present

_MAX_BATCH_MEDIA = 200
_MAX_POSTGRES_BIGINT = 2**63 - 1
_DOCUMENT_KINDS = frozenset(("web_article", "epub", "pdf"))


@dataclass(frozen=True)
class MediaSummaryMetrics:
    word_count: int
    source_section_count: Presence[int]


def _nonnegative_bigint(value: object, *, label: str) -> int:
    # justify-service-invariant-check: raw-SQL aggregate values enter as object;
    # Python's types cannot encode the PostgreSQL bigint runtime shape or range.
    # justify-defect: a missing, malformed, or out-of-range stored metric means
    # the query/schema contract is broken, not that the metric is absent.
    if value is None:
        raise AssertionError(f"Missing {label}")
    if not isinstance(value, int) or isinstance(value, bool):
        raise AssertionError(f"Invalid {label} type: {type(value).__name__}")
    if value < 0 or value > _MAX_POSTGRES_BIGINT:
        raise AssertionError(f"Invalid {label}: {value}")
    return value


def load_media_word_counts(db: Session, media_ids: list[UUID]) -> dict[UUID, int]:
    distinct_ids = list(dict.fromkeys(media_ids))
    if not distinct_ids:
        return {}
    if len(distinct_ids) > _MAX_BATCH_MEDIA:
        # justify-service-invariant-check: Python list types cannot carry a
        # distinct-cardinality bound; callers own the documented 0..200 contract.
        # justify-defect: exceeding the internal batch contract is a caller bug.
        raise AssertionError(f"Media word-count batch exceeds {_MAX_BATCH_MEDIA} distinct IDs")

    rows = db.execute(
        text(
            """
            WITH fragment_counts AS MATERIALIZED (
                SELECT media_id, canonical_text_word_count
                FROM fragments
                WHERE media_id = ANY(:media_ids)
            )
            SELECT
                m.id,
                m.kind,
                CASE
                    WHEN m.kind IN ('web_article', 'epub')
                        THEN COALESCE(SUM(f.canonical_text_word_count), 0)
                    WHEN m.kind = 'pdf'
                        THEN m.plain_text_word_count::bigint
                    ELSE NULL
                END AS word_count
            FROM media m
            LEFT JOIN fragment_counts f
              ON f.media_id = m.id
             AND m.kind IN ('web_article', 'epub')
            WHERE m.id = ANY(:media_ids)
            GROUP BY m.id, m.kind, m.plain_text_word_count
            """
        ),
        {"media_ids": distinct_ids},
    ).all()

    counts: dict[UUID, int] = {}
    for raw_id, raw_kind, raw_count in rows:
        media_id = UUID(str(raw_id))
        kind = str(raw_kind)
        if kind not in _DOCUMENT_KINDS:
            # justify-service-invariant-check: raw SQL cannot encode the
            # correlation between the selected media kind and this document-only API.
            # justify-defect: callers preselect eligible document media.
            raise AssertionError(f"Unsupported document metrics kind: {kind}")
        counts[media_id] = _nonnegative_bigint(
            raw_count,
            label=f"word count for media {media_id}",
        )

    missing_ids = set(distinct_ids) - counts.keys()
    if missing_ids:
        # justify-service-invariant-check: result completeness is a query/input
        # correlation that cannot be represented by the returned dict type.
        # justify-defect: callers supply existing authorized IDs, so a miss is corruption.
        raise AssertionError(f"Missing media word counts: {sorted(map(str, missing_ids))}")
    return {media_id: counts[media_id] for media_id in distinct_ids}


def load_media_summary_metrics(db: Session, media_id: UUID) -> MediaSummaryMetrics:
    row = db.execute(
        text(
            """
            WITH fragment_counts AS MATERIALIZED (
                SELECT id, media_id, canonical_text_word_count
                FROM fragments
                WHERE media_id = :media_id
            )
            SELECT
                m.kind,
                CASE
                    WHEN m.kind = 'pdf'
                        THEN m.plain_text_word_count::bigint
                    ELSE COALESCE(SUM(f.canonical_text_word_count), 0)
                END AS word_count,
                CASE
                    WHEN m.kind = 'pdf' THEN COALESCE(
                        NULLIF(m.page_count, 0),
                        (
                            SELECT COUNT(DISTINCT page_number)
                            FROM pdf_page_text_spans
                            WHERE media_id = m.id
                        ),
                        0
                    )
                    WHEN m.kind IN ('podcast_episode', 'video') THEN COUNT(f.id)
                    ELSE NULL
                END AS source_section_count
            FROM media m
            LEFT JOIN fragment_counts f
              ON f.media_id = m.id
             AND m.kind != 'pdf'
            WHERE m.id = :media_id
            GROUP BY m.id, m.kind, m.plain_text_word_count, m.page_count
            """
        ),
        {"media_id": media_id},
    ).one_or_none()
    if row is None:
        # justify-service-invariant-check: the raw query result cannot encode the
        # caller's existing-media precondition in its static type.
        # justify-defect: summary callers resolve an existing authorized media row first.
        raise AssertionError(f"Missing media summary metrics: {media_id}")

    kind = str(row[0])
    if kind in ("web_article", "epub"):
        source_section_count = absent()
    elif kind in ("pdf", "podcast_episode", "video"):
        source_section_count = present(
            _nonnegative_bigint(
                row[2],
                label=f"source section count for media {media_id}",
            )
        )
    else:
        # justify-service-invariant-check: the database kind discriminant and the
        # finite summary union are correlated only at this raw-SQL boundary.
        # justify-defect: every persisted media kind must have an explicit summary policy.
        raise AssertionError(f"Unsupported media summary metrics kind: {kind}")

    return MediaSummaryMetrics(
        word_count=_nonnegative_bigint(
            row[1],
            label=f"word count for media {media_id}",
        ),
        source_section_count=source_section_count,
    )
