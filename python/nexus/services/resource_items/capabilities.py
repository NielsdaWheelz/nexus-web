"""Closed resource item capability policy.

`resource_graph.refs` owns identity grammar. This module owns item-level route,
read, search, citation, prompt, attachment, and expansion policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_visibility_filter
from nexus.db.models import Highlight
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
    "artifact_revisions",
]
UserLinkTargetMode = Literal["none", "direct", "materialize_passage"]
ShareMode = Literal[
    "None",
    "CopyOnly",
    "CopyWithLibraryFiling",
    "ResourceGrants",
    "HighlightGrants",
    "LibraryMembership",
]


class ResourceInspectorSurfaceRole(StrEnum):
    Contents = "Contents"
    LinkedItems = "LinkedItems"
    Forks = "Forks"
    Dossier = "Dossier"


ResourceInspectorLinkedItemsSurface = Literal[
    "MediaEvidence", "ConversationContext", "ResourceConnections"
]
ResourceInspectorForksSurface = Literal["ConversationForks"]


@dataclass(frozen=True, slots=True)
class ResourceInspectorResourcePolicy:
    linked_items: ResourceInspectorLinkedItemsSurface
    forks: ResourceInspectorForksSurface | None
    default_surface_order: tuple[ResourceInspectorSurfaceRole, ...]


ResourceInspectorPolicy = ResourceInspectorResourcePolicy | None


@dataclass(frozen=True, slots=True)
class ResourceUserRelationPolicy:
    """Universal Link authoring capability (universal-link-authoring-hard-cutover.md,
    Capability Contract). Replaces the scalar ``linkable`` boolean, which could not
    distinguish a direct durable endpoint from raw material a search hit must
    materialize into a ``passage_anchor`` before it can be linked (Invariant 4).
    """

    user_link_source: bool
    user_link_target: UserLinkTargetMode

    @property
    def note_reference_target(self) -> bool:
        return self.user_link_target == "direct"


@dataclass(frozen=True, slots=True)
class ResourceItemCapability:
    sharing: ShareMode
    user_relation: ResourceUserRelationPolicy
    attachable: bool
    chat_subject: ResourceChatSubjectMode
    readable: ResourceReadMode
    inspectable: ResourceInspectMode
    inspector_policy: ResourceInspectorPolicy
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
        sharing="ResourceGrants",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="readable",
        readable="media",
        inspectable="media_document_map",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="MediaEvidence",
            forks=None,
            default_surface_order=(
                ResourceInspectorSurfaceRole.Contents,
                ResourceInspectorSurfaceRole.LinkedItems,
                ResourceInspectorSurfaceRole.Dossier,
            ),
        ),
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
        sharing="LibraryMembership",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="scope",
        readable="scope",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ResourceConnections",
            forks=None,
            default_surface_order=(ResourceInspectorSurfaceRole.Dossier,),
        ),
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(
            user_link_source=False, user_link_target="materialize_passage"
        ),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(
            user_link_source=False, user_link_target="materialize_passage"
        ),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="HighlightGrants",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="quote",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ResourceConnections",
            forks=None,
            default_surface_order=(ResourceInspectorSurfaceRole.Dossier,),
        ),
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
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ResourceConnections",
            forks=None,
            default_surface_order=(ResourceInspectorSurfaceRole.Dossier,),
        ),
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(
            user_link_source=False, user_link_target="materialize_passage"
        ),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="label",
        readable="body",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ConversationContext",
            forks="ConversationForks",
            default_surface_order=(
                ResourceInspectorSurfaceRole.LinkedItems,
                ResourceInspectorSurfaceRole.Forks,
                ResourceInspectorSurfaceRole.Dossier,
            ),
        ),
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(
            user_link_source=False, user_link_target="materialize_passage"
        ),
        attachable=False,
        chat_subject="none",
        readable="body",
        inspectable="none",
        inspector_policy=None,
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "artifact": ResourceItemCapability(
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        inspector_policy=None,
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="artifact_revisions",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "artifact_revision": ResourceItemCapability(
        sharing="None",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="generated_output",
        readable="body",
        inspectable="none",
        inspector_policy=None,
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(user_link_source=False, user_link_target="none"),
        attachable=False,
        chat_subject="none",
        readable="none",
        inspectable="none",
        inspector_policy=None,
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
        sharing="CopyOnly",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="label",
        readable="none",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ResourceConnections",
            forks=None,
            default_surface_order=(ResourceInspectorSurfaceRole.Dossier,),
        ),
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
        sharing="CopyWithLibraryFiling",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="label",
        readable="none",
        inspectable="none",
        inspector_policy=ResourceInspectorResourcePolicy(
            linked_items="ResourceConnections",
            forks=None,
            default_surface_order=(ResourceInspectorSurfaceRole.Dossier,),
        ),
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
        sharing="None",
        user_relation=ResourceUserRelationPolicy(
            user_link_source=False, user_link_target="materialize_passage"
        ),
        attachable=True,
        chat_subject="readable",
        readable="body",
        inspectable="none",
        inspector_policy=None,
        citable_result_type="reader_apparatus_item",
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="inline_body",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
    "passage_anchor": ResourceItemCapability(
        sharing="None",
        user_relation=ResourceUserRelationPolicy(user_link_source=True, user_link_target="direct"),
        attachable=True,
        chat_subject="quote",
        readable="body",
        inspectable="none",
        inspector_policy=None,
        citable_result_type=None,
        app_search_scope=False,
        conversation_search_scope=False,
        citation_output_source=False,
        prompt_render="quote",
        expansion_policy="none",
        adjacency_source=False,
        adjacency_target=True,
    ),
}

if set(RESOURCE_ITEM_CAPABILITIES) != set(RESOURCE_SCHEMES):
    raise AssertionError("Every ResourceScheme needs one resource item capability")

_RESOURCE_INSPECTOR_SCHEMES: frozenset[ResourceScheme] = frozenset(
    {"media", "conversation", "library", "podcast", "contributor", "page", "note_block"}
)
if {
    scheme
    for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
    if capability.inspector_policy is not None
} != _RESOURCE_INSPECTOR_SCHEMES:
    raise AssertionError("Resource Inspector policy must cover exactly the seven dossier subjects")

for scheme in _RESOURCE_INSPECTOR_SCHEMES:
    capability = RESOURCE_ITEM_CAPABILITIES[scheme]
    policy = capability.inspector_policy
    if policy is None:
        raise AssertionError(f"{scheme} is missing its Resource Inspector policy")
    if not policy.default_surface_order:
        raise AssertionError(f"{scheme} needs a Resource Inspector default surface")
    if len(policy.default_surface_order) != len(set(policy.default_surface_order)):
        raise AssertionError(f"{scheme} has duplicate Resource Inspector surfaces")
    if policy.default_surface_order[-1] != ResourceInspectorSurfaceRole.Dossier:
        raise AssertionError(f"{scheme} must terminate in the always-published Dossier surface")

if RESOURCE_ITEM_CAPABILITIES["media"].inspector_policy != ResourceInspectorResourcePolicy(
    linked_items="MediaEvidence",
    forks=None,
    default_surface_order=(
        ResourceInspectorSurfaceRole.Contents,
        ResourceInspectorSurfaceRole.LinkedItems,
        ResourceInspectorSurfaceRole.Dossier,
    ),
):
    raise AssertionError("Media Resource Inspector policy drifted")

if RESOURCE_ITEM_CAPABILITIES["conversation"].inspector_policy != (
    ResourceInspectorResourcePolicy(
        linked_items="ConversationContext",
        forks="ConversationForks",
        default_surface_order=(
            ResourceInspectorSurfaceRole.LinkedItems,
            ResourceInspectorSurfaceRole.Forks,
            ResourceInspectorSurfaceRole.Dossier,
        ),
    )
):
    raise AssertionError("Conversation Resource Inspector policy drifted")

for scheme in ("library", "podcast", "contributor", "page", "note_block"):
    policy = RESOURCE_ITEM_CAPABILITIES[scheme].inspector_policy
    if policy is None or policy.linked_items != "ResourceConnections" or policy.forks is not None:
        raise AssertionError(f"{scheme} needs the generic Connections surface")


def capability_for_scheme(scheme: ResourceScheme) -> ResourceItemCapability:
    return RESOURCE_ITEM_CAPABILITIES[scheme]


def capability_for_ref(ref: ResourceRef) -> ResourceItemCapability:
    return capability_for_scheme(ref.scheme)


def resource_can_link_source(ref: ResourceRef) -> bool:
    """Whether ``ref`` can be the source of a durable, direct-endpoint Link edge."""
    return capability_for_ref(ref).user_relation.user_link_source


def resource_user_link_target_mode(ref: ResourceRef) -> UserLinkTargetMode:
    return capability_for_ref(ref).user_relation.user_link_target


def resource_can_link_target(ref: ResourceRef) -> bool:
    """Whether ``ref`` can be the target of a durable, direct-endpoint edge.

    ``materialize_passage`` targets are raw material a search hit must convert
    into a ``passage_anchor`` first (Invariant 4); they are never themselves a
    direct edge endpoint.
    """
    return resource_user_link_target_mode(ref) == "direct"


def resource_can_be_note_reference_target(ref: ResourceRef) -> bool:
    return capability_for_ref(ref).user_relation.note_reference_target


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
            *(
                ResourceRef(scheme="highlight", id=highlight_id)
                for highlight_id in db.scalars(
                    select(Highlight.id)
                    .where(Highlight.anchor_media_id == ref.id)
                    .where(highlight_visibility_filter(viewer_id, ref.id))
                    .distinct()
                )
            ),
            *_child_refs(
                db,
                "reader_apparatus_item",
                "SELECT id FROM reader_apparatus_items WHERE media_id = :id",
                ref.id,
            ),
            *_child_refs(
                db,
                "passage_anchor",
                "SELECT id FROM passage_anchors "
                "WHERE user_id = :viewer_id AND owner_scheme = 'media' AND owner_id = :id",
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
    if policy == "artifact_revisions":
        return _child_refs(
            db,
            "artifact_revision",
            "SELECT r.id FROM artifact_revisions r "
            "JOIN artifact_builds b ON b.id = r.build_id "
            "WHERE b.artifact_id = :id",
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
