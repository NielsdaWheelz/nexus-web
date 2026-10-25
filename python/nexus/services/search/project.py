"""Hydrated rows -> the ``SearchResultOut`` wire union: refs, locators, snippets, activation."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, cast, get_args
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedResourceTarget,
    CapturedSource,
)
from nexus.schemas.retrieval import LocatorBackedResultType
from nexus.schemas.search_types import SearchResultContextRefOut
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    load_contributor_credits_for_podcasts,
)
from nexus.services.locator_resolver import evidence_resolution, locator_from_resolution
from nexus.services.media import media_summaries
from nexus.services.resource_graph.highlight_notes import highlight_excerpts_for_note_blocks
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import source_attributions
from nexus.services.resource_items.locations import scoped_media_passage
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.search.candidates import (
    RESULT_MODELS,
    SearchResultOut,
    SearchResultSourceOut,
)
from nexus.services.search.sources import Hit, hydrate

MAX_SNIPPET = 300
MEDIA_TYPES = frozenset({"media", "episode", "video"})
# Passage occurrences act on their readable owner.
_PASSAGES = frozenset({"content_chunk", "fragment", "evidence_span", "reader_apparatus_item"})
_LOCATED = frozenset(get_args(LocatorBackedResultType))
# Result types whose resource scheme differs from the type.
SCHEMES = {
    "episode": "media",
    "video": "media",
    "web_result": "external_snapshot",
}


def family_of(result_type: str) -> str:
    return "media" if result_type in MEDIA_TYPES else result_type


def _ref(scheme: str, resource_id: UUID) -> ResourceRef:
    return ResourceRef(cast("ResourceScheme", scheme), resource_id)


def _truncate(snippet: str) -> str:
    """At most ~300 plain characters, ending at a nearby word boundary."""
    if len(snippet) <= MAX_SNIPPET:
        return snippet
    cut = snippet[:MAX_SNIPPET]
    space = cut.rfind(" ")
    return (cut[:space] if space > MAX_SNIPPET // 2 else cut) + "..."


def snippet(text: str, terms: str) -> str:
    """Plain excerpt only; emphasis is an independent public search projection."""
    phrase = " ".join(terms.lower().split())
    found = [
        text.lower().find(word)
        for word in (phrase, *re.findall(r"[a-z0-9]{2,}", phrase))
        if word and word in text.lower()
    ]
    start = max(0, min(found) - 100) if found else 0
    return text[start : start + MAX_SNIPPET]


def build_source_label(source: SearchResultSourceOut | MediaSummaryOut) -> str:
    """``title - credited names - date - kind``; chat labels its citations with it too."""
    names = ", ".join(c.credited_name for c in source.contributors if c.credited_name)
    date = source.original_published_date
    kind = (
        "piece" if source.media_kind == "text_part" else (source.media_kind or "").replace("_", " ")
    )
    parts = [source.title, names, date if date is not None else "", kind]
    return " - ".join(part for part in parts if part)


def _locator(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """The row's reader locator, or None where its evidence span no longer resolves."""
    if row["type"] not in ("content_chunk", "evidence_span"):
        return row.get("locator")
    resolution = evidence_resolution(
        evidence_span_id=row["span_id"],
        owner_id=row.get("source_media_id", row["media_id"]),
        span_text=row["span_text"],
        selector=row["selector"],
        resolver_kind=row["resolver_kind"],
    )
    locator = locator_from_resolution(
        resolution,
        media_id=row.get("source_media_id", row["media_id"]),
        media_kind=row.get("source_media_kind", row["media_kind"]),
    )
    if locator is not None and locator["type"] == "note_block_offsets":
        locator["body_version"] = row.get("note_body_version") or 1
        locator["text_quote_selector"] = {"exact": row["span_text"]}
    return locator


