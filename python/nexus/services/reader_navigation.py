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
from nexus.schemas.presence import Presence, Present, absent, presence_from_nullable, present
from nexus.services.capabilities import is_document_status_ready
from nexus.services.epub_read import read_epub_navigation
from nexus.services.reader_publication import (
    read_publication_generation,
    read_publication_source_issues,
)
from nexus.services.reader_structure import DocumentPoint, SectionRangeInput, resolve_section_ends


def get_media_navigation_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID
) -> MediaNavigationOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = db.execute(
        text(
            "SELECT m.kind, m.processing_status, rp.generation FROM media m"
            " LEFT JOIN reader_publications rp ON rp.media_id = m.id WHERE m.id = :media_id"
        ),
        {"media_id": media_id},
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if row.kind not in ("epub", "web_article"):
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports reader navigation")
        error.status_code = 409
        raise error
    if not is_document_status_ready(str(row.processing_status)) or row.generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    return read_media_navigation(db, media_id=media_id, kind=row.kind, generation=generation)


def read_media_navigation(
    db: Session,
    *,
    media_id: UUID,
    kind: Literal["epub", "web_article"],
    generation: int,
) -> MediaNavigationOut:
    """Navigation for an authorized, captured source publication."""
    if kind == "epub":
        return read_epub_navigation(db, media_id=media_id, generation=generation)
    from nexus.services.reader_apparatus import read_note_regions
    from nexus.services.web_article_structure import build_web_article_index_blocks

    fragment_rows = (
        db.execute(
            text(
                "SELECT f.id, f.idx, char_length(f.canonical_text) AS char_count,"
                " f.canonical_text, f.html_sanitized"
                " FROM fragments f WHERE f.media_id = :media_id ORDER BY f.idx"
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    fragments = [
        ReaderNavigationFragmentOut(
            fragment_id=row["id"], fragment_idx=row["idx"], char_count=row["char_count"]
        )
        for row in fragment_rows
    ]
    fragment_ids = {fragment.fragment_idx: fragment.fragment_id for fragment in fragments}
    note_regions = read_note_regions(db, media_id)
    inputs: list[SectionRangeInput] = []
    labels: dict[str, str] = {}
    anchors: dict[str, str | None] = {}
    toc_specs: list[tuple[str, str, Presence[str], NavigationTextPointOut, str | None]] = []
    for fragment in fragment_rows:
        headings = build_web_article_index_blocks(
            html_sanitized=fragment["html_sanitized"],
            canonical_text=fragment["canonical_text"],
            fragment_idx=fragment["idx"],
            fragment_id=fragment["id"],
            note_regions=note_regions,
        )
        for heading in headings:
            if heading.heading_id is None:
                continue
            toc_specs.append(
                (
                    heading.heading_id,
                    heading.heading_label or "",
                    heading.toc_parent_id,
                    NavigationTextPointOut(
                        fragment_id=fragment_ids[fragment["idx"]], offset=heading.start_offset
                    ),
                    heading.section_id,
                )
            )
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
            labels[heading.section_id] = heading.heading_label or ""
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
    section_targets = {section.section_id: section.target for section in sections}
    for heading_id, label, _parent_id, target, section_id in toc_specs:
        if section_id is not None and section_targets.get(section_id) != target:
            raise ValueError("Web TOC section linkage disagrees with its target")
        nodes[heading_id] = ReaderNavigationTocNodeOut(
            id=heading_id,
            label=label,
            target=present(target),
            section_id=presence_from_nullable(section_id),
            children=[],
        )
    for heading_id, _label, parent_id, _target, _section_id in toc_specs:
        if isinstance(parent_id, Present) and parent_id.value in nodes:
            nodes[parent_id.value].children.append(nodes[heading_id])
        else:
            roots.append(nodes[heading_id])
    return MediaNavigationOut(
        media_id=media_id,
        kind="web_article",
        generation=generation,
        source_issues=read_publication_source_issues(db, media_id=media_id, generation=generation),
        fragments=fragments,
        sections=sections,
        toc_nodes=roots,
        landmarks=[],
        page_list=[],
    )
