from __future__ import annotations

from typing import cast
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge, ResourceViewState
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_items import (
    ResourceItemCapabilitiesOut,
    ResourceItemOut,
    ResourceSurfaceItemOut,
    ResourceSurfaceMutationOut,
    ResourceSurfaceMutationRequest,
    ResourceSurfaceOut,
    ResourceUserRelationPolicyOut,
)
from nexus.services.resource_graph import adjacency as graph_adjacency
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import (
    assert_ref_visible,
    resolve_ref,
)
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability_for_ref
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)


def get_surface(db: Session, *, viewer_id: UUID, source: ResourceRef) -> ResourceSurfaceOut:
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    source_item = resource_item_out(db, viewer_id=viewer_id, ref=source)
    rows = (
        db.execute(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "user",
                ResourceEdge.kind == "context",
                ResourceEdge.source_scheme == source.scheme,
                ResourceEdge.source_id == source.id,
                ResourceEdge.source_order_key.is_not(None),
                ResourceEdge.ordinal.is_(None),
                ResourceEdge.snapshot.is_(None),
            )
            .order_by(ResourceEdge.source_order_key.asc(), ResourceEdge.id.asc())
        )
        .scalars()
        .all()
    )
    states = _view_states_by_edge(db, viewer_id=viewer_id, edge_ids=[row.id for row in rows])
    return ResourceSurfaceOut(
        source=source_item,
        ordered_items=[
            ResourceSurfaceItemOut(
                edge_id=row.id,
                target=resource_item_out(
                    db,
                    viewer_id=viewer_id,
                    ref=ResourceRef(
                        scheme=cast(ResourceScheme, row.target_scheme),
                        id=row.target_id,
                    ),
                ),
                source_order_key=str(row.source_order_key),
                view_state=states.get(row.id),
            )
            for row in rows
        ],
    )


def replace_surface(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    request: ResourceSurfaceMutationRequest,
) -> ResourceSurfaceMutationOut:
    def op() -> ResourceSurfaceMutationOut:
        scope = f"resource:{source.uri}:outgoing_edges"
        request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=True))
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return ResourceSurfaceMutationOut.model_validate(replay)

        assert_ref_visible(db, viewer_id=viewer_id, ref=source)
        for base in request.base_versions:
            ref = _parse_ref_or_error(base.ref)
            version = versions.ensure_version(db, viewer_id=viewer_id, ref=ref, lane=base.lane)
            if version.version != base.version:
                raise ConflictError(
                    ApiErrorCode.E_NOTE_CONFLICT,
                    "Resource version is stale",
                    details={
                        "current": resource_item_out(db, viewer_id=viewer_id, ref=ref).model_dump(
                            mode="json", by_alias=True
                        )
                    },
                )

        targets = [_parse_ref_or_error(item.ref) for item in request.ordered_targets]
        if len({target.uri for target in targets}) != len(targets):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Ordered targets contain duplicates")

        changed_edge_ids = graph_adjacency.replace_ordered_targets(
            db,
            user_id=viewer_id,
            source=source,
            targets=[
                graph_adjacency.OrderedTarget(
                    target=target,
                    source_order_key=item.source_order_key,
                )
                for item, target in zip(request.ordered_targets, targets, strict=True)
            ],
        )

        versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="outgoing_edges")
        changed_lanes = {source.uri: versions.versions_for_ref(db, viewer_id=viewer_id, ref=source)}
        updated_at = db.scalar(select(func.now()))
        if updated_at is None:
            raise AssertionError("database clock returned no timestamp")
        response = ResourceSurfaceMutationOut(
            client_mutation_id=request.client_mutation_id,
            surface=get_surface(db, viewer_id=viewer_id, source=source),
            changed_edge_ids=changed_edge_ids,
            updated_at=updated_at,
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json", by_alias=True),
            changed_lanes=changed_lanes,
        )
        db.commit()
        return response

    return retry_serializable(db, "replace_resource_surface", op)


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    resolved = resolve_ref(db, viewer_id=viewer_id, ref=ref)
    capability = capability_for_ref(ref)
    activation = resource_activation_for_ref(
        db,
        viewer_id=viewer_id,
        ref=ref,
        missing=resolved.missing,
    )
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
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref),
    )


def _view_states_by_edge(
    db: Session, *, viewer_id: UUID, edge_ids: list[UUID]
) -> dict[UUID, dict[str, object]]:
    if not edge_ids:
        return {}
    rows = db.execute(
        select(ResourceViewState.edge_id, ResourceViewState.state).where(
            ResourceViewState.user_id == viewer_id,
            ResourceViewState.edge_id.in_(edge_ids),
        )
    ).all()
    return {edge_id: state for edge_id, state in rows if edge_id is not None}


def _parse_ref_or_error(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource ref is invalid")
    return parsed
