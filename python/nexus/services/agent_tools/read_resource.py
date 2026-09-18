"""Route-neutral read-resource tool execution for model generations.

The shared tool pipeline uses this to let a model fetch the exact text of a
resource admitted by its frozen generation scope. Data access is shared with prompt assembly through
:mod:`nexus.services.resource_graph.resolve` (per-scheme bodies) and
:mod:`nexus.services.media_read_map` (media documents); this module only
presents the result, labelling every read with an explicit ``kind``:

- ``quote``       — a highlight's passage (prefix/exact/suffix + source + note).
- ``section``     — a fragment (article/epub section, transcript segment).
- ``page_range``  — a PDF page slice (``page_range:<media>:<a>-<b>``, read-only).
- ``full``        — a short media document, whole.
- ``too_large``   — an over-budget media document; redirect to the document-map binding.

Non-citable bodies (``artifact`` synthesis, ``oracle_reading``) carry
their prose but no citation target: their inline chips are owned by their own pane.

A media-derived pointer (``fragment``/``page_range``/``evidence_span``/
``content_chunk``) is readable when its parent ``media:`` is referenced, even if
the sub-URI itself is not. Authorization is unchanged: the loaders/core still
gate every read.
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
from nexus.services.resource_graph.resolve import (
    LoadedResource,
    load_resource_batch,
)
from nexus.services.resource_items.capabilities import (
    resource_citation_result_type,
    resource_read_policy,
)


@dataclass(slots=True)
class ReadResourceResult:
    """Executed read-resource tool call.

    ``body`` carries exact text on success and is empty on failure. The
    canonical tool-runtime binding owns the model-facing JSON projection.
    """

    uri: str
    status: Literal["complete", "error"]
    body: str = ""
    kind: str | None = None
    # Citation target for evidence kinds (quote/section/full/page_range): the
    # (result_type, source_id) get_search_result needs to materialize a chip.
    # None for non-evidence (too_large) and errors.
    citation_result_type: str | None = None
    citation_source_id: str | None = None
    error_code: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"


def execute_read_resource(
    db: Session,
    *,
    viewer_id: UUID,
    admitted_resource_uris: frozenset[str],
    uri: str,
) -> ReadResourceResult:
    """Read exact text under one operation-frozen resource admission set."""

    from nexus.services.tool_runtime.resource_scope import resource_uri_is_admitted

    if not resource_uri_is_admitted(
        db,
        uri=uri,
        admitted_resource_uris=admitted_resource_uris,
        allow_derived_read=True,
    ):
        return ReadResourceResult(uri=uri, status="error", error_code="not_in_context_refs")

    if uri.startswith("page_range:"):
        return _enforce_read_bound(_read_page_range(db, viewer_id, uri))

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            return ReadResourceResult(uri=uri, status="error", error_code="unknown_scheme")
        return ReadResourceResult(uri=uri, status="error", error_code="invalid_uri")

    read_policy = resource_read_policy(parsed)
    if read_policy == "scope":
        return ReadResourceResult(uri=uri, status="error", error_code="scope_not_readable")

    if read_policy == "none":
        return ReadResourceResult(uri=uri, status="error", error_code="not_readable")

    if read_policy == "media":
        return _enforce_read_bound(_read_media(db, viewer_id, parsed.id, uri))

    loaded = load_resource_batch(db, [parsed], viewer_id=viewer_id)[uri]
    return _enforce_read_bound(_present_read(loaded))


def _enforce_read_bound(result: ReadResourceResult) -> ReadResourceResult:
    if result.is_error or result.kind == "too_large" or len(result.body) <= READ_DOCUMENT_MAX_CHARS:
        return result
    return ReadResourceResult(
        uri=result.uri,
        status="complete",
        body=(
            f"This resource is {len(result.body):,} characters — too large to read in one call. "
            "Inspect or search the admitted parent and read a narrower section."
        ),
        kind="too_large",
    )


def _missing(uri: str) -> ReadResourceResult:
    return ReadResourceResult(uri=uri, status="error", error_code="missing")


def _read_media(db: Session, viewer_id: UUID, media_id: UUID, uri: str) -> ReadResourceResult:
    document = load_media_document(db, viewer_id, media_id)
    if document is None:
        return _missing(uri)
    return ReadResourceResult(
        uri=uri,
        status="complete",
        body=document.body,
        kind="full",
        citation_result_type=_media_citation_result_type(document.kind),
        citation_source_id=str(media_id),
    )


def _read_page_range(db: Session, viewer_id: UUID, uri: str) -> ReadResourceResult:
    parsed = parse_page_range(uri)
    if parsed is None:
        return ReadResourceResult(uri=uri, status="error", error_code="invalid_uri")
    media_id, page_start, page_end = parsed
    body = read_page_range(db, viewer_id, media_id, page_start, page_end)
    if body is None:
        return _missing(uri)
    return ReadResourceResult(
        uri=uri,
        status="complete",
        body=body,
        kind="page_range",
        citation_result_type="media",
        citation_source_id=str(media_id),
    )


def _media_citation_result_type(kind: str) -> str:
    if kind == "podcast_episode":
        return "episode"
    if kind == "video":
        return "video"
    return "media"


def _present_read(loaded: LoadedResource) -> ReadResourceResult:
    if loaded.missing:
        return _missing(loaded.uri)
    parsed = _loaded_ref(loaded)
    scheme = parsed.scheme
    if scheme == "highlight":
        quote = loaded.quote
        if quote is None:
            # justify-defect: the highlight loader always sets quote for a visible highlight.
            raise AssertionError(f"highlight {loaded.uri} loaded without a quote")
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=quote.exact,
            kind="quote",
            citation_result_type=resource_citation_result_type(parsed),
            citation_source_id=str(parsed.id),
        )
    if scheme == "fragment":
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind="section",
            citation_result_type=resource_citation_result_type(parsed),
            citation_source_id=str(parsed.id),
        )
    citation_result_type = resource_citation_result_type(parsed)
    citation_source_id = str(parsed.id) if citation_result_type is not None else None
    if scheme == "conversation":
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=f"{loaded.title}\nChat history with {loaded.message_count or 0} messages.",
            kind="conversation",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme == "message":
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=f"{loaded.message_role}:\n{loaded.body or ''}",
            kind="message",
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    if scheme in ("artifact", "artifact_revision"):
        # Synthesis prose is NON-citable here: inline [N] markers reference the
        # revision's own citations, not a get_search_result chip.
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind=("artifact_revision" if scheme == "artifact_revision" else "artifact"),
        )
    if scheme == "oracle_reading":
        # The reading's body is its question + motto/argument + interpretation. NON-citable
        # (like a Dossier artifact): its per-phase passages are rendered as chips by the Oracle
        # pane from the reading's own citation edges, not a get_search_result chip.
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind="oracle_reading",
        )
    if scheme == "oracle_passage_anchor":
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind="oracle_passage_anchor",
        )
    if scheme in ("evidence_span", "content_chunk", "page", "note_block", "reader_apparatus_item"):
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind=scheme,
            citation_result_type=citation_result_type,
            citation_source_id=citation_source_id,
        )
    # media/library never reach here: media is handled before the loader, library rejected.
    raise AssertionError(f"Unreadable resource URI scheme reached read presenter: {scheme}")


def _loaded_ref(loaded: LoadedResource) -> ResourceRef:
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
