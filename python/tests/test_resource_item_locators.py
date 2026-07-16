from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import DailyNotePage
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.notes import CreatePageRequest
from nexus.schemas.resource_items import (
    ContributorHandleLocatorIn,
    DailyNoteDateLocatorIn,
    DailyNoteTodayLocatorIn,
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
        CreatePageRequest(title="Locator Page"),
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
        CreatePageRequest(title="Batch Page"),
    )
    local_date = date(2026, 6, 19)

    results = resolve_resource_locators(
        db_session,
        viewer_id=bootstrapped_user,
        locators=[
            DailyNoteDateLocatorIn(
                kind="daily_note_date",
                local_date=local_date,
                time_zone="America/Los_Angeles",
            ),
            ResourceRefLocatorIn(kind="resource_ref", ref=f"page:{page.id}"),
        ],
    )

    assert [result.locator.kind for result in results] == [
        "daily_note_date",
        "resource_ref",
    ]
    assert results[0].resource_item.scheme == "page"
    assert results[1].resource_item.ref == f"page:{page.id}"


def test_daily_note_date_locator_is_idempotent(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    locator = DailyNoteDateLocatorIn(
        kind="daily_note_date",
        local_date=date(2026, 6, 19),
        time_zone="America/Los_Angeles",
    )

    first = resolve_resource_locator(db_session, viewer_id=bootstrapped_user, locator=locator)
    second = resolve_resource_locator(db_session, viewer_id=bootstrapped_user, locator=locator)

    assert first.resource_item.ref == second.resource_item.ref
    assert first.resource_item.scheme == "page"
    assert first.canonical_href == f"/pages/{first.resource_item.id}"
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(DailyNotePage)
            .where(
                DailyNotePage.user_id == bootstrapped_user,
                DailyNotePage.local_date == date(2026, 6, 19),
            )
        )
        == 1
    )


def test_daily_note_today_locator_uses_explicit_timezone(
    db_session: Session,
    bootstrapped_user: UUID,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            fixed = datetime(2026, 6, 20, 6, 30, tzinfo=UTC)
            return fixed if tz is None else fixed.astimezone(tz)

    monkeypatch.setattr(notes, "datetime", FixedDateTime)

    result = resolve_resource_locator(
        db_session,
        viewer_id=bootstrapped_user,
        locator=DailyNoteTodayLocatorIn(
            kind="daily_note_today",
            time_zone="America/Los_Angeles",
        ),
    )

    daily = db_session.scalar(
        select(DailyNotePage).where(DailyNotePage.page_id == result.resource_item.id)
    )
    assert daily is not None
    assert daily.local_date == date(2026, 6, 19)


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


def test_daily_locator_rejects_invalid_timezone(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    with pytest.raises(ApiError) as error:
        resolve_resource_locator(
            db_session,
            viewer_id=bootstrapped_user,
            locator=DailyNoteDateLocatorIn(
                kind="daily_note_date",
                local_date=date(2026, 6, 19),
                time_zone="Not/A_Zone",
            ),
        )

    assert error.value.code == ApiErrorCode.E_INVALID_REQUEST


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
