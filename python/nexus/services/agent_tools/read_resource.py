"""Provider-neutral read-resource tool execution for chat.

The chat pipeline uses this tool to let the model fetch the exact text of a
resource. Data access is shared with prompt assembly through
:mod:`nexus.services.resource_graph.resolve` (per-scheme bodies) and
:mod:`nexus.services.media_read_map` (media documents); this module only
presents the result, labelling every read with an explicit ``kind``:

- ``quote``       — a highlight's passage (prefix/exact/suffix + source + note).
- ``section``     — a fragment (article/epub section, transcript segment).
- ``page_range``  — a PDF page slice (``page_range:<media>:<a>-<b>``, read-only).
- ``full``        — a short media document, whole.
- ``too_large``   — an over-budget media document; redirect to ``inspect_resource``.

Non-citable bodies (``artifact`` synthesis, ``oracle_reading``) carry
their prose but no citation target: their inline chips are owned by their own pane.

A media-derived pointer (``fragment``/``page_range``/``evidence_span``/
``content_chunk``) is readable when its parent ``media:`` is referenced, even if
the sub-URI itself is not — this is what lets the model open sections a
``document_map`` handed it. Authorization is unchanged: the loaders/core still
gate every read.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy.orm import Session

from nexus.services.chat_quote import render_quote_block
from nexus.services.media_read_map import (
    READ_DOCUMENT_MAX_CHARS,
    load_media_document,
    read_page_range,
)
from nexus.services.resource_graph.context import admits_resource_for_conversation_read
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import (
    LoadedQuote,
    LoadedResource,
    load_resource_batch,
    parent_media_id_for_read_pointer,
)
from nexus.services.resource_items.capabilities import (
    resource_citation_result_type,
    resource_read_policy,
)

READ_RESOURCE_TOOL_NAME = "read_resource"

READ_RESOURCE_TOOL_DEFINITION: dict[str, Any] = {
    "name": READ_RESOURCE_TOOL_NAME,
    "description": (
        "Fetch the exact text of a resource from <subject> or <resources> in your "
        "system context, or a read_uri that inspect_resource returned. Scope resources are not "
        "readable; use app_search with scopes=[...] for those. Every result is "
        "labelled with a kind attribute."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "uri": {"type": "string", "description": "Resource URI or read_uri to read."},
        },
        "required": ["uri"],
        "additionalProperties": False,
    },
}


def _xml_attr(value: object) -> str:
    return xml_escape(str(value), {'"': "&quot;"})


@dataclass(slots=True)
class ReadResourceResult:
    """Executed read-resource tool call.

    ``body`` carries the exact text on success or a model-readable error
    description on failure. ``quote`` is set for highlights (rendered as an
    enriched ``<quote>``); ``kind`` labels the result for the model.
    ``tool_output`` renders every case into the XML returned to the LLM.
    """

    uri: str
    status: Literal["complete", "error"]
    body: str
    kind: str | None = None
    quote: LoadedQuote | None = None
    # Citation target for evidence kinds (quote/section/full/page_range): the
    # (result_type, source_id) get_search_result needs to materialize a chip.
    # None for non-evidence (too_large) and errors.
    citation_result_type: str | None = None
    citation_source_id: str | None = None
    error_code: str | None = None
    library_ref: str | None = None
    artifact_ref: str | None = None
    revision_ref: str | None = None
    revision_status: str | None = None
    revision_is_current: bool | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"

    def tool_output(self, n: int | None = None) -> str:
        if self.status == "error":
            return (
                f'<resource_error uri="{_xml_attr(self.uri)}" '
                f'code="{_xml_attr(self.error_code or "")}">'
                f"{xml_escape(self.body)}"
                f"</resource_error>"
            )
        n_attr = f' n="{n}"' if n is not None else ""
        kind_attr = f' kind="{_xml_attr(self.kind)}"' if self.kind else ""
        metadata_attrs = []
        if self.library_ref is not None:
            metadata_attrs.append(f'library_ref="{_xml_attr(self.library_ref)}"')
        if self.artifact_ref is not None:
            metadata_attrs.append(f'artifact_ref="{_xml_attr(self.artifact_ref)}"')
        if self.revision_ref is not None:
            metadata_attrs.append(f'revision_ref="{_xml_attr(self.revision_ref)}"')
        if self.revision_status is not None:
            metadata_attrs.append(f'revision_status="{_xml_attr(self.revision_status)}"')
        if self.revision_is_current is not None:
            metadata_attrs.append(f'revision_is_current="{str(self.revision_is_current).lower()}"')
        metadata_attr = f" {' '.join(metadata_attrs)}" if metadata_attrs else ""
        if self.quote is not None:
            inner = render_quote_block(
                "quote",
                exact=self.quote.exact,
                prefix=self.quote.prefix,
                suffix=self.quote.suffix,
                source_label=self.quote.source_label,
                note=self.quote.note,
            )
            return (
                f'<resource uri="{_xml_attr(self.uri)}"{n_attr}{kind_attr}{metadata_attr}>'
                f"\n{inner}\n</resource>"
            )
        return (
            f'<resource uri="{_xml_attr(self.uri)}"{n_attr}{kind_attr}{metadata_attr}>'
            f"<body>{xml_escape(self.body)}</body>"
            f"</resource>"
        )


def execute_read_resource(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    uri: str,
) -> ReadResourceResult:
    """Read the exact text of a referenced resource for a chat turn."""

    if not _readable_in_conversation(db, conversation_id, uri):
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=(
                f"Resource {uri} is not in this conversation's context refs. "
                "Use app_search to find new sources first."
            ),
            error_code="not_in_context_refs",
        )

    if uri.startswith("page_range:"):
        return _read_page_range(db, viewer_id, uri)

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            scheme = uri.partition(":")[0]
            return ReadResourceResult(
                uri=uri,
                status="error",
                body=f"Resource URI scheme '{scheme}' is not supported.",
                error_code="unknown_scheme",
            )
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=f"Resource URI {uri} is malformed or has an invalid identifier.",
            error_code="invalid_uri",
        )

    read_policy = resource_read_policy(parsed)
    if read_policy == "scope":
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=(
                f"Resource {uri} is a search scope, not a readable resource. "
                f'Call app_search(query=..., scopes=["{uri}"]) instead.'
            ),
            error_code="scope_not_readable",
        )

    if read_policy == "none":
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=f"Resource {uri} has no readable body for read_resource.",
            error_code="not_readable",
        )

    if read_policy == "media":
        return _read_media(db, viewer_id, parsed.id, uri)

    loaded = load_resource_batch(db, [parsed], viewer_id=viewer_id)[uri]
    return _present_read(loaded)


def _missing(uri: str) -> ReadResourceResult:
    return ReadResourceResult(
        uri=uri,
        status="error",
        body=f"Resource {uri} is unavailable or you do not have access to it.",
        error_code="missing",
    )


def _read_media(db: Session, viewer_id: UUID, media_id: UUID, uri: str) -> ReadResourceResult:
    document = load_media_document(db, viewer_id, media_id)
    if document is None:
        return _missing(uri)
    if document.char_count > READ_DOCUMENT_MAX_CHARS:
        return ReadResourceResult(
            uri=uri,
            status="complete",
            body=(
                f"This document is {document.char_count:,} characters — too large to read whole. "
                f'Call inspect_resource("{uri}") for its section map, then read the sections you need.'
            ),
            kind="too_large",
        )
    return ReadResourceResult(
        uri=uri,
        status="complete",
        body=document.body,
        kind="full",
        citation_result_type=_media_citation_result_type(document.kind),
        citation_source_id=str(media_id),
    )


def _read_page_range(db: Session, viewer_id: UUID, uri: str) -> ReadResourceResult:
    parsed = _parse_page_range(uri)
    if parsed is None:
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=f"Resource URI {uri} is not a valid page_range pointer.",
            error_code="invalid_uri",
        )
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
            quote=quote,
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
        library_ref = (
            f"library:{loaded.related_library_id}"
            if loaded.related_library_id is not None
            else None
        )
        artifact_ref = (
            f"artifact:{loaded.related_artifact_id}"
            if loaded.related_artifact_id is not None
            else None
        )
        revision_ref = (
            f"artifact_revision:{loaded.related_revision_id}"
            if loaded.related_revision_id is not None
            else None
        )
        return ReadResourceResult(
            uri=loaded.uri,
            status="complete",
            body=loaded.body or "",
            kind=("artifact_revision" if scheme == "artifact_revision" else "artifact"),
            library_ref=library_ref,
            artifact_ref=artifact_ref,
            revision_ref=revision_ref,
            revision_status=loaded.related_revision_status,
            revision_is_current=loaded.related_revision_is_current,
        )
    if scheme == "oracle_reading":
        # The reading's body is its question + motto/argument + interpretation. NON-citable
        # (like the LI artifact): its per-phase passages are rendered as chips by the oracle
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


def _readable_in_conversation(db: Session, conversation_id: UUID, uri: str) -> bool:
    """A URI is readable when it is context, or its parent media is (gate O2)."""
    parsed = parse_resource_ref(uri)
    if not isinstance(parsed, ResourceRefParseFailure) and admits_resource_for_conversation_read(
        db, conversation_id=conversation_id, target=parsed
    ):
        return True
    parent = _parent_media_ref(db, uri)
    return parent is not None and admits_resource_for_conversation_read(
        db, conversation_id=conversation_id, target=parent
    )


def _parent_media_ref(db: Session, uri: str) -> ResourceRef | None:
    """The ``media:`` ref a media-derived read pointer belongs to, else None."""
    if uri.startswith("page_range:"):
        parsed = _parse_page_range(uri)
        return ResourceRef(scheme="media", id=parsed[0]) if parsed is not None else None
    ref = parse_resource_ref(uri)
    if isinstance(ref, ResourceRefParseFailure):
        return None
    media_id = parent_media_id_for_read_pointer(db, scheme=ref.scheme, resource_id=ref.id)
    return ResourceRef(scheme="media", id=media_id) if media_id is not None else None


def _parse_page_range(uri: str) -> tuple[UUID, int, int] | None:
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
