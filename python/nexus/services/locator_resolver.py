"""Backend-owned evidence locator resolution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader import ResolvedHighlightReaderTarget
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import reader_locations, text_quote
from nexus.services.text_quote import QuoteStatus


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
    """Read one evidence span, authorize it for ``viewer_id``, and resolve it."""
    row = (
        db.execute(
            text(
                """
                SELECT owner_kind, owner_id, span_text, selector, resolver_kind
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
    if row["owner_kind"] == "media" and row["resolver_kind"] != "note":
        readable = can_read_media(db, viewer_id, row["owner_id"])
    elif row["owner_kind"] == "note_block" and row["resolver_kind"] == "note":
        readable = viewer_id == db.scalar(
            text("SELECT user_id FROM note_blocks WHERE id = :id"), {"id": row["owner_id"]}
        )
    else:
        readable = False
    if not readable:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")
    return evidence_resolution(
        evidence_span_id=evidence_span_id,
        owner_id=row["owner_id"],
        span_text=row["span_text"],
        selector=row["selector"],
        resolver_kind=row["resolver_kind"],
    )


def evidence_resolution(
    *,
    evidence_span_id: UUID,
    owner_id: UUID,
    span_text: str,
    selector: dict[str, Any],
    resolver_kind: str,
) -> dict[str, Any]:
    """Resolve one read, authorized evidence span into reader routing params and geometry.

    The status is a predicate on the selector alone. The span is not re-proved against
    ``content_blocks``: ``publish_content_index``, the only writer, inserts a span with
    its blocks in one transaction, its ``span_text`` equal to their slices and to
    ``selector.text_quote.exact``, and nothing updates either table.
    """
    raw_quote = selector.get("text_quote")
    stored_quote: dict[str, Any] = raw_quote if isinstance(raw_quote, dict) else {}
    quote = {
        "exact": str(stored_quote.get("exact") or span_text),
        "prefix": str(stored_quote.get("prefix") or ""),
        "suffix": str(stored_quote.get("suffix") or ""),
    }
    span_id = str(evidence_span_id)
    params = {"evidence": span_id}
    status = "unresolved"
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
        ):
            status = "resolved"
            highlight = {
                "kind": "web_text" if resolver_kind == "web" else "epub_text",
                "evidence_span_id": span_id,
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
            status = "resolved" if quads else "no_geometry"
            page_label = selector.get("page_label")
            highlight = {
                "kind": "pdf_text",
                "evidence_span_id": span_id,
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
        ):
            status = "resolved"
            highlight = {
                "kind": "transcript_time_text",
                "evidence_span_id": span_id,
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
                "evidence_span_id": span_id,
                "note_block_id": note_block_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": quote,
            }
    return {
        "evidence_span_id": span_id,
        "media_id": str(owner_id),
        "span_text": span_text,
        "resolver": {
            "kind": resolver_kind,
            "params": params,
            "status": status,
            "selector": selector,
            "highlight": highlight,
        },
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


def locator_from_resolution(
    resolution: dict[str, Any], *, media_id: UUID, media_kind: str
) -> dict[str, Any] | None:
    """Map resolved evidence to a validated positional locator, otherwise none.

    The single owner of the resolver-kind -> ``RetrievalLocator`` mapping, shared by
    ``search`` (content-chunk and evidence-span results) and ``reader_targets``.
    """
    resolver = resolution["resolver"]
    if resolver["status"] != "resolved":
        return None
    selector = resolver["selector"]
    quote_selector = resolver["highlight"]["text_quote"]

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
            "exact": quote_selector["exact"],
            "prefix": quote_selector["prefix"],
            "suffix": quote_selector["suffix"],
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
