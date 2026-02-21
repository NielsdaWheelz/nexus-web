"""EPUB chapter and TOC read service (C5 owner for PR-04).

Read-only service consuming persisted fragments and epub_toc_nodes.
No lifecycle mutation, no extraction recomputation.
"""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import (
    EpubChapterListOut,
    EpubChapterOut,
    EpubChapterPageInfoOut,
    EpubChapterSummaryOut,
    EpubTocNodeOut,
    EpubTocOut,
)

_HEADING_RE = re.compile(r"<h[1-6][^>]*>(.*?)</h[1-6]>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")

_READABLE_STATUSES = frozenset({"ready_for_reading", "embedding", "ready"})


def _enforce_epub_read_guards(
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

    if status not in _READABLE_STATUSES:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")


def _extract_first_heading(html: str) -> str | None:
    """Extract text of first h1-h6 from sanitized HTML."""
    m = _HEADING_RE.search(html)
    if m:
        inner = _TAG_RE.sub("", m.group(1)).strip()
        if inner:
            return inner
    return None


def _compute_word_count(canonical_text: str) -> int:
    stripped = canonical_text.strip()
    if not stripped:
        return 0
    return len(stripped.split())


def _build_chapter_summary(
    fragment_row: tuple,
    toc_map: dict[int, tuple[str, str]],
) -> EpubChapterSummaryOut:
    """Build summary from a fragment row and pre-fetched toc mapping.

    fragment_row columns: (id, media_id, idx, canonical_text, html_sanitized)
    toc_map: {fragment_idx: (node_id, label)} for primary node (min order_key)
    """
    frag_id, _media_id, idx, canonical_text, html_sanitized = fragment_row

    has_toc_entry = idx in toc_map
    primary_toc_node_id = toc_map[idx][0] if has_toc_entry else None
    primary_label = toc_map[idx][1] if has_toc_entry else None

    if primary_label:
        title = primary_label
    else:
        heading = _extract_first_heading(html_sanitized)
        title = heading if heading else f"Chapter {idx + 1}"

    return EpubChapterSummaryOut(
        idx=idx,
        fragment_id=frag_id,
        title=title,
        char_count=len(canonical_text),
        word_count=_compute_word_count(canonical_text),
        has_toc_entry=has_toc_entry,
        primary_toc_node_id=primary_toc_node_id,
    )


def _fetch_toc_map(db: Session, media_id: UUID) -> dict[int, tuple[str, str]]:
    """Fetch primary TOC node per fragment_idx (min order_key wins).

    Returns {fragment_idx: (node_id, label)}.
    """
    rows = db.execute(
        text("""
            SELECT DISTINCT ON (fragment_idx)
                   fragment_idx, node_id, label
            FROM epub_toc_nodes
            WHERE media_id = :mid AND fragment_idx IS NOT NULL
            ORDER BY fragment_idx, order_key ASC
        """),
        {"mid": media_id},
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def list_epub_chapters_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    limit: int = 100,
    cursor: int | None = None,
) -> EpubChapterListOut:
    """Return metadata-only chapter manifest with cursor pagination."""
    if limit < 1 or limit > 200:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "limit must be between 1 and 200",
        )
    if cursor is not None and cursor < 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "cursor must be a non-negative integer",
        )

    _enforce_epub_read_guards(db, viewer_id, media_id)

    params: dict = {"mid": media_id, "lim": limit + 1}
    where_cursor = ""
    if cursor is not None:
        where_cursor = "AND f.idx > :cursor"
        params["cursor"] = cursor

    rows = db.execute(
        text(f"""
            SELECT f.id, f.media_id, f.idx,
                   f.canonical_text, f.html_sanitized
            FROM fragments f
            WHERE f.media_id = :mid {where_cursor}
            ORDER BY f.idx ASC
            LIMIT :lim
        """),
        params,
    ).fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]

    toc_map = _fetch_toc_map(db, media_id)

    summaries = [_build_chapter_summary(r, toc_map) for r in page_rows]

    next_cursor = summaries[-1].idx if summaries and has_more else None

    return EpubChapterListOut(
        data=summaries,
        page=EpubChapterPageInfoOut(next_cursor=next_cursor, has_more=has_more),
    )


def get_epub_chapter_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    idx: int,
) -> EpubChapterOut:
    """Return single chapter payload with navigation pointers."""
    if idx < 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Chapter index must be a non-negative integer",
        )

    _enforce_epub_read_guards(db, viewer_id, media_id)

    row = db.execute(
        text("""
            SELECT f.id, f.media_id, f.idx,
                   f.html_sanitized, f.canonical_text, f.created_at
            FROM fragments f
            WHERE f.media_id = :mid AND f.idx = :idx
        """),
        {"mid": media_id, "idx": idx},
    ).fetchone()

    if row is None:
        raise NotFoundError(
            ApiErrorCode.E_CHAPTER_NOT_FOUND,
            f"Chapter index {idx} not found",
        )

    frag_id, _media_id, frag_idx, html_sanitized, canonical_text, created_at = row

    max_idx_row = db.execute(
        text("SELECT MAX(idx) FROM fragments WHERE media_id = :mid"),
        {"mid": media_id},
    ).fetchone()
    max_idx = max_idx_row[0] if max_idx_row else 0

    toc_map = _fetch_toc_map(db, media_id)

    has_toc_entry = frag_idx in toc_map
    primary_toc_node_id = toc_map[frag_idx][0] if has_toc_entry else None
    primary_label = toc_map[frag_idx][1] if has_toc_entry else None

    if primary_label:
        title = primary_label
    else:
        heading = _extract_first_heading(html_sanitized)
        title = heading if heading else f"Chapter {frag_idx + 1}"

    prev_idx = frag_idx - 1 if frag_idx > 0 else None
    next_idx = frag_idx + 1 if frag_idx < max_idx else None

    return EpubChapterOut(
        idx=frag_idx,
        fragment_id=frag_id,
        title=title,
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
        char_count=len(canonical_text),
        word_count=_compute_word_count(canonical_text),
        has_toc_entry=has_toc_entry,
        primary_toc_node_id=primary_toc_node_id,
        prev_idx=prev_idx,
        next_idx=next_idx,
        created_at=created_at,
    )


def get_epub_toc_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> EpubTocOut:
    """Return deterministic nested TOC tree."""
    _enforce_epub_read_guards(db, viewer_id, media_id)

    rows = db.execute(
        text("""
            SELECT node_id, parent_node_id, label, href,
                   fragment_idx, depth, order_key
            FROM epub_toc_nodes
            WHERE media_id = :mid
            ORDER BY order_key ASC
        """),
        {"mid": media_id},
    ).fetchall()

    if not rows:
        return EpubTocOut(nodes=[])

    nodes_by_id: dict[str, EpubTocNodeOut] = {}
    roots: list[EpubTocNodeOut] = []

    for r in rows:
        node = EpubTocNodeOut(
            node_id=r[0],
            parent_node_id=r[1],
            label=r[2],
            href=r[3],
            fragment_idx=r[4],
            depth=r[5],
            order_key=r[6],
            children=[],
        )
        nodes_by_id[r[0]] = node

    for r in rows:
        node = nodes_by_id[r[0]]
        parent_id = r[1]
        if parent_id is None or parent_id not in nodes_by_id:
            roots.append(node)
        else:
            nodes_by_id[parent_id].children.append(node)

    return EpubTocOut(nodes=roots)
