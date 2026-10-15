"""User link commands: create (with a minted highlight or passage anchor), remove, and the
link's one ordinary note. Each command is SERIALIZABLE with retry. Create is named by the
client's ``link_id``: a resend that landed answers that link as created; the note commands
are idempotent by the client's note id.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.schemas.notes import AnnotationNoteRequest
from nexus.schemas.resource_graph import (
    CreateLinkOut,
    CreateLinkRequest,
    LinkEndpoint,
    LinkNoteOut,
)
from nexus.services import highlights, note_bodies, passage_anchors, pdf_highlights
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.connections import connection_for_edge
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_items.capabilities import capability
from nexus.services.search.pickers import candidate_owner_and_quote
from nexus.services.suggestion_changes import record_input_change


def create_link(db: Session, *, viewer_id: UUID, request: CreateLinkRequest) -> CreateLinkOut:
    """Create or reuse one link; a highlight or passage anchor minted for it is written in
    the same transaction, so both exist or neither does. ``link_id`` held by any other
    link is 409; a resend after the link was deleted creates it again."""

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
        held = db.get(ResourceEdge, request.link_id)
        if held is not None:
            pair = edges.existing_link_pair(db, viewer_id=viewer_id, a=source_ref, b=target_ref)
            if pair is None or pair.id != held.id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Link id is taken")
        write = edges.create_link(
            db, viewer_id=viewer_id, source=source_ref, target=target_ref, link_id=request.link_id
        )
        out = CreateLinkOut(
            created=write.created or write.edge.id == request.link_id,
            created_source_ref=minted.uri if minted is not None else None,
            connection=connection_for_edge(
                db, viewer_id=viewer_id, edge_id=write.edge.id, ref=source_ref
            ),
        )
        record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "create_link", op)


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
        record_input_change(db)
        db.commit()

    retry_serializable(db, "delete_link", op)


def put_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, request: AnnotationNoteRequest
) -> LinkNoteOut:
    """Create the link's one note and attach it to both ends (two ``link_note`` edges).
    Retry: that note already attached has landed; another note attached, or the note id
    taken, is 409. Later edits are outline ``set_body`` commands."""

    def op() -> LinkNoteOut:
        link = _link(db, viewer_id, link_id)
        attached = _attached_notes(db, viewer_id, link)
        if request.note_id not in attached:
            taken = note_bodies.note_exists(db, viewer_id=viewer_id, note_id=request.note_id)
            if attached or taken:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a note")
            note_bodies.ensure_note(
                db,
                viewer_id=viewer_id,
                note_id=request.note_id,
                body_pm_json=request.body_pm_json,
                reason="link_note",
            )
            note = note_bodies.note_ref(request.note_id)
            for endpoint in (link.source, link.target):
                edges.create_edge(
                    db,
                    viewer_id=viewer_id,
                    input=edges.EdgeCreate(note, endpoint, "context", "link_note"),
                )
        saved = note_bodies.read_note(db, viewer_id=viewer_id, note_id=request.note_id)
        out = LinkNoteOut(
            note_block_id=saved.id,
            body_pm_json=saved.body_pm_json,
            body_text=saved.body_text,
            body_version=saved.body_version,
            connection=connection_for_edge(
                db, viewer_id=viewer_id, edge_id=link.id, ref=link.source
            ),
        )
        record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "put_link_note", op)


def detach_link_note(db: Session, *, viewer_id: UUID, link_id: UUID, note_id: UUID) -> None:
    """Detach the note from both ends (idempotent); the note and the link stay."""

    def op() -> None:
        link = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
        if link is not None and note_id in _attached_notes(db, viewer_id, link):
            edges.detach_link_notes(db, viewer_id=viewer_id, link=link, note_block_id=note_id)
            record_input_change(db)
        db.commit()

    retry_serializable(db, "detach_link_note", op)


def materialize_link_endpoint(
    db: Session, *, viewer_id: UUID, endpoint: LinkEndpoint
) -> ResourceRef:
    """A linkable ref for a resource (the writer checks it is visible), or a passage
    anchor minted or reused for a passage candidate. Only flushes."""
    if endpoint.kind == "resource":
        ref = require_ref(endpoint.ref)
        if capability(ref.scheme).link_mode != "direct":
            raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be linked")
        return ref
    candidate = require_ref(endpoint.candidate_ref)
    if capability(candidate.scheme).link_mode != "materialize_passage":
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


def _link(db: Session, viewer_id: UUID, link_id: UUID) -> edges.EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or edge.origin != "user":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge


def _attached_notes(db: Session, viewer_id: UUID, link: edges.EdgeOut) -> list[UUID]:
    pair = edges.link_pair(link)
    return edges.link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[pair]).get(pair, [])
