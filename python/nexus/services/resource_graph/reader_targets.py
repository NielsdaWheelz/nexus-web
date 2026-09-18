"""Reader-jump projection for cited resources.

The one owner of ``(media_id, locator)`` reconstruction for a citation target
(render contract G6): position lives in the target, not the citing edge (D11),
so every citing surface — chat, Oracle, the library dossier, the reader's own
connections — recomputes the jump here through the single locator owner
(``locator_resolver``). Note-owned evidence projects to ``(None, locator)``,
which the frontend treats as a note activation rather than a media jump.
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


def reader_target_for_citation_target(
    db: Session, *, viewer_id: UUID, target: ResourceRef
) -> tuple[UUID | None, dict[str, object] | None]:
    """Reconstruct the in-reader jump ``(media_id, locator)`` for a citation target.

    The render contract (G6): the same single ``ReaderCitationData`` jump path lights
    up for chat, Oracle, and the library dossier, all of which cite the finest-grained
    object (``evidence_span``/``content_chunk``/``media``). Position lives in the target,
    not the edge (D11), so it is recomputed here from the target's own anchoring using
    the single locator owner (``locator_resolver``), exactly as search and Dossier synthesis do.

    Note-owned evidence returns ``(None, note_block_offsets)``. The frontend citation
    adapter treats that locator as a note activation target, not a media jump.
    """
    if target.scheme == "media":
        return target.id, None
    if target.scheme == "highlight":
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"),
            {"id": target.id},
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            return None, None
        return media_id, None
    if target.scheme == "fragment":
        row = db.execute(
            text(
                """
                SELECT media_id
                FROM fragments
                WHERE id = :id
                """
            ),
            {"id": target.id},
        ).first()
        if row is None or not can_read_media(db, viewer_id, row[0]):
            return None, None
        return row[0], None
    if target.scheme == "reader_apparatus_item":
        return _reader_target_for_reader_apparatus_item(
            db, viewer_id=viewer_id, apparatus_item_id=target.id
        )
    if target.scheme == "note_block":
        return None, _note_block_locator_for_block(db, viewer_id=viewer_id, block_id=target.id)
    if target.scheme == "content_chunk":
        return _reader_target_for_content_chunk(db, viewer_id=viewer_id, chunk_id=target.id)
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
        # cited edge outlives it (N4), so the chip renders from its stored snapshot.
        return None, None
    resolver = resolution.get("resolver")
    if isinstance(resolver, dict) and resolver.get("kind") == "note":
        return None, locator_from_resolution(
            resolution,
            media_id=UUID(str(resolution["media_id"])),
            media_kind="note",
        )
    media_id = parent_media_id_for_read_pointer(db, scheme="evidence_span", resource_id=target.id)
    if media_id is None:
        return None, None
    media_kind = db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": media_id})
    locator = locator_from_resolution(
        resolution, media_id=media_id, media_kind=str(media_kind or "")
    )
    return media_id, locator


def _reader_target_for_content_chunk(
    db: Session, *, viewer_id: UUID, chunk_id: UUID
) -> tuple[UUID | None, dict[str, object] | None]:
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
    if span_id is not None:
        try:
            resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=span_id)
        except NotFoundError:
            return None, None
        return None, locator_from_resolution(
            resolution,
            media_id=UUID(str(row["owner_id"])),
            media_kind="note",
        )
    return None, _note_locator_from_summary_locator(row["summary_locator"])


def _note_block_locator_for_block(
    db: Session, *, viewer_id: UUID, block_id: UUID
) -> dict[str, object] | None:
    row = db.execute(
        text(
            """
            SELECT body_text
            FROM note_blocks
            WHERE id = :block_id
              AND user_id = :viewer_id
            """
        ),
        {"viewer_id": viewer_id, "block_id": block_id},
    ).first()
    if row is None:
        return None
    body = str(row[0] or "")
    if not body:
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": str(block_id),
            "start_offset": 0,
            "end_offset": len(body),
        }
    )


def _note_locator_from_summary_locator(raw: object) -> dict[str, object] | None:
    locator = raw if isinstance(raw, dict) else {}
    note_block_id = locator.get("note_block_id")
    start_offset = locator.get("start_offset")
    end_offset = locator.get("end_offset")
    if (
        not isinstance(note_block_id, str)
        or not isinstance(start_offset, int)
        or not isinstance(end_offset, int)
    ):
        return None
    return retrieval_locator_json(
        {
            "type": "note_block_offsets",
            "block_id": note_block_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
        }
    )


def _reader_target_for_reader_apparatus_item(
    db: Session, *, viewer_id: UUID, apparatus_item_id: UUID
) -> tuple[UUID | None, dict[str, object] | None]:
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
        {"id": apparatus_item_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None, None
    return row[0], retrieval_locator_json(row[1])
