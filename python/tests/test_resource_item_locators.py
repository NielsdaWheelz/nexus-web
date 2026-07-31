from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.notes import CreatePageRequest
from nexus.schemas.resource_items import (
    ContributorHandleLocatorIn,
    ResourceLocatorResolveRequest,
    ResourceRefLocatorIn,
)
from nexus.services import notes
from nexus.services.resource_items.locators import (
    resolve_resource_locator,
    resolve_resource_locators,
)

pytestmark = pytest.mark.integration


def test_resource_ref_locator_projects_resource_item(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Locator Page"),
    )

    result = resolve_resource_locator(
        db_session,
        viewer_id=bootstrapped_user,
        locator=ResourceRefLocatorIn(kind="resource_ref", ref=f"page:{page.id}"),
    )

    assert result.resource_item.ref == f"page:{page.id}"
    assert result.resource_item.scheme == "page"
    assert result.canonical_href == f"/pages/{page.id}"


def test_batch_locator_resolution_preserves_input_order(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Batch Page"),
    )
    other_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Second Batch Page"),
    )

    results = resolve_resource_locators(
        db_session,
        viewer_id=bootstrapped_user,
        locators=[
            ResourceRefLocatorIn(kind="resource_ref", ref=f"page:{other_page.id}"),
            ResourceRefLocatorIn(kind="resource_ref", ref=f"page:{page.id}"),
        ],
    )

    assert [result.locator.kind for result in results] == [
        "resource_ref",
        "resource_ref",
    ]
    assert results[0].resource_item.ref == f"page:{other_page.id}"
    assert results[1].resource_item.ref == f"page:{page.id}"


def test_resource_ref_locator_rejects_product_pseudo_refs() -> None:
    for ref in ("author:ursula-k-le-guin", "daily_note:2026-06-19"):
        with pytest.raises(ValidationError):
            ResourceLocatorResolveRequest(
                locators=[
                    {
                        "kind": "resource_ref",
                        "ref": ref,
                    }
                ]
            )


@pytest.mark.parametrize("kind", ["daily_note_today", "daily_note_date"])
def test_removed_daily_locators_fail_exact_schema_decode(kind: str) -> None:
    with pytest.raises(ValidationError):
        ResourceLocatorResolveRequest(
            locators=[
                {
                    "kind": kind,
                    "localDate": "2026-06-19",
                    "timeZone": "UTC",
                }
            ]
        )


@pytest.mark.parametrize(
    "handle",
    ["directory", "reconciliation-candidates", "Not A Handle", "trailing-"],
)
def test_contributor_handle_locator_rejects_reserved_and_malformed(
    db_session: Session,
    bootstrapped_user: UUID,
    handle: str,
) -> None:
    # Reserved segments and non-canonical handles fail the parse before any DB
    # read, so they never capture a contributor row (D-26).
    with pytest.raises(ApiError) as error:
        resolve_resource_locator(
            db_session,
            viewer_id=bootstrapped_user,
            locator=ContributorHandleLocatorIn(kind="contributor_handle", handle=handle),
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST
