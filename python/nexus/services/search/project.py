"""Hydrated rows -> the ``SearchResultOut`` wire union: refs, locators, snippets, activation."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any, cast, get_args
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Present, presence_from_nullable
from nexus.schemas.retrieval import LocatorBackedResultType
from nexus.schemas.search import (
    RESULT_MODELS,
    SearchResultContextRefOut,
    SearchResultOut,
    SearchResultSourceOut,
)
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    load_contributor_credits_for_podcasts,
)
from nexus.services.locator_resolver import evidence_resolution, locator_from_resolution
from nexus.services.media import list_collection_media_for_viewer_by_ids
from nexus.services.resource_graph.highlight_notes import highlight_excerpts_for_note_blocks
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.resource_items.routing import resource_activations_for_refs
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
    "dossier": "artifact",
}


def family_of(result_type: str) -> str:
    return "media" if result_type in MEDIA_TYPES else result_type


def _ref(scheme: str, resource_id: UUID) -> ResourceRef:
    return ResourceRef(cast("ResourceScheme", scheme), resource_id)


def _truncate(snippet: str) -> str:
    """At most ~300 characters, keeping the first ``<b>`` match in view."""
    if len(snippet) <= MAX_SNIPPET:
        return snippet
    match = snippet.lower().find("<b>")
    if match > MAX_SNIPPET:
        start = max(0, match - MAX_SNIPPET // 3)
        start = snippet.find(" ", start, match) + 1 or start
        end = min(len(snippet), start + MAX_SNIPPET)
        space = snippet.rfind(" ", match, end)
        end = space if space > match else end
        return f"...{snippet[start:end]}{'...' if end < len(snippet) else ''}"
    cut = snippet[:MAX_SNIPPET]
    space = cut.rfind(" ")
    return (cut[:space] if space > MAX_SNIPPET // 2 else cut) + "..."


def snippet(text: str, terms: str, headline: str | None = None) -> str:
    """At most ~300 characters, ``<b>`` the only markup (I5): the headline when it marked a
    match, else a window around the first literal term, else the text's start."""
    if headline and "<b>" in headline:
        return _truncate(headline)
    lower = text.lower()
    phrase = " ".join(terms.lower().split())
    words = (phrase, *re.findall(r"[a-z0-9]{2,}", phrase))
    found = [(lower.find(word), word) for word in words if word and word in lower]
    if not found:
        return _truncate(text)
    at, word = min(found, key=lambda hit: (hit[0], -len(hit[1])))
    start = text.find(" ", at - MAX_SNIPPET // 3, at) + 1 if at > MAX_SNIPPET // 3 else 0
    end = at + len(word)
    return _truncate(f"{'...' if start else ''}{text[start:at]}<b>{text[at:end]}</b>{text[end:]}")


def build_source_label(source: SearchResultSourceOut | MediaSummaryOut) -> str:
    """``title - credited names - date - kind``; chat labels its citations with it too."""
    names = ", ".join(c.credited_name for c in source.contributors if c.credited_name)
    date = source.original_published_date
    kind = (source.media_kind or "").replace("_", " ")
    parts = [source.title, names, date.value if isinstance(date, Present) else "", kind]
    return " - ".join(part for part in parts if part)


def _locator(row: RowMapping) -> dict[str, Any] | None:
    """The row's reader locator, or None where its evidence span no longer resolves."""
    if row["type"] not in ("content_chunk", "evidence_span"):
        return row.get("locator")
    resolution = evidence_resolution(
        evidence_span_id=row["span_id"],
        owner_id=row["media_id"],
        span_text=row["span_text"],
        selector=row["selector"],
        resolver_kind=row["resolver_kind"],
    )
    return locator_from_resolution(
        resolution, media_id=row["media_id"], media_kind=row["media_kind"]
    )


def _refs(row: RowMapping) -> tuple[ResourceRef, ResourceRef]:
    """(occurrence, owner): the resource a hit names and the one that receives it."""
    t = row["type"]
    if t == "artifact":
        return _ref("artifact_revision", row["revision_id"]), _ref("conversation", row["id"])
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
    for hit in hits:
        ids.setdefault(family_of(hit.type), []).append(hit.id)
    rows = {
        (family, row["id"]): row
        for family, family_ids in ids.items()
        for row in hydrate(db, viewer_id, family, family_ids, terms)
    }
    sourced = [row["media_id"] for row in rows.values() if "media_title" in row]
    credits = load_contributor_credits_for_media(db, sourced)
    credits |= load_contributor_credits_for_podcasts(db, ids.get("podcast", []))
    summaries = {
        item.id: item.summary
        for item in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=ids.get("media", [])
        )
    }
    excerpts = highlight_excerpts_for_note_blocks(db, viewer_id, ids.get("note_block", []))
    placed = []
    for hit in hits:
        row = rows.get((family_of(hit.type), hit.id))
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
        placed.append((row, hit.score, locator, *_refs(row)))
    refs = [ref for *_, ref, _ in placed]
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=refs)
    results = []
    for row, score, locator, ref, owner in placed:
        t = row["type"]
        rid = row["id"]
        activation = activations[ref.uri]
        if activation.href is None:
            raise AssertionError(f"{t} search result is not activatable")
        values: dict[str, Any] = {"media_id": None, "media_kind": None, **row}
        if "media_title" in row:  # passages and highlights carry their source
            source = SearchResultSourceOut(
                media_id=row["media_id"],
                media_kind=row["media_kind"],
                title=row["media_title"],
                contributors=credits.get(row["media_id"], []),
                original_published_date=presence_from_nullable(row["original_published_date"]),
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
            "snippet": snippet(row["text"] or "", terms, row["headline"]),
            "resource_ref": ref.uri,
            "owner_resource_ref": owner.uri,
            "action_subject_ref": (owner if t in _PASSAGES else ref).uri,
            "activation": activation,
            "citation_target": ref.uri if resource_citation_result_type(ref) else None,
            "context_ref": SearchResultContextRefOut(
                type="media" if t in MEDIA_TYPES else t,
                id=handle or rid,
                evidence_span_ids=[row["span_id"]] if t == "content_chunk" else [],
            ),
            "locator": locator,
        }
        model = RESULT_MODELS[t]
        results.append(model(**{k: v for k, v in values.items() if k in model.model_fields}))
    return cast("list[SearchResultOut]", results)
