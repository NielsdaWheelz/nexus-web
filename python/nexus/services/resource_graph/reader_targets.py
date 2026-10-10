"""Where a cited or deep-linked resource lands in a reader.

Position lives in the target, not in the edge that cites it, so every citing surface
recomputes ``(media_id, locator)`` here. Note-owned text projects to
``(None, note_block_offsets)``, which the client treats as a note activation.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.passage_anchors import (
    FragmentPassageTarget,
    PdfPassageTarget,
    TimePassageTarget,
)
from nexus.schemas.reader import (
    PdfPageGeometryTargetOut,
    ReaderTargetKind,
    ReaderTargetOut,
    ReaderTargetPdfOut,
    ReaderTargetTextOut,
    ReaderTargetTimeOut,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.locator_resolver import (
    locator_from_resolution,
    resolve_evidence_span,
    resolve_highlight_reader_target,
)
from nexus.services.passage_anchors import get_navigation_target
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import assert_ref_visible, oracle_anchor_current_target

ReaderTarget = tuple[UUID | None, dict[str, Any] | None]


def reader_target_for_citation_target(
    db: Session, *, viewer_id: UUID, target: ResourceRef
) -> ReaderTarget:
    """The jump into a reader for a target the viewer can see (the caller has resolved
    it), or ``(None, None)`` when it has none."""
    if target.scheme == "media":
        return target.id, None
    if target.scheme == "highlight" or target.scheme == "fragment":
        sql = {
            "highlight": "SELECT anchor_media_id FROM highlights WHERE id = :id",
            "fragment": "SELECT media_id FROM fragments WHERE id = :id",
        }[target.scheme]
        return db.scalar(text(sql), {"id": target.id}), None
    if target.scheme == "reader_apparatus_item":
        row = db.execute(
            text("""
            SELECT rai.media_id, rai.locator
            FROM reader_apparatus_items rai
            JOIN reader_apparatus_states ras ON ras.id = rai.state_id
            WHERE rai.id = :id AND ras.status IN ('ready', 'partial')
              AND rai.locator IS NOT NULL AND rai.locator_status != 'missing'
            """),
            {"id": target.id},
        ).first()
        return (row.media_id, retrieval_locator_json(row.locator)) if row else (None, None)
    if target.scheme == "note_block":
        body = db.scalar(
            text("SELECT body_text FROM note_blocks WHERE id = :id AND user_id = :viewer_id"),
            {"id": target.id, "viewer_id": viewer_id},
        )
        return None, _note_offsets(target.id, 0, len(body)) if body else None
    if target.scheme == "oracle_passage_anchor":
        current = oracle_anchor_current_target(db, target.id)
        if current is None:
            return None, None
        return reader_target_for_citation_target(db, viewer_id=viewer_id, target=current)
    if target.scheme == "content_chunk":
        row = db.execute(
            text(
                "SELECT owner_kind, owner_id, primary_evidence_span_id, summary_locator"
                " FROM content_chunks WHERE id = :id"
            ),
            {"id": target.id},
        ).first()
        if row is None:
            return None, None
        if row.owner_kind == "media":
            return row.owner_id, None
        if row.primary_evidence_span_id is None:
            block, start, end = (
                row.summary_locator.get(k) for k in ("note_block_id", "start_offset", "end_offset")
            )
            if isinstance(block, str) and isinstance(start, int) and isinstance(end, int):
                return None, _note_offsets(block, start, end)
            return None, None
        # A note's chunk jumps where its primary span does.
        target = ResourceRef("evidence_span", row.primary_evidence_span_id)
    if target.scheme != "evidence_span":
        return None, None
    try:
        resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=target.id)
    except NotFoundError:
        # justify-ignore-error: the cited span is gone or hidden; the chip renders from
        # its snapshot and the jump fails closed.
        return None, None
    # A readable span is media-owned, or note-owned with the note resolver.
    owner = UUID(str(resolution["media_id"]))
    if resolution["resolver"]["kind"] == "note":
        return None, locator_from_resolution(resolution, media_id=owner, media_kind="note")
    kind = db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": owner})
    return owner, locator_from_resolution(resolution, media_id=owner, media_kind=kind)


def reader_target_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID, kind: ReaderTargetKind, target_id: UUID
) -> ReaderTargetOut:
    """Where a deep link into one media's reader lands; 404 when it lands nowhere there."""
    unavailable = NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader target unavailable")
    if kind == "passage":
        passage = get_navigation_target(
            db,
            viewer_id=viewer_id,
            passage_anchor_id=target_id,
            owner=ResourceRef("media", media_id),
        )
        match passage.value if passage.kind == "Present" else None:
            case FragmentPassageTarget() as found:
                return ReaderTargetTextOut(
                    unit_id=str(found.fragment_id),
                    start_offset=found.start_offset,
                    end_offset=found.end_offset,
                )
            case TimePassageTarget() as found:
                return ReaderTargetTimeOut(start_ms=found.start_ms, end_ms=found.end_ms)
            case PdfPassageTarget() as found:
                return ReaderTargetPdfOut(page_number=found.page_number, quads=[])
        raise unavailable
    if kind == "highlight":
        owner = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"), {"id": target_id}
        )
        if owner != media_id or not can_read_highlight(db, viewer_id, target_id):
            raise unavailable
        match resolve_highlight_reader_target(db, highlight_id=target_id):
            case PdfPageGeometryTargetOut() as pdf:
                return ReaderTargetPdfOut(page_number=pdf.page_number, quads=pdf.quads)
            case None:
                raise unavailable
            case found:
                return ReaderTargetTextOut(
                    unit_id=str(found.fragment_id),
                    start_offset=found.start_offset,
                    end_offset=found.end_offset,
                )
    ref = ResourceRef("evidence_span" if kind == "evidence" else "reader_apparatus_item", target_id)
    try:
        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)
    except NotFoundError:
        raise unavailable from None
    owner, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
    if owner != media_id or locator is None:
        raise unavailable
    match locator["type"]:
        case "web_text_offsets" | "epub_fragment_offsets":
            return ReaderTargetTextOut(
                unit_id=str(locator["fragment_id"]),
                start_offset=cast(int, locator["start_offset"]),
                end_offset=cast(int, locator["end_offset"]),
            )
        case "pdf_page_geometry":
            return ReaderTargetPdfOut.model_validate(
                {"page_number": locator["page_number"], "quads": locator["quads"]}
            )
        case "transcript_time_range":
            return ReaderTargetTimeOut(
                start_ms=cast(int, locator["t_start_ms"]), end_ms=cast(int, locator["t_end_ms"])
            )
    raise unavailable


def _note_offsets(block_id: object, start: int, end: int) -> dict[str, Any] | None:
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": str(block_id),
            "start_offset": start,
            "end_offset": end,
        }
    )
