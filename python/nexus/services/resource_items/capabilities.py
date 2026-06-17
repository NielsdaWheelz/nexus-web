"""Closed resource item capability policy.

`resource_graph.refs` owns identity grammar. This module owns item-level product
facts: readability, search scopes, context search activation, and citable
search-result mapping.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeOrigin


@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    linkable: bool
    attachable: bool
    chat_subject: Literal["none", "label", "scope", "readable", "quote", "generated_output"]
    readable: Literal["none", "scope", "body", "media"]
    citable_result_type: str | None
    app_search_scope: bool
    conversation_search_scope: bool
    citation_output_source: bool
    prompt_render: Literal["none", "label", "inline_body", "quote"]
    expandable: bool
    adjacency_source: bool
    adjacency_target: bool


RESOURCE_ITEM_CAPABILITIES: dict[ResourceScheme, ResourceItemCapability] = {
    "media": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="media",
        citable_result_type="media",
        app_search_scope=True,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "library": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="scope",
        readable="scope",
        citable_result_type=None,
        app_search_scope=True,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "evidence_span": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="evidence_span",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "content_chunk": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="content_chunk",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "highlight": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="quote",
        readable="body",
        citable_result_type="highlight",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="quote",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "page": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="page",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=True,
        adjacency_target=True,
    ),
    "note_block": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="note_block",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=True,
        adjacency_target=True,
    ),
    "fragment": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="fragment",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "conversation": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="body",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "message": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        citable_result_type="message",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "oracle_reading": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "oracle_corpus_passage": ResourceItemCapability(
        linkable=False,
        attachable=False,
        chat_subject="none",
        readable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="none",
        expandable=False,
        adjacency_source=False,
        adjacency_target=False,
    ),
    "library_intelligence_artifact": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "library_intelligence_revision": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "external_snapshot": ResourceItemCapability(
        linkable=False,
        attachable=False,
        chat_subject="none",
        readable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="none",
        expandable=False,
        adjacency_source=False,
        adjacency_target=False,
    ),
    "contributor": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "podcast": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
    "tag": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expandable=False,
        adjacency_source=False,
        adjacency_target=True,
    ),
}

if set(RESOURCE_ITEM_CAPABILITIES) != set(RESOURCE_SCHEMES):
    raise AssertionError("Every ResourceScheme needs one resource item capability")

READABLE_RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.readable in ("body", "media")
)
SCOPE_ONLY_RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.readable == "scope"
)
APP_SEARCH_SCOPE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.app_search_scope
)
CONVERSATION_SEARCH_SCOPE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.conversation_search_scope
)
CITABLE_RESOURCE_RESULT_TYPES: dict[ResourceScheme, str] = {
    scheme: capability.citable_result_type
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.citable_result_type is not None
}
CITATION_OUTPUT_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.citation_output_source
)
LINKABLE_RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items() if capability.linkable
)
ATTACHABLE_RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items() if capability.attachable
)
CHAT_SUBJECT_RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.chat_subject != "none"
)

CONVERSATION_CONTEXT_EDGE_ORIGINS: tuple[EdgeOrigin, ...] = ("user", "citation", "system")
NOTE_MEDIA_SEARCH_EDGE_ORIGINS: tuple[EdgeOrigin, ...] = (
    "user",
    "highlight_note",
)
