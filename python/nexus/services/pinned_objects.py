"""Pinned-navigation CRUD.

Pins reference a resource by ``(object_type, object_id)`` (a scheme + UUID —
the same grammar as :class:`~nexus.services.resource_graph.refs.ResourceRef`)
and hydrate through ``resource_items.surfaces.resource_item_out``, the single
manifest-assembly point every other resource-item consumer uses. Pins do not
route through the (deleted) ObjectRef hydrators."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import PinnedResource
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.resource_items import ObjectRef, PinnedResourceOut
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items.surfaces import resource_item_out


@dataclass(frozen=True)
class PinObjectRefInput:
    object_ref: ObjectRef
    surface_key: str = "navbar"
    order_key: str | None = None


@dataclass(frozen=True)
class UpdatePinnedObjectRefPatch:
    surface_key: str | None = None
    order_key: str | None = None


def _ref_for_pin(object_type: str, object_id: UUID) -> ResourceRef:
    return ResourceRef(scheme=cast(ResourceScheme, object_type), id=object_id)


def list_pinned_object_refs(
    db: Session,
    viewer_id: UUID,
    *,
    surface_key: str = "navbar",
) -> list[PinnedResourceOut]:
    pins = db.scalars(
        select(PinnedResource)
        .where(
            PinnedResource.user_id == viewer_id,
            PinnedResource.surface_key == surface_key,
            PinnedResource.deleted_at.is_(None),
        )
        .order_by(
            PinnedResource.order_key.asc(),
            PinnedResource.created_at.asc(),
            PinnedResource.id.asc(),
        )
    ).all()
    return [_pinned_out(db, viewer_id, pin) for pin in pins]


def _commit_pin_or_conflict(db: Session) -> None:
    """Commit a pinned-ref mutation, mapping the unique-pin constraint to a typed conflict."""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        constraint_name = integrity_constraint_name(exc)
        if constraint_name == "uix_user_pinned_objects_surface_ref" or (
            constraint_name is None and "uix_user_pinned_objects_surface_ref" in str(exc.orig)
        ):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object ref is already pinned") from exc
        raise


def pin_object_ref(
    db: Session,
    viewer_id: UUID,
    pin_input: PinObjectRefInput,
) -> PinnedResourceOut:
    assert_ref_visible(
        db,
        viewer_id=viewer_id,
        ref=_ref_for_pin(pin_input.object_ref.object_type, pin_input.object_ref.object_id),
    )
    existing = db.scalar(
        select(PinnedResource).where(
            PinnedResource.user_id == viewer_id,
            PinnedResource.surface_key == pin_input.surface_key,
            PinnedResource.object_type == pin_input.object_ref.object_type,
            PinnedResource.object_id == pin_input.object_ref.object_id,
            PinnedResource.deleted_at.is_(None),
        )
    )
    if existing is not None:
        if pin_input.order_key is not None:
            existing.order_key = pin_input.order_key
            existing.updated_at = func.now()
            db.commit()
            db.refresh(existing)
        return _pinned_out(db, viewer_id, existing)

    pin = PinnedResource(
        user_id=viewer_id,
        object_type=pin_input.object_ref.object_type,
        object_id=pin_input.object_ref.object_id,
        surface_key=pin_input.surface_key,
        order_key=pin_input.order_key or _next_pin_order_key(db, viewer_id, pin_input.surface_key),
    )
    db.add(pin)
    _commit_pin_or_conflict(db)
    db.refresh(pin)
    return _pinned_out(db, viewer_id, pin)


def update_pinned_object_ref(
    db: Session,
    viewer_id: UUID,
    pin_id: UUID,
    patch: UpdatePinnedObjectRefPatch,
) -> PinnedResourceOut:
    pin = db.get(PinnedResource, pin_id)
    if pin is None or pin.user_id != viewer_id or pin.deleted_at is not None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Pinned object ref not found")
    if patch.surface_key is not None:
        pin.surface_key = patch.surface_key
    if patch.order_key is not None:
        pin.order_key = patch.order_key
    pin.updated_at = func.now()
    _commit_pin_or_conflict(db)
    db.refresh(pin)
    return _pinned_out(db, viewer_id, pin)


def unpin_object_ref(db: Session, viewer_id: UUID, pin_id: UUID) -> None:
    pin = db.get(PinnedResource, pin_id)
    if pin is None or pin.user_id != viewer_id or pin.deleted_at is not None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Pinned object ref not found")
    db.execute(delete(PinnedResource).where(PinnedResource.id == pin.id))
    db.commit()


def _next_pin_order_key(db: Session, viewer_id: UUID, surface_key: str) -> str:
    count = db.scalar(
        select(func.count())
        .select_from(PinnedResource)
        .where(
            PinnedResource.user_id == viewer_id,
            PinnedResource.surface_key == surface_key,
            PinnedResource.deleted_at.is_(None),
        )
    )
    return f"{int(count or 0) + 1:010d}"


def _pinned_out(db: Session, viewer_id: UUID, pin: PinnedResource) -> PinnedResourceOut:
    return PinnedResourceOut(
        id=pin.id,
        item=resource_item_out(
            db,
            viewer_id=viewer_id,
            ref=_ref_for_pin(pin.object_type, pin.object_id),
        ),
        surface_key=pin.surface_key,
        order_key=pin.order_key,
        created_at=pin.created_at,
        updated_at=pin.updated_at,
    )
