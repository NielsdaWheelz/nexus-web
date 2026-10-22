"""Flush-only link materialization and exact preserving unlink; serializable note commands.

Materialization and unlink compose inside their caller's transaction. Unlink removes
one owned user/discovery/assistant edge; an absent uuid succeeds without resolving a
replacement. Only user unlink checks or detaches relationship notes. Every unlink
preserves endpoint resources, note content and creation history. Note commands are
idempotent by the client's note id.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.resource_graph import (
    InsertionSource,
    LinkEndpoint,
    LinkPassageEndpoint,
    LinkResourceEndpoint,
    SetLinkNoteRequest,
)
from nexus.schemas.writing import WritingAck
from nexus.services import (
    authored_identities,
    highlights,
    note_bodies,
    notes,
    passage_anchors,
    pdf_highlights,
    writing,
)
from nexus.services.reader_publication import lock_publication_generation
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import visible_refs
from nexus.services.suggestion_changes import record_input_change


def insertion_source_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef
) -> LinkEndpoint | None:
    """Read a visible endpoint's insertion owner without materializing a passage.

    The caller proves this current ref is visible. Exact candidate adjacency stays
    candidate-owned; a saved passage's child order belongs only to its durable anchor.
    A quote that no longer resolves retains its explicit candidate destination, so
    a later materialization can refuse without retargeting the document.
    """
    match capability(ref.scheme).link_mode:
        case "none":
            return None
        case "direct":
            return LinkResourceEndpoint(ref=ref.uri)
        case "materialize_passage":
            from nexus.services.search.pickers import source_identity

            try:
                _, anchor = source_identity(db, viewer_id, ref)
            except NotFoundError:
                # justify-ignore-error: an unavailable locator does not retarget its source.
                anchor = None
            return (
                LinkResourceEndpoint(ref=anchor.uri)
                if anchor is not None
                else LinkPassageEndpoint(candidate_ref=ref.uri)
            )


def materialize_source(
    db: Session, *, viewer_id: UUID, source: InsertionSource
) -> tuple[ResourceRef, bool]:
    """Materialize a frozen source inside its insertion transaction; never commits."""
    if source.kind == "resource" or source.kind == "passage":
        return materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=source), False
    if source.kind == "daily_page":
        existing = db.scalar(
            select(DailyPageBinding.page_id).where(
                DailyPageBinding.user_id == viewer_id,
                DailyPageBinding.local_date == source.local_date,
            )
        )
        return notes.ensure_daily_page(
            db, viewer_id, source.local_date, source.page_id
        ), existing is None
    if source.kind == "fragment_selection":
        result = highlights.create_fragment_highlight_in_txn(
            db,
            viewer_id=viewer_id,
            highlight_id=source.highlight_id,
            fragment_id=source.fragment_id,
            start_offset=source.start_offset,
            end_offset=source.end_offset,
            color=source.color,
            expected_reader_generation=source.expected_reader_generation,
        )
    else:
        assert_ref_visible(db, viewer_id=viewer_id, ref=ResourceRef("media", source.media_id))
        pdf_highlights.lock_pdf_highlight_write_or_404(db, source.media_id)
        if (
            lock_publication_generation(db, media_id=source.media_id)
            != source.expected_reader_generation
        ):
            raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
        result = pdf_highlights.create_pdf_highlight_in_txn(
            db,
            viewer_id=viewer_id,
            highlight_id=source.highlight_id,
            media_id=source.media_id,
            page_number=source.page_number,
            quads=[quad.model_dump() for quad in source.quads],
            exact=source.exact,
            color=source.color,
        )
    return ResourceRef("highlight", result.highlight.id), result.state == "created"


def unlink_in_txn(
    db: Session, *, viewer_id: UUID, link_id: UUID, require_unannotated: bool
) -> bool:
    """Remove one exact owned user/discovery/assistant edge, preserving resources.

    Absent succeeds; foreign or unsupported origins conflict. For user links, the
    annotation precondition precedes detachment. Only flushes; the caller retries,
    notifies once if changed, and commits or rolls back the complete batch.
    """
    known = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=link_id)
    if known is not None:
        writing.identity(db, known.out())
        if known.deleted:
            return False
        link_id = known.canonical.resource_id
    row = db.get(ResourceEdge, link_id)
    if row is None:
        binding = authored_identities.retire(db, viewer_id=viewer_id, kind="link", id=link_id)
        writing.identity(db, binding.out())
        return False
    if row.user_id != viewer_id or row.origin not in ("user", "discovery", "assistant"):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "This connection cannot be removed")
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    assert edge is not None
    if edge.origin == "user":
        if require_unannotated:
            edges.require_unannotated_link(db, viewer_id=viewer_id, edge=edge)
        edges.detach_link_notes(db, viewer_id=viewer_id, link=edge)
    edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
    return True


def put_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, request: SetLinkNoteRequest
) -> WritingAck:
    """Create the frozen pair of attachment ids once, or write their exact note."""

    def op() -> WritingAck:
        known = [
            authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=id)
            for id in (request.source_link_id, request.target_link_id)
        ]
        if request.expected.kind == "absent" and any(binding is not None for binding in known):
            if any(binding is None for binding in known):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Attachment identities disagree"
                )
            for binding in known:
                assert binding is not None
                writing.identity(db, binding.out())
            note = authored_identities.recognize(
                db, viewer_id=viewer_id, kind="note_block", id=request.note_id
            )
            if note is None:
                raise ConflictError(
                    ApiErrorCode.E_NOTE_CONFLICT, "Initialized attachment cannot take a new note"
                )
            writing.identity(db, note.out())
        else:
            link = _link(db, viewer_id, link_id)
            attached = _attached_notes(db, viewer_id, link)
            if request.expected.kind == "version":
                rows = [
                    db.get(ResourceEdge, id)
                    for id in (request.source_link_id, request.target_link_id)
                ]
                if request.note_id not in attached or any(
                    row is None
                    or row.user_id != viewer_id
                    or row.origin != "link_note"
                    or row.source_id != request.note_id
                    for row in rows
                ):
                    raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link note changed")
                for row, endpoint in zip(rows, (link.source, link.target), strict=True):
                    if row is None or (row.target_scheme, row.target_id) != (
                        endpoint.scheme,
                        endpoint.id,
                    ):
                        raise ConflictError(
                            ApiErrorCode.E_NOTE_CONFLICT, "Link note attachments changed"
                        )
                note_bodies.write_body(
                    db,
                    viewer_id=viewer_id,
                    note_id=request.note_id,
                    body_pm_json=request.body_pm_json,
                    expected_version=request.expected.version,
                    reason="link_note_update",
                )
            else:
                if attached:
                    raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a note")
                source = require_ref(request.expected.source_ref)
                if source not in (link.source, link.target):
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Attachment fence is not a link endpoint"
                    )
                version = versions.versions_for_ref(db, viewer_id=viewer_id, ref=source).get(
                    "links", 1
                )
                if version != request.expected.links_version:
                    raise ConflictError(
                        ApiErrorCode.E_NOTE_CONFLICT, "Link note attachment changed"
                    )
                writing.lane(
                    db,
                    viewer_id=viewer_id,
                    ref=source,
                    name="links",
                    before=version,
                    checked=version,
                )
                if (
                    authored_identities.recognize(
                        db, viewer_id=viewer_id, kind="note_block", id=request.note_id
                    )
                    is not None
                ):
                    raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note id is taken")
                note_bodies.ensure_note(
                    db,
                    viewer_id=viewer_id,
                    note_id=request.note_id,
                    body_pm_json=request.body_pm_json,
                    reason="link_note",
                )
                note = note_bodies.note_ref(request.note_id)
                for endpoint, id in (
                    (link.source, request.source_link_id),
                    (link.target, request.target_link_id),
                ):
                    edges.create_edge(
                        db,
                        viewer_id=viewer_id,
                        input=edges.EdgeCreate(note, endpoint, "context", "link_note", id=id),
                    )
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "put_link_note", op)


def detach_link_note(
    db: Session,
    *,
    viewer_id: UUID,
    link_id: UUID,
    note_id: UUID,
    source_link_id: UUID,
    target_link_id: UUID,
) -> WritingAck:
    """Only the exact two reviewed attachment edges may be detached."""

    def op() -> WritingAck:
        rows = [db.get(ResourceEdge, id) for id in (source_link_id, target_link_id)]
        for id, row in zip((source_link_id, target_link_id), rows, strict=True):
            if row is None:
                binding = authored_identities.retire(db, viewer_id=viewer_id, kind="link", id=id)
                writing.identity(db, binding.out())
            elif row.user_id != viewer_id or row.origin != "link_note" or row.source_id != note_id:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link note changed")
        live = [row for row in rows if row is not None]
        if live:
            link = _link(db, viewer_id, link_id)
            if {(row.target_scheme, row.target_id) for row in live} != edges.link_pair(link):
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link note attachments changed")
            edges.detach_link_notes(db, viewer_id=viewer_id, link=link, note_block_id=note_id)
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "detach_link_note", op)


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
    from nexus.services.search.pickers import candidate_owner_and_quote

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
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)
    return sum(
        a.uri in visible and b.uri in visible for a, b in zip(refs[::2], refs[1::2], strict=True)
    )


def _link(db: Session, viewer_id: UUID, link_id: UUID) -> edges.EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or edge.origin != "user":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge


def _attached_notes(db: Session, viewer_id: UUID, link: edges.EdgeOut) -> list[UUID]:
    pair = edges.link_pair(link)
    return edges.link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[pair]).get(pair, [])
