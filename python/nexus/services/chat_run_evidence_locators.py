"""Convert a resolved evidence span into a canonical locator and verify snippet match."""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.locator_resolver import resolve_evidence_span


def canonical_evidence_span_matches(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
    source_version: str,
    locator: dict[str, Any],
    exact_snippet: str,
) -> bool:
    try:
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            evidence_span_id=evidence_span_id,
        )
        resolver = resolution.get("resolver")
        if not isinstance(resolver, dict) or resolver.get("status") != "resolved":
            return False
        if resolution.get("source_version") != source_version:
            return False
        canonical_locator = _locator_from_evidence_resolution(
            resolution,
            media_id=media_id,
            existing_locator=locator,
        )
    except (AssertionError, NotFoundError, ValueError, ValidationError):
        return False

    return canonical_locator == locator and _snippet_matches_canonical_span(
        exact_snippet,
        str(resolution.get("span_text") or ""),
    )


def _locator_from_evidence_resolution(
    resolution: dict[str, Any],
    *,
    media_id: UUID,
    existing_locator: dict[str, Any],
) -> dict[str, Any]:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict):
        raise AssertionError("Resolved evidence is missing resolver")
    selector = resolver.get("selector")
    if not isinstance(selector, dict):
        raise AssertionError("Resolved evidence is missing selector")

    raw_quote = selector.get("text_quote")
    quote = raw_quote if isinstance(raw_quote, dict) else {}
    exact = str(quote.get("exact") or resolution.get("span_text") or "")
    prefix = quote.get("prefix") if isinstance(quote.get("prefix"), str) else None
    suffix = quote.get("suffix") if isinstance(quote.get("suffix"), str) else None
    quote_selector = {"exact": exact, "prefix": prefix, "suffix": suffix}

    kind = resolver.get("kind")
    if kind == "web":
        locator: dict[str, Any] = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "text_quote_selector": quote_selector,
        }
        _copy_existing_locator_string(existing_locator, locator, "media_kind")
    elif kind == "epub":
        locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(media_id),
            "section_id": selector.get("section_id")
            if isinstance(selector.get("section_id"), str)
            else None,
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "text_quote_selector": quote_selector,
        }
        _copy_existing_locator_string(existing_locator, locator, "media_kind")
    elif kind == "pdf":
        raw_geometry = selector.get("geometry")
        geometry = raw_geometry if isinstance(raw_geometry, dict) else {}
        locator = {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": selector.get("page_number"),
            "quads": geometry.get("quads") if isinstance(geometry.get("quads"), list) else [],
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
            "text_quote_selector": quote_selector,
        }
    elif kind == "transcript":
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": selector.get("t_start_ms"),
            "t_end_ms": selector.get("t_end_ms"),
            "text_quote_selector": quote_selector,
        }
        if isinstance(existing_locator.get("transcript_version_id"), str):
            _copy_existing_locator_string(existing_locator, locator, "transcript_version_id")
    else:
        raise AssertionError("Resolved evidence has unsupported resolver kind")

    validated = retrieval_locator_json(locator)
    if validated is None:
        raise AssertionError("Resolved evidence locator is required")
    return validated


def _copy_existing_locator_string(
    source: dict[str, Any],
    target: dict[str, Any],
    key: str,
) -> None:
    value = source.get(key)
    if isinstance(value, str):
        target[key] = value


def _snippet_matches_canonical_span(snippet: str, canonical_span: str) -> bool:
    snippet_text = _normalized_evidence_text(snippet)
    canonical_text = _normalized_evidence_text(canonical_span)
    if not snippet_text or not canonical_text:
        return False
    return (
        snippet_text == canonical_text
        or snippet_text in canonical_text
        or canonical_text in snippet_text
    )


def _normalized_evidence_text(value: str) -> str:
    stripped = re.sub(r"</?b>", "", value)
    stripped = stripped.replace("...", " ")
    return " ".join(stripped.split())
