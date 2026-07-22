"""Note body persistence and body-derived graph edges."""

from __future__ import annotations

import re
from typing import Any, cast
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_items import is_object_type
from nexus.services.resource_graph.edges import replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import resource_can_be_note_reference_target

_OBJECT_REF_MARKDOWN_RE = re.compile(
    r"\[\[([a-z_]+):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\|([^\]\n]*))?\]\]"
)


def pm_doc_from_text(text: str) -> dict[str, Any]:
    return (
        {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        if text
        else {"type": "paragraph"}
    )


def pm_doc_from_markdown_projection(markdown: str) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    position = 0
    for match in _OBJECT_REF_MARKDOWN_RE.finditer(markdown):
        if match.start() > position:
            _append_text(content, markdown[position : match.start()])
        object_type = match.group(1)
        if not is_object_type(object_type):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object reference type is invalid")
        content.append(
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": object_type,
                    "objectId": str(UUID(match.group(2))),
                    "label": match.group(3) or f"{object_type}:{match.group(2)}",
                },
            }
        )
        position = match.end()
    if position < len(markdown):
        _append_text(content, markdown[position:])
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
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str):
            parts.append(str(node["text"]))
        elif node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            if isinstance(label, str):
                parts.append(label)
        elif node_type == "image" and isinstance(node.get("attrs"), dict):
            alt = node["attrs"].get("alt")
            if isinstance(alt, str):
                parts.append(alt)
        elif node_type == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if node_type in {"paragraph", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def upsert_note_body(
    db: Session,
    *,
    viewer_id: UUID,
    block_id: UUID,
    body_pm_json: dict[str, Any],
) -> NoteBlock:
    block = db.get(NoteBlock, block_id)
    if block is None:
        block = NoteBlock(
            id=block_id,
            user_id=viewer_id,
            body_pm_json=body_pm_json,
            body_text=text_from_pm_json(body_pm_json),
        )
        db.add(block)
        db.flush()
        versions.ensure_version(db, viewer_id=viewer_id, ref=_note_ref(block.id), lane="body")
        versions.ensure_version(
            db, viewer_id=viewer_id, ref=_note_ref(block.id), lane="outgoing_edges"
        )
        sync_note_body_edges(db, viewer_id=viewer_id, block=block)
        return block
    if block.user_id != viewer_id:
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")
    if block.body_pm_json != body_pm_json:
        block.body_pm_json = body_pm_json
        block.body_text = text_from_pm_json(body_pm_json)
        block.updated_at = func.now()
        versions.bump_version(db, viewer_id=viewer_id, ref=_note_ref(block.id), lane="body")
        sync_note_body_edges(db, viewer_id=viewer_id, block=block)
    return block


def sync_note_body_edges(db: Session, *, viewer_id: UUID, block: NoteBlock) -> None:
    source = _note_ref(block.id)
    # A note_body edge is a durable relationship endpoint, so it obeys Invariant 4:
    # it never persists a passage-candidate (evidence_span/content_chunk/fragment/
    # reader_apparatus_item/oracle_passage_anchor) or otherwise non-direct scheme.
    # The reference-insertion UI only emits direct targets, but a stale/forked
    # client, a direct API write, or hand-authored markdown could carry one; those
    # object nodes stay in note-owned prose but never mint a graph edge (the same
    # drop-not-raise discipline replace_edges_for_origin applies to self-targets).
    replace_edges_for_origin(
        db,
        viewer_id=viewer_id,
        source=source,
        origin="note_body",
        edges=[
            EdgeCreate(source=source, target=target, kind="context", origin="note_body")
            for target in _body_target_refs(block.body_pm_json)
            if target != source and resource_can_be_note_reference_target(target)
        ],
    )


def _body_target_refs(value: object) -> list[ResourceRef]:
    refs: list[ResourceRef] = []
    seen: set[str] = set()

    def append_ref(ref: ResourceRef) -> None:
        if ref.uri not in seen:
            seen.add(ref.uri)
            refs.append(ref)

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            if isinstance(object_type, str) and isinstance(object_id, str):
                append_ref(
                    ResourceRef(scheme=cast(ResourceScheme, object_type), id=UUID(object_id))
                )
        visit(node.get("content"))

    visit(value)
    return refs


def _append_text(content: list[dict[str, Any]], text_value: str) -> None:
    for index, line in enumerate(text_value.split("\n")):
        if index > 0:
            content.append({"type": "hard_break"})
        if line:
            content.append({"type": "text", "text": line})


def _note_ref(block_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="note_block", id=block_id)
