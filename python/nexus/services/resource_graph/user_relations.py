"""User link commands compose selection, passage, note and graph owners atomically.

The public mutations own serializable retry and exact response replay. The graph
writer owns canonical pairs and endpoint order; composition helpers only flush.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.resource_graph import (
    CreateLinkOut,
    CreateLinkRequest,
    LinkEndpoint,
    LinkNoteOut,
    PutLinkNoteRequest,
    connection_out,
)
from nexus.schemas.resource_items import NoteBodyVersionsOut
from nexus.services import highlights, note_bodies, passage_anchors, pdf_highlights
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import cleanup, connections, edges
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_graph.schemas import (
    EdgeCreate,
    EdgeOut,
    is_neutral_link_shape,
)
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import resource_link_mode
from nexus.services.resource_items.targets import candidate_owner_and_quote
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

_LINK_SCOPE = "resource_graph:link"


def count_retained_neutral_links(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Surviving user Links in the window whose two current endpoints remain visible."""
    predicates = [ResourceEdge.user_id == viewer_id, ResourceEdge.created_at < end]
    if start is not None:
        predicates.append(ResourceEdge.created_at >= start)
    links = [
        edge
        for edge in db.scalars(select(ResourceEdge).where(*predicates).order_by(ResourceEdge.id))
        if _is_neutral_link(edge)
    ]
    resolved = resolve_refs(
        db,
        viewer_id=viewer_id,
        refs=[
            assert_resource_ref(f"{scheme}:{resource_id}")
            for edge in links
            for scheme, resource_id in (
                (edge.source_scheme, edge.source_id),
                (edge.target_scheme, edge.target_id),
            )
        ],
        include_media_document_summary=False,
    )
    return sum(
        not resolved[index].missing and not resolved[index + 1].missing
        for index in range(0, len(resolved), 2)
    )


def create_link(db: Session, *, viewer_id: UUID, request: CreateLinkRequest) -> CreateLinkOut:
    """Create-or-reuse one neutral Link, memoizing the exact response for replay.

    The fresh Highlight (if any), the passage anchor (if any) and the Link are written
    together; a duplicate or reversed Link is idempotent success with ``created=False``.
    """
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=True))

    def op() -> CreateLinkOut:
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=_LINK_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return CreateLinkOut.model_validate(replay)

        source_ref, created_source_ref = _link_source(db, viewer_id=viewer_id, request=request)
        target_ref = materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=request.target)
        if source_ref.uri == target_ref.uri:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot be linked to itself")

        write = edges.create_link(db, viewer_id=viewer_id, source=source_ref, target=target_ref)
        response = CreateLinkOut(
            created=write.created,
            created_source_ref=created_source_ref.uri if created_source_ref is not None else None,
            connection=connection_out(
                connections.connection_for_edge(
                    db,
                    viewer_id=viewer_id,
                    edge_id=write.edge.id,
                    ref=source_ref,
                )
            ),
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=_LINK_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True),
        )
        db.commit()
        return response

    return retry_serializable(db, "create_link", op)


def delete_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> None:
    """Idempotent Remove Link: detach the note motif, clear view state, drop the edge.

    SERIALIZABLE so a concurrent delete of the same Link converges on the promised
    no-op rather than a 404 from the read/delete window.
    """

    def op() -> None:
        edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
        if edge is None:
            return
        if edge.origin != "user":
            raise ForbiddenError(
                ApiErrorCode.E_FORBIDDEN, "Only user relations can be removed here"
            )
        if not _is_neutral_link(edge):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
        cleanup.detach_link_note_motif(db, viewer_id=viewer_id, a=edge.source, b=edge.target)
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
        db.commit()

    retry_serializable(db, "delete_link", op)


