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
from nexus.services import text_quote
from nexus.services.text_quote import QuoteStatus

ResolverStatus = Literal["resolved", "unresolved", "no_geometry"]


@dataclass(frozen=True)
class LocatorResolution:
    params: dict[str, str]
    status: ResolverStatus
    highlight: dict[str, Any] | None


@dataclass(frozen=True, slots=True)
class PassageSelectorResolution:
    """Live resolution of a passage-anchor quote within its owner.

    ``prefix``/``suffix`` are the recomputed 64-normalized-scalar context
    windows and ``locator`` a current locator-hint-shaped dict, both set only
    when the quote resolves uniquely. Ambiguity/no-match is explicit — never
    first-occurrence, and locator hints never disambiguate identity.
    """

    status: QuoteStatus
    prefix: str
    suffix: str
    locator: dict[str, Any] | None


def resolve_passage_selector(
    db: Session,
    *,
    owner_scheme: str,
    owner_id: UUID,
    exact: str,
    prefix: str = "",
    suffix: str = "",
    locator_hint: dict[str, Any] | None = None,
    sources_cache: text_quote.MediaSourceCache | None = None,
) -> PassageSelectorResolution:
    """Resolve a normalized passage quote against its owner's CURRENT text.

    Quote identity (``exact``/``prefix``/``suffix``, already normalized) is
    matched by the shared unique/ambiguous/no-match matchers; the replaceable
    ``locator_hint`` only contributes presentation geometry the text match
    cannot recompute (PDF quads, time range), and only when consistent with
    the unique match. No status is persisted. ``sources_cache`` memoizes the
    owner-media fetch+normalize across quotes that share one owner.
    """
    if not exact:
        return PassageSelectorResolution(QuoteStatus.empty_exact, "", "", None)
    hint: dict[str, Any] = locator_hint if isinstance(locator_hint, dict) else {}

    if owner_scheme == "media":
        kind = db.execute(
            text("SELECT kind FROM media WHERE id = :media_id"), {"media_id": owner_id}
        ).scalar()
        if kind is None:
            return PassageSelectorResolution(QuoteStatus.no_match, "", "", None)
        if kind == "pdf":
            return _resolve_pdf_passage(
                db, media_id=owner_id, exact=exact, prefix=prefix, suffix=suffix, hint=hint
            )

    match = text_quote.resolve_owner_quote(
        db,
        owner_scheme=owner_scheme,
        owner_id=owner_id,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
        sources_cache=sources_cache,
    )
    if match.status is not QuoteStatus.unique:
        return PassageSelectorResolution(match.status, "", "", None)

    locator: dict[str, Any]
    if owner_scheme == "note_block":
        locator = {"kind": "text", "start_offset": match.raw_start, "end_offset": match.raw_end}
    elif hint.get("kind") == "time" and match.t_start_ms is not None:
        # Times are recomputed from the matched fragment, not trusted from the hint.
        locator = {"kind": "time", "t_start_ms": match.t_start_ms, "t_end_ms": match.t_end_ms}
    else:
        locator = {
            "kind": "text",
            "fragment_id": str(match.fragment_id),
            "start_offset": match.raw_start,
            "end_offset": match.raw_end,
        }
    return PassageSelectorResolution(QuoteStatus.unique, match.prefix, match.suffix, locator)


def _resolve_pdf_passage(
    db: Session,
    *,
    media_id: UUID,
    exact: str,
    prefix: str,
    suffix: str,
    hint: dict[str, Any],
) -> PassageSelectorResolution:
    plain_text = db.execute(
        text("SELECT plain_text FROM media WHERE id = :media_id"), {"media_id": media_id}
    ).scalar()
    normalized = text_quote.normalize_for_match(plain_text or "")
    candidates = text_quote.find_quote_candidates(
        normalized, exact=exact, prefix=prefix, suffix=suffix
    )
    if len(candidates) > 1:
        return PassageSelectorResolution(QuoteStatus.ambiguous, "", "", None)
    if not candidates:
        return PassageSelectorResolution(QuoteStatus.no_match, "", "", None)

    hit = candidates[0]
    context_prefix, context_suffix = text_quote.context_window(
        normalized, start=hit.normalized_start, end=hit.normalized_end
    )
    page_number = db.execute(
        text(
            """
            SELECT page_number FROM pdf_page_text_spans
            WHERE media_id = :media_id
              AND start_offset <= :offset AND :offset < end_offset
            ORDER BY page_number
            LIMIT 1
            """
        ),
        {"media_id": media_id, "offset": hit.raw_start},
    ).scalar()

    locator: dict[str, Any] | None = None
    if page_number is not None:
        locator = {"kind": "pdf", "page_number": int(page_number)}
        if (
            hint.get("kind") == "pdf"
            and hint.get("page_number") == int(page_number)
            and isinstance(hint.get("quads"), list)
        ):
            locator["quads"] = hint["quads"]
    return PassageSelectorResolution(QuoteStatus.unique, context_prefix, context_suffix, locator)


