from __future__ import annotations

import hashlib
import json
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceMutation
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.resource_items import (
    ResourceBodyMutationOut,
    ResourceBodyMutationRequest,
    ResourceTitleMutationOut,
    ResourceTitleMutationRequest,
)
from nexus.services import note_bodies
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import surfaces, versions


def update_title(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    request: ResourceTitleMutationRequest,
) -> ResourceTitleMutationOut:
    if ref.scheme != "page":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only pages have mutable titles")

    def op() -> ResourceTitleMutationOut:
        page = db.scalar(select(Page).where(Page.id == ref.id, Page.user_id == viewer_id))
        if page is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
        scope = f"resource:{ref.uri}:title"
        replay = _replay(db, viewer_id, scope, request.client_mutation_id, request)
        if replay is not None:
            return ResourceTitleMutationOut.model_validate(replay.response_json)

        _require_base_version(db, viewer_id=viewer_id, ref=ref, lane="title", request=request)
        if page.title != request.title:
            page.title = request.title
            page.updated_at = func.now()
            versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane="title")
        updated_at = db.scalar(select(func.now()))
        if updated_at is None:
            raise AssertionError("database clock returned no timestamp")
        response = ResourceTitleMutationOut(
            client_mutation_id=request.client_mutation_id,
            item=surfaces.resource_item_out(db, viewer_id=viewer_id, ref=ref),
            versions={ref.uri: versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref)},
            updated_at=updated_at,
        )
        _record(
            db, viewer_id, scope, request.client_mutation_id, request, response.versions, response
        )
        db.commit()
        return response

    return retry_serializable(db, "update_resource_title", op)


def update_body(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    request: ResourceBodyMutationRequest,
) -> ResourceBodyMutationOut:
    if ref.scheme != "note_block":
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only notes have mutable bodies")

    def op() -> ResourceBodyMutationOut:
        existing = db.get(NoteBlock, ref.id)
        if existing is not None and existing.user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
        scope = f"resource:{ref.uri}:body"
        replay = _replay(db, viewer_id, scope, request.client_mutation_id, request)
        if replay is not None:
            return ResourceBodyMutationOut.model_validate(replay.response_json)

        if existing is not None:
            _require_base_version(db, viewer_id=viewer_id, ref=ref, lane="body", request=request)
        block = note_bodies.upsert_note_body(
            db,
            viewer_id=viewer_id,
            block_id=ref.id,
            body_pm_json=request.body_pm_json,
        )
        enqueue_note_reindex(db, note_block_id=block.id, reason="note_body")
        updated_at = db.scalar(select(func.now()))
        if updated_at is None:
            raise AssertionError("database clock returned no timestamp")
        response = ResourceBodyMutationOut(
            client_mutation_id=request.client_mutation_id,
            item=surfaces.resource_item_out(db, viewer_id=viewer_id, ref=ref),
            body_pm_json=block.body_pm_json,
            body_text=block.body_text,
            versions={ref.uri: versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref)},
            updated_at=updated_at,
        )
        _record(
            db, viewer_id, scope, request.client_mutation_id, request, response.versions, response
        )
        db.commit()
        return response

    return retry_serializable(db, "update_resource_body", op)


def _require_base_version(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    lane: str,
    request: ResourceTitleMutationRequest | ResourceBodyMutationRequest,
) -> None:
    matches = [base for base in request.base_versions if base.ref == ref.uri and base.lane == lane]
    if len(matches) != 1:
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Resource version base is required",
            details={
                "current": surfaces.resource_item_out(db, viewer_id=viewer_id, ref=ref).model_dump(
                    mode="json", by_alias=True
                )
            },
        )
    current = versions.ensure_version(db, viewer_id=viewer_id, ref=ref, lane=lane)
    if current.version != matches[0].version:
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Resource version is stale",
            details={
                "current": surfaces.resource_item_out(db, viewer_id=viewer_id, ref=ref).model_dump(
                    mode="json", by_alias=True
                )
            },
        )


def _replay(
    db: Session,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request: object,
) -> ResourceMutation | None:
    replay = db.scalar(
        select(ResourceMutation).where(
            ResourceMutation.user_id == viewer_id,
            ResourceMutation.mutation_scope == scope,
            ResourceMutation.client_mutation_id == client_mutation_id,
        )
    )
    if replay is None:
        return None
    if replay.request_hash != _request_hash(request):
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Resource mutation id was reused with a different request",
        )
    return replay


def _record(
    db: Session,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request: object,
    changed_lanes: dict[str, dict[str, int]],
    response: ResourceTitleMutationOut | ResourceBodyMutationOut,
) -> None:
    db.add(
        ResourceMutation(
            user_id=viewer_id,
            mutation_scope=scope,
            client_mutation_id=client_mutation_id,
            request_hash=_request_hash(request),
            changed_lanes=changed_lanes,
            response_json=response.model_dump(mode="json", by_alias=True),
        )
    )


def _request_hash(request: object) -> str:
    encoded = json.dumps(
        request.model_dump(mode="json", by_alias=True)
        if hasattr(request, "model_dump")
        else request,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
