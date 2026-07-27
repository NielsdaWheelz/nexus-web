from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge, ResourceVersion
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_items import (
    InsertNoteSurfaceCommand,
    InsertResourceSurfaceCommand,
    MoveOccurrenceSurfaceCommand,
    NoteBodySurfaceContent,
    PageTitleSurfaceContent,
    RemoveOccurrenceSurfaceCommand,
    ResourceActivationOut,
    ResourceItemCapabilitiesOut,
    ResourceItemOut,
    ResourceSummarySurfaceContent,
    ResourceSurfaceCommandOut,
    ResourceSurfaceCommandRequest,
    ResourceSurfaceNode,
    ResourceSurfaceOccurrence,
    ResourceSurfaceOut,
    ResourceUserRelationPolicyOut,
    SplitNoteSurfaceCommand,
    SurfaceAfterPosition,
    SurfacePosition,
)
from nexus.services import note_bodies
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import adjacency as graph_adjacency
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
)
from nexus.services.resource_items.routing import (
    resource_activation_for_ref,
    resource_activations_for_refs,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)


def get_surface(db: Session, *, viewer_id: UUID, source: ResourceRef) -> ResourceSurfaceOut:
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own a surface")

    edges = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)
    refs = [source, *[_edge_target_ref(edge) for edge in edges]]
    items = resource_items_out(db, viewer_id=viewer_id, refs=refs)
    items_by_ref = {item.ref: item for item in items}
    note_rows = _note_rows(db, viewer_id=viewer_id, refs=refs)
    source_item = items_by_ref[source.uri]
    return ResourceSurfaceOut(
        source=ResourceSurfaceNode(
            item=source_item,
            content=_source_content(source=source, item=source_item, note_rows=note_rows),
        ),
        ordered_items=[
            ResourceSurfaceOccurrence(
                occurrence_id=edge.id,
                target=ResourceSurfaceNode(
                    item=items_by_ref[_edge_target_ref(edge).uri],
                    content=_target_content(_edge_target_ref(edge), note_rows=note_rows),
                ),
            )
            for edge in edges
        ],
    )


def execute_surface_command(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    request: ResourceSurfaceCommandRequest,
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

        edges = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)
        required = {(source.uri, "outgoing_edges")}
        if isinstance(request.command, SplitNoteSurfaceCommand):
            edge = graph_adjacency.ordered_edge_for_occurrence(
                db,
                user_id=viewer_id,
                source=source,
                occurrence_id=request.command.occurrence_id,
            )
            if edge.target_scheme != "note_block":
                raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only note occurrences can be split")
            required.add((ResourceRef(scheme="note_block", id=edge.target_id).uri, "body"))
        _validate_base_versions(
            db,
            viewer_id=viewer_id,
            source=source,
            request=request,
            required=required,
        )

        changed_refs = _apply_command(
            db,
            viewer_id=viewer_id,
            source=source,
            command=request.command,
            edges=edges,
        )
        response = ResourceSurfaceCommandOut(
            client_mutation_id=request.client_mutation_id,
            surface=get_surface(db, viewer_id=viewer_id, source=source),
        )
        changed_lanes = {
            ref.uri: versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref)
            for ref in changed_refs | {source}
        }
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json"),
            changed_lanes=changed_lanes,
        )
        db.commit()
        return response

    return retry_serializable(db, "execute_resource_surface_command", op)


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=[ref])[0]
    activation = resource_activation_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ref,
        missing=resolved.missing,
    )
    return _resource_item_out(
        ref=ref,
        resolved=resolved,
        activation=activation,
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref),
    )


