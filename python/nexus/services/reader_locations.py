"""Canonical locator normalization, ordering, and overview-position semantics."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast
from uuid import UUID

from pydantic import BaseModel, ValidationError

from nexus.schemas.presence import absent, present
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    HighlightTargetPdfQuadOut,
    PdfPageGeometryTargetOut,
    ReaderTimeRange,
    ResolvedHighlightReaderTarget,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)

_TEXT_MEDIA_KINDS = frozenset({"web_article", "epub", "video", "podcast_episode"})


def locator_json(
    locator: BaseModel | Mapping[str, Any] | None,
) -> dict[str, object] | None:
    if locator is None:
        return None
    if isinstance(locator, BaseModel):
        return cast(dict[str, object], locator.model_dump(mode="json"))
    return dict(locator)


def locator_fraction(
    locator: dict[str, object] | None,
    fragment_ranges: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> float | None:
    """Map a current locator to a normalized document-overview position."""

    if not locator:
        return None
    page = locator_page(locator)
    if page is not None and page_count and page_count > 0:
        if locator.get("type") == "pdf_page":
            return (page - 1) / page_count if page <= page_count else None
        origin = _pdf_quad_origin(locator)
        page_height = pdf_page_heights.get(page)
        if (
            origin is None
            or page_height is None
            or page_height <= 0
            or page > page_count
            or not 0 <= origin[0] <= page_height
        ):
            return None
        within_page = origin[0] / page_height
        return ((page - 1) + within_page) / page_count
    fragment_id = locator_fragment(locator)
    if fragment_id is None:
        return None
    fragment_range = fragment_ranges.get(str(fragment_id))
    if fragment_range is None or total_fragment_chars <= 0:
        return None
    fragment_start, fragment_length = fragment_range
    start = locator.get("start_offset")
    if not isinstance(start, int) or isinstance(start, bool) or not 0 <= start <= fragment_length:
        return None
    return (fragment_start + start) / total_fragment_chars


def locator_end_fraction(
    locator: dict[str, object] | None,
    fragment_ranges: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> float | None:
    """Project an exact range end; a point locator has no fabricated extent."""
    if not locator:
        return None
    end = locator.get("end_offset")
    if locator_fragment(locator) is not None and isinstance(end, int):
        return locator_fraction(
            {**locator, "start_offset": end},
            fragment_ranges,
            total_fragment_chars,
            page_count,
            pdf_page_heights,
        )
    page = locator_page(locator)
    quads = locator.get("quads")
    if (
        page is None
        or not page_count
        or page > page_count
        or not isinstance(quads, list)
        or not quads
    ):
        return None
    height = pdf_page_heights.get(page)
    if height is None or height <= 0:
        return None
    bottoms: list[float] = []
    for quad in quads:
        if not isinstance(quad, dict):
            return None
        for index in range(1, 5):
            y = quad.get(f"y{index}")
            if not isinstance(y, (int, float)) or not 0 <= y <= height:
                return None
            bottoms.append(float(y))
    return ((page - 1) + max(bottoms) / height) / page_count


def order_key_from_locator(
    locator: dict[str, object] | None,
    fragment_indexes: Mapping[str, int],
) -> str | None:
    """Return one sortable document-order key across supported locator families."""

    if not locator:
        return None
    page = locator_page(locator)
    if page is not None:
        origin = _pdf_quad_origin(locator)
        if origin is None:
            return f"pdf:{page:08d}"
        top, left = origin
        return f"pdf:{page:08d}:{top:012.4f}:{left:012.4f}"
    fragment_id = locator_fragment(locator)
    start = locator.get("start_offset")
    if fragment_id is not None:
        index = fragment_indexes.get(str(fragment_id), 0)
        offset = int(start) if isinstance(start, int) else 0
        return f"fragment:{index:010d}:{offset:010d}"
    start_ms = locator.get("t_start_ms")
    if isinstance(start_ms, int):
        return f"time:{start_ms:012d}"
    return None


def locator_is_current_for_media(
    locator: Mapping[str, object],
    *,
    media_id: UUID,
    fragment_indexes: Mapping[str, int],
    page_count: int | None,
) -> bool:
    """Return whether a media locator still targets the open document revision."""

    if str(locator.get("media_id")) != str(media_id):
        return False
    match locator.get("type"):
        case "web_text_offsets" | "epub_fragment_offsets":
            fragment_id = locator_fragment(locator)
            return fragment_id is not None and str(fragment_id) in fragment_indexes
        case "pdf_page" | "pdf_page_geometry":
            page_number = locator_page(locator)
            return page_count is not None and page_number is not None and page_number <= page_count
        case "transcript_time_range" | "audio_time_range" | "video_time_range":
            return True
        case _:
            return False


def highlight_locator(
    raw: dict[str, object],
    *,
    media_kind: str,
    exact: str,
    prefix: str,
    suffix: str,
) -> dict[str, object]:
    """Normalize the highlight owner's anchor into RetrievalLocator grammar."""

    locator = dict(raw)
    if locator.get("type") in {
        "fragment_offsets",
        "web_text_offsets",
        "epub_fragment_offsets",
    }:
        if locator["type"] == "fragment_offsets":
            locator["type"] = (
                "epub_fragment_offsets" if media_kind == "epub" else "web_text_offsets"
            )
        locator["media_kind"] = media_kind
        locator["text_quote_selector"] = {
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
        }
        return locator
    if locator.get("type") == "pdf_page_geometry":
        locator["exact"] = exact
        locator["prefix"] = prefix
        locator["suffix"] = suffix
        locator["text_quote_selector"] = {
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
        }
    return locator


