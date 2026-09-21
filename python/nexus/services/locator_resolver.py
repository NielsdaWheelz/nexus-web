"""Backend-owned evidence locator resolution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader import ResolvedHighlightReaderTarget
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import reader_locations, text_quote
from nexus.services.text_quote import QuoteStatus

ResolverStatus = Literal["resolved", "unresolved", "no_geometry"]
_MEDIA_RESOLVER_KINDS = frozenset({"web", "epub", "pdf", "transcript"})


@dataclass(frozen=True, slots=True)
class LocatorResolution:
    params: dict[str, str]
    status: ResolverStatus
    highlight: dict[str, Any] | None


@dataclass(frozen=True, slots=True)
class PassageSelectorResolution:
    """Live resolution of a passage-anchor quote within its owner.

    ``prefix``/``suffix`` are the recomputed 64-normalized-scalar context windows and
    ``locator`` a current locator-hint-shaped dict, both set only when the quote
    resolves uniquely. Ambiguity/no-match is explicit — never first-occurrence, and
    locator hints never disambiguate identity.
    """

    status: QuoteStatus
    prefix: str
    suffix: str
    locator: dict[str, Any] | None


def resolve_highlight_reader_target(
    db: Session, *, highlight_id: UUID
) -> ResolvedHighlightReaderTarget | None:
    """Resolve one highlight against current reader-owned source rows.

    This trusted read performs no authorization. Authenticated and public callers must
    establish their own audience authority before calling it. Missing, incoherent,
    stale, and unsupported anchor facts return ``None``.
    """
    row = (
        db.execute(
            text(
                """
                SELECT h.anchor_kind, h.anchor_media_id, h.exact,
                       m.kind AS media_kind, m.page_count,
                       hfa.fragment_id, hfa.start_offset, hfa.end_offset,
                       f.canonical_text AS fragment_text, f.t_start_ms, f.t_end_ms,
                       hpa.page_number, ppts.page_width, ppts.page_height
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                LEFT JOIN fragments f
                  ON f.id = hfa.fragment_id AND f.media_id = h.anchor_media_id
                LEFT JOIN highlight_pdf_anchors hpa
                  ON hpa.highlight_id = h.id AND hpa.media_id = h.anchor_media_id
                LEFT JOIN pdf_page_text_spans ppts
                  ON ppts.media_id = h.anchor_media_id AND ppts.page_number = hpa.page_number
                WHERE h.id = :highlight_id
                """
            ),
            {"highlight_id": highlight_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None

    raw_quads: list[dict[str, object]] | None = None
    if row["anchor_kind"] == "pdf_page_geometry":
        raw_quads = [
            dict(quad)
            for quad in db.execute(
                text(
                    """
                    SELECT x1, y1, x2, y2, x3, y3, x4, y4
                    FROM highlight_pdf_quads
                    WHERE highlight_id = :highlight_id
                    ORDER BY quad_idx ASC
                    """
                ),
                {"highlight_id": highlight_id},
            )
            .mappings()
            .all()
        ]

    def number(column: str, cast: Any) -> Any:
        return cast(row[column]) if row[column] is not None else None

    return reader_locations.resolved_highlight_reader_target(
        media_kind=str(row["media_kind"]),
        anchor_kind=str(row["anchor_kind"]),
        fragment_id=UUID(str(row["fragment_id"])) if row["fragment_id"] is not None else None,
        exact=str(row["exact"]),
        fragment_text=str(row["fragment_text"]) if row["fragment_text"] is not None else None,
        start_offset=number("start_offset", int),
        end_offset=number("end_offset", int),
        t_start_ms=number("t_start_ms", int),
        t_end_ms=number("t_end_ms", int),
        page_number=number("page_number", int),
        page_count=number("page_count", int),
        page_width=number("page_width", float),
        page_height=number("page_height", float),
        pdf_quads=raw_quads,
    )


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

    Quote identity (``exact``/``prefix``/``suffix``, already normalized) is matched by
    the shared unique/ambiguous/no-match matchers; the replaceable ``locator_hint``
    only contributes presentation geometry the text match cannot recompute (PDF quads,
    time range), and only when consistent with the unique match. No status is
    persisted. ``sources_cache`` memoizes the owner-media fetch+normalize across quotes
    that share one owner.
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
    db: Session, *, viewer_id: UUID, evidence_span_id: UUID
) -> dict[str, Any]:
    """Resolve one stored evidence span into live reader routing params and geometry."""
    row = (
        db.execute(
            text(
                """
                SELECT owner_kind, owner_id, span_text, selector, citation_label, resolver_kind
                FROM evidence_spans
                WHERE id = :evidence_span_id
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
    owner_id: UUID = row["owner_id"]
    resolver_kind = str(row["resolver_kind"])
    selector: dict[str, Any] = row["selector"] if isinstance(row["selector"], dict) else {}
    span_text = str(row["span_text"] or "")
    quote = _quote_selector(selector, span_text)

    if owner_kind == "media" and resolver_kind in _MEDIA_RESOLVER_KINDS:
        if not can_read_media(db, viewer_id, owner_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")
        snapshot_matches = _evidence_span_snapshot_matches(
            db, evidence_span_id=evidence_span_id, exact=quote["exact"]
        )
        route_id = str(owner_id)
    elif owner_kind == "note_block" and resolver_kind == "note":
        if not _can_read_note(db, viewer_id=viewer_id, note_block_id=owner_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")
        snapshot_matches = False
        route_id = str(selector.get("note_block_id") or owner_id)
    else:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    resolution = _resolve_selector(
        resolver_kind,
        selector,
        evidence_span_id=evidence_span_id,
        quote=quote,
        snapshot_matches=snapshot_matches,
    )
    return {
        "evidence_span_id": str(evidence_span_id),
        "media_id": route_id,
        "citation_label": str(row["citation_label"]),
        "span_text": span_text,
        "resolver": {
            "kind": resolver_kind,
            "params": {"evidence": str(evidence_span_id), **resolution.params},
            "status": resolution.status,
            "selector": selector,
            "highlight": resolution.highlight,
        },
    }


def _resolve_selector(
    resolver_kind: str,
    selector: dict[str, Any],
    *,
    evidence_span_id: UUID,
    quote: dict[str, str],
    snapshot_matches: bool,
) -> LocatorResolution:
    """Build the routing params and, when the span still reconstructs, the highlight."""
    params: dict[str, str] = {}
    status: ResolverStatus = "unresolved"
    highlight: dict[str, Any] | None = None
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")

    if resolver_kind in ("web", "epub"):
        section_id = selector.get("section_id")
        fragment_id = selector.get("fragment_id")
        if resolver_kind == "epub" and isinstance(section_id, str):
            params["loc"] = section_id
        if isinstance(fragment_id, str):
            params["fragment"] = fragment_id
        if (
            isinstance(fragment_id, str)
            and isinstance(start_offset, int)
            and isinstance(end_offset, int)
            and snapshot_matches
        ):
            status = "resolved"
            highlight = {
                "kind": "web_text" if resolver_kind == "web" else "epub_text",
                "evidence_span_id": str(evidence_span_id),
                "fragment_id": fragment_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": quote,
            }
    elif resolver_kind == "pdf":
        page_number = selector.get("page_number")
        raw_geometry = selector.get("geometry")
        geometry: dict[str, Any] = raw_geometry if isinstance(raw_geometry, dict) else {}
        quads = _pdf_quads_from_geometry(geometry)
        if isinstance(page_number, int) and page_number >= 1:
            params["page"] = str(page_number)
            if snapshot_matches:
                status = "resolved" if quads else "no_geometry"
                page_label = selector.get("page_label")
                highlight = {
                    "kind": "pdf_text",
                    "evidence_span_id": str(evidence_span_id),
                    "page_number": page_number,
                    "page_label": page_label if isinstance(page_label, str) else None,
                    "text_quote": quote,
                    "geometry": {**geometry, "quads": quads} if quads else None,
                }
    elif resolver_kind == "transcript":
        t_start_ms = selector.get("t_start_ms")
        t_end_ms = selector.get("t_end_ms")
        if isinstance(t_start_ms, int) and t_start_ms >= 0:
            params["t_start_ms"] = str(t_start_ms)
        if (
            isinstance(t_start_ms, int)
            and isinstance(t_end_ms, int)
            and t_start_ms >= 0
            and t_end_ms > t_start_ms
            and snapshot_matches
        ):
            status = "resolved"
            highlight = {
                "kind": "transcript_time_text",
                "evidence_span_id": str(evidence_span_id),
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "text_quote": quote,
            }
    elif resolver_kind == "note":
        note_block_id = selector.get("note_block_id")
        if (
            isinstance(note_block_id, str)
            and isinstance(start_offset, int)
            and isinstance(end_offset, int)
            and start_offset >= 0
            and end_offset > start_offset
        ):
            params["note_block"] = note_block_id
            status = "resolved"
            highlight = {
                "kind": "note_text",
                "evidence_span_id": str(evidence_span_id),
                "note_block_id": note_block_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": quote,
            }
    return LocatorResolution(params=params, status=status, highlight=highlight)


def _quote_selector(selector: dict[str, Any], span_text: str) -> dict[str, str]:
    raw_quote = selector.get("text_quote")
    quote: dict[str, Any] = raw_quote if isinstance(raw_quote, dict) else {}
    return {
        "exact": str(quote.get("exact") or span_text or ""),
        "prefix": str(quote.get("prefix") or ""),
        "suffix": str(quote.get("suffix") or ""),
    }


_QUAD_KEYS = ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4")


def _pdf_quads_from_geometry(geometry: dict[str, Any]) -> list[dict[str, float]]:
    raw_quads = geometry.get("quads")
    quads: list[dict[str, float]] = []
    for raw_quad in raw_quads if isinstance(raw_quads, list) else []:
        if not isinstance(raw_quad, dict):
            continue
        quad: dict[str, float] = {}
        for key in _QUAD_KEYS:
            value = raw_quad.get(key)
            if not isinstance(value, int | float):
                quad = {}
                break
            quad[key] = float(value)
        if quad:
            quads.append(quad)
    return quads


def _can_read_note(db: Session, *, viewer_id: UUID, note_block_id: UUID) -> bool:
    row = db.execute(
        text("SELECT user_id FROM note_blocks WHERE id = :note_block_id"),
        {"note_block_id": note_block_id},
    ).first()
    return row is not None and row[0] == viewer_id


def _evidence_span_snapshot_matches(db: Session, *, evidence_span_id: UUID, exact: str) -> bool:
    """True when the stored span text still reconstructs from the current blocks."""
    rows = (
        db.execute(
            text(
                """
                SELECT es.span_text, es.start_block_id, es.end_block_id,
                       es.start_block_offset, es.end_block_offset,
                       start_block.block_idx AS start_block_idx,
                       end_block.block_idx AS end_block_idx,
                       cb.id AS block_id, cb.block_idx, cb.canonical_text
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

    start_idx = int(rows[0]["start_block_idx"])
    end_idx = int(rows[0]["end_block_idx"])
    if start_idx > end_idx:
        return False
    parts: list[str] = []
    expected_block_idx = start_idx
    for row in rows:
        block_idx = int(row["block_idx"])
        if block_idx != expected_block_idx:
            return False
        block_text = str(row["canonical_text"] or "")
        block_start = int(row["start_block_offset"]) if block_idx == start_idx else 0
        block_end = int(row["end_block_offset"]) if block_idx == end_idx else len(block_text)
        if block_start < 0 or block_end < block_start or block_end > len(block_text):
            return False
        parts.append(block_text[block_start:block_end])
        expected_block_idx += 1
    if expected_block_idx != end_idx + 1:
        return False
    if (
        rows[0]["block_id"] != rows[0]["start_block_id"]
        or rows[-1]["block_id"] != rows[0]["end_block_id"]
    ):
        return False
    span_text = str(rows[0]["span_text"] or "")
    return "".join(parts) == span_text and span_text == exact


def locator_from_resolution(
    resolution: dict[str, Any], *, media_id: UUID, media_kind: str
) -> dict[str, Any]:
    """Map a ``resolve_evidence_span`` resolution to a validated retrieval locator.

    The single owner of the resolver-kind -> ``RetrievalLocator`` mapping, shared by
    ``search`` (content-chunk results) and the Universal Dossier citation producer.
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
        section_id = selector.get("section_id")
        locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(media_id),
            "section_id": section_id if isinstance(section_id, str) else None,
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "media_kind": media_kind,
            "text_quote_selector": quote_selector,
        }
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
