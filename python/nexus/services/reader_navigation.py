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
from nexus.services.capabilities import is_document_status_ready
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
    if not is_document_status_ready(status):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    ready = db.execute(
        text(
            """
            SELECT 1
            FROM content_index_states mcis
            WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
              AND mcis.status = 'ready'
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if ready is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media navigation is not ready")

    rows = db.execute(
        text(
            """
            SELECT cb.canonical_text,
                   cb.block_idx,
                   cb.locator,
                   cb.metadata
            FROM content_blocks cb
            WHERE cb.owner_kind = 'media' AND cb.owner_id = :media_id
              AND cb.block_kind = 'heading'
            ORDER BY cb.block_idx ASC
            """
        ),
        {"media_id": media_id},
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
            )
        )

    return MediaNavigationOut(
        media_id=media_id,
        kind="web_article",
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
