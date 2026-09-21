"""The user-authored relationship commands: Link, Link note and stance.

Each command is one retryable transaction that composes the Highlight, passage-anchor,
note and edge writers, then commits. The canonical unordered pair is ordered by
``(scheme, lowercase-uuid-string)`` here, in the service, never by a CHECK; stance
direction is stored as given, and one stance per unordered pair is enforced by
selecting both orientations under SERIALIZABLE. This module reads ``resource_edges``
but never writes it directly.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.db.retries import retry_read_committed, retry_serializable
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
    LinkNoteOut,
    PutLinkNoteRequest,
    PutStanceRequest,
    StanceOut,
    connection_out,
)
from nexus.services import highlights, note_bodies, notes, passage_anchors, pdf_highlights
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import cleanup, connections, edges
from nexus.services.resource_graph.edges import source_is, target_is
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
    EdgeKind,
    EdgeOut,
    is_neutral_link_shape,
)
from nexus.services.resource_items.capabilities import (
    resource_can_link_source,
    resource_user_link_target_mode,
)
from nexus.services.resource_items.targets import candidate_owner_and_quote
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

_LINK_SCOPE = "resource_graph:link"
_LINK_FILTERS = ConnectionFilters(origins=("user",), kinds=("context",))
_STANCE_FILTERS = ConnectionFilters(origins=("user",), kinds=("supports", "contradicts"))


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
        target_ref = _link_target(db, viewer_id=viewer_id, request=request)
        if source_ref.uri == target_ref.uri:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot be linked to itself")

        a, b = _canonical_pair(source_ref, target_ref)
        write = edges.create_link(db, viewer_id=viewer_id, source=a, target=b)
        response = CreateLinkOut(
            created=write.created,
            created_source_ref=created_source_ref.uri if created_source_ref is not None else None,
            connection=connection_out(
                _connection(
                    db,
                    viewer_id=viewer_id,
                    edge_id=write.edge.id,
                    refs=(a, b),
                    filters=_LINK_FILTERS,
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
        cleanup.clear_edge_view_state(db, edge_id=link_id)
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

        existing_note_id = edges.link_note_block_for_pair(
            db, viewer_id=viewer_id, a=link.source, b=link.target
        )
        if existing_note_id is not None and existing_note_id != request.note_block_id:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a different note")

        block = note_bodies.upsert_note_body(
            db,
            viewer_id=viewer_id,
            block_id=request.note_block_id,
            body_pm_json=request.body_pm_json,
        )
        if existing_note_id is None:
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
            connection=connection_out(
                _connection(
                    db,
                    viewer_id=viewer_id,
                    edge_id=link.id,
                    refs=(link.source, link.target),
                    filters=_LINK_FILTERS,
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


def delete_link_note(db: Session, *, viewer_id: UUID, link_id: UUID) -> None:
    """Delete the Link's note; the Link itself is preserved. A Link with no note is a no-op.

    Deleting the note removes its own edges, anchors and index rows through the note owner.
    """

    def op() -> None:
        link = _neutral_link(db, viewer_id=viewer_id, link_id=link_id)
        note_id = edges.link_note_block_for_pair(
            db, viewer_id=viewer_id, a=link.source, b=link.target
        )
        if note_id is None:
            return
        if notes.remove_note_block_in_current_transaction(db, viewer_id, note_id):
            db.commit()

    retry_read_committed(db, "delete_link_note", op)


def put_stance(db: Session, *, viewer_id: UUID, request: PutStanceRequest) -> StanceOut:
    """Replace whatever stance the unordered pair carried with this directed one.

    A focused highlight materializes a passage anchor inside the media it is about;
    durable media is the explicit fallback when the quote is ambiguous.
    """
    source = _parse_ref(request.source_ref)
    target_input = _parse_ref(request.target_ref)

    def op() -> StanceOut:
        _admit_source(db, viewer_id=viewer_id, ref=source)
        _admit_target(db, viewer_id=viewer_id, ref=target_input)
        target = _focused_stance_target(db, viewer_id=viewer_id, source=source, target=target_input)
        if source.uri == target.uri:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot take a stance on itself")

        edge = _replace_stance(
            db, viewer_id=viewer_id, source=source, target=target, kind=request.kind
        )
        response = StanceOut(
            connection=connection_out(
                _connection(
                    db,
                    viewer_id=viewer_id,
                    edge_id=edge.id,
                    refs=(source, target),
                    filters=_STANCE_FILTERS,
                )
            )
        )
        db.commit()
        return response

    return retry_serializable(db, "put_stance", op)


def delete_stance(db: Session, *, viewer_id: UUID, stance_id: UUID) -> None:
    """Idempotent stance removal; view state goes before the edge."""

    def op() -> None:
        edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=stance_id)
        if edge is None:
            return
        if edge.origin != "user":
            raise ForbiddenError(
                ApiErrorCode.E_FORBIDDEN, "Only user relations can be removed here"
            )
        if edge.kind not in ("supports", "contradicts"):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Stance not found")
        cleanup.clear_edge_view_state(db, edge_id=stance_id)
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=stance_id)
        db.commit()

    retry_serializable(db, "delete_stance", op)


def _link_source(
    db: Session, *, viewer_id: UUID, request: CreateLinkRequest
) -> tuple[ResourceRef, ResourceRef | None]:
    """The Link source; the second element is the Highlight this request just minted."""
    source = request.source
    if source.kind == "resource":
        ref = _parse_ref(source.ref)
        _admit_source(db, viewer_id=viewer_id, ref=ref)
        return ref, None
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


def _link_target(db: Session, *, viewer_id: UUID, request: CreateLinkRequest) -> ResourceRef:
    target = request.target
    if target.kind == "resource":
        ref = _parse_ref(target.ref)
        _admit_target(db, viewer_id=viewer_id, ref=ref)
        return ref

    candidate = _parse_ref(target.candidate_ref)
    if resource_user_link_target_mode(candidate) != "materialize_passage":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Target is not a passage candidate"
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


def _focused_stance_target(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> ResourceRef:
    if source.scheme != "highlight" or target.scheme != "media":
        return target
    highlight = highlights.get_highlight_for_visible_read_or_404(db, viewer_id, source.id)
    try:
        anchor = passage_anchors.materialize_or_reuse(
            db,
            user_id=viewer_id,
            owner_scheme="media",
            owner_id=target.id,
            exact=highlight.exact,
            prefix=highlight.prefix,
            suffix=highlight.suffix,
        )
    except ApiError as exc:
        if exc.code is ApiErrorCode.E_LINK_TARGET_AMBIGUOUS:
            return target
        raise
    return ResourceRef(scheme="passage_anchor", id=anchor.id)


def _replace_stance(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef, kind: EdgeKind
) -> EdgeOut:
    """An unchanged re-PUT keeps the existing edge id; any other prior stance is dropped."""
    prior_id = db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind.in_(("supports", "contradicts")),
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
            ResourceEdge.source_order_key.is_(None),
            ResourceEdge.target_order_key.is_(None),
            or_(
                and_(source_is(source), target_is(target)),
                and_(source_is(target), target_is(source)),
            ),
        )
    ).scalar_one_or_none()
    if prior_id is not None:
        prior = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=prior_id)
        if (
            prior is not None
            and prior.source.uri == source.uri
            and prior.target.uri == target.uri
            and prior.kind == kind
        ):
            return prior
        cleanup.clear_edge_view_state(db, edge_id=prior_id)
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=prior_id)
    return edges.create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(source=source, target=target, kind=kind, origin="user"),
    )


def _admit_source(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    if not resource_can_link_source(ref):
        raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be a link source")
    assert_ref_visible(db, viewer_id=viewer_id, ref=ref)


def _admit_target(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    if resource_user_link_target_mode(ref) != "direct":
        raise ApiError(ApiErrorCode.E_LINK_CAPABILITY, "Resource cannot be a link target")
    assert_ref_visible(db, viewer_id=viewer_id, ref=ref)


def _parse_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRef):
        return parsed
    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST,
        f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
    )


def _canonical_pair(x: ResourceRef, y: ResourceRef) -> tuple[ResourceRef, ResourceRef]:
    return (x, y) if (x.scheme, str(x.id)) <= (y.scheme, str(y.id)) else (y, x)


def _is_neutral_link(edge: EdgeOut | ResourceEdge) -> bool:
    return is_neutral_link_shape(
        origin=edge.origin,
        kind=edge.kind,
        ordinal=edge.ordinal,
        snapshot=edge.snapshot,
        source_order_key=edge.source_order_key,
        target_order_key=edge.target_order_key,
    )


def _neutral_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or not _is_neutral_link(edge):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge


def _connection(
    db: Session,
    *,
    viewer_id: UUID,
    edge_id: UUID,
    refs: tuple[ResourceRef, ...],
    filters: ConnectionFilters,
) -> Connection:
    """Hydrate the just-written edge through the canonical connection read."""
    page = connections.query_connections(
        db,
        viewer_id=viewer_id,
        query=ConnectionQuery(
            refs=refs, direction="both", rollup="exact", filters=filters, limit=100
        ),
    )
    return next(item for item in page.items if item.edge_id == edge_id)