def put_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, request: PutLinkNoteRequest
) -> LinkNoteOut:
    """Add or edit the Link's single ordinary note and its two attachment edges."""
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=True))
    scope = f"link_note:{link_id}"

    def op() -> LinkNoteOut:
        link = _neutral_link(db, viewer_id=viewer_id, link_id=link_id)
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return LinkNoteOut.model_validate(replay)

        attached_ids = edges.link_note_blocks_for_pair(
            db, viewer_id=viewer_id, a=link.source, b=link.target
        )
        if request.expected_body.kind == "absent":
            if attached_ids:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a note")
        elif request.note_block_id not in attached_ids:
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
        if request.expected_body.kind == "absent":
            note_ref = ResourceRef(scheme="note_block", id=block.id)
            for endpoint in (link.source, link.target):
                edges.create_edge(
                    db,
                    viewer_id=viewer_id,
                    input=EdgeCreate(
                        source=note_ref, target=endpoint, kind="context", origin="link_note"
                    ),
                )
        enqueue_note_reindex(db, note_block_id=block.id, reason="link_note")

        response = LinkNoteOut(
            note_block_id=block.id,
            body_pm_json=block.body_pm_json,
            body_text=block.body_text,
            version_by_lane=NoteBodyVersionsOut.model_validate(
                versions.versions_for_ref(
                    db, viewer_id=viewer_id, ref=note_bodies.note_ref(block.id)
                )
            ),
            connection=connection_out(
                connections.connection_for_edge(
                    db,
                    viewer_id=viewer_id,
                    edge_id=link.id,
                    ref=link.source,
                )
            ),
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True),
        )
        db.commit()
        return response

    return retry_serializable(db, "put_link_note", op)


def detach_link_note(
    db: Session,
    *,
    viewer_id: UUID,
    link_id: UUID,
    note_block_id: UUID,
    client_mutation_id: str,
) -> None:
    """Detach the exact Link annotation; preserve the canonical note and Link."""
    scope = f"link_note:{link_id}"
    request_bytes = canonical_json_bytes({"operation": "detach", "noteBlockId": str(note_block_id)})

    def op() -> None:
        link = _neutral_link(db, viewer_id=viewer_id, link_id=link_id)
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return
        attached_ids = edges.link_note_blocks_for_pair(
            db, viewer_id=viewer_id, a=link.source, b=link.target
        )
        if note_block_id not in attached_ids:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note is no longer attached")
        cleanup.detach_link_note_motif(
            db,
            viewer_id=viewer_id,
            a=link.source,
            b=link.target,
            note_id=note_block_id,
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
            response_json={},
        )
        db.commit()

    retry_serializable(db, "detach_link_note", op)


def _link_source(
    db: Session, *, viewer_id: UUID, request: CreateLinkRequest
) -> tuple[ResourceRef, ResourceRef | None]:
    """The Link source; the second element is the Highlight this request just minted."""
    source = request.source
    if source.kind == "resource" or source.kind == "passage":
        return materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=source), None
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
    ref = ResourceRef(scheme="highlight", id=highlight.id)
    return ref, ref


def materialize_link_endpoint(
    db: Session, *, viewer_id: UUID, endpoint: LinkEndpoint
) -> ResourceRef:
    """Resolve a visible link endpoint; may create a passage anchor, and only flushes."""
    if endpoint.kind == "resource":
        ref = _parse_ref(endpoint.ref)
        if resource_link_mode(ref) != "direct":
            raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be linked")
        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)
        return ref

    candidate = _parse_ref(endpoint.candidate_ref)
    if resource_link_mode(candidate) != "materialize_passage":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Resource is not a passage candidate"
        )
    owner_and_quote = candidate_owner_and_quote(db, ref=candidate)
    if owner_and_quote is None:
        raise ConflictError(ApiErrorCode.E_LINK_TARGET_STALE, "Passage candidate no longer exists")
    owner_ref, exact = owner_and_quote
    assert_ref_visible(db, viewer_id=viewer_id, ref=owner_ref)
    anchor = passage_anchors.materialize_or_reuse(
        db, user_id=viewer_id, owner_scheme=owner_ref.scheme, owner_id=owner_ref.id, exact=exact
    )
    return ResourceRef(scheme="passage_anchor", id=anchor.id)


def _parse_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRef):
        return parsed
    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST,
        f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
    )


def _is_neutral_link(edge: EdgeOut | ResourceEdge) -> bool:
    return is_neutral_link_shape(
        origin=edge.origin,
        kind=edge.kind,
        ordinal=edge.ordinal,
        snapshot=edge.snapshot,
        source_order_key=edge.source_order_key,
    )


def _neutral_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or not _is_neutral_link(edge):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge
