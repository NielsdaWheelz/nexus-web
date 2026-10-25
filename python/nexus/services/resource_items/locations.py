"""Where words land now: the one proof that a frozen or current location still names the
same words in the current publication.

``current_locator`` judges one captured passage target against batched current reads
(I7). ``current_passages`` derives the current extent of evidence spans, content chunks
and oracle passage anchors and proves it the same way, so routing gives such a passage an
href exactly when capture would freeze a passage target for it now (I17). Reads only: a
moved or missing source answers ``None``, never an error. The caller proves visibility.

reading ownership is separate from canonical storage. ``passage_owner_sql`` admits
only the caller-supplied reading audience; an explicit reading owner never widens
to another readable identity. current refs and frozen evidence revalidate complete
extents and permitted note dependencies, bounding incidental context in that owner.
saved highlights retain their stored quote for an authorized source even when the
locator is unavailable; a piece audience still requires every canonical anchor.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    highlight_visibility_sql,
    requested_media_ids_cte_sql,
)
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
from nexus.services.media_text_scope import (
    highlight_in_reading_scope_sql,
    read_media_text_scope,
    text_scope_rows_sql,
)
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


def reading_owner_sql(candidates_sql: str) -> str:
    """Choose within the supplied audience: root, then smallest canonical extent, then id."""
    intervals = text_scope_rows_sql("SELECT nexus_owner_candidate.reading_media_id AS media_id")
    return f"""
        SELECT nexus_owner_candidate.reading_media_id FROM ({candidates_sql}) nexus_owner_candidate
        LEFT JOIN media_parts nexus_owner_part ON nexus_owner_part.media_id=nexus_owner_candidate.reading_media_id
        CROSS JOIN LATERAL (
            SELECT CASE WHEN nexus_owner_part.media_id IS NULL THEN 0 ELSE (
                SELECT COALESCE(sum(nexus_owner_bound.end_offset-nexus_owner_bound.start_offset),0) FROM ({intervals}) nexus_owner_bound
            ) END AS codepoints
        ) nexus_owner_extent
        ORDER BY (nexus_owner_part.media_id IS NULL) DESC,nexus_owner_extent.codepoints,nexus_owner_candidate.reading_media_id LIMIT 1
    """


def passage_owner_sql(
    admitted_sql: str, *, source: str, fragment: str, start: str, end: str
) -> str:
    """Setwise main-body admission inside the requested identities.

    Full reading evidence, including permitted notes, uses ``scoped_media_passage``.
    """
    scopes = text_scope_rows_sql(admitted_sql)
    candidates = f"""
        SELECT DISTINCT nexus_owner_bound.reading_media_id FROM ({scopes}) nexus_owner_bound
        WHERE nexus_owner_bound.source_media_id={source} AND nexus_owner_bound.fragment_id={fragment}
          AND {start} < {end} AND nexus_owner_bound.start_offset<={start} AND nexus_owner_bound.end_offset>={end}
        UNION
        SELECT nexus_owner_admitted.media_id FROM ({admitted_sql}) nexus_owner_admitted JOIN media nexus_owner_source_kind ON nexus_owner_source_kind.id=nexus_owner_admitted.media_id
        WHERE nexus_owner_admitted.media_id={source} AND {fragment} IS NULL
          AND nexus_owner_source_kind.kind NOT IN ('epub','web_article','text_part')
    """
    return reading_owner_sql(candidates)


@dataclass(frozen=True, slots=True)
class ScopedMediaPassage:
    owner: ResourceRef
    quote: CapturedQuote
    locator: dict[str, Any] | None


def _reading_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    source_media_id: UUID,
    reading_media_id: UUID | None,
    admitted_reading_media_ids: Sequence[UUID] | None,
) -> list[UUID]:
    admitted = requested_media_ids_cte_sql()
    if admitted_reading_media_ids is not None:
        admitted = f"SELECT media_id FROM ({admitted}) audience WHERE media_id=ANY(CAST(:admitted_ids AS uuid[]))"
    if reading_media_id is not None:
        admitted = f"SELECT media_id FROM ({admitted}) audience WHERE media_id=:reading_id"
    return list(
        db.scalars(
            text(f"""
                SELECT audience.media_id FROM ({admitted}) audience
                JOIN media reading ON reading.id=audience.media_id
                LEFT JOIN media_parts part ON part.media_id=reading.id
                WHERE COALESCE(part.source_media_id,reading.id)=:source
            """),
            {
                "viewer_id": viewer_id,
                "reading_id": reading_media_id,
                "admitted_ids": None
                if admitted_reading_media_ids is None
                else list(admitted_reading_media_ids),
                "source": source_media_id,
            },
        )
    )


def scoped_media_passage(
    db: Session,
    *,
    viewer_id: UUID,
    source_media_id: UUID,
    quote: CapturedQuote,
    locator: dict[str, Any] | None,
    reading_media_id: UUID | None = None,
    apparatus_item_id: UUID | None = None,
    admitted_reading_media_ids: Sequence[UUID] | None = None,
) -> ScopedMediaPassage | None:
    """Choose an authorized reading owner and bound incidental context there.

    An explicit owner is authoritative. Shared passage ranges admit the body and
    exact permitted notes without changing the body interval or source owner.
    A supplied audience intersects visibility; an empty audience admits nothing.
    """
    if admitted_reading_media_ids is not None and not admitted_reading_media_ids:
        return None
    kind = db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": source_media_id})
    if kind == "text_part":
        retained = read_media_text_scope(db, source_media_id)
        if reading_media_id is None and admitted_reading_media_ids is None:
            reading_media_id = source_media_id
        source_media_id, kind = retained.source_media_id, retained.source_format
    if kind not in ("epub", "web_article"):
        if (
            reading_media_id not in (None, source_media_id)
            or admitted_reading_media_ids is not None
            and source_media_id not in admitted_reading_media_ids
            or not can_read_media(db, viewer_id, source_media_id)
        ):
            return None
        return ScopedMediaPassage(ResourceRef("media", source_media_id), quote, locator)
    candidates = _reading_candidates(
        db,
        viewer_id=viewer_id,
        source_media_id=source_media_id,
        reading_media_id=reading_media_id,
        admitted_reading_media_ids=admitted_reading_media_ids,
    )
    owner_id = None
    sources: locator_resolver.PassageSourceReads | None = None
    words: str | None = None
    if apparatus_item_id is not None:
        permitted = (
            [source_media_id]
            if source_media_id in candidates
            else [
                id
                for id in candidates
                if apparatus_item_id in read_media_text_scope(db, id).permitted_apparatus
            ]
        )
        if permitted:
            owner_id = db.scalar(
                text(reading_owner_sql("SELECT unnest(CAST(:ids AS uuid[])) AS reading_media_id")),
                {"ids": permitted},
            )
    elif locator is not None and locator.get("type") in (
        "web_text_offsets",
        "epub_fragment_offsets",
    ):
        fragment_id = UUID(str(locator["fragment_id"]))
        start, end = locator["start_offset"], locator["end_offset"]
        words = db.scalar(
            text("SELECT canonical_text FROM fragments WHERE id=:fragment AND media_id=:source"),
            {"fragment": fragment_id, "source": source_media_id},
        )
        if words is None or not 0 <= start < end <= len(words):
            return None
        if source_media_id in candidates:
            owner_id = source_media_id
        else:
            sources = locator_resolver.read_passage_sources(
                db, [("media", id) for id in candidates]
            )
            permitted = [
                id
                for id in candidates
                if sources.canonical_media.get(id) == source_media_id
                and locator_resolver.admits_passage(sources, id, fragment_id, start, end)
            ]
            if permitted:
                owner_id = db.scalar(
                    text(
                        reading_owner_sql("SELECT unnest(CAST(:ids AS uuid[])) AS reading_media_id")
                    ),
                    {"ids": permitted},
                )
    elif source_media_id in candidates:
        owner_id = source_media_id
    if owner_id is None:
        return None
    if locator is not None and locator.get("type") in ("web_text_offsets", "epub_fragment_offsets"):
        fragment_id = UUID(str(locator["fragment_id"]))
        start, end = locator["start_offset"], locator["end_offset"]
        if words is None:
            words = db.scalar(
                text(
                    "SELECT canonical_text FROM fragments WHERE id=:fragment AND media_id=:source"
                ),
                {"fragment": fragment_id, "source": source_media_id},
            )
        bounds = (0, len(words)) if owner_id == source_media_id and words is not None else None
        if owner_id != source_media_id:
            if sources is None:
                sources = locator_resolver.read_passage_sources(db, [("media", owner_id)])
            bounds = max(
                (
                    (left, right)
                    for id, left, right in sources.ranges.get(owner_id, [])
                    if id == fragment_id and left <= start and end <= right
                ),
                key=lambda interval: interval[1] - interval[0],
                default=None,
            )
        if words is not None and bounds is not None:
            quote = quote.model_copy(
                update={
                    "prefix": words[max(bounds[0], start - 64) : start],
                    "suffix": words[end : min(bounds[1], end + 64)],
                }
            )
        else:
            quote = quote.model_copy(update={"prefix": None, "suffix": None})
        locator = {
            **locator,
            "media_id": str(source_media_id),
            "media_kind": kind,
            "text_quote_selector": {
                "exact": quote.exact,
                "prefix": quote.prefix or "",
                "suffix": quote.suffix or "",
            },
        }
    return ScopedMediaPassage(ResourceRef("media", owner_id), quote, locator)


def media_passages(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    reading_media_ids: Mapping[str, UUID] | None = None,
    admitted_reading_media_ids: Sequence[UUID] | None = None,
) -> dict[str, ScopedMediaPassage]:
    """Current canonical media refs, with one authorized bounded reading owner each.

    A supplied audience limits owner choice before quote resolution; ``None``
    keeps ordinary visibility, while an empty sequence admits no media passage.
    The per-ref reading map batches distinct occurrences with explicit contexts;
    a canonical ref has only one context per invocation. An absent map entry uses
    its authorized preferred owner. The map chooses within visibility and the
    separate admitted audience; it never grants authority.
    """
    out: dict[str, ScopedMediaPassage] = {}
    reading_owners = reading_media_ids or {}
    if admitted_reading_media_ids is not None and not admitted_reading_media_ids:
        return out
    ids = {
        scheme: [ref.id for ref in refs if ref.scheme == scheme]
        for scheme in ("highlight", "fragment", "reader_apparatus_item", "passage_anchor")
    }
    highlights = (
        {
            row.id: row.reading_media_ids
            for row in db.execute(
                text(f"""SELECT h.id,array_agg(reading.media_id) AS reading_media_ids
                    FROM highlights h JOIN ({requested_media_ids_cte_sql()}) reading
                      ON reading.media_id=h.anchor_media_id
                        OR (h.anchor_kind='fragment_offsets'
                            AND {highlight_in_reading_scope_sql("h.id", "reading.media_id")})
                    WHERE h.id=ANY(:ids) AND {highlight_visibility_sql("h")}
                      AND (CAST(:reading_owners AS jsonb)->>('highlight:' || h.id::text) IS NULL
                        OR reading.media_id=CAST(CAST(:reading_owners AS jsonb)->>('highlight:' || h.id::text) AS uuid))
                      AND (CAST(:audience AS uuid[]) IS NULL
                        OR reading.media_id=ANY(CAST(:audience AS uuid[])))
                    GROUP BY h.id"""),
                {
                    "ids": ids["highlight"],
                    "viewer_id": viewer_id,
                    "reading_owners": json.dumps(reading_owners, default=str),
                    "audience": list(admitted_reading_media_ids)
                    if admitted_reading_media_ids is not None
                    else None,
                },
            )
        }
        if ids["highlight"]
        else {}
    )
    for id, row in locator_resolver.read_highlight_reader_sources(
        db, highlight_ids=list(highlights)
    ).items():
        quote = CapturedQuote(
            exact=row.exact, prefix=row.prefix, suffix=row.suffix, color=row.color
        )
        raw = row.target.model_dump(mode="json") if row.target is not None else None
        locator = None
        if raw is not None:
            if raw["kind"] == "PdfPageGeometry":
                locator = {
                    "type": "pdf_page_geometry",
                    "media_id": str(row.media_id),
                    "page_number": raw["page_number"],
                    "quads": raw["quads"],
                    "exact": quote.exact,
                    "prefix": quote.prefix or "",
                    "suffix": quote.suffix or "",
                }
            elif raw["kind"] == "TranscriptTextOffsets" and raw["time_range"] is not None:
                locator = {
                    "type": "transcript_time_range",
                    "media_id": str(row.media_id),
                    "t_start_ms": raw["time_range"]["start_ms"],
                    "t_end_ms": raw["time_range"]["end_ms"],
                }
            else:
                locator = {
                    "type": "epub_fragment_offsets"
                    if row.media_kind == "epub"
                    else "web_text_offsets",
                    "media_id": str(row.media_id),
                    "media_kind": row.media_kind,
                    "fragment_id": raw["fragment_id"],
                    "start_offset": raw["start_offset"],
                    "end_offset": raw["end_offset"],
                }
        scoped = scoped_media_passage(
            db,
            viewer_id=viewer_id,
            source_media_id=row.media_id,
            quote=quote,
            locator=locator,
            reading_media_id=reading_owners.get(f"highlight:{id}"),
            admitted_reading_media_ids=highlights[id],
        )
        if scoped is not None:
            if scoped.owner.id == row.media_id:
                locator = scoped.locator
                if locator is not None:
                    locator = {
                        **locator,
                        "text_quote_selector": {
                            "exact": quote.exact,
                            "prefix": quote.prefix or "",
                            "suffix": quote.suffix or "",
                        },
                    }
                scoped = ScopedMediaPassage(scoped.owner, quote, locator)
            out[f"highlight:{id}"] = scoped
    for row in db.execute(
        text(
            "SELECT f.id,f.media_id,f.canonical_text,f.t_start_ms,f.t_end_ms,m.kind FROM fragments f JOIN media m ON m.id=f.media_id WHERE f.id=ANY(:ids)"
        ),
        {"ids": ids["fragment"]},
    ):
        quote = CapturedQuote(exact=row.canonical_text, prefix=None, suffix=None, color=None)
        locator = None
        if (
            row.kind in ("video", "podcast_episode")
            and row.t_start_ms is not None
            and row.t_end_ms is not None
        ):
            locator = {
                "type": "transcript_time_range",
                "media_id": str(row.media_id),
                "t_start_ms": row.t_start_ms,
                "t_end_ms": row.t_end_ms,
            }
        elif row.canonical_text:
            locator = {
                "type": "epub_fragment_offsets" if row.kind == "epub" else "web_text_offsets",
                "media_id": str(row.media_id),
                "media_kind": row.kind,
                "fragment_id": str(row.id),
                "start_offset": 0,
                "end_offset": len(row.canonical_text),
            }
        scoped = scoped_media_passage(
            db,
            viewer_id=viewer_id,
            source_media_id=row.media_id,
            quote=quote,
            locator=locator,
            reading_media_id=reading_owners.get(f"fragment:{row.id}"),
            admitted_reading_media_ids=admitted_reading_media_ids,
        )
        if scoped is not None:
            out[f"fragment:{row.id}"] = scoped
    for row in db.execute(
        text(
            "SELECT item.id,item.media_id,item.body_text,item.label,item.locator FROM reader_apparatus_items item JOIN reader_apparatus_states state ON state.id=item.state_id WHERE item.id=ANY(:ids) AND state.status IN ('ready','partial')"
        ),
        {"ids": ids["reader_apparatus_item"]},
    ):
        scoped = scoped_media_passage(
            db,
            viewer_id=viewer_id,
            source_media_id=row.media_id,
            quote=CapturedQuote(
                exact=row.body_text or row.label or "", prefix=None, suffix=None, color=None
            ),
            locator=row.locator,
            reading_media_id=reading_owners.get(f"reader_apparatus_item:{row.id}"),
            apparatus_item_id=row.id,
            admitted_reading_media_ids=admitted_reading_media_ids,
        )
        if scoped is not None:
            out[f"reader_apparatus_item:{row.id}"] = scoped
    for row in db.execute(
        text(
            "SELECT id,owner_scheme,owner_id,selector FROM passage_anchors WHERE id=ANY(:ids) AND user_id=:viewer_id AND owner_scheme='media'"
        ),
        {"ids": ids["passage_anchor"], "viewer_id": viewer_id},
    ):
        words = row.selector["quote"]
        quote = CapturedQuote(
            exact=words["exact"], prefix=words.get("prefix"), suffix=words.get("suffix"), color=None
        )
        requested_reading = reading_owners.get(f"passage_anchor:{row.id}")
        owners = [ResourceRef("media", requested_reading or row.owner_id)]
        if admitted_reading_media_ids is not None:
            source_id = (
                db.scalar(
                    text("SELECT source_media_id FROM media_parts WHERE media_id=:id"),
                    {"id": row.owner_id},
                )
                or row.owner_id
            )
            owners = [
                ResourceRef("media", id)
                for id in _reading_candidates(
                    db,
                    viewer_id=viewer_id,
                    source_media_id=source_id,
                    reading_media_id=requested_reading,
                    admitted_reading_media_ids=admitted_reading_media_ids,
                )
            ]
        sources = locator_resolver.read_passage_sources(
            db, [(owner.scheme, owner.id) for owner in owners]
        )
        proved: dict[UUID, ScopedMediaPassage] = {}
        for owner in owners:
            locator = resolve_quote(db, owner, quote, row.selector.get("locator_hint"), sources)
            if (
                admitted_reading_media_ids is not None
                and locator is None
                and sources.canonical_media.get(owner.id, owner.id) != owner.id
            ):
                continue
            scoped = scoped_media_passage(
                db,
                viewer_id=viewer_id,
                source_media_id=row.owner_id,
                quote=quote,
                locator=locator,
                reading_media_id=owner.id
                if admitted_reading_media_ids is not None
                else requested_reading,
                admitted_reading_media_ids=admitted_reading_media_ids,
            )
            if scoped is not None:
                proved[scoped.owner.id] = scoped
        if proved:
            chosen = (
                next(iter(proved))
                if len(proved) == 1
                else db.scalar(
                    text(
                        reading_owner_sql("SELECT unnest(CAST(:ids AS uuid[])) AS reading_media_id")
                    ),
                    {"ids": list(proved)},
                )
            )
            if chosen is not None:
                out[f"passage_anchor:{row.id}"] = proved[chosen]
    for uri, passage in current_passages(
        db,
        viewer_id=viewer_id,
        refs=refs,
        reading_media_ids=reading_media_ids,
        admitted_reading_media_ids=admitted_reading_media_ids,
    ).items():
        if passage.owner.scheme == "media":
            out[uri] = ScopedMediaPassage(passage.owner, passage.quote, passage.locator)
    return out


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
    passages: locator_resolver.PassageSourceReads


def location_reads(
    db: Session, viewer_id: UUID, targets: Sequence[CapturedPassageTarget]
) -> LocationReads:
    """What ``current_locator`` reads for ``targets``, one batch per kind, between two
    identity reads: a publication that moves in between reads as changed."""
    owners = [assert_resource_ref(target.owner_ref) for target in targets]
    locators = [target.locator for target in targets]
    media_ids = list({ref.id for ref in owners if ref.scheme == "media"})
    before = source_identities(db, media_ids)
    passages = locator_resolver.read_passage_sources(
        db,
        [
            ("media", id)
            for id in db.scalars(
                text("SELECT id FROM media WHERE id=ANY(:ids) AND kind='text_part'"),
                {"ids": media_ids},
            )
        ],
    )
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
        passages=passages,
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
                if str(f["id"]) == raw["fragment_id"]
                and f["media_id"] == reads.passages.canonical_media.get(owner.id, owner.id)
            ),
            None,
        )
        if fragment is None or exact is None:
            return None
        start, end = raw["start_offset"], raw["end_offset"]
        words = fragment["canonical_text"][start:end]
        if owner.id in reads.passages.canonical_media:
            if not locator_resolver.admits_passage(
                reads.passages, owner.id, fragment["id"], start, end
            ):
                return None
            bounds = next(
                (
                    (left, right)
                    for id, left, right in reads.passages.ranges[owner.id]
                    if id == fragment["id"] and left <= start and end <= right
                ),
                None,
            )
            if bounds is None:
                return None
            selector = {
                **selector,
                "prefix": fragment["canonical_text"][max(bounds[0], start - 64) : start],
                "suffix": fragment["canonical_text"][end : min(bounds[1], end + 64)],
            }
            raw = {**raw, "text_quote_selector": selector}
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
            "media_id": str(reads.canonical_media.get(owner.id, owner.id)),
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
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    reading_media_ids: Mapping[str, UUID] | None = None,
    admitted_reading_media_ids: Sequence[UUID] | None = None,
) -> dict[str, CurrentPassage]:
    """The spans, chunks and oracle anchors among ``refs`` that exist, keyed by uri. A span
    lands where its selector resolves and its words still match; a chunk where its primary
    span lands, when their words are identical; an oracle anchor (resolved onto a span,
    else a chunk) where its quote resolves uniquely, while that span or chunk lands.

    Per-ref readings select within the separately admitted audience and visibility;
    missing entries use the authorized preferred owner, never additional authority.
    """
    reading_owners = reading_media_ids or {}
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
    for uri, passage in list(out.items()):
        if passage.owner.scheme != "media":
            continue
        scoped = scoped_media_passage(
            db,
            viewer_id=viewer_id,
            source_media_id=passage.owner.id,
            quote=passage.quote,
            locator=passage.locator,
            reading_media_id=reading_owners.get(uri),
            admitted_reading_media_ids=admitted_reading_media_ids,
        )
        if scoped is None:
            del out[uri]
        else:
            out[uri] = CurrentPassage(scoped.owner, scoped.quote, scoped.locator)
    return out
