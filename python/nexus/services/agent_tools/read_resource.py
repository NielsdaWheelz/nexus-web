"""Route-neutral read-resource tool execution for model generations.

The shared tool pipeline uses this to let a model fetch the exact text of a
resource its handler has already admitted. Data access is shared with prompt
assembly through :mod:`nexus.services.resource_graph.resolve` (per-scheme
bodies) and :mod:`nexus.services.media_read_map` (media documents); this module
only presents the result, labelling every read with an explicit ``kind``:

- ``quote``       — a highlight's passage (prefix/exact/suffix + source + note).
- ``section``     — a fragment (article/epub section, transcript segment).
- ``page_range``  — a PDF page slice (``page_range:<media>:<a>-<b>``, read-only).
- ``full``        — a short media document, whole.
- ``too_large``   — an over-budget media document; redirect to the document map.

Non-citable bodies (``artifact`` synthesis, ``oracle_reading``) carry their
prose but no citation target: their inline chips are owned by their own pane.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.media_read_map import (
    READ_DOCUMENT_MAX_CHARS,
    load_media_document,
    read_page_range,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import ResolvedResource, load_resource_batch
from nexus.services.resource_items.capabilities import (
    resource_citation_result_type,
    resource_read_policy,
)

type ReadRefusalCode = Literal["unknown_scheme", "invalid_uri", "missing", "not_readable"]


@dataclass(frozen=True, slots=True)
class ReadRefusal:
    code: ReadRefusalCode


@dataclass(frozen=True, slots=True)
class ReadResourceResult:
    """One resource's exact text plus the chip identity it can be cited as."""

    uri: str
    body: str
    kind: str
    # (result_type, source_id) is what get_search_result needs to materialize a
    # chip; both are None for non-evidence bodies and for ``too_large``.
    citation_result_type: str | None = None
    citation_source_id: str | None = None


def execute_read_resource(
    db: Session,
    *,
    viewer_id: UUID,
    uri: str,
) -> ReadResourceResult | ReadRefusal:
    """Read exact bounded text from one admitted resource."""

    if uri.startswith("page_range:"):
        return _bounded(_read_page_range(db, viewer_id, uri))

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            return ReadRefusal("unknown_scheme")
        return ReadRefusal("invalid_uri")

    read_policy = resource_read_policy(parsed)
    if read_policy in ("scope", "none"):
        return ReadRefusal("not_readable")
    if read_policy == "media":
        return _bounded(_read_media(db, viewer_id, parsed.id, uri))
    return _bounded(_present_read(load_resource_batch(db, [parsed], viewer_id=viewer_id)[uri]))


def _bounded(result: ReadResourceResult | ReadRefusal) -> ReadResourceResult | ReadRefusal:
    if isinstance(result, ReadRefusal) or len(result.body) <= READ_DOCUMENT_MAX_CHARS:
        return result
    return ReadResourceResult(
        uri=result.uri,
        body=(
            f"This resource is {len(result.body):,} characters — too large to read in one call. "
            "Inspect or search the admitted parent and read a narrower section."
        ),
        kind="too_large",
    )


def _read_media(
    db: Session, viewer_id: UUID, media_id: UUID, uri: str
) -> ReadResourceResult | ReadRefusal:
    document = load_media_document(db, viewer_id, media_id)
    if document is None:
        return ReadRefusal("missing")
    return ReadResourceResult(
        uri=uri,
        body=document.body,
        kind="full",
        citation_result_type={"podcast_episode": "episode", "video": "video"}.get(
            document.kind, "media"
        ),
        citation_source_id=str(media_id),
    )


def _read_page_range(db: Session, viewer_id: UUID, uri: str) -> ReadResourceResult | ReadRefusal:
    parsed = parse_page_range(uri)
    if parsed is None:
        return ReadRefusal("invalid_uri")
    media_id, page_start, page_end = parsed
    body = read_page_range(db, viewer_id, media_id, page_start, page_end)
    if body is None:
        return ReadRefusal("missing")
    return ReadResourceResult(
        uri=uri,
        body=body,
        kind="page_range",
        citation_result_type="media",
        citation_source_id=str(media_id),
    )


def _present_read(loaded: ResolvedResource) -> ReadResourceResult | ReadRefusal:
    if loaded.missing:
        return ReadRefusal("missing")
    parsed = _loaded_ref(loaded)
    scheme = parsed.scheme
    citation_result_type = resource_citation_result_type(parsed)
    citation_source_id = str(parsed.id) if citation_result_type is not None else None
    if scheme == "highlight":
        quote = loaded.quote
        if quote is None:
            # justify-defect: the highlight loader always sets quote for a visible highlight.
            raise AssertionError(f"highlight {loaded.uri} loaded without a quote")
        return ReadResourceResult(
            uri=loaded.uri,
            body=quote.exact,
            kind="quote",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme == "fragment":
        return ReadResourceResult(
            uri=loaded.uri,
            body=loaded.body or "",
            kind="section",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme == "conversation":
        return ReadResourceResult(
            uri=loaded.uri,
            body=f"{loaded.title}\nChat history with {loaded.message_count or 0} messages.",
            kind="conversation",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme == "message":
        return ReadResourceResult(
            uri=loaded.uri,
            body=f"{loaded.message_role}:\n{loaded.body or ''}",
            kind="message",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme in ("artifact", "artifact_revision", "oracle_reading", "oracle_passage_anchor"):
        # Synthesis prose, Oracle readings and their anchors are NON-citable here:
        # their inline markers reference the owning pane's own citation edges.
        return ReadResourceResult(uri=loaded.uri, body=loaded.body or "", kind=scheme)
    if scheme in ("evidence_span", "content_chunk", "page", "note_block", "reader_apparatus_item"):
        return ReadResourceResult(
            uri=loaded.uri,
            body=loaded.body or "",
            kind=scheme,
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    # media/library never reach here: media is handled before the loader, library rejected.
    raise AssertionError(f"Unreadable resource URI scheme reached read presenter: {scheme}")


def _loaded_ref(loaded: ResolvedResource) -> ResourceRef:
    parsed = parse_resource_ref(loaded.uri)
    if isinstance(parsed, ResourceRefParseFailure):
        # justify-defect: loaded resources come from typed ResourceRef loader inputs.
        raise AssertionError(f"Loaded resource has invalid URI {loaded.uri!r}")
    return parsed


def parse_page_range(uri: str) -> tuple[UUID, int, int] | None:
    """Parse ``page_range:<media_uuid>:<a>-<b>``; None if malformed."""
    scheme, _, rest = uri.partition(":")
    if scheme != "page_range":
        return None
    media_str, _, range_str = rest.partition(":")
    start_str, sep, end_str = range_str.partition("-")
    if not sep:
        return None
    try:
        media_id = UUID(media_str)
        page_start = int(start_str)
        page_end = int(end_str)
    except ValueError:
        return None
    if str(media_id) != media_str or page_start < 1 or page_end < page_start:
        return None
    return media_id, page_start, page_end
