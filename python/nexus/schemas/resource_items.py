"""Wire schemas for resource items.

Two serialization families live here and the split is load-bearing: the item /
activation / capability / locator / mutation models are camelCase on the wire
(:class:`CamelModel`), while the surface and command models stay snake_case — the web
decodes both key-exact, so a blanket alias generator over the module would break the
surface routes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, TypeGuard
from uuid import UUID

from pydantic import AliasChoices, AliasGenerator, BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from nexus.services.resource_graph.refs import (
    RESOURCE_SCHEMES,
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)

OBJECT_TYPES = ResourceScheme
OBJECT_TYPE_VALUES = frozenset(RESOURCE_SCHEMES)
NOTE_PM_BODY_NODE_TYPES = {"paragraph", "code_block", "object_embed"}
NOTE_PM_NODE_TYPES = {
    "paragraph",
    "text",
    "hard_break",
    "object_ref",
    "object_embed",
    "code_block",
    "image",
}
NOTE_PM_INLINE_NODE_TYPES = {"text", "hard_break", "object_ref", "image"}
NOTE_PM_MARK_TYPES = {"strong", "em", "code", "link", "strikethrough"}


class CamelModel(BaseModel):
    """Accepts snake_case or camelCase; emits camelCase under ``by_alias=True``.

    Validation keeps the snake name first so a request body's declared schema stays
    snake_case, which is what the web sends.
    """

    model_config = ConfigDict(
        alias_generator=AliasGenerator(
            validation_alias=lambda field: (
                AliasChoices(field, to_camel(field)) if to_camel(field) != field else field
            ),
            serialization_alias=to_camel,
        ),
        populate_by_name=True,
    )


def is_object_type(value: str) -> TypeGuard[OBJECT_TYPES]:
    return value in OBJECT_TYPE_VALUES


def validate_note_body_pm_json(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    _validate_pm_node(value, path="body_pm_json", top_level=True)
    return value


def _validate_pm_node(node: object, *, path: str, top_level: bool = False) -> str:
    if not isinstance(node, dict):
        raise ValueError(f"{path} must be a ProseMirror node object")

    node_type = node.get("type")
    if not isinstance(node_type, str) or node_type not in NOTE_PM_NODE_TYPES:
        raise ValueError(f"{path}.type must be a known notes ProseMirror node type")
    if top_level and node_type not in NOTE_PM_BODY_NODE_TYPES:
        raise ValueError(f"{path}.type must be paragraph, code_block, or object_embed")
    if set(node) - {"type", "attrs", "content", "marks", "text"}:
        raise ValueError(f"{path} contains unsupported ProseMirror node fields")
    if "marks" in node:
        _validate_pm_marks(node["marks"], path=f"{path}.marks")

    if node_type == "text":
        if not isinstance(node.get("text"), str):
            raise ValueError(f"{path}.text must be a string")
        if not node["text"]:
            raise ValueError(f"{path}.text must not be empty")
        if "content" in node:
            raise ValueError(f"{path}.content is not valid on text nodes")
        return node_type
    if "text" in node:
        raise ValueError(f"{path}.text is only valid on text nodes")

    attrs = node.get("attrs")
    if attrs is not None and not isinstance(attrs, dict):
        raise ValueError(f"{path}.attrs must be an object")
    _validate_pm_attrs(node_type, attrs, path=f"{path}.attrs")

    content = node.get("content")
    if content is None:
        return node_type
    if node_type in {"hard_break", "object_ref", "object_embed", "image"}:
        raise ValueError(f"{path}.content is not valid on atom nodes")
    if not isinstance(content, list):
        raise ValueError(f"{path}.content must be a list")
    child_types = [
        _validate_pm_node(child, path=f"{path}.content[{index}]")
        for index, child in enumerate(content)
    ]
    if node_type == "paragraph" and any(
        child not in NOTE_PM_INLINE_NODE_TYPES for child in child_types
    ):
        raise ValueError(f"{path}.content must contain only inline nodes")
    if node_type == "code_block" and any(child != "text" for child in child_types):
        raise ValueError(f"{path}.content must contain only text nodes")
    return node_type


def _validate_pm_marks(marks: object, *, path: str) -> None:
    if not isinstance(marks, list):
        raise ValueError(f"{path} must be a list")
    for index, mark in enumerate(marks):
        mark_path = f"{path}[{index}]"
        if not isinstance(mark, dict):
            raise ValueError(f"{mark_path} must be an object")
        mark_type = mark.get("type")
        if not isinstance(mark_type, str) or mark_type not in NOTE_PM_MARK_TYPES:
            raise ValueError(f"{mark_path}.type must be a known notes ProseMirror mark type")
        if set(mark) - {"type", "attrs"}:
            raise ValueError(f"{mark_path} contains unsupported ProseMirror mark fields")
        attrs = mark.get("attrs")
        if attrs is not None and not isinstance(attrs, dict):
            raise ValueError(f"{mark_path}.attrs must be an object")
        if mark_type == "link":
            if not isinstance(attrs, dict) or not isinstance(attrs.get("href"), str):
                raise ValueError(f"{mark_path}.attrs.href must be a string")
            title = attrs.get("title")
            if title is not None and not isinstance(title, str):
                raise ValueError(f"{mark_path}.attrs.title must be a string or null")


def _validate_pm_attrs(node_type: str, attrs: dict[str, Any] | None, *, path: str) -> None:
    if node_type in {"object_ref", "object_embed"}:
        if not isinstance(attrs, dict):
            raise ValueError(f"{path} must be an object")
        object_type = attrs.get("objectType")
        object_id = attrs.get("objectId")
        if not isinstance(object_type, str) or not is_object_type(object_type):
            raise ValueError(f"{path}.objectType must be a known object type")
        if not isinstance(object_id, str):
            raise ValueError(f"{path}.objectId must be a UUID string")
        try:
            UUID(object_id)
        except ValueError as exc:
            raise ValueError(f"{path}.objectId must be a UUID string") from exc
        label = attrs.get("label")
        if label is not None and not isinstance(label, str):
            raise ValueError(f"{path}.label must be a string")
        relation = attrs.get("relationType")
        if relation is not None and relation != "embeds":
            raise ValueError(f"{path}.relationType must be embeds")
        display_mode = attrs.get("displayMode")
        if display_mode is not None and not isinstance(display_mode, str):
            raise ValueError(f"{path}.displayMode must be a string")
        return

    if node_type == "image":
        if not isinstance(attrs, dict) or not isinstance(attrs.get("src"), str):
            raise ValueError(f"{path}.src must be a string")
        alt = attrs.get("alt")
        title = attrs.get("title")
        if alt is not None and not isinstance(alt, str):
            raise ValueError(f"{path}.alt must be a string or null")
        if title is not None and not isinstance(title, str):
            raise ValueError(f"{path}.title must be a string or null")


class ResourceUserRelationPolicyOut(CamelModel):
    user_link_source: bool
    user_link_target: Literal["none", "direct", "materialize_passage"]
    note_reference_target: bool


class ResourceItemCapabilitiesOut(CamelModel):
    sharing: Literal["None", "CopyOnly", "ResourceGrants", "HighlightGrants", "LibraryMembership"]
    library_placement: Literal["None", "ManageEntries"]
    user_relation: ResourceUserRelationPolicyOut
    attachable: bool
    chat_subject: Literal["none", "label", "scope", "readable", "quote", "generated_output"]
    readable: Literal["none", "scope", "body", "media"]
    inspectable: Literal["none", "media_document_map"]
    citable_result_type: str | None = None
    citation_output_source: bool
    app_search_scope: bool
    conversation_search_scope: bool
    adjacency_source: bool
    adjacency_target: bool
    prompt_render: Literal["none", "label", "inline_body", "quote"]
    expansion_policy: Literal[
        "none",
        "media_owned_reader_children",
        "page_note_blocks",
        "note_block_owned_evidence",
        "artifact_revisions",
    ]
    expandable: bool


class ResourceActivationOut(CamelModel):
    resource_ref: str
    kind: Literal["route", "external", "none"]
    href: str | None = None
    unresolved_reason: str | None = None


class ResourceItemOut(CamelModel):
    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str
    summary: str
    route: str | None = None
    activation: ResourceActivationOut
    missing: bool = False
    capabilities: ResourceItemCapabilitiesOut
    version_by_lane: dict[str, int] = Field(default_factory=dict)


class ResourceRefLocatorIn(BaseModel):
    kind: Literal["resource_ref"]
    ref: str = Field(min_length=1)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @field_validator("ref")
    @classmethod
    def validate_ref(cls, value: str) -> str:
        if isinstance(parse_resource_ref(value), ResourceRefParseFailure):
            raise ValueError("ref must be a canonical ResourceRef")
        return value


class ContributorHandleLocatorIn(BaseModel):
    kind: Literal["contributor_handle"]
    handle: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


ResourceLocatorIn = Annotated[
    ResourceRefLocatorIn | ContributorHandleLocatorIn,
    Field(discriminator="kind"),
]


class ResourceLocatorResolveRequest(BaseModel):
    locators: list[ResourceLocatorIn] = Field(min_length=1, max_length=50)

    model_config = ConfigDict(extra="forbid")


class ResourceLocatorResolutionOut(CamelModel):
    locator: ResourceLocatorIn
    resource_item: ResourceItemOut
    canonical_href: str | None = None


class ResourceLocatorResolveResponse(BaseModel):
    resolutions: list[ResourceLocatorResolutionOut]


class PageTitleSurfaceContent(BaseModel):
    kind: Literal["page_title"]
    title: str

    model_config = ConfigDict(extra="forbid")


class NoteBodySurfaceContent(BaseModel):
    kind: Literal["note_body"]
    body_pm_json: dict[str, Any]
    body_text: str

    model_config = ConfigDict(extra="forbid")


class ResourceSummarySurfaceContent(BaseModel):
    kind: Literal["resource_summary"]

    model_config = ConfigDict(extra="forbid")


ResourceSurfaceContent = Annotated[
    PageTitleSurfaceContent | NoteBodySurfaceContent | ResourceSummarySurfaceContent,
    Field(discriminator="kind"),
]


class ResourceSurfaceNode(BaseModel):
    item: ResourceItemOut
    content: ResourceSurfaceContent

    model_config = ConfigDict(extra="forbid")


class ResourceSurfaceOccurrence(BaseModel):
    occurrence_id: UUID
    target: ResourceSurfaceNode

    model_config = ConfigDict(extra="forbid")


class ResourceSurfaceOut(BaseModel):
    source: ResourceSurfaceNode
    ordered_items: list[ResourceSurfaceOccurrence] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ResourceLaneVersionIn(BaseModel):
    ref: str
    lane: Literal["title", "body", "outgoing_edges"]
    version: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class SurfaceStartPosition(BaseModel):
    kind: Literal["start"]

    model_config = ConfigDict(extra="forbid")


class SurfaceAfterPosition(BaseModel):
    kind: Literal["after"]
    occurrence_id: UUID

    model_config = ConfigDict(extra="forbid")


SurfacePosition = Annotated[
    SurfaceStartPosition | SurfaceAfterPosition,
    Field(discriminator="kind"),
]


class InsertNoteSurfaceCommand(BaseModel):
    type: Literal["insert_note"]
    note_id: UUID
    position: SurfacePosition
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class SplitNoteSurfaceCommand(BaseModel):
    type: Literal["split_note"]
    occurrence_id: UUID
    note_id: UUID
    left_body_pm_json: dict[str, Any]
    right_body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("left_body_pm_json", "right_body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class InsertResourceSurfaceCommand(BaseModel):
    type: Literal["insert_resource"]
    target_ref: str
    position: SurfacePosition

    model_config = ConfigDict(extra="forbid")


class MoveOccurrenceSurfaceCommand(BaseModel):
    type: Literal["move_occurrence"]
    occurrence_id: UUID
    position: SurfacePosition

    model_config = ConfigDict(extra="forbid")


class RemoveOccurrenceSurfaceCommand(BaseModel):
    type: Literal["remove_occurrence"]
    occurrence_id: UUID

    model_config = ConfigDict(extra="forbid")


SurfaceCommand = Annotated[
    InsertNoteSurfaceCommand
    | SplitNoteSurfaceCommand
    | InsertResourceSurfaceCommand
    | MoveOccurrenceSurfaceCommand
    | RemoveOccurrenceSurfaceCommand,
    Field(discriminator="type"),
]


class ResourceSurfaceCommandRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn] = Field(default_factory=list)
    command: SurfaceCommand

    model_config = ConfigDict(extra="forbid")


class ResourceSurfaceCommandOut(BaseModel):
    client_mutation_id: str
    surface: ResourceSurfaceOut

    model_config = ConfigDict(extra="forbid")


class ResourceBodyMutationRequest(CamelModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn] = Field(default_factory=list)
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class ResourceTitleMutationRequest(CamelModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn] = Field(default_factory=list)
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(extra="forbid")


class ResourceBodyMutationOut(CamelModel):
    client_mutation_id: str
    item: ResourceItemOut
    body_pm_json: dict[str, Any]
    body_text: str
    versions: dict[str, dict[str, int]] = Field(default_factory=dict)
    updated_at: datetime


class ResourceTitleMutationOut(CamelModel):
    client_mutation_id: str
    item: ResourceItemOut
    versions: dict[str, dict[str, int]] = Field(default_factory=dict)
    updated_at: datetime
