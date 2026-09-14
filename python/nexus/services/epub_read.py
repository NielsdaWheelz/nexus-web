"""EPUB read service backed by persisted section/navigation rows."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import (
    MediaNavigationOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.reader import ReaderEpubTarget
from nexus.services.capabilities import is_document_status_ready


def epub_fragment_resume_targets(navigation: MediaNavigationOut) -> dict[UUID, ReaderEpubTarget]:
    """Reuse the first authored navigation section for each source fragment."""
    if navigation.kind != "epub":
        return {}
    targets: dict[UUID, ReaderEpubTarget] = {}
    for section in navigation.sections:
        if section.href_path is None:
            raise ValueError("EPUB navigation section has no source path")
        targets.setdefault(
            section.fragment_id,
            ReaderEpubTarget(
                section_id=section.section_id,
                href_path=section.href_path,
                anchor_id=section.anchor_id,
            ),
        )
    if targets.keys() != {fragment.fragment_id for fragment in navigation.fragments}:
        raise ValueError("EPUB source fragment has no existing navigation target")
    return targets


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

    return build_epub_navigation_projection(
        media_id=media_id,
        fragment_rows=fragment_rows,
        section_rows=section_rows,
        toc_rows=toc_rows,
        landmark_rows=landmark_rows,
        page_rows=page_rows,
    )


def build_epub_navigation_projection(
    *,
    media_id: UUID,
    fragment_rows: Sequence[Mapping[str, Any] | RowMapping],
    section_rows: Sequence[Mapping[str, Any] | RowMapping],
    toc_rows: Sequence[tuple],
    landmark_rows: Sequence[tuple],
    page_rows: Sequence[tuple],
) -> MediaNavigationOut:
    """One projection policy for persisted rows and the prepared extraction plan.

    Inputs use the exact named/positional row shapes selected immediately above;
    prepared plans supply these same facts before their database installation.
    """

    fragment_by_idx = {int(row["idx"]): row for row in fragment_rows}
    section_rows_by_fragment: dict[int, list] = {}
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
        section_rows_by_fragment.setdefault(fragment_idx, []).append(row)

    for fragment_idx, rows in section_rows_by_fragment.items():
        fragment_length = int(fragment_by_idx[fragment_idx]["char_count"])
        ordered_starts = sorted({int(row["start_offset"]) for row in rows})
        end_by_start = {
            start: ordered_starts[index + 1] if index + 1 < len(ordered_starts) else fragment_length
            for index, start in enumerate(ordered_starts)
        }
        if any(int(row["end_offset"]) != end_by_start[int(row["start_offset"])] for row in rows):
            raise RuntimeError("Ready EPUB navigation has invalid persisted intervals")

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
