"""Reader Document Map aggregate orchestration."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.presence import absent, present
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapDiagnosticsOut,
    ReaderDocumentMapOut,
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
from nexus.services.capabilities import is_document_status_ready
from nexus.services.reader_publication import read_publication_generation


def get_reader_document_map(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> ReaderDocumentMapOut:
    """Read each domain owner once and assemble the canonical Document Map."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = (
        db.execute(
            text(
                """
                SELECT kind, title, page_count, processing_status
                FROM media WHERE id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_kind = str(media["kind"])
    page_count = int(media["page_count"]) if media["page_count"] is not None else None

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
    total_fragment_chars = 0
    for row in fragments:
        char_count = int(row["char_count"] or 0)
        fragment_ranges[str(row["id"])] = (total_fragment_chars, char_count)
        total_fragment_chars += char_count

    generation = absent()
    if media_kind in ("epub", "web_article", "pdf"):
        publication_generation = read_publication_generation(db, media_id=media_id)
        if publication_generation is None:
            if is_document_status_ready(str(media["processing_status"])):
                # justify-defect: ready canonical content is installed by the publication owner.
                raise AssertionError("Readable document has no reader publication")
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media has no reader publication")
        generation = present(publication_generation)

    pdf_page_heights: dict[int, float] = {}
    if media_kind == "pdf":
        pdf_page_heights = {
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

    navigation = None
    navigation_partial = False
    if media_kind in ("web_article", "epub"):
        try:
            navigation = reader_navigation.get_media_navigation_for_viewer(db, viewer_id, media_id)
        except ApiError as exc:
            if exc.code != ApiErrorCode.E_MEDIA_NOT_READY:
                raise
            navigation_partial = True

    apparatus = reader_apparatus.get_media_apparatus(db, viewer_id, media_id)
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
        highlights=highlights.list_highlights_for_media(
            db=db, viewer_id=viewer_id, media_id=media_id, mine_only=False
        ),
        apparatus=apparatus,
        connections=reader_connections.list_reader_connections(
            db, viewer_id=viewer_id, media_id=media_id
        ),
        fragment_indexes=fragment_indexes,
        fragment_ranges=fragment_ranges,
        total_fragment_chars=total_fragment_chars,
        page_count=page_count,
        pdf_page_heights=pdf_page_heights,
    )

    omitted_item_counts = dict(projection.omitted_item_counts)
    if navigation is not None:
        unknown_extents = sum(section.extent.kind == "Absent" for section in navigation.sections)
        if unknown_extents:
            omitted_item_counts["unknown_section_extent"] = unknown_extents
            navigation_partial = True
    if media_kind == "epub":
        unresolved_targets = db.execute(
            text(
                """
                SELECT count(*) FROM epub_toc_nodes
                WHERE media_id = :media_id AND href IS NOT NULL AND target_offset IS NULL
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        if unresolved_targets:
            omitted_item_counts["unresolved_navigation_target"] = unresolved_targets
            navigation_partial = True

    counts = projection.evidence.counts
    has_content = bool(
        counts.passages
        or counts.document
        or embed_rows
        or (navigation is not None and navigation.sections)
    )
    partial = navigation_partial or apparatus.status in ("partial", "failed")
    status: ReaderDocumentMapStatus = (
        "partial" if partial else ("ready" if has_content else "empty")
    )
    return ReaderDocumentMapOut(
        media_id=media_id,
        generation=generation,
        media_kind=media_kind,
        title=str(media["title"]),
        status=status,
        navigation=present(navigation) if navigation is not None else absent(),
        embeds=embed_rows,
        evidence=projection.evidence,
        markers=projection.markers,
        diagnostics=ReaderDocumentMapDiagnosticsOut(omitted_item_counts=omitted_item_counts),
    )
