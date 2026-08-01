"""EPUB read service backed by persisted section/navigation rows."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import (
    EpubSectionOut,
    MediaNavigationOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.services.capabilities import is_document_status_ready


@dataclass(frozen=True, slots=True)
class EpubSectionSource:
    """Private source facts for a deterministic reading-order section."""

    ordinal: int
    label: str
    depth: int
    html_sanitized: str
    canonical_text: str


def list_epub_section_sources(
    db: Session,
    *,
    media_id: UUID,
    after_ordinal: int | None = None,
    limit: int,
) -> list[EpubSectionSource]:
    """Load section source facts without making an authorization decision."""
    rows = (
        db.execute(
            text(
                """
                SELECT n.ordinal,
                       n.label,
                       COALESCE(toc.depth, 0) AS depth,
                       f.html_sanitized,
                       f.canonical_text
                FROM epub_nav_locations n
                JOIN fragments f
                  ON f.media_id = n.media_id
                 AND f.idx = n.fragment_idx
                LEFT JOIN epub_toc_nodes toc
                  ON toc.media_id = n.media_id
                 AND toc.node_id = n.source_node_id
                AND toc.nav_type = 'toc'
                WHERE n.media_id = :media_id
                  AND (
                    CAST(:after_ordinal AS INTEGER) IS NULL
                    OR n.ordinal > CAST(:after_ordinal AS INTEGER)
                  )
                ORDER BY n.ordinal ASC
                LIMIT :limit
                """
            ),
            {
                "media_id": media_id,
                "after_ordinal": after_ordinal,
                "limit": limit,
            },
        )
        .mappings()
        .all()
    )
    return [
        EpubSectionSource(
            ordinal=int(row["ordinal"]),
            label=str(row["label"]),
            depth=int(row["depth"]),
            html_sanitized=str(row["html_sanitized"]),
            canonical_text=str(row["canonical_text"]),
        )
        for row in rows
    ]


def get_epub_section_source(
    db: Session,
    *,
    media_id: UUID,
    ordinal: int,
) -> EpubSectionSource | None:
    rows = list_epub_section_sources(
        db,
        media_id=media_id,
        after_ordinal=ordinal - 1,
        limit=1,
    )
    if not rows or rows[0].ordinal != ordinal:
        return None
    return rows[0]


def require_readable_epub(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> None:
    """Enforce guard order: visibility -> kind -> readiness."""
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    row = db.execute(
        text("SELECT kind, processing_status FROM media WHERE id = :mid"),
        {"mid": media_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    kind, status = row[0], row[1]
    if kind != "epub":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media")
    if not is_document_status_ready(str(status)):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")


def _load_toc_rows(db: Session, media_id: UUID) -> list[tuple]:
    return list(
        db.execute(
            text("""
                SELECT node_id, parent_node_id, label, href,
                       fragment_idx, depth, order_key
                FROM epub_toc_nodes
                WHERE media_id = :mid
                  AND nav_type = 'toc'
                ORDER BY order_key ASC
            """),
            {"mid": media_id},
        )
        .tuples()
        .all()
    )


def _load_navigation_locations(db: Session, media_id: UUID, nav_type: str) -> list[tuple]:
    return list(
        db.execute(
            text("""
                SELECT n.label,
                       n.href,
                       n.fragment_idx,
                       loc.location_id
                FROM epub_toc_nodes n
                LEFT JOIN LATERAL (
                    SELECT location_id
                    FROM epub_nav_locations
                    WHERE media_id = n.media_id
                      AND fragment_idx = n.fragment_idx
                    ORDER BY ordinal ASC
                    LIMIT 1
                ) loc ON n.fragment_idx IS NOT NULL
                WHERE n.media_id = :mid
                  AND n.nav_type = :nav_type
                ORDER BY n.order_key ASC
            """),
            {"mid": media_id, "nav_type": nav_type},
        )
        .tuples()
        .all()
    )


def get_epub_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut:
    """Return canonical persisted EPUB navigation."""
    require_readable_epub(db, viewer_id, media_id)

    fragment_rows = (
        db.execute(
            text(
                """
                SELECT id, idx, char_length(canonical_text) AS char_count
                FROM fragments
                WHERE media_id = :mid
                ORDER BY idx ASC
                """
            ),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    section_rows = (
        db.execute(
            text(
                """
                SELECT n.location_id,
                       n.label,
                       n.fragment_idx,
                       n.href_path,
                       n.href_fragment,
                       n.start_offset,
                       n.end_offset,
                       n.source_node_id,
                       n.source,
                       n.ordinal
                FROM epub_nav_locations n
                WHERE n.media_id = :mid
                ORDER BY n.ordinal ASC
                """
            ),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    toc_rows = _load_toc_rows(db, media_id)
    landmark_rows = _load_navigation_locations(db, media_id, "landmarks")
    page_rows = _load_navigation_locations(db, media_id, "page_list")

    fragment_by_idx = {int(row["idx"]): row for row in fragment_rows}
    previous_start_by_fragment: dict[int, int] = {}
    for row in section_rows:
        fragment_idx = int(row["fragment_idx"])
        fragment = fragment_by_idx.get(fragment_idx)
        if fragment is None:
            raise RuntimeError("Ready EPUB navigation targets a missing fragment")
        start_offset = int(row["start_offset"])
        end_offset = int(row["end_offset"])
        fragment_length = int(fragment["char_count"])
        if not 0 <= start_offset <= end_offset <= fragment_length:
            raise RuntimeError("Ready EPUB navigation has invalid persisted offsets")
        previous_start = previous_start_by_fragment.get(fragment_idx, -1)
        if start_offset < previous_start:
            raise RuntimeError("Ready EPUB navigation anchors are not in document order")
        previous_start_by_fragment[fragment_idx] = start_offset

    sections: list[ReaderNavigationSectionOut] = []
    for row in section_rows:
        fragment_idx = int(row["fragment_idx"])
        fragment = fragment_by_idx[fragment_idx]
        sections.append(
            ReaderNavigationSectionOut(
                section_id=str(row["location_id"]),
                label=str(row["label"]),
                ordinal=int(row["ordinal"]),
                fragment_id=fragment["id"],
                fragment_idx=fragment_idx,
                start_offset=int(row["start_offset"]),
                end_offset=int(row["end_offset"]),
                href_path=row["href_path"],
                href_fragment=row["href_fragment"],
                anchor_id=row["href_fragment"],
            )
        )

    fragments = [
        ReaderNavigationFragmentOut(
            fragment_id=row["id"],
            fragment_idx=row["idx"],
            char_count=row["char_count"],
        )
        for row in fragment_rows
    ]

    section_by_source_node = {
        str(row["source_node_id"]): str(row["location_id"])
        for row in section_rows
        if row["source_node_id"] is not None
    }

    nodes_by_id: dict[str, ReaderNavigationTocNodeOut] = {}
    roots: list[ReaderNavigationTocNodeOut] = []

    for ordinal, row in enumerate(toc_rows):
        node = ReaderNavigationTocNodeOut(
            id=row[0],
            label=row[2],
            ordinal=ordinal,
            href=row[3],
            fragment_idx=row[4],
            depth=row[5],
            section_id=section_by_source_node.get(row[0]),
            children=[],
        )
        nodes_by_id[row[0]] = node

    for row in toc_rows:
        node = nodes_by_id[row[0]]
        parent_id = row[1]
        if parent_id is None or parent_id not in nodes_by_id:
            roots.append(node)
        else:
            nodes_by_id[parent_id].children.append(node)

    return MediaNavigationOut(
        media_id=media_id,
        kind="epub",
        fragments=fragments,
        sections=sections,
        toc_nodes=roots,
        landmarks=[
            ReaderNavigationLocationOut(
                id=f"landmark:{idx}",
                label=row[0],
                ordinal=idx,
                href=row[1],
                fragment_idx=row[2],
                section_id=row[3],
            )
            for idx, row in enumerate(landmark_rows)
        ],
        page_list=[
            ReaderNavigationLocationOut(
                id=f"page:{idx}",
                label=row[0],
                ordinal=idx,
                href=row[1],
                fragment_idx=row[2],
                section_id=row[3],
            )
            for idx, row in enumerate(page_rows)
        ],
    )


def get_epub_section_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    section_id: str,
) -> EpubSectionOut:
    """Return canonical EPUB section content by persisted section id."""
    if not section_id:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "section_id is required")

    require_readable_epub(db, viewer_id, media_id)

    row = db.execute(
        text("""
            WITH ordered_sections AS (
                SELECT n.location_id,
                       n.label,
                       n.fragment_idx,
                       n.href_path,
                       n.href_fragment,
                       n.source_node_id,
                       n.source,
                       n.ordinal,
                       LAG(n.location_id) OVER (ORDER BY n.ordinal) AS prev_section_id,
                       LEAD(n.location_id) OVER (ORDER BY n.ordinal) AS next_section_id,
                       f.id AS fragment_id,
                       f.html_sanitized,
                       f.canonical_text,
                       f.canonical_text_word_count,
                       COALESCE(
                           (
                               SELECT SUM(prior.canonical_text_word_count)
                               FROM fragments prior
                               WHERE prior.media_id = f.media_id
                                 AND prior.idx < f.idx
                           ),
                           0
                       ) AS document_word_start,
                       f.created_at
                FROM epub_nav_locations n
                JOIN fragments f
                  ON f.media_id = n.media_id
                 AND f.idx = n.fragment_idx
                WHERE n.media_id = :mid
            )
            SELECT location_id, label, fragment_id, fragment_idx, href_path,
                   href_fragment, source_node_id, source, ordinal,
                   prev_section_id, next_section_id,
                   html_sanitized, canonical_text,
                   canonical_text_word_count, document_word_start, created_at
            FROM ordered_sections
            WHERE location_id = :section_id
        """),
        {"mid": media_id, "section_id": section_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(
            ApiErrorCode.E_CHAPTER_NOT_FOUND,
            f"Section '{section_id}' not found",
        )

    canonical_text = row[12]
    return EpubSectionOut(
        section_id=row[0],
        label=row[1],
        fragment_id=row[2],
        fragment_idx=row[3],
        href_path=row[4],
        anchor_id=row[5],
        source_node_id=row[6],
        source=row[7],
        ordinal=row[8],
        prev_section_id=row[9],
        next_section_id=row[10],
        html_sanitized=row[11],
        canonical_text=canonical_text,
        char_count=len(canonical_text),
        word_count=int(row[13]),
        document_word_start=int(row[14]),
        created_at=row[15],
    )
