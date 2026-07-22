"""User-authored relationship commands: Link, stance, and Link-note (§ Mutation APIs).

Sole owner of the user operation. It composes transaction-scoped Highlight,
passage-anchor, note, and low-level edge helpers into one retryable serializable
transaction and records the exact response through the shared replay ledger; it
never constructs ``ResourceEdge`` or writes ``resource_edges`` directly (that
stays in ``edges``/``adjacency``/``cleanup``). Reads over ``resource_edges`` are
fine — this module IS the graph-owned Link service.

Canonical unordered-pair order is ``tuple(scheme, lowercase-uuid-string)``,
matching migration 0184 and ``uq_resource_edges_user_context_link_pair``; the
service orders the pair, never a ``CHECK``. Stance direction is stored, not
canonicalized: the stored orientation carries the stance and one stance per
unordered pair is enforced by selecting both orientations under SERIALIZABLE.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import and_, or_, select
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
    LinkNoteOut,
    PutLinkNoteRequest,
    PutStanceRequest,
    StanceOut,
    connection_out,
)
from nexus.services import highlights, notes, passage_anchors, pdf_highlights
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import cleanup, connections, edges
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
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


# =============================================================================
# Link create / delete
# =============================================================================


def create_link(db: Session, *, viewer_id: UUID, request: CreateLinkRequest) -> CreateLinkOut:
    """Create-or-reuse one neutral Link; one retryable serializable transaction.

    The fresh Highlight (if any), the passage anchor (if any), and the canonical
    Link are written together and the exact response is memoized in the replay
    ledger. A duplicate/reverse Link is idempotent success (``created=False``);
    failure rolls back every new row (§ Mutation APIs, AC2/AC3).
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

        source_ref, created_source_ref = _resolve_link_source(
            db, viewer_id=viewer_id, request=request
        )
        target_ref = _resolve_link_target(db, viewer_id=viewer_id, request=request)
        if source_ref.uri == target_ref.uri:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot be linked to itself")

        a, b = _canonical_pair(source_ref, target_ref)
        write = edges.create_link(db, viewer_id=viewer_id, source=a, target=b)

        connection = _connection_for_edge(
            db,
            viewer_id=viewer_id,
            edge_id=write.edge.id,
            refs=(a, b),
            filters=ConnectionFilters(origins=("user",), kinds=("context",)),
        )
        response = CreateLinkOut(
            created=write.created,
            created_source_ref=created_source_ref.uri if created_source_ref is not None else None,
            connection=connection_out(connection),
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=_LINK_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True),
            changed_lanes={connection.edge_id.hex: True},
        )
        db.commit()
        return response

    return retry_serializable(db, "create_link", op)


def delete_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> None:
    """Idempotent Remove Link: detach both attachment motifs, clear view state, drop the edge.

    The authored note prose survives as standalone prose (§ Graph Shapes). An
    absent Link is a no-op; a non-user edge id is forbidden. Runs under
    SERIALIZABLE so a concurrent delete of the same Link (double-click, retry,
    second tab) converges: the loser retries, re-reads an absent edge, and
    returns the promised no-op rather than a spurious 404 from the TOCTOU
    between ``get_owned_edge`` and ``delete_edge``.
    """

    def op() -> None:
        edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
        if edge is None:
            return
        if edge.origin != "user":
            raise ForbiddenError(
                ApiErrorCode.E_FORBIDDEN, "Only user relations can be removed here"
            )
        if not is_neutral_link_shape(edge):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
        cleanup.detach_link_note_motif(db, viewer_id=viewer_id, a=edge.source, b=edge.target)
        cleanup.clear_edge_view_state(db, edge_id=link_id)
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
        db.commit()

    retry_serializable(db, "delete_link", op)


# =============================================================================
# Link note put / delete
# =============================================================================


