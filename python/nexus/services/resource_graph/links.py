"""User link commands: create (with a minted highlight or passage anchor), remove, and the
link's one ordinary note. Each command is SERIALIZABLE with retry; create and the note
commands replay their exact first response for a repeated ``client_mutation_id``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.schemas.resource_graph import (
    CreateLinkOut,
    CreateLinkRequest,
    LinkEndpoint,
    LinkNoteOut,
    PutLinkNoteRequest,
)
from nexus.schemas.resource_items import NoteBodyVersionsOut
from nexus.services import highlights, note_bodies, passage_anchors, pdf_highlights
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.connections import connection_for_edge
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import resource_link_mode
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.search.pickers import candidate_owner_and_quote

_LINK_SCOPE = "resource_graph:link"


def create_link(db: Session, *, viewer_id: UUID, request: CreateLinkRequest) -> CreateLinkOut:
    """Create or reuse one link; a highlight or passage anchor minted for it is written in
    the same transaction, so both exist or neither does."""

    def op() -> CreateLinkOut:
        source = request.source
        minted = None
        if source.kind == "resource" or source.kind == "passage":
            source_ref = materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=source)
        else:
            if source.kind == "fragment_selection":
                highlight = highlights.create_fragment_highlight_in_txn(
                    db,
                    viewer_id=viewer_id,
                    highlight_id=source.highlight_id,
                    fragment_id=source.fragment_id,
                    start_offset=source.start_offset,
                    end_offset=source.end_offset,
                    color=source.color,
                )
            else:
                highlight = pdf_highlights.create_pdf_highlight_in_txn(
                    db,
                    viewer_id=viewer_id,
                    highlight_id=source.highlight_id,
                    media_id=source.media_id,
                    page_number=source.page_number,
                    quads=[quad.model_dump() for quad in source.quads],
                    exact=source.exact,
                    color=source.color,
                )
            source_ref = minted = ResourceRef("highlight", highlight.id)
        target_ref = materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=request.target)
        if source_ref == target_ref:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot be linked to itself")
        write = edges.create_link(db, viewer_id=viewer_id, source=source_ref, target=target_ref)
        return CreateLinkOut(
            created=write.created,
            created_source_ref=minted.uri if minted is not None else None,
            connection=connection_for_edge(
                db, viewer_id=viewer_id, edge_id=write.edge.id, ref=source_ref
            ),
        )

    body = request.model_dump(mode="json", by_alias=True)
    key = request.client_mutation_id
    return _replayed(db, viewer_id, _LINK_SCOPE, key, body, CreateLinkOut.model_validate, op)


def delete_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> None:
    """Remove a link after detaching its note motif. Absent is success, so a concurrent
    delete converges on the promised no-op."""

    def op() -> None:
        edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
        if edge is None:
            return
        if edge.origin != "user":
            raise ForbiddenError(
                ApiErrorCode.E_FORBIDDEN, "Only user relations can be removed here"
            )
        edges.detach_link_notes(db, viewer_id=viewer_id, link=edge)
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
        db.commit()

    retry_serializable(db, "delete_link", op)


def put_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, request: PutLinkNoteRequest
) -> LinkNoteOut:
    """Write the link's one ordinary note: the first write (expected absent) attaches it
    to both endpoints, later writes edit the canonical body."""

    def op() -> LinkNoteOut:
        link = _link(db, viewer_id, link_id)
        attached = _attached_notes(db, viewer_id, link)
        first = request.expected_body.kind == "absent"
        if first and attached:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a note")
        if not first and request.note_block_id not in attached:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note is no longer attached")
        note_bodies.require_expected_body(
            db,
            viewer_id=viewer_id,
            block_id=request.note_block_id,
            expected_body=request.expected_body,
        )
        block = note_bodies.upsert_note_body(
            db,
            viewer_id=viewer_id,
            block_id=request.note_block_id,
            body_pm_json=request.body_pm_json,
        )
        note = ResourceRef("note_block", block.id)
        if first:
            for endpoint in (link.source, link.target):
                edges.create_edge(
                    db,
                    viewer_id=viewer_id,
                    input=edges.EdgeCreate(note, endpoint, "context", "link_note"),
                )
        enqueue_note_reindex(db, note_block_id=block.id, reason="link_note")
        return LinkNoteOut(
            note_block_id=block.id,
            body_pm_json=block.body_pm_json,
            body_text=block.body_text,
            version_by_lane=NoteBodyVersionsOut.model_validate(
                versions.versions_for_ref(db, viewer_id=viewer_id, ref=note)
            ),
            connection=connection_for_edge(
                db, viewer_id=viewer_id, edge_id=link.id, ref=link.source
            ),
        )

    scope = f"link_note:{link_id}"
    body = request.model_dump(mode="json", by_alias=True)
    key = request.client_mutation_id
    return _replayed(db, viewer_id, scope, key, body, LinkNoteOut.model_validate, op)


def detach_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, note_block_id: UUID, client_mutation_id: str
) -> None:
    """Detach the link's note from both endpoints; the note and the link stay."""

    def op() -> None:
        link = _link(db, viewer_id, link_id)
        if note_block_id not in _attached_notes(db, viewer_id, link):
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note is no longer attached")
        edges.detach_link_notes(db, viewer_id=viewer_id, link=link, note_block_id=note_block_id)

    body = {"operation": "detach", "noteBlockId": str(note_block_id)}
    _replayed(db, viewer_id, f"link_note:{link_id}", client_mutation_id, body, lambda _: None, op)


