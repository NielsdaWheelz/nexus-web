"""Where words land now: the one proof that a frozen or current location still names the
same words in the current publication.

``current_locator`` judges one captured passage target against batched current reads
(I7). ``current_passages`` derives the current extent of evidence spans, content chunks
and oracle passage anchors and proves it the same way, so routing gives such a passage an
href exactly when capture would freeze a passage target for it now (I17). Reads only: a
moved or missing source answers ``None``, never an error. The caller proves visibility.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.resource_evidence import CapturedPassageTarget, CapturedQuote
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    PdfPageGeometryLocator,
    PdfPageLocator,
    PlaybackTimeRangeLocator,
    TranscriptTimeRangeLocator,
    WebTextOffsetsLocator,
)
from nexus.services import locator_resolver, text_quote
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref

if TYPE_CHECKING:
    from nexus.services.note_bodies import NoteSource

TIMED_KINDS = ("transcript_time_range", "audio_time_range", "video_time_range")
# Locator kinds whose offsets name their own words; the others borrow the captured quote.
_OFFSET_WORDS = (
    "note_block_offsets",
    "message_offsets",
    "web_text_offsets",
    "epub_fragment_offsets",
)


@dataclass(frozen=True, slots=True)
class CurrentPassage:
    """A span, chunk or oracle anchor now: the resource holding its words, the words, and
    where they land (``None`` when they land nowhere provable)."""

    owner: ResourceRef
    quote: CapturedQuote
    locator: dict[str, Any] | None


def source_identities(db: Session, media_ids: Sequence[UUID]) -> dict[UUID, str]:
    """A media's publication identity: its reader generation, else a transcript's unit
    identity; a document without a publication has none."""
    if not media_ids:
        return {}
    from nexus.services.reader_document import transcript_identity

    rows = db.execute(
        text("""
        SELECT m.id, m.kind, r.generation,
          ARRAY(SELECT f.id::text FROM fragments f WHERE f.media_id = m.id
                ORDER BY f.t_start_ms NULLS LAST, f.idx) AS unit_ids
        FROM media m LEFT JOIN reader_publications r ON r.media_id = m.id
        WHERE m.id = ANY(:ids)
        """),
        {"ids": list(media_ids)},
    )
    return {
        row.id: f"g{row.generation}"
        if row.generation is not None
        else transcript_identity(row.unit_ids)
        for row in rows
        if row.generation is not None or row.kind in ("podcast_episode", "video")
    }


@dataclass(frozen=True, slots=True)
class LocationReads:
    """What ``current_locator`` reads; ``changed``: media whose publication moved meanwhile."""

    changed: set[UUID]
    identities: dict[UUID, str]
    x_posts: set[UUID]
    fragments: list[Any]
    pdfs: dict[UUID, Any]
    pages: list[Any]
    notes: dict[UUID, NoteSource]
    messages: dict[UUID, Any]


def location_reads(
    db: Session, viewer_id: UUID, targets: Sequence[CapturedPassageTarget]
) -> LocationReads:
    """What ``current_locator`` reads for ``targets``, one batch per kind, between two
    identity reads: a publication that moves in between reads as changed."""
    owners = [assert_resource_ref(target.owner_ref) for target in targets]
    locators = [target.locator for target in targets]
    media_ids = list({ref.id for ref in owners if ref.scheme == "media"})
    before = source_identities(db, media_ids)
    # An X post's anchors stay source-local while its text is recomposed: it requotes.
    x_posts = (
        set(
            db.scalars(
                text("SELECT media_id FROM x_post_sources WHERE media_id = ANY(:ids)"),
                {"ids": media_ids},
            )
        )
        if media_ids
        else set()
    )
    fragment_ids = list(
        {
            UUID(str(locator.fragment_id))
            for locator in locators
            if isinstance(locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator))
        }
    )
    timed_ids = list(
        {
            UUID(str(locator.media_id))
            for locator in locators
            if isinstance(locator, (TranscriptTimeRangeLocator, PlaybackTimeRangeLocator))
        }
    )
    pdf_ids = list(
        {
            UUID(str(locator.media_id))
            for locator in locators
            if isinstance(locator, (PdfPageGeometryLocator, PdfPageLocator))
        }
    )
    message_ids = list(
        {UUID(str(locator.message_id)) for locator in locators if locator.type == "message_offsets"}
    )
    note_ids = list({ref.id for ref in owners if ref.scheme == "note_block"})
    fragments = (
        list(
            db.execute(
                text(
                    "SELECT id, media_id, canonical_text, t_start_ms, t_end_ms FROM fragments"
                    " WHERE id = ANY(:ids) OR media_id = ANY(:timed) OR media_id = ANY(:x_posts)"
                    " ORDER BY t_start_ms NULLS LAST, idx"
                ),
                {"ids": fragment_ids, "timed": timed_ids, "x_posts": list(x_posts)},
            ).mappings()
        )
        if fragment_ids or timed_ids or x_posts
        else []
    )
    pdfs = (
        {
            row.id: row
            for row in db.execute(
                text("SELECT id, page_count, plain_text FROM media WHERE id = ANY(:ids)"),
                {"ids": pdf_ids},
            )
        }
        if pdf_ids
        else {}
    )
    pages = (
        list(
            db.execute(
                text(
                    "SELECT media_id, page_number, start_offset, end_offset"
                    " FROM pdf_page_text_spans WHERE media_id = ANY(:ids)"
                ),
                {"ids": pdf_ids},
            ).mappings()
        )
        if pdf_ids
        else []
    )
    from nexus.services.note_bodies import read_note_sources

    notes = read_note_sources(db, viewer_id=viewer_id, note_ids=note_ids) if note_ids else {}
    messages = (
        {
            row.id: row
            for row in db.execute(
                text("SELECT id, conversation_id, content FROM messages WHERE id = ANY(:ids)"),
                {"ids": message_ids},
            )
        }
        if message_ids
        else {}
    )
    after = source_identities(db, media_ids)
    return LocationReads(
        changed={id_ for id_ in media_ids if before.get(id_) != after.get(id_)},
        identities=after,
        x_posts=x_posts,
        fragments=fragments,
        pdfs=pdfs,
        pages=pages,
        notes=notes,
        messages=messages,
    )


def _normal(words: str) -> str:
    return text_quote.normalize_for_match(words).text.strip()


def _with_words(raw: dict[str, Any], words: str) -> dict[str, Any]:
    return {
        **raw,
        "text_quote_selector": {**(raw.get("text_quote_selector") or {}), "exact": words},
    }


def current_locator(
    target: CapturedPassageTarget, quote: CapturedQuote | None, reads: LocationReads
) -> dict[str, Any] | None:
    """The target's locator if it still names the same normalized words now (I7): text
    offsets by their words (an X post by a unique requote); a note also by
    ``body_version``, else a unique requote; a message whole only; pdf boxes by
    publication identity, else a unique quote recovers the page; a time range by identity
    or exact unit bounds and words. ``None`` otherwise."""
    raw = target.locator.model_dump(mode="json")
    owner = assert_resource_ref(target.owner_ref)
    kind = raw["type"]
    selector = raw.get("text_quote_selector") or {}
    exact = selector.get("exact")
    if kind not in _OFFSET_WORDS:
        exact = exact or (quote.exact if quote else None)
    prefix = selector.get("prefix") or (quote.prefix if quote else None) or ""
    suffix = selector.get("suffix") or (quote.suffix if quote else None) or ""
    if owner.id in reads.changed:
        return None
    if kind == "web_text_offsets" and owner.id in reads.x_posts:
        exact = exact or (quote.exact if quote else None)
        if not exact:
            return None
        sources = [
            text_quote.NormalizedOwnerSource(
                fragment["id"],
                None,
                None,
                text_quote.normalize_for_match(fragment["canonical_text"]),
            )
            for fragment in reads.fragments
            if fragment["media_id"] == owner.id
        ]
        match = text_quote.match_quote_in_sources(
            sources, exact=_normal(exact), prefix=_normal(prefix), suffix=_normal(suffix)
        )
        if match.status is text_quote.QuoteStatus.no_match:
            match = text_quote.match_quote_in_sources(sources, exact=_normal(exact))
        if match.status is not text_quote.QuoteStatus.unique:
            return None
        return {
            **raw,
            "fragment_id": str(match.fragment_id),
            "start_offset": match.raw_start,
            "end_offset": match.raw_end,
            "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
        }
    if kind in ("web_text_offsets", "epub_fragment_offsets"):
        fragment = next(
            (
                f
                for f in reads.fragments
                if str(f["id"]) == raw["fragment_id"] and f["media_id"] == owner.id
            ),
            None,
        )
        if fragment is None or exact is None:
            return None
        start, end = raw["start_offset"], raw["end_offset"]
        words = fragment["canonical_text"][start:end]
        if not 0 <= start < end <= len(fragment["canonical_text"]) or _normal(words) != _normal(
            exact
        ):
            return None
        return _with_words(raw, words)
    if kind == "note_block_offsets":
        note = reads.notes.get(owner.id)
        if note is None:
            return None
        start, end = raw["start_offset"], raw["end_offset"]
        words = note.body_text[start:end]
        if (
            raw.get("body_version") == note.body_version
            and 0 <= start < end <= len(note.body_text)
            and (exact is None or _normal(words) == _normal(exact))
        ):
            return _with_words(raw, words)
        if exact is None:
            return None
        match = text_quote.match_quote_in_sources(
            [
                text_quote.NormalizedOwnerSource(
                    None, None, None, text_quote.normalize_for_match(note.body_text)
                )
            ],
            exact=_normal(exact),
            prefix=_normal(prefix),
            suffix=_normal(suffix),
        )
        match = text_quote.project_note_match(note.body_text, match, exact=_normal(exact))
        if match.status is not text_quote.QuoteStatus.unique:
            return None
        located = {
            **raw,
            "start_offset": match.raw_start,
            "end_offset": match.raw_end,
            "body_version": note.body_version,
        }
        return _with_words(located, note.body_text[match.raw_start : match.raw_end])
    if kind == "message_offsets":
        message = reads.messages.get(UUID(raw["message_id"]))
        if (
            message is None
            or message.conversation_id != owner.id
            or exact is None
            or raw["start_offset"] != 0
            or raw["end_offset"] != len(message.content)
            or _normal(message.content) != _normal(exact)
        ):
            return None
        return _with_words(raw, message.content)
    identity = reads.identities.get(owner.id)
    if kind in ("pdf_page_geometry", "pdf_page"):
        media = reads.pdfs.get(owner.id)
        if media is None:
            return None
        if (
            target.source_identity is not None
            and identity == target.source_identity
            and media.page_count
            and raw["page_number"] <= media.page_count
        ):
            return raw
        if not exact:
            return None
        # Historical geometry has no publication proof: a unique current quote can recover
        # its page, never the old boxes.
        candidates = text_quote.find_quote_candidates(
            text_quote.normalize_for_match(media.plain_text or ""),
            exact=_normal(exact),
            prefix=_normal(prefix),
            suffix=_normal(suffix),
        )
        if len(candidates) != 1:
            return None
        hit = candidates[0]
        pages = [
            page
            for page in reads.pages
            if page["media_id"] == owner.id
            and page["start_offset"] <= hit.raw_start < page["end_offset"]
            and hit.raw_end <= page["end_offset"]
        ]
        if len(pages) != 1:
            return None
        return {
            "type": "pdf_page",
            "media_id": str(owner.id),
            "page_number": pages[0]["page_number"],
        }
    if kind in TIMED_KINDS:
        units = [
            f
            for f in reads.fragments
            if f["media_id"] == owner.id
            and f["t_start_ms"] is not None
            and f["t_end_ms"] is not None
            and f["t_end_ms"] > raw["t_start_ms"]
            and f["t_start_ms"] < raw["t_end_ms"]
        ]
        words = "\n".join(f["canonical_text"] for f in units)
        proven = (target.source_identity is not None and identity == target.source_identity) or (
            bool(units)
            and units[0]["t_start_ms"] == raw["t_start_ms"]
            and units[-1]["t_end_ms"] == raw["t_end_ms"]
            and exact is not None
            and _normal(words) == _normal(exact)
        )
        if not proven:
            return None
        return _with_words(raw, words) if kind == "transcript_time_range" and units else raw
    return raw if kind == "external_url" else None


def resolve_quote(
    db: Session,
    owner: ResourceRef,
    quote: CapturedQuote,
    hint: dict[str, Any] | None,
    source_reads: locator_resolver.PassageSourceReads | None = None,
) -> dict[str, Any] | None:
    """Where ``quote`` occurs uniquely in its owner now, as a locator; ``None`` otherwise.
    A list read passes one ``source_reads`` batch for all its owners."""
    reads = source_reads or locator_resolver.read_passage_sources(db, [(owner.scheme, owner.id)])
    found = locator_resolver.resolve_passage_selector(
        db,
        owner_scheme=owner.scheme,
        owner_id=owner.id,
        exact=_normal(quote.exact),
        prefix=_normal(quote.prefix or ""),
        suffix=_normal(quote.suffix or ""),
        locator_hint=hint,
        source_reads=reads,
    ).locator
    if found is None:
        return None
    selector = {"exact": quote.exact, "prefix": quote.prefix or "", "suffix": quote.suffix or ""}
    if owner.scheme == "note_block":
        return {
            "type": "note_block_offsets",
            "block_id": str(owner.id),
            "start_offset": found["start_offset"],
            "end_offset": found["end_offset"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "text":
        kind = reads.media_kinds.get(owner.id)
        return {
            "type": "epub_fragment_offsets" if kind == "epub" else "web_text_offsets",
            "media_id": str(owner.id),
            "media_kind": kind,
            "fragment_id": found["fragment_id"],
            "start_offset": found["start_offset"],
            "end_offset": found["end_offset"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "time":
        return {
            "type": "transcript_time_range",
            "media_id": str(owner.id),
            "t_start_ms": found["t_start_ms"],
            "t_end_ms": found["t_end_ms"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "pdf":
        return {
            "type": "pdf_page",
            "media_id": str(owner.id),
            "page_number": found["page_number"],
            "text_quote_selector": selector,
        }
    return None


def current_passages(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> dict[str, CurrentPassage]:
    """The spans, chunks and oracle anchors among ``refs`` that exist, keyed by uri. A span
    lands where its selector resolves and its words still match; a chunk where its primary
    span lands, when their words are identical; an oracle anchor (resolved onto a span,
    else a chunk) where its quote resolves uniquely, while that span or chunk lands."""
    ids = {
        scheme: [ref.id for ref in refs if ref.scheme == scheme]
        for scheme in ("evidence_span", "content_chunk", "oracle_passage_anchor")
    }
    anchors = (
        db.execute(
            text("""
            SELECT a.id, a.quote, s.media_id,
              CASE WHEN a.resolution_status = 'resolved' THEN a.current_evidence_span_id END
                AS span_id,
              CASE WHEN a.resolution_status = 'resolved' THEN a.current_content_chunk_id END
                AS chunk_id
            FROM oracle_passage_anchors a
            JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
            WHERE a.id = ANY(:ids)
            """),
            {"ids": ids["oracle_passage_anchor"]},
        ).all()
        if ids["oracle_passage_anchor"]
        else []
    )
    chunk_ids = {*ids["content_chunk"], *(a.chunk_id for a in anchors if a.chunk_id)}
    chunks = (
        db.execute(
            text(
                "SELECT id, owner_kind, owner_id, chunk_text, primary_evidence_span_id"
                " FROM content_chunks WHERE id = ANY(:ids)"
            ),
            {"ids": list(chunk_ids)},
        ).all()
        if chunk_ids
        else []
    )
    span_ids = {
        *ids["evidence_span"],
        *(a.span_id for a in anchors if a.span_id),
        *(c.primary_evidence_span_id for c in chunks if c.primary_evidence_span_id),
    }
    spans = (
        db.execute(
            text(
                "SELECT es.id, es.owner_kind, es.owner_id, es.span_text, es.selector,"
                " es.resolver_kind, m.kind AS media_kind FROM evidence_spans es"
                " LEFT JOIN media m ON es.owner_kind = 'media' AND m.id = es.owner_id"
                " WHERE es.id = ANY(:ids)"
            ),
            {"ids": list(span_ids)},
        ).all()
        if span_ids
        else []
    )
    identities = source_identities(db, list({s.owner_id for s in spans if s.owner_kind == "media"}))
    derived: list[tuple[UUID, ResourceRef, CapturedQuote, CapturedPassageTarget | None]] = []
    for span in spans:
        owner = assert_resource_ref(f"{span.owner_kind}:{span.owner_id}")
        context = span.selector.get("text_quote", {})
        quote = CapturedQuote(
            exact=span.span_text,
            prefix=context.get("prefix"),
            suffix=context.get("suffix"),
            color=None,
        )
        locator = locator_resolver.locator_from_resolution(
            locator_resolver.evidence_resolution(
                evidence_span_id=span.id,
                owner_id=span.owner_id,
                span_text=span.span_text,
                selector=span.selector,
                resolver_kind=span.resolver_kind,
            ),
            media_id=span.owner_id,
            media_kind=span.media_kind or "note",
        )
        target = (
            CapturedPassageTarget.model_validate(
                {
                    "owner_ref": owner.uri,
                    "locator": locator,
                    "precision": "exact",
                    "source_identity": identities.get(span.owner_id),
                }
            )
            if locator is not None
            else None
        )
        derived.append((span.id, owner, quote, target))
    reads = location_reads(db, viewer_id, [t for _, _, _, t in derived if t is not None])
    span_passages = {
        id_: CurrentPassage(owner, quote, current_locator(target, quote, reads) if target else None)
        for id_, owner, quote, target in derived
    }
    chunk_passages = {}
    for chunk in chunks:
        primary = span_passages.get(chunk.primary_evidence_span_id)
        chunk_passages[chunk.id] = CurrentPassage(
            assert_resource_ref(f"{chunk.owner_kind}:{chunk.owner_id}"),
            CapturedQuote(exact=chunk.chunk_text, prefix=None, suffix=None, color=None),
            primary.locator if primary and primary.quote.exact == chunk.chunk_text else None,
        )
    out = {
        f"evidence_span:{id_}": span_passages[id_]
        for id_ in ids["evidence_span"]
        if id_ in span_passages
    }
    out |= {
        f"content_chunk:{id_}": chunk_passages[id_]
        for id_ in ids["content_chunk"]
        if id_ in chunk_passages
    }
    sources = (
        locator_resolver.read_passage_sources(db, [("media", a.media_id) for a in anchors])
        if anchors
        else None
    )
    for anchor in anchors:
        owner = ResourceRef("media", anchor.media_id)
        quote = CapturedQuote(exact=anchor.quote, prefix=None, suffix=None, color=None)
        # Resolved onto a span, else a chunk; a span pointer that dangles lands nowhere.
        current = (
            span_passages.get(anchor.span_id)
            if anchor.span_id
            else chunk_passages.get(anchor.chunk_id)
        )
        lands = current is not None and current.locator is not None
        locator = resolve_quote(db, owner, quote, None, sources) if lands else None
        out[f"oracle_passage_anchor:{anchor.id}"] = CurrentPassage(owner, quote, locator)
    return out
