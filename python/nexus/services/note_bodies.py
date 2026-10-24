"""The note row: its text projection, persistence, embed facts and teardown.

I1: ``body_text == text_from_pm_json(body_pm_json)``. The browser mirrors the projection
byte for byte (``lib/notes/noteBody.ts``) for offsets; ``body_text`` is the search,
passage-anchor and content-index basis.
I3: every body change (create or write) bumps the ``body`` lane, replaces the note's
``note_body`` embed edges and enqueues ``note_reindex_job``.
I9: a missing version row reads as 1; ``bump_version`` creates it first.

Retry rules: ``ensure_note`` creates under the client id, an existing own note is reused
unchanged and another owner's id is 409; ``write_body`` is absolute (current == desired
succeeds whatever the version, else the expected version must match: 409 with the
current note); ``delete_note`` is idempotent. Callers start a serializable attempt
before canonical reads; body and dossier text publish here in
the same transaction after the source and version flush.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceVersion
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.notes import NoteBlockOut
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import retention
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.edges import EdgeCreate, replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.search import projection


def note_ref(note_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="note_block", id=note_id)


def pm_doc_from_markdown_projection(markdown: str) -> dict[str, Any]:
    """Plain text as one paragraph; newlines become hard breaks, brackets stay literal."""
    content: list[dict[str, Any]] = []
    for index, line in enumerate(markdown.split("\n")):
        if index:
            content.append({"type": "hard_break"})
        if line:
            content.append({"type": "text", "text": line})
    return {"type": "paragraph", "content": content} if content else {"type": "paragraph"}


def text_from_pm_json(value: object) -> str:
    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        kind, attrs = node.get("type"), node.get("attrs")
        if kind == "text" and isinstance(node.get("text"), str):
            parts.append(node["text"])
        elif kind == "object_embed" and isinstance(attrs, dict):
            label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            if isinstance(label, str):
                parts.append(label)
        elif kind == "image" and isinstance(attrs, dict) and isinstance(attrs.get("alt"), str):
            parts.append(attrs["alt"])
        elif kind == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if kind in ("paragraph", "code_block"):
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def note_exists(db: Session, *, viewer_id: UUID, note_id: UUID) -> bool:
    """Whether the viewer has this note; another owner's id is 409."""
    block = db.get(NoteBlock, note_id)
    if block is not None and block.user_id != viewer_id:
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note id is taken")
    return block is not None


def owned_note(db: Session, *, viewer_id: UUID, note_id: UUID) -> NoteBlock:
    block = db.get(NoteBlock, note_id)
    if block is None or block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
    return block


def read_note(db: Session, *, viewer_id: UUID, note_id: UUID) -> NoteBlockOut:
    note = read_notes(db, viewer_id=viewer_id, note_ids=[note_id]).get(note_id)
    if note is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
    return note


def read_notes(
    db: Session, *, viewer_id: UUID, note_ids: Sequence[UUID]
) -> dict[UUID, NoteBlockOut]:
    rows = _read_note_rows(db, viewer_id, note_ids)
    from nexus.services.resource_items.items import resource_items_out

    targets = {note_id: _embeds(body) for note_id, body, _, _ in rows}
    embedded = {
        item.ref: item
        for item in resource_items_out(
            db,
            viewer_id=viewer_id,
            refs=list({ref.uri: ref for refs in targets.values() for ref in refs}.values()),
        )
    }
    return {
        note_id: NoteBlockOut(
            id=note_id,
            body_pm_json=body,
            body_text=body_text,
            body_version=version,
            embedded_item=embedded.get(targets[note_id][0].uri) if targets[note_id] else None,
        )
        for note_id, body, body_text, version in rows
    }


@dataclass(frozen=True, slots=True)
class NoteSource:
    body_text: str
    body_version: int


def read_note_sources(
    db: Session, *, viewer_id: UUID, note_ids: Sequence[UUID]
) -> dict[UUID, NoteSource]:
    """Location validation needs text/version, without recursively projecting embeds."""
    return {
        note_id: NoteSource(body_text, version)
        for note_id, _, body_text, version in _read_note_rows(db, viewer_id, note_ids)
    }


def _read_note_rows(db: Session, viewer_id: UUID, note_ids: Sequence[UUID]):
    """Read each owned body and its version in one statement snapshot.

    Separate queries under READ COMMITTED can pair an older body with a newer
    version, admitting a subsequent edit that unknowingly overwrites that version.
    Selecting columns also avoids older ORM identity-map bodies.
    """
    rows = db.execute(
        select(
            NoteBlock.id,
            NoteBlock.body_pm_json,
            NoteBlock.body_text,
            func.coalesce(ResourceVersion.version, 1),
        )
        .outerjoin(
            ResourceVersion,
            and_(
                ResourceVersion.user_id == viewer_id,
                ResourceVersion.resource_scheme == "note_block",
                ResourceVersion.resource_id == NoteBlock.id,
                ResourceVersion.lane == "body",
            ),
        )
        .where(NoteBlock.user_id == viewer_id, NoteBlock.id.in_(note_ids))
    )
    return list(rows)