def _refs(row: Mapping[str, Any]) -> tuple[ResourceRef, ResourceRef]:
    """(occurrence, owner): the resource a hit names and the one that receives it."""
    t = row["type"]
    ref = _ref(SCHEMES.get(t) or t, row["id"])
    if t == "message":
        return ref, _ref("conversation", row["conversation_id"])
    if t == "evidence_span":
        return ref, _ref(row["owner_kind"], row["media_id"])
    return ref, _ref("media", row["media_id"]) if "media_title" in row else ref


def project(
    db: Session,
    viewer_id: UUID,
    hits: Sequence[Hit],
    terms: str,
    *,
    evidence_span_ids: Sequence[UUID] | None = None,
) -> list[SearchResultOut]:
    """Hydrate ``hits`` and project, in order, the ones that still place; a hydrated row's
    own type wins (a media id reopens as media, episode or video by its kind).

    Rows drop after ranking and paging (a chunk whose span no longer resolves, a highlight
    without a locator), so a page can be short while the ranking has more.
    """
    ids: dict[str, list[Any]] = {}
    groups: dict[tuple[str, UUID | None], list[Any]] = {}
    for hit in hits:
        family = family_of(hit.type)
        ids.setdefault(family, []).append(hit.id)
        groups.setdefault((family, hit.reading_media_id), []).append(hit.id)
    rows = {
        (family, row["id"], owner): dict(row)
        for (family, owner), family_ids in groups.items()
        for row in hydrate(db, viewer_id, family, family_ids, terms, reading_media_id=owner)
    }
    sourced = [row["media_id"] for row in rows.values() if "media_title" in row]
    credits = load_contributor_credits_for_media(db, sourced)
    credits |= load_contributor_credits_for_podcasts(db, ids.get("podcast", []))
    summaries = media_summaries(db, viewer_id=viewer_id, media_ids=ids.get("media", []))
    excerpts = highlight_excerpts_for_note_blocks(db, viewer_id, ids.get("note_block", []))
    placed = []
    for hit in hits:
        row = rows.get((family_of(hit.type), hit.id, hit.reading_media_id))
        locator = None if row is None else _locator(row)
        if (
            row is None
            or (row["type"] in _LOCATED and locator is None)
            or (row["type"] in MEDIA_TYPES and row["id"] not in summaries)
            or (
                evidence_span_ids
                and row["type"] == "content_chunk"
                and row["span_id"] not in evidence_span_ids
            )
        ):
            continue
        if row.get("reading_media_id") is not None:
            scoped = scoped_media_passage(
                db,
                viewer_id=viewer_id,
                source_media_id=row.get("source_media_id", row["media_id"]),
                reading_media_id=row["reading_media_id"],
                locator=locator,
                apparatus_item_id=row["id"] if row["type"] == "reader_apparatus_item" else None,
                quote=CapturedQuote(
                    exact=row.get("span_text") or row.get("exact") or row.get("text") or "",
                    prefix=(locator or {}).get("text_quote_selector", {}).get("prefix"),
                    suffix=(locator or {}).get("text_quote_selector", {}).get("suffix"),
                    color=row.get("color"),
                ),
            )
            if scoped is None:
                continue
            locator = scoped.locator
        placed.append((row, hit.score, locator, *_refs(row)))
    activations = {}
    for owner in dict.fromkeys(row.get("reading_media_id") for row, *_ in placed):
        group_refs = [ref for row, _, _, ref, _ in placed if row.get("reading_media_id") == owner]
        activations.update(
            resource_activations_for_refs(
                db, viewer_id=viewer_id, refs=group_refs, reading_media_id=owner
            )
        )
    source_metadata = source_attributions(
        db, viewer_id=viewer_id, refs=list({owner for *_, owner in placed})
    )
    results = []
    for row, score, locator, ref, owner in placed:
        t = row["type"]
        rid = row["id"]
        activation = activations[ref.uri]
        if activation.href is None:
            continue
        values: dict[str, Any] = {"media_id": None, "media_kind": None, **row}
        if "media_title" in row:  # passages and highlights carry their source
            source = SearchResultSourceOut(
                media_id=row["media_id"],
                media_kind=row["media_kind"],
                title=row["media_title"],
                contributors=credits.get(row["media_id"], []),
                original_published_date=row["original_published_date"],
            )
            values |= {"source": source, "title": source.title}
            values["source_label"] = build_source_label(source)
        if t == "podcast":
            values["contributors"] = credits.get(rid, [])
            names = [c.credited_name for c in values["contributors"] if c.credited_name]
            values["source_label"] = " - ".join([row["title"], *names])
        if t == "note_block":
            excerpt = excerpts.get(rid)
            values["highlight_excerpt"] = None if excerpt is None else _truncate(excerpt)
            values["note_origin"] = "note" if excerpt is None else "highlight_note"
        if t in ("content_chunk", "evidence_span"):
            values |= {"evidence_span_ids": [row["span_id"]], "evidence_span_id": row["span_id"]}
        if t in MEDIA_TYPES:
            values["media_summary"] = summaries[rid]
        handle = row["contributor_handle"] if t == "contributor" else None
        values |= {
            "id": handle or (str(rid) if t == "web_result" else rid),
            "score": round(score, 4),
            "snippet": snippet(row["text"] or "", terms),
            "resource_ref": ref.uri,
            "owner_resource_ref": owner.uri,
            "action_ref": (owner if t in _PASSAGES else ref).uri,
            "activation": activation,
            "citation_target": ref.uri if capability(ref.scheme).citable_result_type else None,
            "context_ref": SearchResultContextRefOut(
                type="media" if t in MEDIA_TYPES else t,
                id=handle or rid,
                evidence_span_ids=[row["span_id"]] if t == "content_chunk" else [],
                passage_target=None,
            ),
            "locator": locator,
        }
        attribution = source_metadata.get(owner.uri)
        frozen_source = CapturedSource(
            ref=owner.uri,
            title=attribution.title if attribution else None,
            media_kind=attribution.media_kind if attribution else None,
            contributors=attribution.contributors if attribution else None,
            location_label=row.get("citation_label"),
        )
        exact = (
            row.get("span_text")
            or row.get("exact")
            or row.get("body_text")
            or row.get("text")
            or ""
        )
        quote = (
            CapturedQuote(
                exact=exact,
                prefix=(locator or {}).get("text_quote_selector", {}).get("prefix"),
                suffix=(locator or {}).get("text_quote_selector", {}).get("suffix"),
                color=row.get("color"),
            )
            if locator is not None
            else None
        )
        precision = (
            "approximate"
            if locator and locator.get("projection") == "proportional_text_offsets"
            else "time"
            if locator
            and locator["type"] in ("transcript_time_range", "audio_time_range", "video_time_range")
            else "exact"
        )
        from nexus.services.reader_document import transcript_identity

        source_identity = (
            f"g{row['publication_generation']}"
            if row.get("publication_generation") is not None
            else transcript_identity(row["source_unit_ids"])
            if row.get("media_kind") in ("podcast_episode", "video") and row.get("source_unit_ids")
            else None
        )
        frozen_target = (
            CapturedPassageTarget.model_validate(
                {
                    "owner_ref": owner.uri,
                    "locator": locator,
                    "precision": precision,
                    "source_identity": source_identity,
                }
            )
            if locator is not None
            else CapturedResourceTarget(owner_ref=owner.uri)
        )
        if isinstance(frozen_target, CapturedPassageTarget):
            values["context_ref"] = values["context_ref"].model_copy(
                update={"passage_target": frozen_target}
            )
        values["captured_evidence"] = CapturedEvidence(
            quote=quote, source=frozen_source, target=frozen_target
        )
        model = RESULT_MODELS[t]
        results.append(model(**{k: v for k, v in values.items() if k in model.model_fields}))
    return cast("list[SearchResultOut]", results)
