"""Per-kind media document access — the single owner of document-map and
full-read SQL for a media item.

Three operations, one place:
- ``get_media_document_map_for_viewer`` — an ordered, navigable section list
  (the agent's ``inspect_resource`` document map).
- ``load_media_document`` — the whole canonical body + char count (the read
  tool's ``media:`` full / too_large read).
- ``read_page_range`` — a PDF page-range slice of ``media.plain_text`` (the read
  tool's ``page_range:`` evidence read).

Sections are neutral (not the frontend-coupled ``MediaNavigationOut``): each
points at evidence the read tool can actually open (``fragment:`` or
``page_range:``). web/epub section data is reused from ``reader_navigation`` (no
SQL duplicated; one-way dependency — ``reader_navigation`` does not import this);
pdf and podcast/video SQL is owned here. Missing/forbidden media returns
``None``; never raises to a tool (errors.md).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError
from nexus.services.capabilities import is_text_document_ready
from nexus.services.pdf_readiness import is_pdf_quote_text_ready
from nexus.services.reader_navigation import get_media_navigation_for_viewer

READ_DOCUMENT_MAX_CHARS = 50_000  # media: read over this → too_large redirect
_PAGE_GROUP_CHARS = 6_000  # PDF pages are grouped into read sections up to ~this size
_MAX_MAP_SECTIONS = 200  # cap the document map; the model app_searches for the rest


@dataclass(frozen=True)
class DocumentMapSection:
    label: str
    section_kind: str  # "heading" | "page_range" | "transcript_segment"
    read_uri: str  # fragment:<id> | page_range:<media>:<a>-<b>
    preview: str
    ordinal: int = 0
    source_version: str | None = None
    fragment_id: UUID | None = None
    page_start: int | None = None
    page_end: int | None = None
    t_start_ms: int | None = None
    t_end_ms: int | None = None
    parent_label: str | None = None


@dataclass(frozen=True)
class MediaDocumentMap:
    media_id: UUID
    kind: str
    title: str
    sections: list[DocumentMapSection] = field(default_factory=list)
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
    """Prompt-facing document metrics owned by the document access layer."""

    section_count: int | None
    word_count: int | None


def get_media_document_map_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID
) -> MediaDocumentMap | None:
    if not can_read_media(db, viewer_id, media_id):
        return None
    row = db.execute(
        text("""
            SELECT m.kind, m.title, m.processing_status,
                   mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :id
        """),
        {"id": media_id},
    ).fetchone()
    if row is None:
        return None
    kind = str(row[0])
    title = str(row[1])
    if not is_text_document_ready(
        kind,
        str(row[2]),
        str(row[3]) if row[3] is not None else None,
        str(row[4]) if row[4] is not None else None,
    ):
        return None
    if kind in ("podcast_episode", "video") and _active_transcript_version(db, media_id) is None:
        return None
    if kind in ("web_article", "epub"):
        sections = _heading_sections(db, viewer_id, media_id)
        if sections is None:
            return None
    elif kind == "pdf":
        if not is_pdf_quote_text_ready(db, media_id):
            return None
        sections = _page_sections(db, media_id)
    elif kind in ("podcast_episode", "video"):
        sections = _transcript_sections(db, media_id)
    else:
        raise AssertionError(f"Unhandled media kind for document map: {kind}")
    numbered_sections = [
        replace(section, ordinal=ordinal) for ordinal, section in enumerate(sections, start=1)
    ]
    total = len(numbered_sections)
    return MediaDocumentMap(
        media_id=media_id,
        kind=kind,
        title=title,
        sections=numbered_sections[:_MAX_MAP_SECTIONS],
        total_sections=total,
    )


def load_media_document_summary(
    db: Session, viewer_id: UUID, media_id: UUID
) -> MediaDocumentSummary | None:
    """Return the same user-visible metrics as inspect/read for a media item.

    ``resource_resolver`` uses this for the pointer summary so section counts do
    not drift from the document map's per-kind ownership rules.
    """
    if not can_read_media(db, viewer_id, media_id):
        return None
    row = db.execute(
        text("""
            SELECT m.kind, m.processing_status, mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :id
        """),
        {"id": media_id},
    ).fetchone()
    if row is None:
        return None
    kind = str(row[0])
    if not is_text_document_ready(
        kind,
        str(row[1]),
        str(row[2]) if row[2] is not None else None,
        str(row[3]) if row[3] is not None else None,
    ):
        return None
    if kind == "pdf":
        if not is_pdf_quote_text_ready(db, media_id):
            return None
        metrics = db.execute(
            text(
                """
                SELECT
                    COALESCE(NULLIF(m.page_count, 0), page_spans.page_count, 0) AS section_count,
                    CASE
                        WHEN btrim(COALESCE(m.plain_text, '')) = '' THEN 0
                        ELSE cardinality(regexp_split_to_array(btrim(m.plain_text), '\\s+'))
                    END AS word_count
                FROM media m
                LEFT JOIN LATERAL (
                    SELECT COUNT(DISTINCT page_number) AS page_count
                    FROM pdf_page_text_spans
                    WHERE media_id = m.id
                ) page_spans ON true
                WHERE m.id = :id
                """
            ),
            {"id": media_id},
        ).fetchone()
        if metrics is None:
            return None
        return MediaDocumentSummary(
            section_count=int(metrics[0] or 0),
            word_count=int(metrics[1] or 0),
        )
    if kind in ("web_article", "epub"):
        sections = _heading_sections(db, viewer_id, media_id)
        metrics = db.execute(
            text(
                """
                SELECT COALESCE(SUM(
                    CASE
                        WHEN btrim(COALESCE(canonical_text, '')) = '' THEN 0
                        ELSE cardinality(regexp_split_to_array(btrim(canonical_text), '\\s+'))
                    END
                ), 0) AS word_count
                FROM fragments
                WHERE media_id = :id
                """
            ),
            {"id": media_id},
        ).fetchone()
        return MediaDocumentSummary(
            section_count=len(sections) if sections is not None else None,
            word_count=int(metrics[0] or 0) if metrics is not None else None,
        )
    if kind in ("podcast_episode", "video"):
        version_id = _active_transcript_version(db, media_id)
        if version_id is None:
            return None
        metrics = db.execute(
            text(
                """
                SELECT COUNT(*) AS section_count,
                       COALESCE(SUM(
                           CASE
                               WHEN btrim(COALESCE(canonical_text, '')) = '' THEN 0
                               ELSE cardinality(regexp_split_to_array(btrim(canonical_text), '\\s+'))
                           END
                       ), 0) AS word_count
                FROM fragments
                WHERE media_id = :id AND transcript_version_id = :version_id
                """
            ),
            {"id": media_id, "version_id": version_id},
        ).fetchone()
        if metrics is None:
            return None
        return MediaDocumentSummary(
            section_count=int(metrics[0] or 0),
            word_count=int(metrics[1] or 0),
        )
    raise AssertionError(f"Unhandled media kind for document summary: {kind}")


def load_media_document(db: Session, viewer_id: UUID, media_id: UUID) -> DocumentRead | None:
    if not can_read_media(db, viewer_id, media_id):
        return None
    row = db.execute(
        text("""
            SELECT m.kind, m.title, m.plain_text, m.processing_status,
                   mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :id
        """),
        {"id": media_id},
    ).fetchone()
    if row is None:
        return None
    kind = str(row[0])
    title = str(row[1])
    if not is_text_document_ready(
        kind,
        str(row[3]),
        str(row[4]) if row[4] is not None else None,
        str(row[5]) if row[5] is not None else None,
    ):
        return None
    if kind == "pdf":
        if not is_pdf_quote_text_ready(db, media_id):
            return None
        body = str(row[2] or "")
    elif kind in ("web_article", "epub"):
        body = _join_fragments(db, media_id, transcript_version_id=None)
    elif kind in ("podcast_episode", "video"):
        version_id = _active_transcript_version(db, media_id)
        if version_id is None:
            return None
        body = _join_fragments(db, media_id, transcript_version_id=version_id)
    else:
        raise AssertionError(f"Unhandled media kind for full read: {kind}")
    return DocumentRead(media_id=media_id, kind=kind, title=title, body=body, char_count=len(body))


def read_page_range(
    db: Session, viewer_id: UUID, media_id: UUID, page_start: int, page_end: int
) -> str | None:
    if not can_read_media(db, viewer_id, media_id):
        return None
    row = db.execute(
        text("SELECT kind, plain_text, processing_status FROM media WHERE id = :id"),
        {"id": media_id},
    ).fetchone()
    if row is None:
        return None
    if str(row[0]) != "pdf":
        return None
    if not is_text_document_ready(str(row[0]), str(row[2])):
        return None
    if not is_pdf_quote_text_ready(db, media_id):
        return None
    plain_text = row[1]
    if plain_text is None:
        return None
    bounds = db.execute(
        text(
            """
            SELECT MIN(start_offset), MAX(end_offset)
            FROM pdf_page_text_spans
            WHERE media_id = :id AND page_number BETWEEN :a AND :b
            """
        ),
        {"id": media_id, "a": page_start, "b": page_end},
    ).fetchone()
    if bounds is None or bounds[0] is None:
        return None
    return str(plain_text)[int(bounds[0]) : int(bounds[1])]


# --- section builders (per kind) -------------------------------------------------


def _heading_sections(
    db: Session, viewer_id: UUID, media_id: UUID
) -> list[DocumentMapSection] | None:
    try:
        nav = get_media_navigation_for_viewer(db, viewer_id, media_id)
    except ApiError:
        # justify-ignore-error: media exists and is readable (checked above); a
        # remaining ApiError means navigation is not ready yet → the map is not
        # available. Do not silently return a successful empty map.
        return None
    fragment_ids = [s.fragment_id for s in nav.sections if s.fragment_id is not None]
    previews = _fragment_previews(db, fragment_ids)
    sections: list[DocumentMapSection] = []
    for nav_section in nav.sections:
        if nav_section.fragment_id is None:
            continue
        sections.append(
            DocumentMapSection(
                label=nav_section.label or "(section)",
                section_kind="heading",
                read_uri=f"fragment:{nav_section.fragment_id}",
                preview=previews.get(nav_section.fragment_id, ""),
                source_version=nav_section.source_version,
                fragment_id=nav_section.fragment_id,
            )
        )
    return sections


def _page_sections(db: Session, media_id: UUID) -> list[DocumentMapSection]:
    plain_text = str(
        db.scalar(text("SELECT plain_text FROM media WHERE id = :id"), {"id": media_id}) or ""
    )
    rows = db.execute(
        text(
            """
            SELECT page_number, page_label, start_offset, end_offset
            FROM pdf_page_text_spans
            WHERE media_id = :id
            ORDER BY page_number ASC
            """
        ),
        {"id": media_id},
    ).fetchall()
    sections: list[DocumentMapSection] = []
    group: list[tuple[int, str | None, int, int]] = []

    def flush() -> None:
        first_page, first_label, group_start, _ = group[0]
        last_page, last_label, _, group_end = group[-1]
        first_display = first_label or str(first_page)
        last_display = last_label or str(last_page)
        label = (
            f"Page {first_display}"
            if first_page == last_page
            else f"Pages {first_display}-{last_display}"
        )
        sections.append(
            DocumentMapSection(
                label=label,
                section_kind="page_range",
                read_uri=f"page_range:{media_id}:{first_page}-{last_page}",
                preview=_preview(plain_text[group_start:group_end]),
                page_start=first_page,
                page_end=last_page,
            )
        )

    for row in rows:
        group.append((int(row[0]), str(row[1]) if row[1] else None, int(row[2]), int(row[3])))
        if group[-1][3] - group[0][2] >= _PAGE_GROUP_CHARS:
            flush()
            group = []
    if group:
        flush()
    return sections


def _transcript_sections(db: Session, media_id: UUID) -> list[DocumentMapSection]:
    version_id = _active_transcript_version(db, media_id)
    if version_id is None:
        return []
    chapters: list[tuple[str, int, int | None]] = [
        (str(row[0]), int(row[1]), int(row[2]) if row[2] is not None else None)
        for row in db.execute(
            text(
                """
                SELECT title, t_start_ms, t_end_ms
                FROM podcast_episode_chapters
                WHERE media_id = :id
                ORDER BY chapter_idx ASC
                """
            ),
            {"id": media_id},
        ).fetchall()
    ]
    fragments = db.execute(
        text(
            """
            SELECT id, canonical_text, t_start_ms, t_end_ms
            FROM fragments
            WHERE media_id = :id AND transcript_version_id = :version_id
            ORDER BY t_start_ms ASC NULLS LAST, idx ASC
            """
        ),
        {"id": media_id, "version_id": version_id},
    ).fetchall()
    sections: list[DocumentMapSection] = []
    for row in fragments:
        canonical_text = str(row[1] or "")
        t_start_ms = int(row[2]) if row[2] is not None else None
        t_end_ms = int(row[3]) if row[3] is not None else None
        sections.append(
            DocumentMapSection(
                label=_preview(canonical_text) or "(segment)",
                section_kind="transcript_segment",
                read_uri=f"fragment:{row[0]}",
                preview=_preview(canonical_text),
                t_start_ms=t_start_ms,
                t_end_ms=t_end_ms,
                parent_label=_chapter_label(chapters, t_start_ms),
            )
        )
    return sections


# --- shared helpers --------------------------------------------------------------


def _active_transcript_version(db: Session, media_id: UUID) -> UUID | None:
    return db.scalar(
        text(
            """
            SELECT id
            FROM podcast_transcript_versions
            WHERE media_id = :id AND is_active
            """
        ),
        {"id": media_id},
    )


def _join_fragments(db: Session, media_id: UUID, *, transcript_version_id: UUID | None) -> str:
    if transcript_version_id is None:
        rows = db.execute(
            text("SELECT canonical_text FROM fragments WHERE media_id = :id ORDER BY idx ASC"),
            {"id": media_id},
        ).fetchall()
    else:
        rows = db.execute(
            text(
                """
                SELECT canonical_text FROM fragments
                WHERE media_id = :id AND transcript_version_id = :version_id
                ORDER BY t_start_ms ASC NULLS LAST, idx ASC
                """
            ),
            {"id": media_id, "version_id": transcript_version_id},
        ).fetchall()
    return "\n\n".join(str(row[0] or "") for row in rows)


def _fragment_previews(db: Session, fragment_ids: list[UUID]) -> dict[UUID, str]:
    if not fragment_ids:
        return {}
    rows = db.execute(
        text("SELECT id, canonical_text FROM fragments WHERE id = ANY(:ids)"),
        {"ids": fragment_ids},
    ).fetchall()
    return {row[0]: _preview(str(row[1] or "")) for row in rows}


def _chapter_label(
    chapters: list[tuple[str, int, int | None]], t_start_ms: int | None
) -> str | None:
    if t_start_ms is None or not chapters:
        return None
    fallback: str | None = None
    for title, chapter_start, chapter_end in chapters:
        if chapter_start <= t_start_ms:
            fallback = title
        if chapter_start <= t_start_ms and (chapter_end is None or t_start_ms < chapter_end):
            return title
        if chapter_start <= t_start_ms:
            continue
        break
    return fallback


def _preview(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:160]
    return ""
