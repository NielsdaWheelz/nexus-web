"""Reader-jump reconstruction for a cited resource.

Position lives in the target, not in the citing edge, so every citing surface — chat,
Oracle, the Dossier, the reader's own connections — recomputes ``(media_id, locator)``
here through the single locator owner. Note-owned evidence projects to
``(None, note_block_offsets)``, which the frontend treats as a note activation.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import (
    oracle_anchor_current_target,
    parent_media_id_for_read_pointer,
)

ReaderTarget = tuple[UUID | None, dict[str, object] | None]


def reader_target_for_citation_target(
    db: Session, *, viewer_id: UUID, target: ResourceRef
) -> ReaderTarget:
    """The in-reader jump for a citation target, or ``(None, None)`` when unanchorable."""
    if target.scheme == "media":
        return target.id, None
    if target.scheme == "highlight":
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"), {"id": target.id}
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            return None, None
        return media_id, None
    if target.scheme == "fragment":
        media_id = db.scalar(
            text("SELECT media_id FROM fragments WHERE id = :id"), {"id": target.id}
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            return None, None
        return media_id, None
    if target.scheme == "reader_apparatus_item":
        return _reader_apparatus_target(db, viewer_id=viewer_id, item_id=target.id)
    if target.scheme == "note_block":
        return None, _whole_note_locator(db, viewer_id=viewer_id, block_id=target.id)
    if target.scheme == "content_chunk":
        return _content_chunk_target(db, viewer_id=viewer_id, chunk_id=target.id)
    if target.scheme == "oracle_passage_anchor":
        current = oracle_anchor_current_target(db, target.id)
        if current is None:
            return None, None
        return reader_target_for_citation_target(db, viewer_id=viewer_id, target=current)
    if target.scheme != "evidence_span":
        return None, None

    try:
        resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=target.id)
    except NotFoundError:
        # justify-ignore-error: the cited span was deleted or is no longer visible; the
        # citation outlives it, so the chip renders from its stored snapshot.
        return None, None
    resolver = resolution.get("resolver")
    if isinstance(resolver, dict) and resolver.get("kind") == "note":
        return None, locator_from_resolution(
            resolution, media_id=UUID(str(resolution["media_id"])), media_kind="note"
        )
    media_id = parent_media_id_for_read_pointer(db, scheme="evidence_span", resource_id=target.id)
    if media_id is None:
        return None, None
    media_kind = db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": media_id})
    return media_id, locator_from_resolution(
        resolution, media_id=media_id, media_kind=str(media_kind or "")
    )


def _content_chunk_target(db: Session, *, viewer_id: UUID, chunk_id: UUID) -> ReaderTarget:
    row = (
        db.execute(
            text(
                """
                SELECT owner_kind, owner_id, primary_evidence_span_id, summary_locator
                FROM content_chunks
                WHERE id = :chunk_id
                """
            ),
            {"chunk_id": chunk_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None, None
    owner_kind = str(row["owner_kind"])
    if owner_kind == "media":
        return row["owner_id"], None
    if owner_kind != "note_block":
        return None, None
    span_id = row["primary_evidence_span_id"]
    if span_id is None:
        return None, _note_locator(row["summary_locator"])
    try:
        resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=span_id)
    except NotFoundError:
        # justify-ignore-error: as above — the chunk's span is gone; no jump, chip stays.
        return None, None
    return None, locator_from_resolution(
        resolution, media_id=UUID(str(row["owner_id"])), media_kind="note"
    )


def _whole_note_locator(
    db: Session, *, viewer_id: UUID, block_id: UUID
) -> dict[str, object] | None:
    body = db.scalar(
        text("SELECT body_text FROM note_blocks WHERE id = :block_id AND user_id = :viewer_id"),
        {"viewer_id": viewer_id, "block_id": block_id},
    )
    if not body:
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": str(block_id),
            "start_offset": 0,
            "end_offset": len(str(body)),
        }
    )


def _note_locator(raw: object) -> dict[str, object] | None:
    locator = raw if isinstance(raw, dict) else {}
    block_id = locator.get("note_block_id")
    start_offset = locator.get("start_offset")
    end_offset = locator.get("end_offset")
    if (
        not isinstance(block_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
    ):
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": block_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
        }
    )


def _reader_apparatus_target(db: Session, *, viewer_id: UUID, item_id: UUID) -> ReaderTarget:
    row = db.execute(
        text(
            """
            SELECT rai.media_id, rai.locator
            FROM reader_apparatus_items rai
            JOIN reader_apparatus_states ras ON ras.id = rai.state_id
            WHERE rai.id = :id
              AND ras.status IN ('ready', 'partial')
              AND rai.locator IS NOT NULL
              AND rai.locator_status != 'missing'
            """
        ),
        {"id": item_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None, None
    return row[0], retrieval_locator_json(row[1])
