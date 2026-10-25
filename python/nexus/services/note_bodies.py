"""Server reads of the note projection, its derived embed facts and tool-created bodies.

``body_pm_json`` and ``body_text`` are projections the shared kernel derives from the
note's canonical Yjs state (``node/authored``); python never recomputes either. Readers
see only ``authored_visible`` notes. ``note_body`` facts are rebuilt from the kernel's
``embedded_refs`` inside each projecting transaction; they carry no visibility gate of
their own, because every reader filters endpoint liveness and access.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge, ResourceViewState
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    assert_resource_ref,
    parse_resource_ref,
)
from nexus.services.resource_items.capabilities import capability


def note_ref(note_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="note_block", id=note_id)


def markdown_body(markdown: str) -> dict[str, Any]:
    """A tool's literal text as one canonical prose body: newlines become hard breaks and
    brackets stay literal. The kernel validates it in the creating command."""
    content: list[dict[str, Any]] = []
    for index, line in enumerate(markdown.split("\n")):
        if index:
            content.append({"type": "hard_break"})
        if line:
            content.append({"type": "text", "text": line})
    return {"type": "body", "attrs": {"presentation": "prose"}, "content": content}


def sole_embed(body_pm_json: dict[str, Any]) -> ResourceRef | None:
    """The resource a body consisting of exactly one embed presents standalone."""
    content = body_pm_json.get("content")
    if not isinstance(content, list) or len(content) != 1:
        return None
    node = content[0]
    if not isinstance(node, dict) or node.get("type") != "resource_embed":
        return None
    ref = parse_resource_ref(str(node["attrs"]["resource_ref"]))
    return None if isinstance(ref, ResourceRefParseFailure) else ref


@dataclass(frozen=True, slots=True)
class NoteRead:
    body_pm_json: dict[str, Any]
    body_text: str


def read_notes(db: Session, *, viewer_id: UUID, note_ids: Sequence[UUID]) -> dict[UUID, NoteRead]:
    """The viewer's visible note projections among ``note_ids``."""
    if not note_ids:
        return {}
    rows = db.execute(
        select(NoteBlock.id, NoteBlock.body_pm_json, NoteBlock.body_text).where(
            NoteBlock.user_id == viewer_id,
            NoteBlock.id.in_(note_ids),
            NoteBlock.authored_visible,
        )
    )
    return {id_: NoteRead(body, words) for id_, body, words in rows}


def project_note_embeds(
    db: Session, *, viewer_id: UUID, note_id: UUID, embedded_refs: Sequence[str]
) -> None:
    """Replace the note's ``note_body`` facts with its current embeds. Flush-only.

    Called by the authored projection for every merged note, visible or not: a hidden
    note's facts are hidden by endpoint liveness and return with revival. Unparseable,
    self and non-embeddable refs derive no fact; a ref the viewer cannot read still
    derives one and stays unreadable to every reader.
    """
    source = note_ref(note_id)
    wanted: dict[ResourceRef, None] = {}
    for raw in embedded_refs:
        target = parse_resource_ref(raw)
        if (
            not isinstance(target, ResourceRefParseFailure)
            and target != source
            and capability(target.scheme).embeddable
        ):
            wanted[target] = None
    existing = {
        assert_resource_ref(f"{row.target_scheme}:{row.target_id}"): row
        for row in db.scalars(
            select(ResourceEdge).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "note_body",
                ResourceEdge.source_scheme == "note_block",
                ResourceEdge.source_id == note_id,
            )
        )
    }
    stale = [row.id for ref, row in existing.items() if ref not in wanted]
    if stale:
        db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(stale)))
        db.execute(delete(ResourceEdge).where(ResourceEdge.id.in_(stale)))
    db.add_all(
        ResourceEdge(
            user_id=viewer_id,
            kind="context",
            origin="note_body",
            source_scheme="note_block",
            source_id=note_id,
            target_scheme=target.scheme,
            target_id=target.id,
        )
        for target in wanted
        if target not in existing
    )
    db.flush()
