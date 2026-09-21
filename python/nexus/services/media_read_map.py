"""Per-kind media read access for the inspect and read tools.

Missing, forbidden, or not-ready media yields ``None``; a tool never sees an
exception from here.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError
from nexus.services.capabilities import is_text_document_ready
from nexus.services.media_document_metrics import load_media_summary_metrics
from nexus.services.pdf_readiness import is_pdf_quote_text_ready
from nexus.services.reader_navigation import get_media_navigation_for_viewer

READ_DOCUMENT_MAX_CHARS = 50_000  # media: read over this → too_large redirect
_PAGE_GROUP_CHARS = 6_000  # PDF pages are grouped into read sections up to ~this size
_MAX_MAP_SECTIONS = 200  # cap the read map; the model app_searches for the rest


@dataclass(frozen=True)
class MediaReadMapSection:
    label: str
    section_kind: str  # "heading" | "page_range" | "transcript_segment"
    read_uri: str  # fragment:<id> | page_range:<media>:<a>-<b>
    preview: str
    ordinal: int = 0
    fragment_id: UUID | None = None
    page_start: int | None = None
    page_end: int | None = None
    t_start_ms: int | None = None
    t_end_ms: int | None = None
    parent_label: str | None = None


@dataclass(frozen=True)
class MediaReadMap:
    media_id: UUID
    kind: str
    title: str
    sections: list[MediaReadMapSection] = field(default_factory=list)
    total_sections: int = 0  # full count before the _MAX_MAP_SECTIONS cap


@dataclass(frozen=True)
class DocumentRead:
    media_id: UUID
    kind: str
    title: str
    body: str
    char_count: int


@dataclass(frozen=True)
class MediaDocumentSummary:
    section_count: int | None
    word_count: int | None


@dataclass(frozen=True)
class _Readable:
    kind: str
    title: str


def _readable(db: Session, viewer_id: UUID, media_id: UUID) -> _Readable | None:
    """The media's kind and title when this viewer may read its current text."""
    if not can_read_media(db, viewer_id, media_id):
        return None
    row = db.execute(
        text(
            "SELECT m.kind, m.title, m.processing_status, mts.transcript_state,"
            " mts.transcript_coverage FROM media m"
            " LEFT JOIN media_transcript_states mts ON mts.media_id = m.id WHERE m.id = :id"
        ),
        {"id": media_id},
    ).first()
    if row is None:
        return None
    kind = str(row.kind)
    if not is_text_document_ready(
        kind, row.processing_status, row.transcript_state, row.transcript_coverage
    ):
        return None
    if kind == "pdf" and not is_pdf_quote_text_ready(db, media_id):
        return None
    return _Readable(kind=kind, title=str(row.title))


def get_media_read_map_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID
) -> MediaReadMap | None:
    readable = _readable(db, viewer_id, media_id)
    if readable is None:
        return None
    if readable.kind in ("web_article", "epub"):
        sections = _heading_sections(db, viewer_id, media_id)
        if sections is None:
            return None
    elif readable.kind == "pdf":
        sections = _page_sections(db, media_id)
    else:
        sections = _transcript_sections(db, media_id)
    numbered = [replace(section, ordinal=ordinal) for ordinal, section in enumerate(sections, 1)]
    return MediaReadMap(
        media_id=media_id,
        kind=readable.kind,
        title=readable.title,
        sections=numbered[:_MAX_MAP_SECTIONS],
        total_sections=len(numbered),
    )


def load_media_document_summary(
    db: Session, viewer_id: UUID, media_id: UUID
) -> MediaDocumentSummary | None:
    """The same metrics inspect/read report, for the resource-graph pointer summary."""
    readable = _readable(db, viewer_id, media_id)
    if readable is None:
        return None
    metrics = load_media_summary_metrics(db, media_id)
    section_count = metrics.source_section_count
    if readable.kind in ("web_article", "epub"):
        try:
            section_count = len(get_media_navigation_for_viewer(db, viewer_id, media_id).sections)
        except ApiError:
            # justify-ignore-error: navigation is not ready; the section count is absent.
            section_count = None
    return MediaDocumentSummary(section_count=section_count, word_count=metrics.word_count)


def load_media_document(db: Session, viewer_id: UUID, media_id: UUID) -> DocumentRead | None:
    readable = _readable(db, viewer_id, media_id)
    if readable is None:
        return None
    if readable.kind == "pdf":
        body = str(_plain_text(db, media_id) or "")
    else:
        body = _join_fragments(db, media_id)
    return DocumentRead(media_id, readable.kind, readable.title, body, len(body))


def read_page_range(
    db: Session, viewer_id: UUID, media_id: UUID, page_start: int, page_end: int
) -> str | None:
    readable = _readable(db, viewer_id, media_id)
    if readable is None or readable.kind != "pdf":
        return None
    plain_text = _plain_text(db, media_id)
    if plain_text is None:
        return None
    bounds = db.execute(
        text(
            "SELECT MIN(start_offset), MAX(end_offset) FROM pdf_page_text_spans"
            " WHERE media_id = :id AND page_number BETWEEN :a AND :b"
        ),
        {"id": media_id, "a": page_start, "b": page_end},
    ).first()
    if bounds is None or bounds[0] is None:
        return None
    return str(plain_text)[int(bounds[0]) : int(bounds[1])]