def materialize_link_endpoint(
    db: Session, *, viewer_id: UUID, endpoint: LinkEndpoint
) -> ResourceRef:
    """A linkable ref for a resource (the writer checks it is visible), or a passage
    anchor minted or reused for a passage candidate. Only flushes."""
    if endpoint.kind == "resource":
        ref = require_ref(endpoint.ref)
        if resource_link_mode(ref) != "direct":
            raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be linked")
        return ref
    candidate = require_ref(endpoint.candidate_ref)
    if resource_link_mode(candidate) != "materialize_passage":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource is not a passage candidate")
    found = candidate_owner_and_quote(db, ref=candidate)
    if found is None:
        raise ConflictError(ApiErrorCode.E_LINK_TARGET_STALE, "Passage candidate no longer exists")
    owner, exact = found
    assert_ref_visible(db, viewer_id=viewer_id, ref=owner)
    anchor = passage_anchors.materialize_or_reuse(
        db, user_id=viewer_id, owner_scheme=owner.scheme, owner_id=owner.id, exact=exact
    )
    return ResourceRef("passage_anchor", anchor.id)


def count_retained_neutral_links(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Links created in the window whose two endpoints are still visible."""
    window = [ResourceEdge.created_at < end]
    if start is not None:
        window.append(ResourceEdge.created_at >= start)
    rows = db.execute(
        select(
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(ResourceEdge.user_id == viewer_id, ResourceEdge.origin == "user", *window)
    ).all()
    refs = [assert_resource_ref(f"{row[i]}:{row[i + 1]}") for row in rows for i in (0, 2)]
    resolved = resolve_refs(
        db, viewer_id=viewer_id, refs=refs, include_media_document_summary=False
    )
    return sum(
        not a.missing and not b.missing for a, b in zip(resolved[::2], resolved[1::2], strict=True)
    )


def _replayed[T: BaseModel | None](
    db: Session,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_json: dict[str, Any],
    decode: Callable[[dict[str, object]], T],
    op: Callable[[], T],
) -> T:
    """Run ``op`` SERIALIZABLE and memoize its response, or return the memo. The memo is
    looked up before anything else, so a replay outlives the link it answered."""
    request_bytes = canonical_json_bytes(request_json)

    def attempt() -> T:
        memo = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
        )
        if memo is not None:
            return decode(memo)
        response = op()
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True)
            if isinstance(response, BaseModel)
            else {},
        )
        db.commit()
        return response

    return retry_serializable(db, scope, attempt)


def _link(db: Session, viewer_id: UUID, link_id: UUID) -> edges.EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or edge.origin != "user":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge


def _attached_notes(db: Session, viewer_id: UUID, link: edges.EdgeOut) -> list[UUID]:
    pair = edges.link_pair(link)
    return edges.link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[pair]).get(pair, [])
