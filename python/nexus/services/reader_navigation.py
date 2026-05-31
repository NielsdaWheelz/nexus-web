"""Reader navigation read model."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.media import (
    MediaNavigationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.services.capabilities import READABLE_PROCESSING_STATUSES
from nexus.services.epub_read import get_epub_navigation_for_viewer


def get_media_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    row = db.execute(
        text("SELECT kind, processing_status FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    kind = str(row[0])
    status = str(row[1])
    if kind == "epub":
        return get_epub_navigation_for_viewer(db, viewer_id, media_id)
    if kind != "web_article":
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports reader navigation")
        error.status_code = 409
        raise error
    if status not in READABLE_PROCESSING_STATUSES:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    active = db.execute(
        text(
            """
            SELECT active_run.id, active_run.source_version
            FROM media_content_index_states mcis
            JOIN content_index_runs active_run
              ON active_run.id = mcis.active_run_id
             AND active_run.state = 'ready'
             AND active_run.deactivated_at IS NULL
            WHERE mcis.media_id = :media_id
              AND mcis.status = 'ready'
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if active is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media navigation is not ready")

    rows = db.execute(
        text(
            """
            SELECT cb.canonical_text,
                   cb.block_idx,
                   cb.locator,
                   cb.metadata,
                   ss.source_version
            FROM content_blocks cb
            JOIN source_snapshots ss ON ss.id = cb.source_snapshot_id
            WHERE cb.media_id = :media_id
              AND cb.index_run_id = :run_id
              AND cb.block_kind = 'heading'
            ORDER BY cb.block_idx ASC
            """
        ),
        {"media_id": media_id, "run_id": active[0]},
    ).fetchall()

    sections: list[ReaderNavigationSectionOut] = []
    for fallback_ordinal, row in enumerate(rows):
        locator = row[2] if isinstance(row[2], dict) else {}
        metadata = row[3] if isinstance(row[3], dict) else {}
        section_id = locator.get("section_id") or metadata.get("section_id")
        if not isinstance(section_id, str) or not section_id:
            continue
        sections.append(
            ReaderNavigationSectionOut(
                section_id=section_id,
                label=str(row[0]).strip(),
                ordinal=_int(metadata.get("ordinal"), fallback_ordinal),
                fragment_id=locator.get("fragment_id")
                if isinstance(locator.get("fragment_id"), str)
                else None,
                fragment_idx=_optional_int(locator.get("fragment_idx")),
                level=_optional_int(locator.get("heading_level")),
                depth=_optional_int(metadata.get("depth")),
                start_offset=_optional_int(locator.get("start_offset")),
                end_offset=_optional_int(locator.get("end_offset")),
                anchor_id=locator.get("anchor_id")
                if isinstance(locator.get("anchor_id"), str)
                else None,
                source_version=str(row[4]) if row[4] else str(active[1]),
            )
        )

    return MediaNavigationOut(
        media_id=media_id,
        kind="web_article",
        source_version=str(active[1]),
        sections=sections,
        toc_nodes=_toc_nodes(sections),
        landmarks=[],
        page_list=[],
    )


def _toc_nodes(sections: list[ReaderNavigationSectionOut]) -> list[ReaderNavigationTocNodeOut]:
    roots: list[ReaderNavigationTocNodeOut] = []
    stack: list[tuple[int, ReaderNavigationTocNodeOut]] = []
    for section in sections:
        depth = section.depth or 1
        node = ReaderNavigationTocNodeOut(
            id=section.section_id,
            label=section.label,
            ordinal=section.ordinal,
            fragment_idx=section.fragment_idx,
            level=section.level,
            depth=depth,
            section_id=section.section_id,
            source_version=section.source_version,
            children=[],
        )
        while stack and stack[-1][0] >= depth:
            stack.pop()
        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)
        stack.append((depth, node))
    return roots


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _int(value: object, fallback: int) -> int:
    return value if isinstance(value, int) else fallback
