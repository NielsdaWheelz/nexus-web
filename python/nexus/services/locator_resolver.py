"""Backend-owned evidence locator resolution.

Passage quotes resolve against their reading owner's text scope only; resolved offsets
and locators stay canonical (source fragment ids and offsets).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.reader import ResolvedHighlightReaderTarget
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services import reader_locations, text_quote
from nexus.services.media_text_scope import (
    MediaTextScope,
    read_media_text_scope,
    text_scope_rows_sql,
)
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


@dataclass(frozen=True, slots=True)
class HighlightReaderSource:
    media_id: UUID
    media_kind: str
    exact: str
    prefix: str
    suffix: str
    color: HighlightColor
    target: ResolvedHighlightReaderTarget | None


@dataclass(frozen=True, slots=True)
class PassageSourceReads:
    """One batch of owner texts, keyed by reading owner.

    ``media_kinds`` and ``canonical_media`` name the media whose fragments hold an
    owner's words (a piece's source); ``ranges`` are the owner's exact canonical
    intervals ``(fragment_id, start, end)`` and ``sources`` their normalized slices.
    """

    media_kinds: dict[UUID, str]
    canonical_media: dict[UUID, UUID]
    ranges: dict[UUID, list[tuple[UUID, int, int]]]
    sources: dict[UUID, list[text_quote.NormalizedOwnerSource]]
    note_texts: dict[UUID, str]
    pdf_texts: dict[UUID, text_quote.NormalizedText]
    pdf_pages: dict[UUID, list[tuple[int, int, int]]]


def read_passage_sources(db: Session, owners: Sequence[tuple[str, UUID]]) -> PassageSourceReads:
    """Load each source family once for a page of quote selectors; callers prove
    visibility.

    A media owner reads exactly its text scope (``text_scope_rows_sql``): a source whole,
    a piece only its bounded slices with canonical bases, so a quote matches and takes
    context only inside the piece and repeated text outside it cannot make it ambiguous.
    A piece also reads the exact ranges of its permitted notes outside its body, each
    its own slice. A pdf reads its extracted text.
    """
    media_ids = list({id_ for scheme, id_ in owners if scheme == "media"})
    note_ids = list({id_ for scheme, id_ in owners if scheme == "note_block"})
    media = (
        db.execute(
            text(
                "SELECT id, kind, CASE WHEN kind = 'pdf' THEN plain_text END FROM media"
                " WHERE id = ANY(:ids)"
            ),
            {"ids": media_ids},
        ).all()
        if media_ids
        else []
    )
    pdfs = {
        id_: text_quote.normalize_for_match(words or "")
        for id_, kind, words in media
        if kind == "pdf"
    }
    kinds = {id_: kind for id_, kind, _ in media}
    canonical = {id_: id_ for id_, _, _ in media}
    ranges: dict[UUID, list[tuple[UUID, int, int]]] = {id_: [] for id_ in media_ids}
    sources: dict[UUID, list[text_quote.NormalizedOwnerSource]] = {id_: [] for id_ in media_ids}
    text_ids = [id_ for id_, kind, _ in media if kind != "pdf"]
    if text_ids:
        scopes = text_scope_rows_sql("SELECT unnest(CAST(:ids AS uuid[])) AS media_id")
        for (
            owner,
            source_id,
            source_kind,
            fragment_id,
            words,
            t_start,
            t_end,
            start,
            end,
        ) in db.execute(
            text(f"""
                SELECT scope.reading_media_id, scope.source_media_id, source.kind, f.id,
                       f.canonical_text, f.t_start_ms, f.t_end_ms, scope.start_offset,
                       scope.end_offset
                FROM ({scopes}) scope
                JOIN fragments f ON f.id = scope.fragment_id
                JOIN media source ON source.id = scope.source_media_id
                ORDER BY scope.reading_media_id, scope.fragment_idx
                """),
            {"ids": text_ids},
        ):
            kinds[owner], canonical[owner] = source_kind, source_id
            ranges[owner].append((fragment_id, start, end))
            sources[owner].append(
                text_quote.NormalizedOwnerSource(
                    fragment_id,
                    t_start,
                    t_end,
                    text_quote.normalize_for_match(words[start:end]),
                    start,
                    start > 0,
                    end < len(words),
                )
            )
    notes_of = {
        id_: sorted(set(permitted_note_ranges(db, read_media_text_scope(db, id_)).values()))
        for id_, kind, _ in media
        if kind == "text_part"
    }
    note_fragment_ids = list({fragment for owned in notes_of.values() for fragment, _, _ in owned})
    if note_fragment_ids:
        fragments = {
            row.id: row
            for row in db.execute(
                text(
                    "SELECT id, canonical_text, t_start_ms, t_end_ms FROM fragments"
                    " WHERE id = ANY(:ids)"
                ),
                {"ids": note_fragment_ids},
            )
        }
        for owner, owned in notes_of.items():
            for fragment_id, start, end in owned:
                fragment = fragments[fragment_id]
                ranges[owner].append((fragment_id, start, end))
                sources[owner].append(
                    text_quote.NormalizedOwnerSource(
                        fragment_id,
                        fragment.t_start_ms,
                        fragment.t_end_ms,
                        text_quote.normalize_for_match(fragment.canonical_text[start:end]),
                        start,
                        start > 0,
                        end < len(fragment.canonical_text),
                    )
                )
    notes = (
        {
            id_: words
            for id_, words in db.execute(
                text("SELECT id,body_text FROM note_blocks WHERE id=ANY(:ids)"), {"ids": note_ids}
            )
        }
        if note_ids
        else {}
    )
    pages: dict[UUID, list[tuple[int, int, int]]] = {id_: [] for id_ in pdfs}
    if pdfs:
        for owner, page, start, end in db.execute(
            text(
                "SELECT media_id,page_number,start_offset,end_offset FROM pdf_page_text_spans WHERE media_id=ANY(:ids) ORDER BY page_number"
            ),
            {"ids": list(pdfs)},
        ):
            pages[owner].append((page, start, end))
    return PassageSourceReads(kinds, canonical, ranges, sources, notes, pdfs, pages)


def permitted_note_ranges(db: Session, scope: MediaTextScope) -> dict[UUID, tuple[UUID, int, int]]:
    """The whole exact source ranges of a piece's permitted notes, each its own slice.

    Only an exact text locator on the piece's source contributes; any other locator adds
    no words and never widens the body. A note overlapping the body keeps its complete
    range (the matcher counts an occurrence both slices hold once); one wholly inside the
    body adds nothing. Ranges are never united or bridged across gaps.
    """
    out: dict[UUID, tuple[UUID, int, int]] = {}
    for item_id, locator in db.execute(
        text("""
            SELECT id, locator FROM reader_apparatus_items
            WHERE id = ANY(:ids) AND locator_status = 'exact'
              AND locator ->> 'type' IN ('web_text_offsets', 'epub_fragment_offsets')
              AND locator ->> 'media_id' = :source
        """),
        {"ids": list(scope.permitted_apparatus), "source": str(scope.source_media_id)},
    ):
        fragment_id = UUID(str(locator["fragment_id"]))
        start, end = int(locator["start_offset"]), int(locator["end_offset"])
        if start < end and not scope.contains(fragment_id, start, end):
            out[item_id] = (fragment_id, start, end)
    return out


def admits_passage(
    reads: PassageSourceReads, owner_id: UUID, fragment_id: UUID, start: int, end: int
) -> bool:
    """Whether canonical ``[start, end)`` of ``fragment_id`` lies wholly inside one of the
    owner's exact ranges (its body or one permitted note): the target proof for a
    passage under its reading owner."""
    return start < end and any(
        owned == fragment_id and lo <= start and end <= hi
        for owned, lo, hi in reads.ranges.get(owner_id, [])
    )


def read_highlight_reader_source(
    db: Session, *, highlight_id: UUID
) -> HighlightReaderSource | None:
    return read_highlight_reader_sources(db, highlight_ids=[highlight_id]).get(highlight_id)


def read_highlight_reader_sources(
    db: Session, *, highlight_ids: Sequence[UUID]
) -> dict[UUID, HighlightReaderSource]:
    """Read quote, colour and complete anchor in one database snapshot.

    This trusted read performs no authorization. Authenticated and public callers must
    establish their own audience authority before calling it. Missing highlights
    are omitted; incoherent, stale and unsupported anchors have ``target=None``.
    """
    if not highlight_ids:
        return {}
    rows = (
        db.execute(
            text(
                """
                SELECT h.id, h.anchor_kind, h.anchor_media_id, h.exact, h.prefix, h.suffix, h.color,
                       m.kind AS media_kind, m.page_count,
                       hfa.fragment_id, hfa.start_offset, hfa.end_offset,
                       f.canonical_text AS fragment_text, f.t_start_ms, f.t_end_ms,
                       hpa.page_number, ppts.page_width, ppts.page_height,
                       (SELECT jsonb_agg(jsonb_build_object(
                           'x1',q.x1,'y1',q.y1,'x2',q.x2,'y2',q.y2,
                           'x3',q.x3,'y3',q.y3,'x4',q.x4,'y4',q.y4
                        ) ORDER BY q.quad_idx)
                        FROM highlight_pdf_quads q WHERE q.highlight_id=h.id) AS quads
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                LEFT JOIN fragments f
                  ON f.id = hfa.fragment_id AND f.media_id = h.anchor_media_id
                LEFT JOIN highlight_pdf_anchors hpa
                  ON hpa.highlight_id = h.id AND hpa.media_id = h.anchor_media_id
                LEFT JOIN pdf_page_text_spans ppts
                  ON ppts.media_id = h.anchor_media_id AND ppts.page_number = hpa.page_number
                WHERE h.id = ANY(:highlight_ids)
                """
            ),
            {"highlight_ids": list(highlight_ids)},
        )
        .mappings()
        .all()
    )
    return {row["id"]: _highlight_reader_source(row) for row in rows}


def _highlight_reader_source(row: RowMapping) -> HighlightReaderSource:
    def number(column: str, cast: Any) -> Any:
        return cast(row[column]) if row[column] is not None else None

    target = reader_locations.resolved_highlight_reader_target(
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
        pdf_quads=row["quads"],
    )
    return HighlightReaderSource(
        media_id=row["anchor_media_id"],
        media_kind=row["media_kind"],
        exact=row["exact"],
        prefix=row["prefix"],
        suffix=row["suffix"],
        color=cast(HighlightColor, row["color"]),
        target=target,
    )


def resolve_highlight_reader_target(
    db: Session, *, highlight_id: UUID
) -> ResolvedHighlightReaderTarget | None:
    source = read_highlight_reader_source(db, highlight_id=highlight_id)
    return source.target if source is not None else None


def resolve_passage_selector(
    db: Session,
    *,
    owner_scheme: str,
    owner_id: UUID,
    exact: str,
    prefix: str = "",
    suffix: str = "",
    locator_hint: dict[str, Any] | None = None,
    source_reads: PassageSourceReads | None = None,
) -> PassageSelectorResolution:
    """Resolve a normalized passage quote against its owner's CURRENT text.

    Quote identity (``exact``/``prefix``/``suffix``, already normalized) is matched by
    the shared unique/ambiguous/no-match matchers; the replaceable ``locator_hint``
    only contributes presentation geometry the text match cannot recompute (PDF quads,
    time range), and only when consistent with the unique match. No status is
    persisted. A list read supplies one ``source_reads`` batch for all its owners.
    """
    if not exact:
        return PassageSelectorResolution(QuoteStatus.empty_exact, "", "", None)
    hint: dict[str, Any] = locator_hint if isinstance(locator_hint, dict) else {}
    reads = source_reads or read_passage_sources(db, [(owner_scheme, owner_id)])
    if owner_scheme == "media":
        kind = reads.media_kinds.get(owner_id)
        if kind is None:
            return PassageSelectorResolution(QuoteStatus.no_match, "", "", None)
        if kind == "pdf":
            return _resolve_pdf_passage(
                reads, media_id=owner_id, exact=exact, prefix=prefix, suffix=suffix, hint=hint
            )
    if owner_scheme == "note_block":
        words = reads.note_texts.get(owner_id)
        if words is None:
            return PassageSelectorResolution(QuoteStatus.no_match, "", "", None)
        sources = [
            text_quote.NormalizedOwnerSource(
                None, None, None, text_quote.normalize_for_match(words)
            )
        ]
        match = text_quote.match_quote_in_sources(
            sources, exact=exact, prefix=prefix, suffix=suffix
        )
        match = text_quote.project_note_match(words, match, exact=exact)
    else:
        match = text_quote.match_quote_in_sources(
            reads.sources.get(owner_id, []), exact=exact, prefix=prefix, suffix=suffix
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
    reads: PassageSourceReads,
    *,
    media_id: UUID,
    exact: str,
    prefix: str,
    suffix: str,
    hint: dict[str, Any],
) -> PassageSelectorResolution:
    normalized = reads.pdf_texts[media_id]
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
    page_number = next(
        (page for page, start, end in reads.pdf_pages[media_id] if start <= hit.raw_start < end),
        None,
    )

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


def evidence_resolution(
    *,
    evidence_span_id: UUID,
    owner_id: UUID,
    span_text: str,
    selector: dict[str, Any],
    resolver_kind: str,
) -> dict[str, Any]:
    """Resolve one read, authorized evidence span into its resolver status and geometry.

    The status is a predicate on the selector alone: ``publish_content_index``, the only
    writer, inserts each span with ``span_text`` equal to ``selector.text_quote.exact``, and
    nothing updates it.
    """
    raw_quote = selector.get("text_quote")
    stored_quote: dict[str, Any] = raw_quote if isinstance(raw_quote, dict) else {}
    quote = {
        "exact": str(stored_quote.get("exact") or span_text),
        "prefix": str(stored_quote.get("prefix") or ""),
        "suffix": str(stored_quote.get("suffix") or ""),
    }
    span_id = str(evidence_span_id)
    status = "unresolved"
    highlight: dict[str, Any] | None = None
    start_offset = selector.get("start_offset")
    end_offset = selector.get("end_offset")

    if resolver_kind in ("web", "epub"):
        fragment_id = selector.get("fragment_id")
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
    ``search`` (content-chunk and evidence-span results) and ``resource_items.locations``.
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
            "projection": geometry.get("projection"),
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
        locator = {
            "type": "note_block_offsets",
            "block_id": selector.get("note_block_id"),
            "text_quote_selector": quote_selector,
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
        }
    else:
        raise AssertionError("Resolved evidence has unsupported resolver kind")

    validated = retrieval_locator_json(locator)
    if validated is None:
        raise AssertionError("Resolved evidence locator is required")
    return validated