def put_link_note(
    db: Session, *, viewer_id: UUID, link_id: UUID, request: PutLinkNoteRequest
) -> LinkNoteOut:
    """Add/Edit the Link's single ordinary note; one retryable serializable transaction.

    Selects the Link, checks/creates the one note (normal note validation), and
    commits exactly two ``link_note`` attachment edges (Link's endpoints). Note
    indexing stays the note-owned post-commit follow-up (§ Mutation APIs).
    """
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=True))
    scope = f"link_note:{link_id}"

    def op() -> LinkNoteOut:
        link = _load_neutral_link(db, viewer_id=viewer_id, link_id=link_id)
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return LinkNoteOut.model_validate(replay)

        a, b = link.source, link.target
        existing_note_id = _link_note_block_id(db, viewer_id=viewer_id, a=a, b=b)
        if existing_note_id is not None and existing_note_id != request.note_block_id:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Link already has a different note")

        block = notes.upsert_note_body_without_commit(
            db, viewer_id, request.note_block_id, request.body_pm_json
        )
        if existing_note_id is None:
            note_ref = ResourceRef(scheme="note_block", id=block.id)
            for endpoint in (a, b):
                edges.create_edge(
                    db,
                    viewer_id=viewer_id,
                    input=EdgeCreate(
                        source=note_ref, target=endpoint, kind="context", origin="link_note"
                    ),
                )
        enqueue_note_reindex(db, note_block_id=block.id, reason="link_note")

        connection = _connection_for_edge(
            db,
            viewer_id=viewer_id,
            edge_id=link.id,
            refs=(a, b),
            filters=ConnectionFilters(origins=("user",), kinds=("context",)),
        )
        response = LinkNoteOut(note_block_id=block.id, connection=connection_out(connection))
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True),
            changed_lanes={scope: True},
        )
        db.commit()
        return response

    return retry_serializable(db, "put_link_note", op)


def delete_link_note(db: Session, *, viewer_id: UUID, link_id: UUID) -> None:
    """Delete the Link's note and its attachment edges; the Link is preserved.

    Idempotent: a Link with no note is a no-op. Deleting the note removes its
    own graph edges (both ``link_note`` halves and any body mentions), passage
    anchors, and content index through the note owner's cleanup (§ Graph Shapes).
    """
    link = _load_neutral_link(db, viewer_id=viewer_id, link_id=link_id)
    note_id = _link_note_block_id(db, viewer_id=viewer_id, a=link.source, b=link.target)
    if note_id is None:
        return
    notes.remove_note_block(db, viewer_id, note_id)


# =============================================================================
# Stance put / delete
# =============================================================================


def put_stance(db: Session, *, viewer_id: UUID, request: PutStanceRequest) -> StanceOut:
    """Replace the one directed stance on an unordered pair; retryable serializable.

    Selecting both orientations under SERIALIZABLE enforces one stance per pair;
    opposite-orientation races converge on retry, and the directed index catches
    same-orientation races (AC4). A focused highlight materializes a passage
    anchor for its media; durable media is the explicit fallback (§ Stance).
    """
    source = _parse_ref(request.source_ref)
    target_input = _parse_ref(request.target_ref)

    def op() -> StanceOut:
        _admit_source(db, viewer_id=viewer_id, ref=source)
        _admit_direct_target(db, viewer_id=viewer_id, ref=target_input)
        target = _focused_stance_target(db, viewer_id=viewer_id, source=source, target=target_input)
        if source.uri == target.uri:
            raise ApiError(ApiErrorCode.E_LINK_SELF, "A resource cannot take a stance on itself")

        edge = _replace_stance(
            db, viewer_id=viewer_id, source=source, target=target, kind=request.kind
        )
        connection = _connection_for_edge(
            db,
            viewer_id=viewer_id,
            edge_id=edge.id,
            refs=(source, target),
            filters=ConnectionFilters(origins=("user",), kinds=("supports", "contradicts")),
        )
        response = StanceOut(connection=connection_out(connection))
        db.commit()
        return response

    return retry_serializable(db, "put_stance", op)


def delete_stance(db: Session, *, viewer_id: UUID, stance_id: UUID) -> None:
    """Idempotent stance removal; clears view state before dropping the edge.

    Runs under SERIALIZABLE so a concurrent delete of the same stance converges
    on retry to the promised no-op instead of a spurious 404 from the TOCTOU
    between ``get_owned_edge`` and ``delete_edge``.
    """

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


# =============================================================================
# Source / target resolution
# =============================================================================