def resolve_evidence_span(
    db: Session,
    *,
    viewer_id: UUID,
    evidence_span_id: UUID,
) -> dict[str, Any]:
    row = (
        db.execute(
            text(
                """
            SELECT
                es.id,
                es.owner_kind,
                es.owner_id AS media_id,
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
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    owner_kind = str(row["owner_kind"])
    owner_id: UUID = row["media_id"]

    if owner_kind == "media":
        return _resolve_media_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=owner_id,
            evidence_span_id=evidence_span_id,
            row=row,
        )
    if owner_kind == "note_block":
        return _resolve_note_evidence_span(
            db,
            viewer_id=viewer_id,
            note_block_id=owner_id,
            evidence_span_id=evidence_span_id,
            row=row,
        )
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")


def _resolve_media_evidence_span(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
    row: Any,
) -> dict[str, Any]:
    if not can_read_media(db, viewer_id, media_id):
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


def _resolve_note_evidence_span(
    db: Session,
    *,
    viewer_id: UUID,
    note_block_id: UUID,
    evidence_span_id: UUID,
    row: Any,
) -> dict[str, Any]:
    if str(row["resolver_kind"]) != "note":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")
    if not _can_read_note(db, viewer_id=viewer_id, note_block_id=note_block_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    selector: dict[str, Any] = row["selector"] if isinstance(row["selector"], dict) else {}
    _assert_no_legacy_selector_identity(selector)

    resolution = _resolve_note_selector(
        selector,
        evidence_span_id=evidence_span_id,
        span_text=str(row["span_text"] or ""),
    )

    params: dict[str, str] = {"evidence": str(evidence_span_id)}
    params.update(resolution.params)
    route_note_block_id = str(selector.get("note_block_id") or note_block_id)

    return {
        "evidence_span_id": str(evidence_span_id),
        "media_id": route_note_block_id,
        "citation_label": str(row["citation_label"]),
        "span_text": str(row["span_text"] or ""),
        "resolver": {
            "kind": "note",
            "route": f"/notes/{route_note_block_id}",
            "params": params,
            "status": resolution.status,
            "selector": selector,
            "highlight": resolution.highlight,
        },
    }


def _resolve_note_selector(
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    span_text: str,
) -> LocatorResolution:
    """Build a note resolution from the start_block's `note_text` selector.

    The selector shape (also the chunk's `summary_locator`) is
    ``{"kind":"note_text","note_block_id":<uuid>,"start_offset":int,
       "end_offset":int,"text_quote":{...}}``.
    """
    raw_text_quote = selector.get("text_quote")
    text_quote: dict[str, Any] = raw_text_quote if isinstance(raw_text_quote, dict) else {}
    exact = str(text_quote.get("exact") or span_text or "")
    prefix = str(text_quote.get("prefix") or "")
    suffix = str(text_quote.get("suffix") or "")
    text_quote_out = {"exact": exact, "prefix": prefix, "suffix": suffix}

    note_block_id = selector.get("note_block_id")
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")

    resolved = (
        isinstance(note_block_id, str)
        and isinstance(start_offset, int)
        and isinstance(end_offset, int)
        and start_offset >= 0
        and end_offset > start_offset
    )
    if resolved:
        return LocatorResolution(
            params={"note_block": str(note_block_id)},
            status="resolved",
            highlight={
                "kind": "note_text",
                "evidence_span_id": str(evidence_span_id),
                "note_block_id": note_block_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": text_quote_out,
            },
        )
    return LocatorResolution(params={}, status="unresolved", highlight=None)


def _can_read_note(db: Session, *, viewer_id: UUID, note_block_id: UUID) -> bool:
    row = db.execute(
        text("SELECT user_id FROM note_blocks WHERE id = :note_block_id"),
        {"note_block_id": note_block_id},
    ).first()
    return row is not None and row[0] == viewer_id


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
    elif kind == "note":
        # `note_block_offsets` forbids extra keys, so no media_id/text_quote_selector.
        locator = {
            "type": "note_block_offsets",
            "block_id": selector.get("note_block_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
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
                 AND start_block.owner_kind = es.owner_kind AND start_block.owner_id = es.owner_id
                JOIN content_blocks end_block
                  ON end_block.id = es.end_block_id
                 AND end_block.owner_kind = es.owner_kind AND end_block.owner_id = es.owner_id
                JOIN content_blocks cb
                  ON cb.owner_kind = es.owner_kind AND cb.owner_id = es.owner_id
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
