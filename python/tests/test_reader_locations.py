"""Focused ordering and overview-position contracts for Reader locations."""

from uuid import UUID

import pytest

from nexus.services.reader_locations import (
    locator_fraction,
    locator_is_current_for_media,
    order_key_from_locator,
)

MEDIA_ID = UUID("00000000-0000-0000-0000-000000000001")
FRAGMENT_ID = UUID("00000000-0000-0000-0000-000000000002")


def _pdf_locator(*, page_number: int, top: float, left: float) -> dict[str, object]:
    return {
        "type": "pdf_page_geometry",
        "media_id": str(MEDIA_ID),
        "page_number": page_number,
        "quads": [
            {
                "x1": left,
                "y1": top,
                "x2": left + 10,
                "y2": top,
                "x3": left + 10,
                "y3": top + 10,
                "x4": left,
                "y4": top + 10,
            }
        ],
    }


def test_pdf_evidence_orders_and_positions_within_the_same_page() -> None:
    upper = _pdf_locator(page_number=1, top=100.0, left=20.0)
    lower = _pdf_locator(page_number=1, top=500.0, left=10.0)

    assert order_key_from_locator(upper, {}) < order_key_from_locator(lower, {})
    assert locator_fraction(upper, {}, 0, 10, {1: 1000.0}) == 0.01
    assert locator_fraction(lower, {}, 0, 10, {1: 1000.0}) == 0.05


@pytest.mark.parametrize(
    ("locator", "fragment_indexes", "page_count", "current"),
    [
        (
            {
                "type": "web_text_offsets",
                "media_id": str(MEDIA_ID),
                "fragment_id": str(FRAGMENT_ID),
            },
            {str(FRAGMENT_ID): 0},
            None,
            True,
        ),
        (
            {
                "type": "web_text_offsets",
                "media_id": str(MEDIA_ID),
                "fragment_id": str(FRAGMENT_ID),
            },
            {},
            None,
            False,
        ),
        (_pdf_locator(page_number=2, top=10, left=10), {}, 1, False),
        (_pdf_locator(page_number=1, top=10, left=10), {}, 1, True),
        (
            {
                "type": "transcript_time_range",
                "media_id": "00000000-0000-0000-0000-000000000099",
            },
            {},
            None,
            False,
        ),
    ],
)
def test_locator_currency_is_owned_by_the_open_media_revision(
    locator: dict[str, object],
    fragment_indexes: dict[str, int],
    page_count: int | None,
    current: bool,
) -> None:
    assert (
        locator_is_current_for_media(
            locator,
            media_id=MEDIA_ID,
            fragment_indexes=fragment_indexes,
            page_count=page_count,
        )
        is current
    )
