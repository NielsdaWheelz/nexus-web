"""Object link service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import case, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import ObjectLink
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    OBJECT_LINK_RELATIONS,
    OBJECT_TYPES,
    UNSET,
    ObjectLinkOut,
    ObjectRef,
    _UnsetType,
)
from nexus.services.object_refs import hydrate_object_ref


@dataclass(frozen=True)
class CreateObjectLinkInput:
    relation_type: str
    a: ObjectRef
    b: ObjectRef
    a_locator: dict[str, Any] | None = None
    b_locator: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class UpdateObjectLinkPatch:
    relation_type: str | None = None
    a_order_key: str | None | _UnsetType = UNSET
    b_order_key: str | None | _UnsetType = UNSET
    metadata: dict[str, Any] | None = None


def create_object_link(
    db: Session,
    viewer_id: UUID,
    link_input: CreateObjectLinkInput,
) -> ObjectLinkOut:
    hydrate_object_ref(db, viewer_id, link_input.a)
    hydrate_object_ref(db, viewer_id, link_input.b)
    if link_input.a_locator is None and link_input.b_locator is None:
        if _duplicate_unlocated_link_id(
            db,
            viewer_id,
            relation_type=link_input.relation_type,
            a_type=link_input.a.object_type,
            a_id=link_input.a.object_id,
            b_type=link_input.b.object_type,
            b_id=link_input.b.object_id,
        ):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object link already exists")
    link = ObjectLink(
        user_id=viewer_id,
        relation_type=link_input.relation_type,
        a_type=link_input.a.object_type,
        a_id=link_input.a.object_id,
        b_type=link_input.b.object_type,
        b_id=link_input.b.object_id,
        a_order_key=None,
        b_order_key=None,
        a_locator_json=link_input.a_locator,
        b_locator_json=link_input.b_locator,
        metadata_json=link_input.metadata or {},
    )
    db.add(link)
    _commit_object_link(db)
    db.refresh(link)
    return _link_out(db, viewer_id, link)


def list_object_links(
    db: Session,
    viewer_id: UUID,
    object_ref: ObjectRef | None = None,
    a_ref: ObjectRef | None = None,
    b_ref: ObjectRef | None = None,
    relation_type: str | None = None,
) -> list[ObjectLinkOut]:
    statement = select(ObjectLink).where(ObjectLink.user_id == viewer_id)
    if object_ref is not None:
        hydrate_object_ref(db, viewer_id, object_ref)
        statement = statement.where(
            or_(
                (ObjectLink.a_type == object_ref.object_type)
                & (ObjectLink.a_id == object_ref.object_id),
                (ObjectLink.b_type == object_ref.object_type)
                & (ObjectLink.b_id == object_ref.object_id),
            )
        )
    if a_ref is not None:
        hydrate_object_ref(db, viewer_id, a_ref)
        statement = statement.where(
            ObjectLink.a_type == a_ref.object_type, ObjectLink.a_id == a_ref.object_id
        )
    if b_ref is not None:
        hydrate_object_ref(db, viewer_id, b_ref)
        statement = statement.where(
            ObjectLink.b_type == b_ref.object_type, ObjectLink.b_id == b_ref.object_id
        )
    if relation_type is not None:
        statement = statement.where(ObjectLink.relation_type == relation_type)
    order_by = [ObjectLink.created_at.asc(), ObjectLink.id.asc()]
    if a_ref is not None:
        order_by = [
            ObjectLink.a_order_key.asc().nullsfirst(),
            ObjectLink.created_at.asc(),
            ObjectLink.id.asc(),
        ]
    elif b_ref is not None:
        order_by = [
            ObjectLink.b_order_key.asc().nullsfirst(),
            ObjectLink.created_at.asc(),
            ObjectLink.id.asc(),
        ]
    elif object_ref is not None:
        endpoint_order = case(
            (
                (ObjectLink.a_type == object_ref.object_type)
                & (ObjectLink.a_id == object_ref.object_id),
                ObjectLink.a_order_key,
            ),
            else_=ObjectLink.b_order_key,
        )
        order_by = [
            endpoint_order.asc().nullsfirst(),
            ObjectLink.created_at.asc(),
            ObjectLink.id.asc(),
        ]
    links = db.scalars(statement.order_by(*order_by)).all()
    return [_link_out(db, viewer_id, link) for link in links]


def update_object_link(
    db: Session,
    viewer_id: UUID,
    link_id: UUID,
    patch: UpdateObjectLinkPatch,
) -> ObjectLinkOut:
    link = db.get(ObjectLink, link_id)
    if link is None or link.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object link not found")
    if patch.relation_type is not None:
        link.relation_type = patch.relation_type
    if patch.a_order_key is not UNSET:
        link.a_order_key = patch.a_order_key
    if patch.b_order_key is not UNSET:
        link.b_order_key = patch.b_order_key
    if patch.metadata is not None:
        link.metadata_json = patch.metadata
    if link.a_locator_json is None and link.b_locator_json is None:
        with db.no_autoflush:
            duplicate_id = _duplicate_unlocated_link_id(
                db,
                viewer_id,
                relation_type=link.relation_type,
                a_type=link.a_type,
                a_id=link.a_id,
                b_type=link.b_type,
                b_id=link.b_id,
                exclude_link_id=link.id,
            )
        if duplicate_id is not None:
            db.rollback()
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object link already exists")
    _commit_object_link(db)
    db.refresh(link)
    return _link_out(db, viewer_id, link)


def delete_object_link(db: Session, viewer_id: UUID, link_id: UUID) -> None:
    link = db.get(ObjectLink, link_id)
    if link is None or link.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Object link not found")
    db.delete(link)
    db.commit()


def _duplicate_unlocated_link_id(
    db: Session,
    viewer_id: UUID,
    *,
    relation_type: str,
    a_type: str,
    a_id: UUID,
    b_type: str,
    b_id: UUID,
    exclude_link_id: UUID | None = None,
) -> UUID | None:
    filters = [
        ObjectLink.user_id == viewer_id,
        ObjectLink.relation_type == relation_type,
        or_(
            (
                (ObjectLink.a_type == a_type)
                & (ObjectLink.a_id == a_id)
                & (ObjectLink.b_type == b_type)
                & (ObjectLink.b_id == b_id)
            ),
            (
                (ObjectLink.a_type == b_type)
                & (ObjectLink.a_id == b_id)
                & (ObjectLink.b_type == a_type)
                & (ObjectLink.b_id == a_id)
            ),
        ),
        ObjectLink.a_locator_json.is_(None),
        ObjectLink.b_locator_json.is_(None),
    ]
    if exclude_link_id is not None:
        filters.append(ObjectLink.id != exclude_link_id)
    return db.scalar(select(ObjectLink.id).where(*filters).limit(1))


def _commit_object_link(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        constraint_name = integrity_constraint_name(exc)
        if constraint_name == "uix_object_links_unlocated_pair" or (
            constraint_name is None and "uix_object_links_unlocated_pair" in str(exc.orig)
        ):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object link already exists") from exc
        raise


def _link_out(db: Session, viewer_id: UUID, link: ObjectLink) -> ObjectLinkOut:
    return ObjectLinkOut(
        id=link.id,
        relation_type=cast(OBJECT_LINK_RELATIONS, link.relation_type),
        a=hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type=cast(OBJECT_TYPES, link.a_type), object_id=link.a_id),
        ),
        b=hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type=cast(OBJECT_TYPES, link.b_type), object_id=link.b_id),
        ),
        a_locator=link.a_locator_json,
        b_locator=link.b_locator_json,
        a_order_key=link.a_order_key,
        b_order_key=link.b_order_key,
        metadata=link.metadata_json,
        created_at=link.created_at,
        updated_at=link.updated_at,
    )
