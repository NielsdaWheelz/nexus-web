from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_items import ObjectRef
from nexus.services.pinned_objects import (
    PinObjectRefInput,
    UpdatePinnedObjectRefPatch,
    list_pinned_object_refs,
    pin_object_ref,
    unpin_object_ref,
    update_pinned_object_ref,
)
from tests.factories import create_test_media_in_library, get_user_default_library

pytestmark = pytest.mark.integration


def _pin_media(db_session: Session, viewer_id: UUID, media_id: UUID, **kwargs: object) -> object:
    return pin_object_ref(
        db_session,
        viewer_id,
        PinObjectRefInput(
            object_ref=ObjectRef(object_type="media", object_id=media_id),
            **kwargs,  # type: ignore[arg-type]
        ),
    )


def test_pin_object_ref_hydrates_through_resource_item_out(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Pinned Article"
    )

    pin = _pin_media(db_session, bootstrapped_user, media_id)

    assert pin.item.ref == f"media:{media_id}"
    assert pin.item.scheme == "media"
    assert pin.item.id == media_id
    assert pin.item.label == "Pinned Article"
    assert pin.item.route == f"/media/{media_id}"
    assert pin.surface_key == "navbar"


def test_pin_object_ref_is_idempotent_for_same_surface_and_ref(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)

    first = _pin_media(db_session, bootstrapped_user, media_id)
    second = _pin_media(db_session, bootstrapped_user, media_id)

    assert first.id == second.id
    pins = list_pinned_object_refs(db_session, bootstrapped_user)
    assert [p.id for p in pins] == [first.id]


def test_pin_object_ref_rejects_missing_resource(db_session: Session, bootstrapped_user: UUID):
    with pytest.raises(NotFoundError) as exc_info:
        _pin_media(db_session, bootstrapped_user, uuid4())
    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


def test_list_pinned_object_refs_orders_by_order_key(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")

    pin_a = _pin_media(db_session, bootstrapped_user, media_a, order_key="0000000002")
    pin_b = _pin_media(db_session, bootstrapped_user, media_b, order_key="0000000001")

    pins = list_pinned_object_refs(db_session, bootstrapped_user)
    assert [p.id for p in pins] == [pin_b.id, pin_a.id]


def test_update_pinned_object_ref_changes_order_key(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    pin = _pin_media(db_session, bootstrapped_user, media_id)

    updated = update_pinned_object_ref(
        db_session,
        bootstrapped_user,
        pin.id,
        UpdatePinnedObjectRefPatch(order_key="0000000099"),
    )

    assert updated.order_key == "0000000099"


def test_update_pinned_object_ref_missing_pin_404s(db_session: Session, bootstrapped_user: UUID):
    with pytest.raises(NotFoundError) as exc_info:
        update_pinned_object_ref(
            db_session, bootstrapped_user, uuid4(), UpdatePinnedObjectRefPatch(order_key="x")
        )
    assert exc_info.value.code == ApiErrorCode.E_NOT_FOUND


def test_unpin_object_ref_removes_the_pin(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    pin = _pin_media(db_session, bootstrapped_user, media_id)

    unpin_object_ref(db_session, bootstrapped_user, pin.id)

    assert list_pinned_object_refs(db_session, bootstrapped_user) == []
    with pytest.raises(NotFoundError):
        unpin_object_ref(db_session, bootstrapped_user, pin.id)