def _heading_sections(
    db: Session, viewer_id: UUID, media_id: UUID
) -> list[MediaReadMapSection] | None:
    try:
        nav = get_media_navigation_for_viewer(db, viewer_id, media_id)
    except ApiError:
        # justify-ignore-error: navigation is not ready, so there is no map to serve.
        return None
    previews = _fragment_previews(db, [s.target.fragment_id for s in nav.sections])
    return [
        MediaReadMapSection(
            label=section.label or "(section)",
            section_kind="heading",
            read_uri=f"fragment:{section.target.fragment_id}",
            preview=previews.get(section.target.fragment_id, ""),
            fragment_id=section.target.fragment_id,
        )
        for section in nav.sections
    ]


def _page_sections(db: Session, media_id: UUID) -> list[MediaReadMapSection]:
    plain_text = str(_plain_text(db, media_id) or "")
    sections: list[MediaReadMapSection] = []
    group: list[tuple[int, str | None, int, int]] = []

    def flush() -> None:
        first_page, first_label, group_start, _ = group[0]
        last_page, last_label, _, group_end = group[-1]
        first = first_label or str(first_page)
        last = last_label or str(last_page)
        sections.append(
            MediaReadMapSection(
                label=f"Page {first}" if first_page == last_page else f"Pages {first}-{last}",
                section_kind="page_range",
                read_uri=f"page_range:{media_id}:{first_page}-{last_page}",
                preview=_preview(plain_text[group_start:group_end]),
                page_start=first_page,
                page_end=last_page,
            )
        )

    rows = db.execute(
        text(
            "SELECT page_number, page_label, start_offset, end_offset FROM pdf_page_text_spans"
            " WHERE media_id = :id ORDER BY page_number ASC"
        ),
        {"id": media_id},
    )
    for row in rows:
        group.append((int(row[0]), str(row[1]) if row[1] else None, int(row[2]), int(row[3])))
        if group[-1][3] - group[0][2] >= _PAGE_GROUP_CHARS:
            flush()
            group = []
    if group:
        flush()
    return sections


def _transcript_sections(db: Session, media_id: UUID) -> list[MediaReadMapSection]:
    chapters = [
        (str(row[0]), int(row[1]), int(row[2]) if row[2] is not None else None)
        for row in db.execute(
            text(
                "SELECT title, t_start_ms, t_end_ms FROM podcast_episode_chapters"
                " WHERE media_id = :id ORDER BY chapter_idx ASC"
            ),
            {"id": media_id},
        )
    ]
    sections: list[MediaReadMapSection] = []
    for row in db.execute(
        text(
            "SELECT id, canonical_text, t_start_ms, t_end_ms FROM fragments"
            " WHERE media_id = :id ORDER BY t_start_ms ASC NULLS LAST, idx ASC"
        ),
        {"id": media_id},
    ):
        preview = _preview(str(row[1] or ""))
        t_start_ms = int(row[2]) if row[2] is not None else None
        sections.append(
            MediaReadMapSection(
                label=preview or "(segment)",
                section_kind="transcript_segment",
                read_uri=f"fragment:{row[0]}",
                preview=preview,
                t_start_ms=t_start_ms,
                t_end_ms=int(row[3]) if row[3] is not None else None,
                parent_label=_chapter_label(chapters, t_start_ms),
            )
        )
    return sections


def _plain_text(db: Session, media_id: UUID) -> str | None:
    return db.scalar(text("SELECT plain_text FROM media WHERE id = :id"), {"id": media_id})


def _join_fragments(db: Session, media_id: UUID) -> str:
    rows = db.execute(
        text(
            "SELECT canonical_text FROM fragments WHERE media_id = :id"
            " ORDER BY t_start_ms ASC NULLS LAST, idx ASC"
        ),
        {"id": media_id},
    )
    return "\n\n".join(str(row[0] or "") for row in rows)


def _fragment_previews(db: Session, fragment_ids: list[UUID]) -> dict[UUID, str]:
    if not fragment_ids:
        return {}
    rows = db.execute(
        text("SELECT id, canonical_text FROM fragments WHERE id = ANY(:ids)"),
        {"ids": fragment_ids},
    )
    return {row[0]: _preview(str(row[1] or "")) for row in rows}


def _chapter_label(
    chapters: list[tuple[str, int, int | None]], t_start_ms: int | None
) -> str | None:
    if t_start_ms is None or not chapters:
        return None
    fallback: str | None = None
    for title, chapter_start, chapter_end in chapters:
        if chapter_start > t_start_ms:
            break
        fallback = title
        if chapter_end is None or t_start_ms < chapter_end:
            return title
    return fallback


def _preview(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:160]
    return ""
