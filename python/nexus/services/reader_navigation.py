"""Reader navigation over one canonical publication snapshot."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.media import (
    MediaNavigationOut,
    NavigationTextPointOut,
    NavigationTextRangeOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.services.capabilities import is_document_status_ready
from nexus.services.epub_read import read_epub_navigation
from nexus.services.reader_publication import read_publication_generation
from nexus.services.reader_structure import DocumentPoint, SectionRangeInput, resolve_section_ends


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
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if row.kind not in {"epub", "web_article"}:
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports reader navigation")
        error.status_code = 409
        raise error
    if not is_document_status_ready(str(row.processing_status)):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None:
        # justify-defect: canonical document content is installed by the publication owner.
        raise AssertionError("Readable document has no reader publication")
    return read_media_navigation(db, media_id=media_id, kind=row.kind, generation=generation)


def read_media_navigation(
    db: Session,
    *,
    media_id: UUID,
    kind: Literal["epub", "web_article"],
    generation: int,
) -> MediaNavigationOut:
    """Read navigation for an authorized, captured source publication."""
    if kind == "epub":
        return read_epub_navigation(db, media_id=media_id, generation=generation)
    from nexus.services.web_article_structure import build_web_article_index_blocks

    fragment_rows = (
        db.execute(
            text("""
            SELECT f.id, f.idx, char_length(f.canonical_text) AS char_count,
                   f.canonical_text, f.html_sanitized
            FROM fragments f
            WHERE f.media_id = :media_id ORDER BY f.idx
        """),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    fragments = [
        ReaderNavigationFragmentOut(
            fragment_id=row["id"],
            fragment_idx=row["idx"],
            char_count=row["char_count"],
        )
        for row in fragment_rows
    ]
    fragment_ids = {fragment.fragment_idx: fragment.fragment_id for fragment in fragments}
    inputs: list[SectionRangeInput] = []
    labels: dict[str, str] = {}
    anchors: dict[str, str | None] = {}
    for fragment in fragment_rows:
        headings = build_web_article_index_blocks(
            html_sanitized=fragment["html_sanitized"],
            canonical_text=fragment["canonical_text"],
            fragment_idx=fragment["idx"],
        )
        for heading in headings:
            if heading.section_id is None:
                continue
            container_end = heading.container_end_offset
            inputs.append(
                SectionRangeInput(
                    section_id=heading.section_id,
                    target=DocumentPoint(fragment["idx"], heading.start_offset),
                    parent_section_id=heading.parent_section_id,
                    container_end=present(DocumentPoint(fragment["idx"], container_end.value))
                    if container_end.kind == "Present"
                    else absent(),
                    owns_container=heading.owns_container,
                )
            )
            labels[heading.section_id] = fragment["canonical_text"][
                heading.start_offset : heading.end_offset
            ].strip()
            anchors[heading.section_id] = heading.anchor_id
    sections: list[ReaderNavigationSectionOut] = []
    nodes: dict[str, ReaderNavigationTocNodeOut] = {}
    roots: list[ReaderNavigationTocNodeOut] = []
    if inputs:
        last = fragments[-1]
        ends = resolve_section_ends(inputs, DocumentPoint(last.fragment_idx, last.char_count))
        for section in inputs:
            target = NavigationTextPointOut(
                fragment_id=fragment_ids[section.target.fragment_idx],
                offset=section.target.offset,
            )
            end = ends[section.section_id]
            sections.append(
                ReaderNavigationSectionOut(
                    section_id=section.section_id,
                    label=labels[section.section_id],
                    parent_section_id=section.parent_section_id,
                    target=target,
                    anchor_id=presence_from_nullable(anchors[section.section_id]),
                    source="Heading",
                    extent=present(
                        NavigationTextRangeOut(
                            start=target,
                            end=NavigationTextPointOut(
                                fragment_id=fragment_ids[end.value.fragment_idx],
                                offset=end.value.offset,
                            ),
                        )
                    )
                    if end.kind == "Present"
                    else absent(),
                )
            )
            node = ReaderNavigationTocNodeOut(
                id=section.section_id,
                label=labels[section.section_id],
                section_id=present(section.section_id),
                children=[],
            )
            nodes[section.section_id] = node
        for section in inputs:
            node = nodes[section.section_id]
            if section.parent_section_id.kind == "Present":
                nodes[section.parent_section_id.value].children.append(node)
            else:
                roots.append(node)
    return MediaNavigationOut(
        media_id=media_id,
        kind="web_article",
        generation=generation,
        fragments=fragments,
        sections=sections,
        toc_nodes=roots,
        landmarks=[],
        page_list=[],
    )
