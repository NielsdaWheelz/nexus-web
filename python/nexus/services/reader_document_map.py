"""Reader Document Map aggregate orchestration."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapDiagnosticsOut,
    ReaderDocumentMapOut,
    ReaderDocumentMapSourceVersionOut,
    ReaderDocumentMapStatus,
)
from nexus.services import (
    document_embeds,
    highlights,
    reader_apparatus,
    reader_connections,
    reader_evidence,
    reader_navigation,
)


def get_reader_document_map(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> ReaderDocumentMapOut:
    """Read domain owners once and assemble the canonical Document Map."""

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    reader_apparatus.guard_media_apparatus_generation(db, media_id)

    media = (
        db.execute(
            text(
                """
                SELECT id, kind, title, updated_at, page_count
                FROM media
                WHERE id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    fragments = (
        db.execute(
            text(
                """
                SELECT id, idx, COALESCE(length(canonical_text), 0) AS char_count
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY idx ASC
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    fragment_indexes = {str(row["id"]): int(row["idx"]) for row in fragments}
    fragment_ranges: dict[str, tuple[int, int]] = {}
    fragment_cursor = 0
    for row in fragments:
        char_count = max(int(row["char_count"] or 0), 1)
        fragment_ranges[str(row["id"])] = (fragment_cursor, char_count)
        fragment_cursor += char_count

    media_kind = str(media["kind"])
    pdf_page_heights = (
        {
            int(row["page_number"]): float(row["page_height"])
            for row in db.execute(
                text(
                    """
                    SELECT page_number, max(page_height) AS page_height
                    FROM pdf_page_text_spans
                    WHERE media_id = :media_id AND page_height IS NOT NULL
                    GROUP BY page_number
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .all()
        }
        if media_kind == "pdf"
        else {}
    )
    navigation = None
    navigation_partial = False
    if media_kind in ("web_article", "epub"):
        try:
            navigation = reader_navigation.get_media_navigation_for_viewer(db, viewer_id, media_id)
        except ApiError as exc:
            if exc.code != ApiErrorCode.E_MEDIA_NOT_READY:
                raise
            navigation_partial = True

    media_highlights = highlights.list_highlights_for_media(
        db=db,
        viewer_id=viewer_id,
        media_id=media_id,
        mine_only=False,
    )
    apparatus = reader_apparatus.get_media_apparatus(db, viewer_id, media_id)
    connection_rows = _read_all_connections(db, viewer_id=viewer_id, media_id=media_id)
    embed_rows = (
        document_embeds.list_document_embeds_for_media(db, viewer_id=viewer_id, media_id=media_id)
        if media_kind == "web_article"
        else []
    )
    projection = reader_evidence.build_reader_evidence(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media_kind=media_kind,
        navigation=navigation,
        embeds=embed_rows,
        highlights=media_highlights,
        apparatus=apparatus,
        connections=connection_rows,
        fragment_indexes=fragment_indexes,
        fragment_ranges=fragment_ranges,
        total_fragment_chars=fragment_cursor,
        page_count=int(media["page_count"]) if media["page_count"] is not None else None,
        pdf_page_heights=pdf_page_heights,
    )

    all_item_count = projection.evidence.counts.passages + projection.evidence.counts.document
    has_content = bool(
        all_item_count or embed_rows or (navigation is not None and navigation.sections)
    )
    partial = navigation_partial or apparatus.status in ("partial", "failed")
    status: ReaderDocumentMapStatus = (
        "partial" if partial else ("ready" if has_content else "empty")
    )
    graph_max_updated_at = max((row.connection.created_at for row in connection_rows), default=None)
    highlights_max_updated_at = max(
        (highlight.updated_at for highlight in media_highlights), default=None
    )
    return ReaderDocumentMapOut(
        media_id=media_id,
        media_kind=media_kind,
        title=str(media["title"]),
        status=status,
        source_version=ReaderDocumentMapSourceVersionOut(
            media_updated_at=presence_from_nullable(media["updated_at"]),
            apparatus_source_fingerprint=present(apparatus.source_fingerprint),
            graph_max_updated_at=(
                present(graph_max_updated_at) if graph_max_updated_at is not None else absent()
            ),
            highlights_max_updated_at=(
                present(highlights_max_updated_at)
                if highlights_max_updated_at is not None
                else absent()
            ),
        ),
        navigation=present(navigation) if navigation is not None else absent(),
        embeds=embed_rows,
        evidence=projection.evidence,
        markers=projection.markers,
        diagnostics=ReaderDocumentMapDiagnosticsOut(
            omitted_item_counts=projection.omitted_item_counts,
        ),
    )


def _read_all_connections(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> list[reader_connections.ReaderConnectionRow]:
    rows: list[reader_connections.ReaderConnectionRow] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        page = reader_connections.list_reader_connections(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            origins=reader_connections.READER_CONNECTION_ORIGINS,
            source_schemes=None,
            limit=100,
            cursor=cursor,
        )
        rows.extend(page.items)
        if page.next_cursor is None:
            return rows
        if page.next_cursor in seen_cursors:
            raise RuntimeError("Reader graph pagination returned a repeated cursor")
        seen_cursors.add(page.next_cursor)
        cursor = page.next_cursor
