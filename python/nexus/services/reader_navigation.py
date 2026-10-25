"""Reader navigation over one canonical publication snapshot."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.reader import (
    MediaNavigationOut,
    NavigationTextPointOut,
    NavigationTextRangeOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.services.capabilities import is_document_status_ready
from nexus.services.epub_read import read_epub_navigation_proof
from nexus.services.reader_publication import (
    read_publication_generation,
    read_publication_source_issues,
)
from nexus.services.reader_structure import (
    DocumentPoint,
    DomCut,
    NavigationProof,
    SectionProof,
    SectionRangeInput,
    resolve_section_extents,
)
from nexus.services.reader_text_slice import navigation_proof


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


def read_media_navigation_proof(
    db: Session,
    *,
    media_id: UUID,
    kind: Literal["epub", "web_article"],
    generation: int,
) -> NavigationProof:
    """Navigation for an authorized, captured source publication."""
    if kind == "epub":
        return read_epub_navigation_proof(db, media_id=media_id, generation=generation)
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
    toc_specs: list[tuple[str, str, str | None, NavigationTextPointOut, str | None]] = []
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
                    container_end=DocumentPoint(fragment["idx"], container_end)
                    if container_end is not None
                    else None,
                    owns_container=heading.owns_container,
                    start_cut=heading.start_cut,
                    container_end_cut=heading.container_end_cut,
                )
            )
            labels[heading.section_id] = heading.heading_label or ""
            anchors[heading.section_id] = heading.anchor_id
    sections: list[ReaderNavigationSectionOut] = []
    proofs: list[SectionProof] = []
    nodes: dict[str, ReaderNavigationTocNodeOut] = {}
    roots: list[ReaderNavigationTocNodeOut] = []
    if inputs:
        last = fragments[-1]
        ends = resolve_section_extents(
            inputs,
            DocumentPoint(last.fragment_idx, last.char_count),
            document_end_cut=DomCut((), "after"),
        )
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
                    anchor_id=anchors[section.section_id],
                    source="Heading",
                    extent=NavigationTextRangeOut(
                        start=target,
                        end=NavigationTextPointOut(
                            fragment_id=fragment_ids[end.point.fragment_idx],
                            offset=end.point.offset,
                        ),
                    )
                    if end is not None
                    else None,
                )
            )
            proofs.append(
                SectionProof(
                    section_id=section.section_id,
                    label=labels[section.section_id],
                    parent_section_id=section.parent_section_id,
                    start=section.target,
                    end=end.point if end is not None else None,
                    start_cut=section.start_cut,
                    end_cut=end.cut if end is not None else None,
                )
            )
    section_targets = {section.section_id: section.target for section in sections}
    for heading_id, label, _parent_id, target, section_id in toc_specs:
        if section_id is not None and section_targets.get(section_id) != target:
            raise ValueError("Web TOC section linkage disagrees with its target")
        nodes[heading_id] = ReaderNavigationTocNodeOut(
            id=heading_id,
            label=label,
            target=target,
            section_id=section_id,
            children=[],
        )
    for heading_id, _label, parent_id, _target, _section_id in toc_specs:
        if parent_id is not None and parent_id in nodes:
            nodes[parent_id].children.append(nodes[heading_id])
        else:
            roots.append(nodes[heading_id])
    navigation = MediaNavigationOut(
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

    return navigation_proof(navigation, proofs)


def read_media_navigation(
    db: Session, *, media_id: UUID, kind: Literal["epub", "web_article"], generation: int
) -> MediaNavigationOut:
    """Ordinary navigation and section proof share one detector projection."""
    return read_media_navigation_proof(
        db, media_id=media_id, kind=kind, generation=generation
    ).navigation