def resolved_highlight_reader_target(
    *,
    media_kind: str,
    anchor_kind: str,
    fragment_id: UUID | None = None,
    exact: str = "",
    fragment_text: str | None = None,
    start_offset: int | None = None,
    end_offset: int | None = None,
    t_start_ms: int | None = None,
    t_end_ms: int | None = None,
    page_number: int | None = None,
    page_count: int | None = None,
    page_width: float | None = None,
    page_height: float | None = None,
    pdf_quads: Sequence[Mapping[str, object]] | None = None,
) -> ResolvedHighlightReaderTarget | None:
    """Map current owner facts to the one closed highlight reader target.

    This is the canonical format-total target mapper. The locator resolver owns
    loading current source rows; this owner validates their reader semantics and
    emits no partial or guessed target.
    """
    try:
        if anchor_kind == "fragment_offsets":
            if (
                media_kind not in _TEXT_MEDIA_KINDS
                or fragment_id is None
                or fragment_text is None
                or start_offset is None
                or end_offset is None
                or start_offset < 0
                or end_offset <= start_offset
                or end_offset > len(fragment_text)
                or fragment_text[start_offset:end_offset] != exact
            ):
                return None
            if media_kind == "web_article":
                return WebTextOffsetsTargetOut(
                    fragment_id=fragment_id,
                    start_offset=start_offset,
                    end_offset=end_offset,
                )
            if media_kind == "epub":
                return EpubTextOffsetsTargetOut(
                    fragment_id=fragment_id,
                    start_offset=start_offset,
                    end_offset=end_offset,
                )
            time_range = absent()
            if t_start_ms is not None or t_end_ms is not None:
                if t_start_ms is None or t_end_ms is None:
                    return None
                time_range = present(
                    ReaderTimeRange(
                        start_ms=t_start_ms,
                        end_ms=t_end_ms,
                    )
                )
            return TranscriptTextOffsetsTargetOut(
                fragment_id=fragment_id,
                start_offset=start_offset,
                end_offset=end_offset,
                time_range=time_range,
            )

        if (
            anchor_kind != "pdf_page_geometry"
            or media_kind != "pdf"
            or page_number is None
            or page_count is None
            or page_number < 1
            or page_number > page_count
            or page_width is None
            or page_height is None
            or page_width <= 0
            or page_height <= 0
            or pdf_quads is None
            or not 1 <= len(pdf_quads) <= 512
        ):
            return None
        quads: list[HighlightTargetPdfQuadOut] = []
        for raw in pdf_quads:
            quad = HighlightTargetPdfQuadOut.model_validate(raw)
            if not all(
                0 <= x <= page_width for x in (quad.x1, quad.x2, quad.x3, quad.x4)
            ) or not all(0 <= y <= page_height for y in (quad.y1, quad.y2, quad.y3, quad.y4)):
                return None
            quads.append(quad)
        return PdfPageGeometryTargetOut(page_number=page_number, quads=quads)
    except (KeyError, TypeError, ValueError, ValidationError):
        return None


def locator_page(locator: Mapping[str, object]) -> int | None:
    value = locator.get("page_number")
    return value if isinstance(value, int) else None


def locator_fragment(locator: Mapping[str, object]) -> UUID | None:
    value = locator.get("fragment_id")
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def _pdf_quad_origin(locator: Mapping[str, object]) -> tuple[float, float] | None:
    quads = locator.get("quads")
    if not isinstance(quads, list) or not quads:
        return None
    tops: list[float] = []
    lefts: list[float] = []
    for quad in quads:
        if not isinstance(quad, dict):
            return None
        y_values: list[float] = []
        x_values: list[float] = []
        for index in range(1, 5):
            y = quad.get(f"y{index}")
            x = quad.get(f"x{index}")
            if not isinstance(y, (int, float)) or not isinstance(x, (int, float)):
                return None
            y_values.append(float(y))
            x_values.append(float(x))
        tops.append(min(y_values))
        lefts.append(min(x_values))
    return (min(tops), min(lefts))
