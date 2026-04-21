"""EPUB read service backed by persisted section/navigation rows."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import EpubNavigationOut, EpubNavigationSectionOut, EpubNavigationTocNodeOut, EpubSectionOut

_READABLE_STATUSES = frozenset({"ready_for_reading", "embedding", "ready"})


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
    if status not in _READABLE_STATUSES:
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
            ORDER BY order_key ASC
        """),
        {"mid": media_id},
    ).fetchall()


def get_epub_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> EpubNavigationOut:
    """Return canonical persisted EPUB navigation."""
    _enforce_epub_read_guards(db, viewer_id, media_id)

    section_rows = db.execute(
        text("""
            SELECT location_id, label, fragment_idx, href_path, href_fragment,
                   source_node_id, source, ordinal
            FROM epub_nav_locations
            WHERE media_id = :mid
            ORDER BY ordinal ASC
        """),
        {"mid": media_id},
    ).fetchall()
    toc_rows = _load_toc_rows(db, media_id)

    sections = [
        EpubNavigationSectionOut(
            section_id=row[0],
            label=row[1],
            fragment_idx=row[2],
            href_path=row[3],
            anchor_id=row[4],
            source_node_id=row[5],
            source=row[6],
            ordinal=row[7],
        )
        for row in section_rows
    ]

    section_by_source_node = {
        section.source_node_id: section.section_id
        for section in sections
        if section.source_node_id is not None
    }

    nodes_by_id: dict[str, EpubNavigationTocNodeOut] = {}
    roots: list[EpubNavigationTocNodeOut] = []

    for row in toc_rows:
        node = EpubNavigationTocNodeOut(
            node_id=row[0],
            parent_node_id=row[1],
            label=row[2],
            href=row[3],
            fragment_idx=row[4],
            depth=row[5],
            order_key=row[6],
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

    return EpubNavigationOut(sections=sections, toc_nodes=roots)


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
