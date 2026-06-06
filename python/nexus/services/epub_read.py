"""EPUB read service backed by persisted section/navigation rows."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import (
    EpubSectionOut,
    MediaNavigationOut,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.services.capabilities import is_document_status_ready


def _enforce_epub_read_guards(
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


def _compute_word_count(canonical_text: str) -> int:
    stripped = canonical_text.strip()
    if not stripped:
        return 0
    return len(stripped.split())


def _load_toc_rows(db: Session, media_id: UUID) -> list[tuple]:
    return db.execute(
        text("""
            SELECT node_id, parent_node_id, label, href,
                   fragment_idx, depth, order_key
            FROM epub_toc_nodes
            WHERE media_id = :mid
              AND nav_type = 'toc'
            ORDER BY order_key ASC
        """),
        {"mid": media_id},
    ).fetchall()


def _load_navigation_locations(db: Session, media_id: UUID, nav_type: str) -> list[tuple]:
    return db.execute(
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
    ).fetchall()


def get_epub_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut:
    """Return canonical persisted EPUB navigation."""
    _enforce_epub_read_guards(db, viewer_id, media_id)

    section_rows = db.execute(
        text("""
            WITH nav AS (
                SELECT n.location_id,
                       n.label,
                       f.id AS fragment_id,
                       n.fragment_idx,
                       n.href_path,
                       n.href_fragment,
                       n.source_node_id,
                       n.source,
                       n.ordinal,
                       char_length(f.canonical_text) AS fragment_chars,
                       row_number() OVER (
                           PARTITION BY n.fragment_idx
                           ORDER BY n.ordinal
                       ) AS fragment_row
                FROM epub_nav_locations n
                JOIN fragments f
                  ON f.media_id = n.media_id
                 AND f.idx = n.fragment_idx
                WHERE n.media_id = :mid
            )
            SELECT location_id,
                   label,
                   fragment_id,
                   fragment_idx,
                   href_path,
                   href_fragment,
                   source_node_id,
                   source,
                   ordinal,
                   CASE WHEN fragment_row = 1 THEN fragment_chars ELSE 0 END
            FROM nav
            ORDER BY ordinal ASC
        """),
        {"mid": media_id},
    ).fetchall()
    toc_rows = _load_toc_rows(db, media_id)
    landmark_rows = _load_navigation_locations(db, media_id, "landmarks")
    page_rows = _load_navigation_locations(db, media_id, "page_list")

    sections = [
        ReaderNavigationSectionOut(
            section_id=row[0],
            label=row[1],
            ordinal=row[8],
            fragment_id=row[2],
            fragment_idx=row[3],
            href_path=row[4],
            href_fragment=row[5],
            anchor_id=row[5],
            char_count=row[9],
        )
        for row in section_rows
    ]

    section_by_source_node = {
        str(row[6]): str(row[0]) for row in section_rows if row[6] is not None
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

    _enforce_epub_read_guards(db, viewer_id, media_id)

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
                   html_sanitized, canonical_text, created_at
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
        word_count=_compute_word_count(canonical_text),
        created_at=row[13],
    )