def ensure_note(
    db: Session, *, viewer_id: UUID, note_id: UUID, body_pm_json: dict[str, Any], reason: str
) -> None:
    """Create the note under its client id; an existing own note is reused unchanged."""
    if note_exists(db, viewer_id=viewer_id, note_id=note_id):
        return
    block = NoteBlock(
        id=note_id,
        user_id=viewer_id,
        body_pm_json=body_pm_json,
        body_text=text_from_pm_json(body_pm_json),
    )
    db.add(block)
    db.flush()
    for lane in ("body", "links"):
        versions.ensure_version(db, viewer_id=viewer_id, ref=note_ref(note_id), lane=lane)
    _changed(db, viewer_id, block, reason)


def write_body(
    db: Session,
    *,
    viewer_id: UUID,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    expected_version: int,
    reason: str,
) -> bool:
    """Write a changed body; return false when the exact body is already present."""
    block = db.scalar(
        select(NoteBlock)
        .where(NoteBlock.id == note_id, NoteBlock.user_id == viewer_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if block is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
    if block.body_pm_json == body_pm_json:
        return False
    require_version(db, viewer_id=viewer_id, note_id=note_id, version=expected_version)
    block.body_pm_json = body_pm_json
    block.body_text = text_from_pm_json(body_pm_json)
    block.updated_at = func.now()
    versions.bump_version(db, viewer_id=viewer_id, ref=note_ref(note_id), lane="body")
    _changed(db, viewer_id, block, reason)
    retention.touch_owners(db, [note_ref(note_id)])
    return True


def require_version(db: Session, *, viewer_id: UUID, note_id: UUID, version: int) -> None:
    """409 E_NOTE_CONFLICT with ``details.current`` (a NoteBlockOut) unless it matches."""
    if _version(db, viewer_id, note_id) != version:
        current = read_note(db, viewer_id=viewer_id, note_id=note_id)
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Note changed elsewhere",
            details={"current": current.model_dump(mode="json")},
        )


def delete_note(db: Session, *, viewer_id: UUID, note_id: UUID) -> None:
    """The one teardown: subject state, edges, anchors, index, protocol state, row."""
    from nexus.services import passage_anchors
    from nexus.services.dossier import engine as dossier_engine

    block = db.scalar(
        select(NoteBlock)
        .where(NoteBlock.id == note_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if block is None or block.user_id != viewer_id:
        return
    ref = note_ref(note_id)
    dossier_engine.on_subject_deleted(db, ref)
    delete_edges_for_deleted_resource(db, ref=ref, remove_inbound_citations=True)
    passage_anchors.delete_for_owner(db, owner_scheme="note_block", owner_id=note_id)
    delete_content_index(db, owner=IndexOwner("note_block", note_id))
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(block)
    db.flush()
    projection.refresh(db, "note_block", [note_id])


def _version(db: Session, viewer_id: UUID, note_id: UUID) -> int:
    lanes = versions.versions_for_ref(db, viewer_id=viewer_id, ref=note_ref(note_id))
    return lanes.get("body", 1)


def _changed(db: Session, viewer_id: UUID, block: NoteBlock, reason: str) -> None:
    source = note_ref(block.id)
    replace_edges_for_origin(
        db,
        viewer_id=viewer_id,
        source=source,
        origin="note_body",
        edges=[
            EdgeCreate(source=source, target=target, kind="context", origin="note_body")
            for target in _embeds(block.body_pm_json)
            if target != source and capability(target.scheme).embeddable
        ],
    )
    enqueue_note_reindex(db, note_block_id=block.id, reason=reason)
    db.flush()
    projection.refresh(db, "note_block", [block.id])
    projection.refresh_subject_dossiers(db, [source])


def _embeds(value: object) -> list[ResourceRef]:
    found: dict[str, ResourceRef] = {}

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, dict):
            attrs = node.get("attrs")
            if node.get("type") == "object_embed" and isinstance(attrs, dict):
                scheme = cast(ResourceScheme, attrs["objectType"])
                ref = ResourceRef(scheme=scheme, id=UUID(attrs["objectId"]))
                found.setdefault(ref.uri, ref)
            visit(node.get("content"))

    visit(value)
    return list(found.values())
