"""The reader's one publication read: every unit, section and contents entry from one snapshot.

``GET /media/{id}/reader``, the offline reading copy and the public share all
build their document here; the caller supplies the pdf file (signed url, copy
member or public route) and holds the repeatable-read snapshot.
"""

from __future__ import annotations

import hashlib
from bisect import bisect_right
from collections.abc import Callable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.media import (
    DocumentEmbedOut,
    NavigationTextPointOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.presence import Present
from nexus.schemas.reader_document import (
    ReaderPdfDocumentOut,
    ReaderPdfFileOut,
    ReaderPointOut,
    ReaderSectionOut,
    ReaderTextDocumentOut,
    ReaderTocNodeOut,
    ReaderUnitOut,
)
from nexus.services.capabilities import is_text_document_ready
from nexus.services.document_embeds import list_document_embeds_for_fragments
from nexus.services.epub_read import rewrite_epub_fragment_links
from nexus.services.media_file_access import get_signed_download_url
from nexus.services.reader_navigation import read_media_navigation
from nexus.services.reader_publication import read_ready_publication_generation

_MEDIA_SQL = """
    SELECT m.kind, m.title, m.processing_status, m.page_count,
           mts.transcript_state, mts.transcript_coverage
    FROM media m LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    WHERE m.id = :media_id
"""
_UNITS_SQL = """
    SELECT f.id, f.idx, f.html_sanitized, f.canonical_text, f.t_start_ms, f.t_end_ms,
           f.speaker_label, source.package_href
    FROM fragments f
    LEFT JOIN epub_fragment_sources source
      ON source.media_id = f.media_id AND source.fragment_id = f.id
    WHERE f.media_id = :media_id
    ORDER BY f.t_start_ms ASC NULLS LAST, f.idx ASC
"""


def read_reader_document(
    db: Session, viewer_id: UUID, media_id: UUID
) -> ReaderTextDocumentOut | ReaderPdfDocumentOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    def signed() -> ReaderPdfFileOut:
        file = get_signed_download_url(db, viewer_id, media_id)
        return ReaderPdfFileOut(url=file["url"], expires_at=file["expires_at"])

    return build_reader_document(db, media_id=media_id, viewer_id=viewer_id, pdf_file=signed)


def build_reader_document(
    db: Session,
    *,
    media_id: UUID,
    viewer_id: UUID | None,
    pdf_file: Callable[[], ReaderPdfFileOut],
) -> ReaderTextDocumentOut | ReaderPdfDocumentOut:
    """An authorized media's document. Without a viewer, embeds are omitted."""
    media = db.execute(text(_MEDIA_SQL), {"media_id": media_id}).one()
    title = str(media.title)
    if media.kind in ("podcast_episode", "video"):
        if not is_text_document_ready(
            media.kind, media.processing_status, media.transcript_state, media.transcript_coverage
        ):
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
        units, embeds = _units(db, media_id=media_id, epub=False, viewer_id=viewer_id)
        digest = hashlib.sha256("\n".join(unit.id for unit in units).encode()).hexdigest()
        sections = _chapter_sections(db, media_id=media_id, units=units)
        return ReaderTextDocumentOut(
            kind="transcript",
            identity=f"t{digest[:24]}",
            title=title,
            units=units,
            sections=sections,
            toc_nodes=[
                ReaderTocNodeOut(
                    id=section.id,
                    label=section.label,
                    at=section.at,
                    section_id=section.id,
                    children=[],
                )
                for section in sections
            ],
            source_issues=[],
            embeds=embeds,
        )
    if media.kind not in ("web_article", "epub", "pdf"):
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Media has no reader document")
        error.status_code = 409
        raise error
    generation = read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    if media.kind == "pdf":
        return ReaderPdfDocumentOut(
            kind="pdf",
            identity=f"g{generation}",
            title=title,
            page_count=media.page_count,
            file=pdf_file(),
        )

    kind = "epub" if media.kind == "epub" else "web_article"
    units, embeds = _units(db, media_id=media_id, epub=kind == "epub", viewer_id=viewer_id)
    navigation = read_media_navigation(db, media_id=media_id, kind=kind, generation=generation)
    parents = {section.section_id: section.parent_section_id for section in navigation.sections}

    def depth(section: ReaderNavigationSectionOut) -> int:
        levels, parent = 0, section.parent_section_id
        while isinstance(parent, Present) and parent.value in parents:
            levels, parent = levels + 1, parents[parent.value]
        return levels

    def node(toc: ReaderNavigationTocNodeOut) -> ReaderTocNodeOut:
        return ReaderTocNodeOut(
            id=toc.id,
            label=toc.label,
            at=_point(toc.target.value) if isinstance(toc.target, Present) else None,
            section_id=toc.section_id.value if isinstance(toc.section_id, Present) else None,
            children=[node(child) for child in toc.children],
        )

    return ReaderTextDocumentOut(
        kind=kind,
        identity=f"g{generation}",
        title=title,
        units=units,
        sections=[
            ReaderSectionOut(
                id=section.section_id,
                label=section.label,
                depth=depth(section),
                at=_point(section.target),
                anchor_id=section.anchor_id.value
                if isinstance(section.anchor_id, Present)
                else None,
            )
            for section in navigation.sections
        ],
        toc_nodes=[node(toc) for toc in navigation.toc_nodes],
        source_issues=navigation.source_issues,
        embeds=embeds,
    )


def _units(
    db: Session, *, media_id: UUID, epub: bool, viewer_id: UUID | None
) -> tuple[list[ReaderUnitOut], list[DocumentEmbedOut]]:
    """Units in reading order (transcripts by time); epub links bound to their units."""
    rows = db.execute(text(_UNITS_SQL), {"media_id": media_id}).mappings().all()
    links = {row["package_href"]: row["id"] for row in rows if row["package_href"] is not None}
    units = [
        ReaderUnitOut(
            id=str(row["id"]),
            idx=row["idx"],
            html_sanitized=rewrite_epub_fragment_links(
                row["html_sanitized"], href_path=row["package_href"], fragment_ids_by_path=links
            )
            if epub
            else row["html_sanitized"],
            canonical_text=row["canonical_text"],
            char_count=len(row["canonical_text"]),
            href_path=row["package_href"],
            t_start_ms=row["t_start_ms"],
            t_end_ms=row["t_end_ms"],
            speaker_label=row["speaker_label"],
        )
        for row in rows
    ]
    if viewer_id is None:
        return units, []
    by_fragment = list_document_embeds_for_fragments(
        db, viewer_id=viewer_id, fragment_ids=[row["id"] for row in rows]
    )
    return units, [embed for row in rows for embed in by_fragment.get(row["id"], [])]


def _point(point: NavigationTextPointOut) -> ReaderPointOut:
    return ReaderPointOut(unit_id=str(point.fragment_id), offset=point.offset)


def _chapter_sections(
    db: Session, *, media_id: UUID, units: list[ReaderUnitOut]
) -> list[ReaderSectionOut]:
    """Publisher chapters at the segment that is playing when each one starts."""
    if not units:
        return []
    starts = [unit.t_start_ms or 0 for unit in units]
    return [
        ReaderSectionOut(
            id=f"chapter-{row.chapter_idx}",
            label=str(row.title),
            depth=0,
            at=ReaderPointOut(
                unit_id=units[max(0, bisect_right(starts, row.t_start_ms) - 1)].id, offset=0
            ),
            anchor_id=None,
        )
        for row in db.execute(
            text(
                "SELECT chapter_idx, title, t_start_ms FROM podcast_episode_chapters"
                " WHERE media_id = :media_id ORDER BY chapter_idx"
            ),
            {"media_id": media_id},
        )
    ]
