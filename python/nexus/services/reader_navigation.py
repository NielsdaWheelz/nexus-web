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
from nexus.services.web_article_structure import (
    WebArticleIndexBlockSpec,
    build_web_article_index_blocks,
    source_version_for_web_article,
)


def get_media_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    row = db.execute(
        text("SELECT kind, processing_status, title FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    kind = str(row[0])
    status = str(row[1])
    title = str(row[2])
    if kind == "epub":
        return get_epub_navigation_for_viewer(db, viewer_id, media_id)
    if kind != "web_article":
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports reader navigation")
        error.status_code = 409
        raise error
    if not is_document_status_ready(status):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    fragment_rows = db.execute(
        text(
            """
            SELECT id, idx, html_sanitized, canonical_text
            FROM fragments
            WHERE media_id = :media_id
            ORDER BY idx ASC
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    if not fragment_rows:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media navigation is not ready")

    canonical_texts: list[str] = []
    blocks: list[WebArticleIndexBlockSpec] = []
    heading_rows: list[tuple[UUID, int, str, str, WebArticleIndexBlockSpec]] = []
    for fragment in fragment_rows:
        fragment_id = fragment[0]
        fragment_idx = int(fragment[1])
        canonical_text = str(fragment[3] or "")
        canonical_texts.append(canonical_text)
        for block in build_web_article_index_blocks(
            html_sanitized=str(fragment[2] or ""),
            canonical_text=canonical_text,
            fragment_idx=fragment_idx,
            media_title=title,
        ):
            blocks.append(block)
            section_id = block.section_id
            if block.block_kind == "heading" and section_id is not None:
                label = canonical_text[block.start_offset : block.end_offset].strip()
                heading_rows.append((fragment_id, fragment_idx, label, section_id, block))
    source_version = source_version_for_web_article(canonical_texts, blocks)
    sections: list[ReaderNavigationSectionOut] = []
    for fallback_ordinal, (fragment_id, fragment_idx, label, section_id, block) in enumerate(
        heading_rows
    ):
        sections.append(
            ReaderNavigationSectionOut(
                section_id=section_id,
                label=label,
                ordinal=block.ordinal if block.ordinal is not None else fallback_ordinal,
                fragment_id=fragment_id,
                fragment_idx=fragment_idx,
                level=block.heading_level,
                depth=block.depth,
                start_offset=block.start_offset,
                end_offset=block.end_offset,
                anchor_id=block.anchor_id,
                source_version=source_version,
            )
        )

    return MediaNavigationOut(
        media_id=media_id,
        kind="web_article",
        source_version=source_version,
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
