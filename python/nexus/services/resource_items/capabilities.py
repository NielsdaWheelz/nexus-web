"""Closed resource item capability policy.

`resource_graph.refs` owns identity grammar. This module owns item-level route,
read, search, citation, prompt, attachment, and expansion policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeOrigin

ResourceChatSubjectMode = Literal["none", "label", "scope", "readable", "quote", "generated_output"]
ResourceReadMode = Literal["none", "scope", "body", "media"]
ResourceInspectMode = Literal["none", "media_document_map"]
ResourcePromptRenderMode = Literal["none", "label", "inline_body", "quote"]
ResourceExpansionPolicy = Literal[
    "none",
    "media_owned_reader_children",
    "page_note_blocks",
    "note_block_owned_evidence",
    "library_intelligence_artifact_revisions",
]


@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    linkable: bool
    attachable: bool
    chat_subject: ResourceChatSubjectMode
    readable: ResourceReadMode
    inspectable: ResourceInspectMode
    citable_result_type: str | None
    app_search_scope: bool
    conversation_search_scope: bool
    citation_output_source: bool
    prompt_render: ResourcePromptRenderMode
    expansion_policy: ResourceExpansionPolicy
    adjacency_source: bool
    adjacency_target: bool

    @property
    def expandable(self) -> bool:
        return self.expansion_policy != "none"


RESOURCE_ITEM_CAPABILITIES: dict[ResourceScheme, ResourceItemCapability] = {
    "media": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="media",
        inspectable="media_document_map",
        citable_result_type="media",
        app_search_scope=True,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expansion_policy="media_owned_reader_children",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "library": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="scope",
        readable="scope",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=True,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "evidence_span": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="evidence_span",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "content_chunk": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="content_chunk",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "highlight": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="quote",
        readable="body",
        inspectable="none",
        citable_result_type="highlight",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="quote",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "page": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="page",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="page_note_blocks",
        adjacency_source=True,
        adjacency_target=True,
    ),
    "note_block": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="note_block",
        app_search_scope=False,
        conversation_search_scope=True,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="note_block_owned_evidence",
        adjacency_source=True,
        adjacency_target=True,
    ),
    "fragment": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="fragment",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "conversation": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="body",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "message": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="message",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "oracle_reading": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "oracle_passage_anchor": ResourceItemCapability(
        linkable=True,
        attachable=False,
        chat_subject="none",
        readable="body",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "library_intelligence_artifact": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="library_intelligence_artifact_revisions",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "library_intelligence_revision": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=True,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "external_snapshot": ResourceItemCapability(
        linkable=False,
        attachable=False,
        chat_subject="none",
        readable="none",
        inspectable="none",
        citable_result_type="web_result",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="none",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=False,
    ),
    "contributor": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="none",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "podcast": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="label",
        readable="none",
        inspectable="none",
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="label",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "reader_apparatus_item": ResourceItemCapability(
        linkable=True,
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        citable_result_type="reader_apparatus_item",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
}

if set(RESOURCE_ITEM_CAPABILITIES) != set(RESOURCE_SCHEMES):
    raise AssertionError("Every ResourceScheme needs one resource item capability")


def capability_for_scheme(scheme: ResourceScheme) -> ResourceItemCapability:
    return RESOURCE_ITEM_CAPABILITIES[scheme]


def capability_for_ref(ref: ResourceRef) -> ResourceItemCapability:
    return capability_for_scheme(ref.scheme)


def resource_can_link(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).linkable


def resource_can_attach(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).attachable


def resource_can_be_chat_subject(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).chat_subject != "none"


def resource_read_policy(ref: ResourceRef) -> ResourceReadMode:
    return capability_for_ref(ref).readable


def resource_inspect_policy(ref: ResourceRef) -> ResourceInspectMode:
    return capability_for_ref(ref).inspectable


def resource_prompt_render_policy(ref: ResourceRef) -> ResourcePromptRenderMode:
    return capability_for_ref(ref).prompt_render


def resource_citation_result_type(ref: ResourceRef) -> str | None:
    return capability_for_ref(ref).citable_result_type


def resource_can_be_citation_output_source(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).citation_output_source


def resource_can_be_app_search_scope(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).app_search_scope


def resource_can_activate_conversation_search_scope(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).conversation_search_scope


def resource_can_own_ordered_adjacency(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).adjacency_source


def resource_can_be_ordered_adjacency_target(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).adjacency_target


def app_search_scope_schemes() -> tuple[ResourceScheme, ...]:
    return tuple(
        scheme
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.app_search_scope
    )


def conversation_search_scope_schemes() -> tuple[ResourceScheme, ...]:
    return tuple(
        scheme
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.conversation_search_scope
    )


def citation_output_source_schemes() -> tuple[ResourceScheme, ...]:
    return tuple(
        scheme
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.citation_output_source
    )


def app_search_scope_hint() -> str:
    return ", ".join(f"{scheme}:UUID" for scheme in app_search_scope_schemes())


def expandable_resource_schemes() -> tuple[ResourceScheme, ...]:
    return tuple(
        scheme for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items() if capability.expandable
    )


def resource_expansion_policy(ref: ResourceRef) -> ResourceExpansionPolicy:
    return capability_for_ref(ref).expansion_policy


def expand_owned_child_refs(
    db: Session, *, viewer_id: UUID, ref: ResourceRef
) -> tuple[ResourceRef, ...]:
    policy = resource_expansion_policy(ref)
    if policy == "none":
        return ()
    if policy == "media_owned_reader_children":
        return (
            *_child_refs(
                db,
                "evidence_span",
                "SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(
                db,
                "content_chunk",
                "SELECT id FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(db, "fragment", "SELECT id FROM fragments WHERE media_id = :id", ref.id),
            *_child_refs(
                db,
                "highlight",
                "SELECT id FROM highlights WHERE user_id = :viewer_id AND anchor_media_id = :id",
                ref.id,
                viewer_id=viewer_id,
            ),
        )
    if policy == "page_note_blocks":
        return (*_child_refs(db, "note_block", _PAGE_NOTE_BLOCKS_SQL, ref.id, viewer_id=viewer_id),)
    if policy == "note_block_owned_evidence":
        return (
            *_child_refs(
                db,
                "evidence_span",
                "SELECT id FROM evidence_spans WHERE owner_kind = 'note_block' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(
                db,
                "content_chunk",
                "SELECT id FROM content_chunks WHERE owner_kind = 'note_block' AND owner_id = :id",
                ref.id,
            ),
        )
    if policy == "library_intelligence_artifact_revisions":
        return _child_refs(
            db,
            "library_intelligence_revision",
            "SELECT id FROM library_intelligence_artifact_revisions WHERE artifact_id = :id",
            ref.id,
        )
    assert_never(policy)


def _child_refs(
    db: Session,
    scheme: ResourceScheme,
    sql: str,
    parent_id: UUID,
    *,
    viewer_id: UUID | None = None,
) -> tuple[ResourceRef, ...]:
    params: dict[str, object] = {"id": parent_id}
    if viewer_id is not None:
        params["viewer_id"] = viewer_id
    return tuple(ResourceRef(scheme=scheme, id=row[0]) for row in db.execute(text(sql), params))


CONVERSATION_CONTEXT_EDGE_ORIGINS: tuple[EdgeOrigin, ...] = ("user", "citation", "system")
NOTE_MEDIA_SEARCH_EDGE_ORIGINS: tuple[EdgeOrigin, ...] = (
    "user",
    "highlight_note",
)


_PAGE_NOTE_BLOCKS_SQL = """
WITH RECURSIVE contained(id) AS (
    SELECT target_id
    FROM resource_edges
    WHERE user_id = :viewer_id
      AND origin = 'user'
      AND source_scheme = 'page'
      AND source_id = :id
      AND target_scheme = 'note_block'
      AND source_order_key IS NOT NULL
    UNION
    SELECT e.target_id
    FROM resource_edges e
    JOIN contained c ON c.id = e.source_id
    WHERE e.user_id = :viewer_id
      AND e.origin = 'user'
      AND e.source_scheme = 'note_block'
      AND e.target_scheme = 'note_block'
      AND e.source_order_key IS NOT NULL
)
SELECT id FROM contained
"""
