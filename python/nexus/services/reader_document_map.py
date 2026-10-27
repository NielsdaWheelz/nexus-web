"""One media's local annotations, apparatus and connections.

X thread composition owns no source fragments or apparatus. Its canonical post
maps own those facts and are loaded separately, once per source.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapOut,
    ReaderDocumentMapStatus,
)
from nexus.services import (
    document_embeds,
    highlights,
    reader_apparatus,
    reader_connections,
    reader_evidence,
)
from nexus.services.capabilities import is_document_status_ready
from nexus.services.media_text_scope import read_media_text_scope, read_scope_fragment
from nexus.services.reader_document import transcript_identity
from nexus.services.reader_publication import read_publication_generation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.versions import versions_for_ref


def get_reader_document_map(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> ReaderDocumentMapOut:
    """Assemble one read-only snapshot; the route completes locator repair first."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = (
        db.execute(
            text("""SELECT kind, page_count, processing_status,
                           EXISTS (SELECT 1 FROM x_thread_sources x WHERE x.media_id=m.id)
                               AS is_x_thread
                    FROM media m WHERE id = :media_id"""),
            {"media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_kind = str(media["kind"])
    page_count = int(media["page_count"]) if media["page_count"] is not None else None
    scope = read_media_text_scope(db, media_id) if media_kind == "text_part" else None
    source_media_id = scope.source_media_id if scope is not None else media_id

    # Reading order, as the reader document mounts it (transcripts by time).
    fragments = (
        db.execute(
            text(
                """
                SELECT id, idx, t_start_ms, t_end_ms,
                       COALESCE(length(canonical_text), 0) AS char_count
                FROM fragments
                WHERE media_id = :media_id
                ORDER BY t_start_ms ASC NULLS LAST, idx ASC
                """
            ),
            {"media_id": source_media_id},
        )
        .mappings()
        .all()
    )
    if scope is not None:
        admitted = {interval.fragment_id for interval in scope.fragment_intervals}
        fragments = [row for row in fragments if row["id"] in admitted]
    fragment_indexes = {str(row["id"]): index for index, row in enumerate(fragments)}
    fragment_ranges: dict[str, tuple[int, int]] = {}
    fragment_times = {
        str(row["id"]): (int(row["t_start_ms"]), int(row["t_end_ms"]))
        for row in fragments
        if row["t_start_ms"] is not None
        and row["t_end_ms"] is not None
        and row["t_end_ms"] > row["t_start_ms"]
    }
    total_fragment_chars = 0
    for row in fragments:
        char_count = int(row["char_count"] or 0)
        if scope is not None:
            interval = next(
                item for item in scope.fragment_intervals if item.fragment_id == row["id"]
            )
            sliced = read_scope_fragment(db, scope, interval)
            char_count = len(sliced.canonical_text)
            fragment_ranges[str(row["id"])] = (
                total_fragment_chars - sliced.source_start_offset,
                sliced.source_start_offset + char_count,
            )
        else:
            fragment_ranges[str(row["id"])] = (total_fragment_chars, char_count)
        total_fragment_chars += char_count

    generation = None
    if media_kind in ("epub", "web_article", "pdf", "text_part"):
        generation = read_publication_generation(db, media_id=media_id)
        if generation is None:
            if is_document_status_ready(str(media["processing_status"])):
                # justify-defect: ready canonical content is installed by the publication owner.
                raise AssertionError("Readable document has no reader publication")
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media has no reader publication")
        identity = f"g{generation}"
    else:
        identity = transcript_identity([str(row["id"]) for row in fragments])

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

    apparatus = (
        reader_apparatus.ReaderApparatusResponse(
            media_id=media_id, status="empty", items=[], edges=[]
        )
        if media["is_x_thread"]
        else reader_apparatus.get_media_apparatus(db, viewer_id, media_id)
    )
    embed_rows = (
        document_embeds.list_document_embeds_for_media(db, viewer_id=viewer_id, media_id=media_id)
        if media_kind == "web_article"
        else []
    )
    # X source bodies/relations belong to the document projection. Annotation maps
    # remain canonical-source-local and never duplicate child annotation stores.
    embed_rows = [embed for embed in embed_rows if embed.provider != "x"]
    projection = reader_evidence.build_reader_evidence(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        canonical_media_id=source_media_id,
        reading_identity=identity,
        media_kind=scope.source_format if scope is not None else media_kind,
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
        fragment_times=fragment_times,
        total_fragment_chars=total_fragment_chars,
        page_count=page_count,
        pdf_page_heights=pdf_page_heights,
    )
    apparatus_status = apparatus.status
    del apparatus

    status: ReaderDocumentMapStatus = (
        "partial"
        if apparatus_status in ("partial", "failed")
        else ("ready" if projection.evidence.roots or embed_rows else "empty")
    )
    return ReaderDocumentMapOut(
        media_id=media_id,
        publication_generation=generation,
        annotations_version=versions_for_ref(
            db, viewer_id=viewer_id, ref=ResourceRef("media", media_id)
        ).get("annotations", 1),
        identity=identity,
        status=status,
        embeds=embed_rows,
        evidence=projection.evidence,
        markers=projection.markers,
    )