def _resolve_link_source(
    db: Session, *, viewer_id: UUID, request: CreateLinkRequest
) -> tuple[ResourceRef, ResourceRef | None]:
    """Resolve the Link source; the second element is the freshly minted Highlight ref."""
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
            quads=[q.model_dump() for q in source.quads],
            exact=source.exact,
            color=source.color,
        )
    ref = ResourceRef(scheme="highlight", id=highlight.id)
    return ref, ref


def _resolve_link_target(
    db: Session, *, viewer_id: UUID, request: CreateLinkRequest
) -> ResourceRef:
    target = request.target
    if target.kind == "resource":
        ref = _parse_ref(target.ref)
        _admit_direct_target(db, viewer_id=viewer_id, ref=ref)
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
        db,
        user_id=viewer_id,
        owner_scheme=owner_ref.scheme,
        owner_id=owner_ref.id,
        exact=exact,
    )
    return ResourceRef(scheme="passage_anchor", id=anchor.id)


def _focused_stance_target(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> ResourceRef:
    """Upgrade a highlight→media stance to its focused passage anchor when it resolves.

    The highlight's own quote is materialized within the media owner; ambiguity
    or no-match falls back to the durable media endpoint (§ Stance).
    """
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


# =============================================================================
# Admission helpers
# =============================================================================


def _replace_stance(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef, kind: str
) -> EdgeOut:
    """Replace any prior stance on the pair with ``source -> target`` at ``kind``.

    An unchanged re-PUT keeps the existing edge (stable id); any other prior
    orientation/kind is dropped first, so exactly one directed stance remains.
    """
    prior_id = _existing_stance_id(db, viewer_id=viewer_id, a=source, b=target)
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


def _admit_direct_target(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
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


# =============================================================================
# Edge reads (no writes: this is the graph-owned Link service)
# =============================================================================


def _canonical_pair(x: ResourceRef, y: ResourceRef) -> tuple[ResourceRef, ResourceRef]:
    """Order the unordered pair by ``(scheme, lowercase-uuid-string)`` (migration 0184)."""
    return (x, y) if (x.scheme, str(x.id)) <= (y.scheme, str(y.id)) else (y, x)


def _load_neutral_link(db: Session, *, viewer_id: UUID, link_id: UUID) -> EdgeOut:
    edge = edges.get_owned_edge(db, viewer_id=viewer_id, edge_id=link_id)
    if edge is None or not is_neutral_link_shape(edge):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found")
    return edge


def _existing_stance_id(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    """Id of the viewer's stance on the unordered pair ``{a, b}``, either orientation.

    Orderless ``supports``/``contradicts`` only; the SELECT over both orientations
    is what SERIALIZABLE tracks to keep one stance per unordered pair (§ Stance).
    """
    return db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind.in_(("supports", "contradicts")),
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
            ResourceEdge.source_order_key.is_(None),
            ResourceEdge.target_order_key.is_(None),
            or_(
                and_(_source_is(a), _target_is(b)),
                and_(_source_is(b), _target_is(a)),
            ),
        )
    ).scalar_one_or_none()


def _link_note_block_id(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    """The ``note_block`` id whose ``link_note`` motif attaches to BOTH ``a`` and ``b``."""
    a_key = (a.scheme, a.id)
    b_key = (b.scheme, b.id)
    targets_by_note: dict[UUID, set[tuple[str, UUID]]] = {}
    for note_id, ts, ti in db.execute(
        select(ResourceEdge.source_id, ResourceEdge.target_scheme, ResourceEdge.target_id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "link_note",
            ResourceEdge.source_scheme == "note_block",
            or_(_target_is(a), _target_is(b)),
        )
    ).all():
        targets_by_note.setdefault(note_id, set()).add((ts, ti))
    for note_id, targets in targets_by_note.items():
        if a_key in targets and b_key in targets:
            return note_id
    return None


def _connection_for_edge(
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
    for item in page.items:
        if item.edge_id == edge_id:
            return item
    raise AssertionError(  # justify-defect: the edge was just flushed in this transaction
        f"connection for freshly written edge {edge_id} not found"
    )


def _source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def _target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)
