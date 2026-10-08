"""Atomic semantic writing edits over shared neutral links."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from copy import deepcopy
from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    NoteBlock,
    ResourceEdge,
    ResourceMutation,
    ResourceVersion,
    ResourceViewState,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_items import (
    InsertNoteSurfaceCommand,
    InsertResourceSurfaceCommand,
    JoinNotesSurfaceCommand,
    MoveOccurrenceSurfaceCommand,
    NoteBodySurfaceContent,
    OutlineItem,
    OutlineNote,
    PageTitleSurfaceContent,
    PasteOutlineSurfaceCommand,
    RelinkSurfaceCommand,
    RemoveOccurrenceSurfaceCommand,
    ResourceActivationOut,
    ResourceItemCapabilitiesOut,
    ResourceItemOut,
    ResourceLaneVersionIn,
    ResourceSummarySurfaceContent,
    ResourceSurfaceCommandOut,
    ResourceSurfaceCommandRequest,
    ResourceSurfaceNode,
    ResourceSurfaceOccurrence,
    ResourceSurfaceOut,
    ReverseEditSurfaceCommand,
    SplitNoteSurfaceCommand,
    SurfaceAfterPosition,
    SurfaceContext,
    SurfacePosition,
)
from nexus.services import note_bodies
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import adjacency as graph_adjacency
from nexus.services.resource_graph import edges as graph_edges
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import ResolvedResource, assert_ref_visible, resolve_refs
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import (
    capability_for_ref,
    resource_can_own_ordered_adjacency,
    resource_link_mode,
)
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.resource_mutation_replay import canonical_json_bytes, lookup_replay


def get_surface(db: Session, *, viewer_id: UUID, source: ResourceRef) -> ResourceSurfaceOut:
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own a surface")
    links = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)
    refs = [source, *[graph_adjacency.other_endpoint(edge, source) for edge in links]]
    nodes = _nodes(db, viewer_id=viewer_id, refs=refs)
    by_ref = {node.item.ref: node for node in nodes}
    states = {
        state.edge_id: state
        for state in db.scalars(
            select(ResourceViewState).where(
                ResourceViewState.user_id == viewer_id,
                ResourceViewState.surface_scheme == source.scheme,
                ResourceViewState.surface_id == source.id,
                ResourceViewState.edge_id.in_([edge.id for edge in links]),
            )
        ).all()
    }
    pairs = [frozenset({(source.scheme, source.id), (ref.scheme, ref.id)}) for ref in refs[1:]]
    annotations = graph_edges.link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=pairs)
    rows: list[ResourceSurfaceOccurrence] = []
    for edge, pair in zip(links, pairs, strict=True):
        target = graph_adjacency.other_endpoint(edge, source)
        state = states.get(edge.id)
        rows.append(
            ResourceSurfaceOccurrence(
                link_id=edge.id,
                target=by_ref[target.uri],
                collapsed=bool(state.state.get("collapsed")) if state is not None else False,
                has_link_note=bool(annotations.get(pair)),
            )
        )
    return ResourceSurfaceOut(source=by_ref[source.uri], ordered_items=rows)


def _nodes(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> list[ResourceSurfaceNode]:
    items = resource_items_out(db, viewer_id=viewer_id, refs=refs)
    notes = _note_rows(db, viewer_id=viewer_id, refs=refs)
    return [
        ResourceSurfaceNode(
            item=item,
            content=(
                ResourceSummarySurfaceContent(kind="resource_summary")
                if item.missing
                else (
                    PageTitleSurfaceContent(kind="page_title", title=item.label)
                    if ref.scheme == "page"
                    else _target_content(ref, note_rows=notes)
                )
            ),
        )
        for ref, item in zip(refs, items, strict=True)
    ]


def _context_refs(
    db: Session, *, viewer_id: UUID, context: SurfaceContext, endpoint: ResourceRef
) -> set[ResourceRef]:
    current = _parse_ref_or_error(context.root_ref)
    refs = {current}
    assert_ref_visible(db, viewer_id=viewer_id, ref=current)
    for link_id in context.link_path:
        edge = graph_adjacency.incident_link(db, user_id=viewer_id, source=current, link_id=link_id)
        current = graph_adjacency.other_endpoint(edge, current)
        if current in refs:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST, "A terminal cycle reference cannot be edited"
            )
        assert_ref_visible(db, viewer_id=viewer_id, ref=current)
        refs.add(current)
    if current != endpoint:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Writing path no longer reaches this endpoint"
        )
    return refs


def execute_surface_command(
    db: Session, *, viewer_id: UUID, source: ResourceRef, request: ResourceSurfaceCommandRequest
) -> ResourceSurfaceCommandOut:
    request_bytes = canonical_json_bytes(request.model_dump(mode="json"))
    scope = f"resource:{source.uri}:surface_commands"

    def op() -> ResourceSurfaceCommandOut:
        assert_ref_visible(db, viewer_id=viewer_id, ref=source)
        if not resource_can_own_ordered_adjacency(source):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own a surface")
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return ResourceSurfaceCommandOut.model_validate(replay)
        endpoints = _context_refs(db, viewer_id=viewer_id, context=request.context, endpoint=source)
        bodies: set[ResourceRef] = set()
        new_refs: set[ResourceRef] = set()
        owned_bodies: set[ResourceRef] = set()
        command = request.command
        reverse: dict[str, Any] | None = None
        links = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)

        def linked(link_id: UUID, endpoint: ResourceRef = source) -> ResourceRef:
            edge = graph_adjacency.incident_link(
                db, user_id=viewer_id, source=endpoint, link_id=link_id
            )
            return graph_adjacency.other_endpoint(edge, endpoint)

        match command:
            case InsertNoteSurfaceCommand():
                new_refs.add(note_bodies.note_ref(command.note_id))
                _position_index(links, command.position)
            case SplitNoteSurfaceCommand():
                target = linked(command.link_id)
                _owned_paragraph(db, viewer_id=viewer_id, ref=target)
                if (
                    command.left_body_pm_json.get("type") != "paragraph"
                    or command.right_body_pm_json.get("type") != "paragraph"
                ):
                    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only paragraphs can be split")
                bodies.add(target)
                owned_bodies.add(target)
                new_refs.add(note_bodies.note_ref(command.note_id))
            case InsertResourceSurfaceCommand():
                endpoints.add(_parse_ref_or_error(command.target_ref))
                _position_index(links, command.position)
            case MoveOccurrenceSurfaceCommand():
                linked(command.link_id)
                _position_index(
                    [edge for edge in links if edge.id != command.link_id], command.position
                )
            case RemoveOccurrenceSurfaceCommand():
                for entry in command.entries:
                    endpoint = _parse_ref_or_error(entry.endpoint_ref)
                    endpoints.update(
                        _context_refs(
                            db, viewer_id=viewer_id, context=entry.context, endpoint=endpoint
                        )
                    )
                    endpoints.add(linked(entry.link_id, endpoint))
                    graph_edges.require_unannotated_link(
                        db,
                        viewer_id=viewer_id,
                        edge=graph_adjacency.incident_link(
                            db, user_id=viewer_id, source=endpoint, link_id=entry.link_id
                        ),
                    )
            case RelinkSurfaceCommand():
                target = linked(command.link_id)
                destination = _parse_ref_or_error(command.destination_ref)
                if destination == target:
                    raise ApiError(
                        ApiErrorCode.E_INVALID_REQUEST, "A resource cannot be linked to itself"
                    )
                endpoints.update((target, destination))
                graph_edges.require_unannotated_link(
                    db,
                    viewer_id=viewer_id,
                    edge=graph_adjacency.incident_link(
                        db, user_id=viewer_id, source=source, link_id=command.link_id
                    ),
                )
                destination_links = graph_adjacency.ordered_edges(
                    db, user_id=viewer_id, source=destination
                )
                destination_links = [
                    edge
                    for edge in destination_links
                    if graph_adjacency.other_endpoint(edge, destination) != target
                ]
                _position_index(destination_links, command.position)
            case JoinNotesSurfaceCommand():
                ids = [edge.id for edge in links]
                if (
                    command.earlier_link_id not in ids
                    or command.later_link_id not in ids
                    or ids.index(command.later_link_id) != ids.index(command.earlier_link_id) + 1
                ):
                    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Join needs adjacent notes")
                earlier, later = linked(command.earlier_link_id), linked(command.later_link_id)
                _owned_paragraph(db, viewer_id=viewer_id, ref=earlier)
                _owned_paragraph(db, viewer_id=viewer_id, ref=later)
                if command.body_pm_json.get("type") != "paragraph":
                    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only paragraphs can be joined")
                bodies.update((earlier, later))
                owned_bodies.add(earlier)
                endpoints.add(later)
                graph_edges.require_unannotated_link(
                    db,
                    viewer_id=viewer_id,
                    edge=graph_adjacency.incident_link(
                        db, user_id=viewer_id, source=source, link_id=command.later_link_id
                    ),
                )
            case PasteOutlineSurfaceCommand():
                _position_index(links, command.position)
                root_path = endpoints.copy()
                paths: list[set[ResourceRef]] = []
                terminal: list[bool] = []
                for index, item in enumerate(command.items):
                    if item.parent_index is not None and item.parent_index >= index:
                        raise ApiError(
                            ApiErrorCode.E_INVALID_REQUEST,
                            "Outline parents must precede their children",
                        )
                    parent = item.parent_index
                    endpoint = (
                        source if parent is None else _outline_item_ref(command.items[parent])
                    )
                    ancestors = root_path if parent is None else paths[parent]
                    if parent is not None and (
                        not isinstance(command.items[parent], OutlineNote) or terminal[parent]
                    ):
                        raise ApiError(
                            ApiErrorCode.E_INVALID_REQUEST,
                            "Outline parents must be earlier copied notes",
                        )
                    ref = _outline_item_ref(item)
                    if ref == endpoint:
                        raise ApiError(
                            ApiErrorCode.E_INVALID_REQUEST, "A resource cannot be linked to itself"
                        )
                    if isinstance(item, OutlineNote):
                        if ref in new_refs:
                            raise ApiError(
                                ApiErrorCode.E_INVALID_REQUEST, "Outline note ids must be unique"
                            )
                        new_refs.add(ref)
                    else:
                        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)
                        if resource_link_mode(ref) != "direct":
                            raise ApiError(
                                ApiErrorCode.E_INVALID_REQUEST,
                                "Outline resources must be durable link endpoints",
                            )
                        endpoints.add(ref)
                    terminal.append(ref in ancestors)
                    paths.append(ancestors | {ref})
            case ReverseEditSurfaceCommand():
                receipt = db.scalar(
                    select(ResourceMutation).where(
                        ResourceMutation.id == command.receipt_id,
                        ResourceMutation.user_id == viewer_id,
                        ResourceMutation.effects_json.is_not(None),
                    )
                )
                if receipt is None or receipt.effects_json is None:
                    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Writing receipt not found")
                reverse = cast(dict[str, Any], receipt.effects_json)
                endpoints.update(_parse_ref_or_error(ref) for ref in reverse["after"]["orders"])
                bodies.update(_parse_ref_or_error(ref) for ref in reverse["after"]["bodies"])
                owned_bodies.update(bodies)
        for edit in request.body_edits:
            ref = _parse_ref_or_error(edit.ref)
            if ref in owned_bodies or ref in new_refs:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Body edits must be unique and not command-owned",
                )
            if ref.scheme != "note_block":
                _invalid_body_ref()
            note_bodies.get_note_block_for_owner_or_404(db, viewer_id, ref.id)
            owned_bodies.add(ref)
            bodies.add(ref)
        for ref in new_refs:
            if db.get(NoteBlock, ref.id) is not None:
                raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "New note id already exists")
        required = {(ref.uri, "links") for ref in endpoints} | {(ref.uri, "body") for ref in bodies}
        _validate_base_versions(
            db, viewer_id=viewer_id, source=source, request=request, required=required
        )
        before = _snapshot(db, viewer_id=viewer_id, endpoints=endpoints, bodies=bodies)
        if reverse is not None:
            current = _snapshot(
                db,
                viewer_id=viewer_id,
                endpoints={_parse_ref_or_error(ref) for ref in reverse["after"]["orders"]},
                bodies={_parse_ref_or_error(ref) for ref in reverse["after"]["bodies"]},
            )
            if current != reverse["after"]:
                _raise_surface_conflict(db, viewer_id=viewer_id, source=source)
        for edit in request.body_edits:
            _write_body(
                db, viewer_id=viewer_id, ref=_parse_ref_or_error(edit.ref), body=edit.body_pm_json
            )
        if reverse is not None:
            _restore(db, viewer_id=viewer_id, before=reverse["after"], after=reverse["before"])
        else:
            _apply_command(db, viewer_id=viewer_id, source=source, command=command)
        endpoints.update(new_refs)
        bodies.update(new_refs)
        after = _snapshot(db, viewer_id=viewer_id, endpoints=endpoints, bodies=bodies)
        # Generated resources survive undo. Their bodies are postimage guards, not deletion instructions.
        for ref in new_refs:
            before["bodies"][ref.uri] = after["bodies"][ref.uri]
            before["orders"][ref.uri] = []
        receipt_id = uuid4()
        refs = sorted(endpoints | bodies, key=lambda ref: ref.uri)
        inverse_lanes = {(ref, "links") for ref in after["orders"]} | {
            (ref, "body") for ref in after["bodies"]
        }
        response = ResourceSurfaceCommandOut(
            client_mutation_id=request.client_mutation_id,
            receipt_id=receipt_id,
            reverse_versions=[
                ResourceLaneVersionIn(
                    ref=uri,
                    lane=cast(Literal["body", "links"], lane),
                    version=versions.versions_for_ref(
                        db, viewer_id=viewer_id, ref=_parse_ref_or_error(uri)
                    ).get(lane, 1),
                )
                for uri, lane in sorted(inverse_lanes)
            ],
            nodes=_nodes(db, viewer_id=viewer_id, refs=refs),
            surfaces=[
                get_surface(db, viewer_id=viewer_id, source=ref)
                for ref in refs
                if resource_can_own_ordered_adjacency(ref)
            ],
        )
        db.add(
            ResourceMutation(
                id=receipt_id,
                user_id=viewer_id,
                mutation_scope=scope,
                client_mutation_id=request.client_mutation_id,
                request_hash=hashlib.sha256(request_bytes).hexdigest(),
                response_json=response.model_dump(mode="json"),
                effects_json={"before": before, "after": after},
            )
        )
        db.commit()
        return response

    return retry_serializable(db, "execute_resource_surface_command", op)


def _invalid_body_ref() -> None:
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only note bodies can be edited")


def _owned_paragraph(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    if ref.scheme != "note_block":
        _invalid_body_ref()
    block = note_bodies.get_note_block_for_owner_or_404(db, viewer_id, ref.id)
    if block.body_pm_json.get("type") != "paragraph":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only paragraphs support this command")


def _write_body(db: Session, *, viewer_id: UUID, ref: ResourceRef, body: dict[str, Any]) -> None:
    note_bodies.upsert_note_body(db, viewer_id=viewer_id, block_id=ref.id, body_pm_json=body)
    enqueue_note_reindex(db, note_block_id=ref.id, reason="surface_edit")


def _position_index(links: Sequence[ResourceEdge], position: SurfacePosition) -> int:
    if not isinstance(position, SurfaceAfterPosition):
        return 0
    for index, edge in enumerate(links):
        if edge.id == position.link_id:
            return index + 1
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Position anchor is not in the endpoint")


def _place(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    link_id: UUID,
    position: SurfacePosition | Literal["end"],
) -> None:
    links = [
        edge
        for edge in graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)
        if edge.id != link_id
    ]
    index = len(links) if position == "end" else _position_index(links, position)
    ids = [edge.id for edge in links]
    ids.insert(index, link_id)
    graph_adjacency.reorder_links(db, user_id=viewer_id, source=source, link_ids=ids)


def _apply_command(db: Session, *, viewer_id: UUID, source: ResourceRef, command: object) -> None:
    match command:
        case InsertNoteSurfaceCommand():
            insert_note_occurrence_without_commit(
                db,
                viewer_id=viewer_id,
                source=source,
                note_id=command.note_id,
                body_pm_json=command.body_pm_json,
                position=command.position,
                reindex_reason="surface_insert_note",
            )
        case SplitNoteSurfaceCommand():
            edge = graph_adjacency.incident_link(
                db, user_id=viewer_id, source=source, link_id=command.link_id
            )
            _write_body(
                db,
                viewer_id=viewer_id,
                ref=graph_adjacency.other_endpoint(edge, source),
                body=command.left_body_pm_json,
            )
            insert_note_occurrence_without_commit(
                db,
                viewer_id=viewer_id,
                source=source,
                note_id=command.note_id,
                body_pm_json=command.right_body_pm_json,
                position=SurfaceAfterPosition(kind="after", link_id=edge.id),
                reindex_reason="surface_split_note",
            )
        case InsertResourceSurfaceCommand():
            write = graph_adjacency.insert_link(
                db, user_id=viewer_id, source=source, target=_parse_ref_or_error(command.target_ref)
            )
            if write.created:
                _place(
                    db,
                    viewer_id=viewer_id,
                    source=source,
                    link_id=write.edge.id,
                    position=command.position,
                )
        case MoveOccurrenceSurfaceCommand():
            _place(
                db,
                viewer_id=viewer_id,
                source=source,
                link_id=command.link_id,
                position=command.position,
            )
        case RemoveOccurrenceSurfaceCommand():
            for link_id in dict.fromkeys(entry.link_id for entry in command.entries):
                graph_edges.delete_edge(db, viewer_id=viewer_id, edge_id=link_id)
        case RelinkSurfaceCommand():
            edge = graph_adjacency.incident_link(
                db, user_id=viewer_id, source=source, link_id=command.link_id
            )
            target = graph_adjacency.other_endpoint(edge, source)
            destination = _parse_ref_or_error(command.destination_ref)
            if destination != source:
                graph_edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
            write = graph_adjacency.insert_link(
                db, user_id=viewer_id, source=destination, target=target
            )
            _place(
                db,
                viewer_id=viewer_id,
                source=destination,
                link_id=write.edge.id,
                position=command.position,
            )
        case JoinNotesSurfaceCommand():
            edge = graph_adjacency.incident_link(
                db, user_id=viewer_id, source=source, link_id=command.earlier_link_id
            )
            _write_body(
                db,
                viewer_id=viewer_id,
                ref=graph_adjacency.other_endpoint(edge, source),
                body=command.body_pm_json,
            )
            graph_edges.delete_edge(db, viewer_id=viewer_id, edge_id=command.later_link_id)
        case PasteOutlineSurfaceCommand():
            position = command.position
            for item in command.items:
                endpoint = (
                    source
                    if item.parent_index is None
                    else _outline_item_ref(command.items[item.parent_index])
                )
                ref = _outline_item_ref(item)
                item_position: SurfacePosition | Literal["end"] = (
                    position if item.parent_index is None else "end"
                )
                if isinstance(item, OutlineNote):
                    insert_note_occurrence_without_commit(
                        db,
                        viewer_id=viewer_id,
                        source=endpoint,
                        note_id=item.note_id,
                        body_pm_json=item.body_pm_json,
                        position=item_position,
                        reindex_reason="surface_paste",
                    )
                else:
                    write = graph_adjacency.insert_link(
                        db, user_id=viewer_id, source=endpoint, target=ref
                    )
                    if write.created:
                        _place(
                            db,
                            viewer_id=viewer_id,
                            source=endpoint,
                            link_id=write.edge.id,
                            position=item_position,
                        )
                if item.parent_index is None:
                    link = next(
                        edge
                        for edge in graph_adjacency.ordered_edges(
                            db, user_id=viewer_id, source=source
                        )
                        if graph_adjacency.other_endpoint(edge, source) == ref
                    )
                    position = SurfaceAfterPosition(kind="after", link_id=link.id)
        case _:
            raise AssertionError("unreachable surface command")


def _outline_item_ref(item: OutlineItem) -> ResourceRef:
    return (
        note_bodies.note_ref(item.note_id)
        if isinstance(item, OutlineNote)
        else _parse_ref_or_error(item.target_ref)
    )


def insert_note_occurrence_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    position: SurfacePosition | Literal["end"],
    reindex_reason: str,
) -> NoteBlock:
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    if db.get(NoteBlock, note_id) is not None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "New note id already exists")
    note = note_bodies.upsert_note_body(
        db, viewer_id=viewer_id, block_id=note_id, body_pm_json=body_pm_json
    )
    enqueue_note_reindex(db, note_block_id=note_id, reason=reindex_reason)
    write = graph_adjacency.insert_link(
        db, user_id=viewer_id, source=source, target=note_bodies.note_ref(note_id)
    )
    _place(db, viewer_id=viewer_id, source=source, link_id=write.edge.id, position=position)
    return note


def _snapshot(
    db: Session, *, viewer_id: UUID, endpoints: set[ResourceRef], bodies: set[ResourceRef]
) -> dict[str, Any]:
    links: dict[str, Any] = {}
    orders: dict[str, Any] = {}
    for ref in sorted(endpoints, key=lambda ref: ref.uri):
        rows = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=ref)
        orders[ref.uri] = []
        for edge in rows:
            state = graph_adjacency.link_state(db, user_id=viewer_id, source=ref, link_id=edge.id)
            orders[ref.uri].append(
                {
                    "id": str(edge.id),
                    "order_key": state.order_key if state else None,
                    "state": deepcopy(state.state) if state else {},
                }
            )
            links[str(edge.id)] = {
                "source": f"{edge.source_scheme}:{edge.source_id}",
                "target": f"{edge.target_scheme}:{edge.target_id}",
                "created_at": edge.created_at.isoformat(),
            }
    return {
        "orders": orders,
        "links": links,
        "bodies": {
            ref.uri: deepcopy(
                note_bodies.get_note_block_for_owner_or_404(db, viewer_id, ref.id).body_pm_json
            )
            for ref in sorted(bodies, key=lambda ref: ref.uri)
        },
    }


def _restore(
    db: Session, *, viewer_id: UUID, before: dict[str, Any], after: dict[str, Any]
) -> None:
    for link_id in before["links"].keys() - after["links"].keys():
        graph_edges.delete_edge(db, viewer_id=viewer_id, edge_id=UUID(link_id))
    for link_id in after["links"].keys() - before["links"].keys():
        effect = after["links"][link_id]
        a, b = _parse_ref_or_error(effect["source"]), _parse_ref_or_error(effect["target"])
        graph_edges.restore_link(
            db,
            viewer_id=viewer_id,
            source=a,
            target=b,
            link_id=UUID(link_id),
            created_at=datetime.fromisoformat(effect["created_at"]),
        )
    for uri, rows in after["orders"].items():
        if rows == before["orders"].get(uri):
            continue
        ref = _parse_ref_or_error(uri)
        if not resource_can_own_ordered_adjacency(ref) and ref.scheme != "conversation":
            continue
        graph_adjacency.restore_endpoint_order(
            db,
            user_id=viewer_id,
            source=ref,
            entries=[(UUID(row["id"]), row["order_key"], row["state"]) for row in rows],
        )
    for uri, body in after["bodies"].items():
        if body != before["bodies"].get(uri):
            _write_body(db, viewer_id=viewer_id, ref=_parse_ref_or_error(uri), body=body)


def _validate_base_versions(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    request: ResourceSurfaceCommandRequest,
    required: set[tuple[str, str]],
) -> None:
    supplied: dict[tuple[str, str], int] = {}
    for base in request.base_versions:
        ref = _parse_ref_or_error(base.ref)
        key = (ref.uri, base.lane)
        if key in supplied:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Base versions must be unique")
        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)
        supplied[key] = base.version
        current = db.scalar(
            select(ResourceVersion.version).where(
                ResourceVersion.user_id == viewer_id,
                ResourceVersion.resource_scheme == ref.scheme,
                ResourceVersion.resource_id == ref.id,
                ResourceVersion.lane == base.lane,
            )
        )
        if (1 if current is None else current) != base.version:
            _raise_surface_conflict(db, viewer_id=viewer_id, source=source)
    if not required <= supplied.keys():
        _raise_surface_conflict(db, viewer_id=viewer_id, source=source)
    if supplied.keys() != required:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Base versions must match the command lanes")


def _raise_surface_conflict(db: Session, *, viewer_id: UUID, source: ResourceRef) -> None:
    raise ConflictError(
        ApiErrorCode.E_RESOURCE_CONFLICT,
        "Resource surface version is stale",
        details={
            "surface": get_surface(db, viewer_id=viewer_id, source=source).model_dump(mode="json")
        },
    )


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    return resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]


def _note_rows(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> dict[UUID, NoteBlock]:
    note_ids = [ref.id for ref in refs if ref.scheme == "note_block"]
    if not note_ids:
        return {}
    rows = db.scalars(
        select(NoteBlock).where(NoteBlock.user_id == viewer_id, NoteBlock.id.in_(note_ids))
    ).all()
    return {row.id: row for row in rows}


def _target_content(
    ref: ResourceRef, *, note_rows: dict[UUID, NoteBlock]
) -> NoteBodySurfaceContent | ResourceSummarySurfaceContent:
    if ref.scheme != "note_block":
        return ResourceSummarySurfaceContent(kind="resource_summary")
    note = note_rows.get(ref.id)
    if note is None:
        raise AssertionError("justify-defect: visible note surface target has no note body")
    return NoteBodySurfaceContent(
        kind="note_body", body_pm_json=note.body_pm_json, body_text=note.body_text
    )


def resource_items_out(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> list[ResourceItemOut]:
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=refs)
    missing = {ref.uri for ref, item in zip(refs, resolved, strict=True) if item.missing}
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris=missing,
    )
    version_rows = db.execute(
        select(
            ResourceVersion.resource_scheme,
            ResourceVersion.resource_id,
            ResourceVersion.lane,
            ResourceVersion.version,
        ).where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme.in_({ref.scheme for ref in refs}),
            ResourceVersion.resource_id.in_({ref.id for ref in refs}),
        )
    ).all()
    version_by_ref: dict[str, dict[str, int]] = {ref.uri: {} for ref in refs}
    for scheme, resource_id, lane, version in version_rows:
        ref = ResourceRef(scheme=cast(ResourceScheme, scheme), id=resource_id)
        if ref.uri in version_by_ref:
            version_by_ref[ref.uri][str(lane)] = int(version)
    return [
        _resource_item_out(
            ref=ref,
            resolved=item,
            activation=activations[ref.uri],
            version_by_lane=version_by_ref[ref.uri],
        )
        for ref, item in zip(refs, resolved, strict=True)
    ]


def _resource_item_out(
    *,
    ref: ResourceRef,
    resolved: ResolvedResource,
    activation: ResourceActivationOut,
    version_by_lane: dict[str, int],
) -> ResourceItemOut:
    capability = capability_for_ref(ref)
    version_by_lane.setdefault("links", 1)
    if ref.scheme in {"page", "note_block"}:
        for lane in ("links", "title" if ref.scheme == "page" else "body"):
            version_by_lane.setdefault(lane, 1)
    return ResourceItemOut(
        ref=ref.uri,
        scheme=ref.scheme,
        id=ref.id,
        label=resolved.label,
        summary=resolved.summary,
        route=activation.href if activation.kind == "route" else None,
        activation=activation,
        missing=resolved.missing,
        capabilities=ResourceItemCapabilitiesOut(
            sharing=capability.sharing,
            library_placement=capability.library_placement,
            link_mode=capability.link_mode,
            attachable=capability.attachable,
            chat_subject=capability.chat_subject,
            readable=capability.readable,
            inspectable=capability.inspectable,
            citable_result_type=capability.citable_result_type,
            citation_output_source=capability.citation_output_source,
            app_search_scope=capability.app_search_scope,
            conversation_search_scope=capability.conversation_search_scope,
            prompt_render=capability.prompt_render,
            expansion_policy=capability.expansion_policy,
            expandable=capability.expandable,
            adjacency_source=capability.adjacency_source,
            adjacency_target=capability.adjacency_target,
        ),
        version_by_lane=version_by_lane,
    )


def _parse_ref_or_error(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource ref is invalid")
    return parsed