def _apply_command(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    command: object,
    edges: list[ResourceEdge],
) -> set[ResourceRef]:
    match command:
        case InsertNoteSurfaceCommand():
            note = insert_note_occurrence_without_commit(
                db,
                viewer_id=viewer_id,
                source=source,
                note_id=command.note_id,
                body_pm_json=command.body_pm_json,
                position=command.position,
                reindex_reason="surface_insert_note",
            )
            return {ResourceRef(scheme="note_block", id=note.id)}
        case SplitNoteSurfaceCommand():
            left_edge = graph_adjacency.ordered_edge_for_occurrence(
                db,
                user_id=viewer_id,
                source=source,
                occurrence_id=command.occurrence_id,
            )
            if left_edge.target_scheme != "note_block":
                raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only note occurrences can be split")
            _require_new_note_id(db, viewer_id=viewer_id, note_id=command.note_id)
            right_position = SurfaceAfterPosition(
                kind="after",
                occurrence_id=left_edge.id,
            )
            # Fail closed before changing either note body. The shared insertion
            # capability validates again at its own boundary.
            _insertion_index(edges, right_position)
            left_ref = ResourceRef(scheme="note_block", id=left_edge.target_id)
            left = note_bodies.upsert_note_body(
                db,
                viewer_id=viewer_id,
                block_id=left_ref.id,
                body_pm_json=command.left_body_pm_json,
            )
            enqueue_note_reindex(db, note_block_id=left.id, reason="surface_split_note")
            right = insert_note_occurrence_without_commit(
                db,
                viewer_id=viewer_id,
                source=source,
                note_id=command.note_id,
                body_pm_json=command.right_body_pm_json,
                position=right_position,
                reindex_reason="surface_split_note",
            )
            return {left_ref, ResourceRef(scheme="note_block", id=right.id)}
        case InsertResourceSurfaceCommand():
            target = _parse_ref_or_error(command.target_ref)
            insertion_index = _insertion_index(edges, command.position)
            edge = graph_adjacency.insert_ordered_target(
                db,
                user_id=viewer_id,
                source=source,
                target=target,
            )
            graph_adjacency.reorder_ordered_edges(
                db,
                user_id=viewer_id,
                source=source,
                edges=_insert_at_index(edges, edge, insertion_index),
            )
            versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="outgoing_edges")
            return set()
        case MoveOccurrenceSurfaceCommand():
            edge = graph_adjacency.ordered_edge_for_occurrence(
                db,
                user_id=viewer_id,
                source=source,
                occurrence_id=command.occurrence_id,
            )
            remaining = [candidate for candidate in edges if candidate.id != edge.id]
            reordered = _insert_at(remaining, edge, command.position)
            if [candidate.id for candidate in reordered] == [candidate.id for candidate in edges]:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST, "Occurrence is already at that position"
                )
            graph_adjacency.reorder_ordered_edges(
                db,
                user_id=viewer_id,
                source=source,
                edges=reordered,
            )
            versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="outgoing_edges")
            return set()
        case RemoveOccurrenceSurfaceCommand():
            graph_adjacency.remove_ordered_edge(
                db,
                user_id=viewer_id,
                source=source,
                occurrence_id=command.occurrence_id,
            )
            graph_adjacency.reorder_ordered_edges(
                db,
                user_id=viewer_id,
                source=source,
                edges=graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source),
            )
            versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="outgoing_edges")
            return set()
        case _:
            raise AssertionError("unreachable surface command")


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
        if (1 if current is None else int(current)) != base.version:
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


def _insert_at(
    edges: Sequence[ResourceEdge], edge: ResourceEdge, position: SurfacePosition
) -> list[ResourceEdge]:
    return _insert_at_index(edges, edge, _insertion_index(edges, position))


def _insertion_index(edges: Sequence[ResourceEdge], position: SurfacePosition) -> int:
    if not isinstance(position, SurfaceAfterPosition):
        return 0
    for index, candidate in enumerate(edges):
        if candidate.id == position.occurrence_id:
            return index + 1
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Surface position is not in the source")


def _insert_at_index(
    edges: Sequence[ResourceEdge],
    edge: ResourceEdge,
    insertion_index: int,
) -> list[ResourceEdge]:
    ordered = list(edges)
    ordered.insert(insertion_index, edge)
    return ordered


def insert_note_occurrence_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    note_id: UUID,
    body_pm_json: dict[str, object],
    position: SurfacePosition | Literal["end"],
    reindex_reason: str,
) -> NoteBlock:
    """Create one note and place it through the canonical surface write seam."""

    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own a surface")
    edges = graph_adjacency.ordered_edges(db, user_id=viewer_id, source=source)
    insertion_index = len(edges) if position == "end" else _insertion_index(edges, position)
    _require_new_note_id(db, viewer_id=viewer_id, note_id=note_id)
    note = note_bodies.upsert_note_body(
        db,
        viewer_id=viewer_id,
        block_id=note_id,
        body_pm_json=body_pm_json,
    )
    enqueue_note_reindex(db, note_block_id=note.id, reason=reindex_reason)
    edge = graph_adjacency.insert_ordered_target(
        db,
        user_id=viewer_id,
        source=source,
        target=ResourceRef(scheme="note_block", id=note.id),
    )
    graph_adjacency.reorder_ordered_edges(
        db,
        user_id=viewer_id,
        source=source,
        edges=_insert_at_index(edges, edge, insertion_index),
    )
    versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="outgoing_edges")
    return note


def _require_new_note_id(db: Session, *, viewer_id: UUID, note_id: UUID) -> None:
    existing = db.get(NoteBlock, note_id)
    if existing is not None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "New note id already exists")


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


def _source_content(
    *, source: ResourceRef, item: ResourceItemOut, note_rows: dict[UUID, NoteBlock]
) -> PageTitleSurfaceContent | NoteBodySurfaceContent:
    if source.scheme == "page":
        return PageTitleSurfaceContent(kind="page_title", title=item.label)
    if source.scheme == "note_block":
        note = note_rows.get(source.id)
        if note is None:
            raise AssertionError("justify-defect: visible note surface source has no note body")
        return NoteBodySurfaceContent(
            kind="note_body", body_pm_json=note.body_pm_json, body_text=note.body_text
        )
    raise AssertionError("justify-defect: only adjacency sources can project a surface")


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
            user_relation=ResourceUserRelationPolicyOut(
                user_link_source=capability.user_relation.user_link_source,
                user_link_target=capability.user_relation.user_link_target,
                note_reference_target=capability.user_relation.note_reference_target,
            ),
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


def _edge_target_ref(edge: ResourceEdge) -> ResourceRef:
    return ResourceRef(scheme=cast(ResourceScheme, edge.target_scheme), id=edge.target_id)


def _parse_ref_or_error(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource ref is invalid")
    return parsed
