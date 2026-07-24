"""Focused ordering and overview-position contracts for Reader locations."""

from typing import Any
from uuid import UUID

import pytest

from nexus.services.reader_locations import (
    locator_fraction,
    locator_is_current_for_media,
    order_key_from_locator,
    resolved_highlight_reader_target,
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


def test_current_highlight_target_maps_every_text_reader_family() -> None:
    web = resolved_highlight_reader_target(
        media_kind="web_article",
        anchor_kind="fragment_offsets",
        fragment_id=FRAGMENT_ID,
        exact="beta",
        fragment_text="alpha beta gamma",
        start_offset=6,
        end_offset=10,
    )
    epub = resolved_highlight_reader_target(
        media_kind="epub",
        anchor_kind="fragment_offsets",
        fragment_id=FRAGMENT_ID,
        section_id="chapter.xhtml#part-1",
        exact="beta",
        fragment_text="alpha beta gamma",
        start_offset=6,
        end_offset=10,
    )
    transcript = resolved_highlight_reader_target(
        media_kind="video",
        anchor_kind="fragment_offsets",
        fragment_id=FRAGMENT_ID,
        exact="beta",
        fragment_text="alpha beta gamma",
        start_offset=6,
        end_offset=10,
        t_start_ms=100,
        t_end_ms=800,
    )

    assert web is not None and web.kind == "WebTextOffsets"
    assert epub is not None and epub.kind == "EpubTextOffsets"
    assert epub.section_id == "chapter.xhtml#part-1"
    assert transcript is not None and transcript.kind == "TranscriptTextOffsets"
    assert transcript.time_range.kind == "Present"
    assert transcript.time_range.value.start_ms == 100


def test_current_highlight_target_keeps_valid_transcript_text_without_timing() -> None:
    target = resolved_highlight_reader_target(
        media_kind="podcast_episode",
        anchor_kind="fragment_offsets",
        fragment_id=FRAGMENT_ID,
        exact="beta",
        fragment_text="alpha beta gamma",
        start_offset=6,
        end_offset=10,
    )

    assert target is not None and target.kind == "TranscriptTextOffsets"
    assert target.time_range.kind == "Absent"


@pytest.mark.parametrize(
    "overrides",
    [
        {"fragment_text": "changed source"},
        {"section_id": None},
        {"end_offset": 99},
        {"t_start_ms": 100, "t_end_ms": None},
    ],
)
def test_current_highlight_target_rejects_stale_or_partial_text_facts(
    overrides: dict[str, object],
) -> None:
    kwargs: dict[str, Any] = {
        "media_kind": "epub" if "section_id" in overrides else "video",
        "anchor_kind": "fragment_offsets",
        "fragment_id": FRAGMENT_ID,
        "section_id": "chapter.xhtml",
        "exact": "beta",
        "fragment_text": "alpha beta gamma",
        "start_offset": 6,
        "end_offset": 10,
        "t_start_ms": None,
        "t_end_ms": None,
    }
    kwargs.update(overrides)

    assert resolved_highlight_reader_target(**kwargs) is None


def test_current_highlight_target_validates_pdf_geometry_against_current_page() -> None:
    quad = {
        "x1": 10.0,
        "y1": 20.0,
        "x2": 40.0,
        "y2": 20.0,
        "x3": 40.0,
        "y3": 30.0,
        "x4": 10.0,
        "y4": 30.0,
    }
    target = resolved_highlight_reader_target(
        media_kind="pdf",
        anchor_kind="pdf_page_geometry",
        page_number=2,
        page_count=3,
        page_width=100.0,
        page_height=200.0,
        pdf_quads=[quad],
    )
    out_of_bounds = resolved_highlight_reader_target(
        media_kind="pdf",
        anchor_kind="pdf_page_geometry",
        page_number=2,
        page_count=3,
        page_width=20.0,
        page_height=200.0,
        pdf_quads=[quad],
    )

    assert target is not None and target.kind == "PdfPageGeometry"
    assert target.page_number == 2
    assert out_of_bounds is None
