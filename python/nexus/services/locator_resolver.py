"""Backend-owned evidence locator resolution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json

ResolverStatus = Literal["resolved", "unresolved", "no_geometry"]


@dataclass(frozen=True)
class LocatorResolution:
    params: dict[str, str]
    status: ResolverStatus
    highlight: dict[str, Any] | None


def resolve_evidence_span(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
) -> dict[str, Any]:
    row = (
        db.execute(
            text(
                """
            SELECT
                es.id,
                es.media_id,
                es.span_text,
                es.selector,
                es.citation_label,
                es.resolver_kind
            FROM evidence_spans es
            WHERE es.id = :evidence_span_id
            """
            ),
            {"evidence_span_id": evidence_span_id},
        )
        .mappings()
        .first()
    )
    if row is None or row["media_id"] != media_id or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    selector: dict[str, Any] = row["selector"] if isinstance(row["selector"], dict) else {}
    _assert_no_legacy_selector_identity(selector)
    resolver_kind = str(row["resolver_kind"])
    params: dict[str, str] = {"evidence": str(evidence_span_id)}
    raw_text_quote = selector.get("text_quote")
    text_quote: dict[str, Any] = raw_text_quote if isinstance(raw_text_quote, dict) else {}
    exact = str(text_quote.get("exact") or row["span_text"] or "")
    prefix = str(text_quote.get("prefix") or "")
    suffix = str(text_quote.get("suffix") or "")
    text_quote_out = {"exact": exact, "prefix": prefix, "suffix": suffix}
    snapshot_text_matches = _evidence_span_snapshot_matches(
        db,
        evidence_span_id=evidence_span_id,
        exact=exact,
    )

    if resolver_kind == "web":
        resolution = _resolve_web_selector(
            selector,
            evidence_span_id=evidence_span_id,
            text_quote=text_quote_out,
            snapshot_text_matches=snapshot_text_matches,
        )

    elif resolver_kind == "epub":
        resolution = _resolve_epub_selector(
            selector,
            evidence_span_id=evidence_span_id,
            text_quote=text_quote_out,
            snapshot_text_matches=snapshot_text_matches,
        )

    elif resolver_kind == "pdf":
        resolution = _resolve_pdf_selector(
            selector,
            evidence_span_id=evidence_span_id,
            text_quote=text_quote_out,
            selector_matches=snapshot_text_matches,
        )

    elif resolver_kind == "transcript":
        resolution = _resolve_transcript_selector(
            selector,
            evidence_span_id=evidence_span_id,
            text_quote=text_quote_out,
            selector_matches=(
                _transcript_selector_time_range_valid(selector=selector) and snapshot_text_matches
            ),
        )
    else:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    params.update(resolution.params)

    return {
        "evidence_span_id": str(evidence_span_id),
        "media_id": str(media_id),
        "citation_label": str(row["citation_label"]),
        "span_text": str(row["span_text"] or ""),
        "resolver": {
            "kind": resolver_kind,
            "route": f"/media/{media_id}",
            "params": params,
            "status": resolution.status,
            "selector": selector,
            "highlight": resolution.highlight,
        },
    }


def locator_from_resolution(
    resolution: dict[str, Any],
    *,
    media_id: UUID,
    media_kind: str,
) -> dict[str, Any]:
    """Map a ``resolve_evidence_span`` resolution to a validated retrieval locator.

    The single owner of the resolver-kind -> ``RetrievalLocator`` mapping, shared
    by ``search`` (content-chunk results) and the library-intelligence citation
    producer. Strictly behavior-preserving for search (extracted unchanged).
    """
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
        locator = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "media_kind": media_kind,
            "text_quote_selector": quote_selector,
        }
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
            "media_kind": media_kind,
            "text_quote_selector": quote_selector,
        }
    elif kind == "pdf":
        raw_geometry = selector.get("geometry")
        geometry = raw_geometry if isinstance(raw_geometry, dict) else {}
        quads = geometry.get("quads") if isinstance(geometry.get("quads"), list) else []
        locator = {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": selector.get("page_number"),
            "quads": quads,
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
    else:
        raise AssertionError("Resolved evidence has unsupported resolver kind")

    validated = retrieval_locator_json(locator)
    if validated is None:
        raise AssertionError("Resolved evidence locator is required")
    return validated


def _resolve_web_selector(
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    text_quote: dict[str, str],
    snapshot_text_matches: bool,
) -> LocatorResolution:
    params: dict[str, str] = {}
    fragment_id = selector.get("fragment_id")
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if isinstance(fragment_id, str):
        params["fragment"] = fragment_id
    if (
        isinstance(fragment_id, str)
        and isinstance(start_offset, int)
        and isinstance(end_offset, int)
        and snapshot_text_matches
    ):
        return LocatorResolution(
            params=params,
            status="resolved",
            highlight={
                "kind": "web_text",
                "evidence_span_id": str(evidence_span_id),
                "fragment_id": fragment_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": text_quote,
            },
        )
    return LocatorResolution(params=params, status="unresolved", highlight=None)


def _resolve_epub_selector(
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    text_quote: dict[str, str],
    snapshot_text_matches: bool,
) -> LocatorResolution:
    params: dict[str, str] = {}
    section_id = selector.get("section_id")
    fragment_id = selector.get("fragment_id")
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")
    if isinstance(section_id, str):
        params["loc"] = section_id
    if isinstance(fragment_id, str):
        params["fragment"] = fragment_id
    if (
        isinstance(fragment_id, str)
        and isinstance(start_offset, int)
        and isinstance(end_offset, int)
        and snapshot_text_matches
    ):
        return LocatorResolution(
            params=params,
            status="resolved",
            highlight={
                "kind": "epub_text",
                "evidence_span_id": str(evidence_span_id),
                "fragment_id": fragment_id,
                "section_id": section_id if isinstance(section_id, str) else None,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": text_quote,
            },
        )
    return LocatorResolution(params=params, status="unresolved", highlight=None)


def _resolve_pdf_selector(
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    text_quote: dict[str, str],
    selector_matches: bool,
) -> LocatorResolution:
    params: dict[str, str] = {}
    page_number = selector.get("page_number")
    if isinstance(page_number, int) and page_number >= 1:
        params["page"] = str(page_number)
    raw_geometry = selector.get("geometry")
    geometry: dict[str, Any] = raw_geometry if isinstance(raw_geometry, dict) else {}
    quads = _pdf_quads_from_geometry(geometry)
    if isinstance(page_number, int) and page_number >= 1 and selector_matches:
        return LocatorResolution(
            params=params,
            status="resolved" if quads else "no_geometry",
            highlight={
                "kind": "pdf_text",
                "evidence_span_id": str(evidence_span_id),
                "page_number": page_number,
                "page_label": selector.get("page_label")
                if isinstance(selector.get("page_label"), str)
                else None,
                "text_quote": text_quote,
                "geometry": {**geometry, "quads": quads} if quads else None,
            },
        )
    return LocatorResolution(params=params, status="unresolved", highlight=None)


def _pdf_quads_from_geometry(geometry: dict[str, Any]) -> list[dict[str, float]]:
    raw_geometry_quads = geometry.get("quads")
    raw_quads = raw_geometry_quads if isinstance(raw_geometry_quads, list) else []
    quads: list[dict[str, float]] = []
    for raw_quad in raw_quads:
        if not isinstance(raw_quad, dict):
            continue
        quad: dict[str, float] = {}
        for key in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"):
            value = raw_quad.get(key)
            if not isinstance(value, int | float):
                quad = {}
                break
            quad[key] = float(value)
        if quad:
            quads.append(quad)
    return quads


def _resolve_transcript_selector(
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    text_quote: dict[str, str],
    selector_matches: bool,
) -> LocatorResolution:
    params: dict[str, str] = {}
    t_start_ms = selector.get("t_start_ms")
    t_end_ms = selector.get("t_end_ms")
    if isinstance(t_start_ms, int) and t_start_ms >= 0:
        params["t_start_ms"] = str(t_start_ms)
    if selector_matches:
        return LocatorResolution(
            params=params,
            status="resolved",
            highlight={
                "kind": "transcript_time_text",
                "evidence_span_id": str(evidence_span_id),
                "t_start_ms": t_start_ms if isinstance(t_start_ms, int) else None,
                "t_end_ms": t_end_ms if isinstance(t_end_ms, int) else None,
                "text_quote": text_quote,
            },
        )
    return LocatorResolution(params=params, status="unresolved", highlight=None)


def _evidence_span_snapshot_matches(
    db: Session,
    *,
    evidence_span_id: UUID,
    exact: str,
) -> bool:
    rows = (
        db.execute(
            text(
                """
                SELECT
                    es.span_text,
                    es.start_block_id,
                    es.end_block_id,
                    es.start_block_offset,
                    es.end_block_offset,
                    start_block.block_idx AS start_block_idx,
                    end_block.block_idx AS end_block_idx,
                    cb.id AS block_id,
                    cb.block_idx,
                    cb.canonical_text
                FROM evidence_spans es
                JOIN content_blocks start_block
                  ON start_block.id = es.start_block_id
                 AND start_block.media_id = es.media_id
                JOIN content_blocks end_block
                  ON end_block.id = es.end_block_id
                 AND end_block.media_id = es.media_id
                JOIN content_blocks cb
                  ON cb.media_id = es.media_id
                 AND cb.block_idx BETWEEN start_block.block_idx AND end_block.block_idx
                WHERE es.id = :evidence_span_id
                ORDER BY cb.block_idx ASC
                """
            ),
            {"evidence_span_id": evidence_span_id},
        )
        .mappings()
        .all()
    )
    if not rows:
        return False

    parts: list[str] = []
    start_idx = int(rows[0]["start_block_idx"])
    end_idx = int(rows[0]["end_block_idx"])
    if start_idx > end_idx:
        return False
    expected_block_idx = start_idx
    for row in rows:
        block_idx = int(row["block_idx"])
        if block_idx != expected_block_idx:
            return False
        block_text = str(row["canonical_text"] or "")
        if block_idx == start_idx:
            block_start = int(row["start_block_offset"])
        else:
            block_start = 0
        if block_idx == end_idx:
            block_end = int(row["end_block_offset"])
        else:
            block_end = len(block_text)
        if block_start < 0 or block_end < block_start or block_end > len(block_text):
            return False
        parts.append(block_text[block_start:block_end])
        expected_block_idx += 1

    reconstructed = "".join(parts)
    if expected_block_idx != end_idx + 1:
        return False

    first_row = rows[0]
    last_row = rows[-1]
    if (
        first_row["block_id"] != first_row["start_block_id"]
        or last_row["block_id"] != first_row["end_block_id"]
    ):
        return False

    span_text = str(first_row["span_text"] or "")
    return reconstructed == span_text and span_text == exact


_LEGACY_SELECTOR_IDENTITY_KEYS = frozenset(
    {
        "content_hash",
        "content_sha256",
        "file_sha256",
        "fingerprint",
        "geometry_fingerprint",
        "geometry_version",
        "hash",
        "manifest_sha256",
        "sha256",
        "source_fingerprint",
        "source_sha256",
        "source_version",
        "sourceVersion",
        "transcript_version_id",
        "version",
    }
)


def _transcript_selector_time_range_valid(*, selector: dict[str, Any]) -> bool:
    t_start_ms = selector.get("t_start_ms")
    t_end_ms = selector.get("t_end_ms")
    if not (
        isinstance(t_start_ms, int)
        and isinstance(t_end_ms, int)
        and t_start_ms >= 0
        and t_end_ms > t_start_ms
    ):
        return False

    return True


def _assert_no_legacy_selector_identity(selector: dict[str, Any]) -> None:
    if _contains_legacy_selector_identity(selector):
        raise RuntimeError("Evidence selector includes legacy artifact identity")


def _contains_legacy_selector_identity(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            key in _LEGACY_SELECTOR_IDENTITY_KEYS or _contains_legacy_selector_identity(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_legacy_selector_identity(child) for child in value)
    return False
