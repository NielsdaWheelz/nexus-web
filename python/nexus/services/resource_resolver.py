"""URI-based resource resolver for conversation references.

Owns the ``<scheme>:<uuid>`` URI grammar and presents resources for prompt
assembly: label/summary/inline-body blocks, plus an enriched ``<quote>`` for
highlights. Data access (SQL + permission per scheme) lives in
:mod:`nexus.services.resource_loaders`; this module is a pure presenter over
its :class:`LoadedResource`. Unknown, missing, or forbidden URIs return a
``missing=True`` block rather than raising.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.resource_loaders import (
    LoadedQuote,
    LoadedResource,
    load_resource_batch,
)

INLINE_THRESHOLD_CHARS = 1500
ResourceUriScheme = Literal[
    "media",
    "library",
    "library_intelligence_artifact",
    "span",
    "chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
]
RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = (
    "media",
    "library",
    "library_intelligence_artifact",
    "span",
    "chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
)
SEARCH_SCOPE_RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = ("media", "library")
# read_resource rejects these outright (a library has no canonical body). `media`
# is NOT here — it is readable (full / too_large) — but stays a valid search scope
# above. `library_intelligence_artifact` is NOT here either — UNLIKE `library` it
# HAS a canonical body (the current revision's content_md), so it is readable; but
# it is NOT a search scope (the co-referenced `library:` URI carries retrieval).
# The three tuples are distinct on purpose; do not merge them.
READ_REJECTED_RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = ("library",)
READABLE_RESOURCE_URI_SCHEMES: tuple[ResourceUriScheme, ...] = tuple(
    scheme for scheme in RESOURCE_URI_SCHEMES if scheme not in READ_REJECTED_RESOURCE_URI_SCHEMES
)


@dataclass(frozen=True)
class ParsedResourceUri:
    raw: str
    scheme: ResourceUriScheme
    resource_id: UUID


@dataclass(frozen=True)
class ResourceUriParseFailure:
    raw: str
    reason: Literal["invalid_format", "unsupported_scheme"]


@dataclass(frozen=True)
class ResolvedResource:
    uri: str
    label: str
    summary: str
    inline_body: str | None
    fetch_hint: str
    quote: LoadedQuote | None = None  # set for highlights → <quote> instead of <body>
    missing: bool = False


def parse_resource_uri(raw: str) -> ParsedResourceUri | ResourceUriParseFailure:
    scheme, sep, ident = raw.partition(":")
    if not sep:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    if scheme not in RESOURCE_URI_SCHEMES:
        return ResourceUriParseFailure(raw=raw, reason="unsupported_scheme")
    try:
        resource_id = UUID(ident)
    except ValueError:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    if str(resource_id) != ident:
        return ResourceUriParseFailure(raw=raw, reason="invalid_format")
    return ParsedResourceUri(
        raw=raw,
        scheme=cast(ResourceUriScheme, scheme),
        resource_id=resource_id,
    )


def format_resource_uri(scheme: ResourceUriScheme, resource_id: UUID) -> str:
    return f"{scheme}:{resource_id}"


def resolve(db: Session, uri: str, *, viewer_id: UUID) -> ResolvedResource:
    return resolve_batch(db, [uri], viewer_id=viewer_id)[0]


def resolve_batch(
    db: Session,
    uris: Sequence[str],
    *,
    viewer_id: UUID,
) -> list[ResolvedResource]:
    parsed_by_uri: dict[str, ParsedResourceUri] = {}
    results: dict[str, ResolvedResource] = {}
    for uri in uris:
        if uri in results or uri in parsed_by_uri:
            continue
        parsed = parse_resource_uri(uri)
        if isinstance(parsed, ResourceUriParseFailure):
            results[uri] = _missing(uri)
        else:
            parsed_by_uri[uri] = parsed
    loaded = load_resource_batch(db, list(parsed_by_uri.values()), viewer_id=viewer_id)
    for uri in parsed_by_uri:
        results[uri] = _present(loaded[uri])
    return [results[uri] for uri in uris]


def _missing(uri: str) -> ResolvedResource:
    return ResolvedResource(
        uri=uri,
        label="(resource unavailable)",
        summary="",
        inline_body=None,
        fetch_hint="",
        missing=True,
    )


def _first_line(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return ""


def _read_resolved(loaded: LoadedResource, *, label: str) -> ResolvedResource:
    """Present a body-bearing scheme: summary + inline body under the threshold."""
    body = loaded.body or ""
    return ResolvedResource(
        uri=loaded.uri,
        label=label,
        summary=_first_line(body),
        inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
        fetch_hint=f'read_resource("{loaded.uri}")',
    )


def _present(loaded: LoadedResource) -> ResolvedResource:
    if loaded.missing:
        return _missing(loaded.uri)
    scheme = loaded.scheme
    if scheme == "media":
        title = loaded.title or ""
        label = f"{title} by {loaded.author}" if loaded.author else title
        kind = loaded.media_kind or "document"
        count = loaded.section_count if loaded.section_count is not None else 0
        word_count = loaded.word_count if loaded.word_count is not None else 0
        unit = "pages" if kind == "pdf" else "sections"
        summary_parts = [kind]
        if word_count:
            summary_parts.append(f"~{word_count:,} words")
        if count:
            summary_parts.append(f"{count} {unit}")
        summary = " · ".join(summary_parts)
        fetch_hint = (
            f'inspect_resource("{loaded.uri}") to map; '
            f'read_resource("{loaded.uri}") to read; '
            f'app_search(scopes=["{loaded.uri}"], query=...) to search'
        )
        return ResolvedResource(
            uri=loaded.uri, label=label, summary=summary, inline_body=None, fetch_hint=fetch_hint
        )
    if scheme == "library":
        name = loaded.title or ""
        summary = f"{name} ({loaded.item_count} items)" if loaded.item_count else name
        return ResolvedResource(
            uri=loaded.uri,
            label=name,
            summary=summary,
            inline_body=None,
            fetch_hint=f'app_search(scopes=["{loaded.uri}"], query=...)',
        )
    if scheme == "library_intelligence_artifact":
        name = loaded.title or ""
        content_md = loaded.body or ""
        library_uri = (
            f"library:{loaded.related_library_id}"
            if loaded.related_library_id is not None
            else None
        )
        library_search = (
            f'; app_search(scopes=["{library_uri}"], query=...) to search the library'
            if library_uri is not None
            else ""
        )
        return ResolvedResource(
            uri=loaded.uri,
            label=f"Library Intelligence — {name}",
            summary=_first_line(content_md) or f"Library Intelligence for {name}",
            inline_body=(
                content_md if content_md and len(content_md) < INLINE_THRESHOLD_CHARS else None
            ),
            fetch_hint=(f'read_resource("{loaded.uri}") for the full synthesis{library_search}'),
        )
    if scheme == "highlight":
        quote = loaded.quote
        if quote is None:
            # justify-defect: the highlight loader always sets quote for a visible highlight.
            raise AssertionError(f"highlight {loaded.uri} loaded without a quote")
        label = f"Highlight in {quote.source_label}" if quote.source_label else "Highlight"
        return ResolvedResource(
            uri=loaded.uri,
            label=label,
            summary=quote.exact,
            inline_body=None,
            fetch_hint=f'read_resource("{loaded.uri}")',
            quote=quote,
        )
    if scheme == "span":
        return _read_resolved(loaded, label=f"{loaded.title} - {loaded.citation_label}")
    if scheme == "chunk":
        return _read_resolved(
            loaded, label=f"{loaded.title} - chunk: {_first_line(loaded.body or '')[:80]}"
        )
    if scheme == "page":
        return _read_resolved(loaded, label=loaded.title or "")
    if scheme == "note_block":
        return _read_resolved(loaded, label=_first_line(loaded.body or "")[:120] or "Note")
    if scheme == "fragment":
        return _read_resolved(
            loaded, label=f"{loaded.title} — fragment {(loaded.fragment_idx or 0) + 1}"
        )
    if scheme == "conversation":
        return ResolvedResource(
            uri=loaded.uri,
            label=loaded.title or "Untitled conversation",
            summary=f"Chat history with {loaded.message_count or 0} messages.",
            inline_body=None,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    if scheme == "message":
        body = loaded.body or ""
        return ResolvedResource(
            uri=loaded.uri,
            label=f"{loaded.message_role}: {body[:40]}".strip(),
            summary=_first_line(body),
            inline_body=body if len(body) < INLINE_THRESHOLD_CHARS else None,
            fetch_hint=f'read_resource("{loaded.uri}")',
        )
    raise AssertionError(f"Unhandled resource URI scheme: {scheme}")
