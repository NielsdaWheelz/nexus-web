from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, TypeGuard
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceScheme

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


def is_object_type(value: str) -> TypeGuard[OBJECT_TYPES]:
    return value in OBJECT_TYPE_VALUES


class ObjectRef(BaseModel):
    object_type: OBJECT_TYPES = Field(
        validation_alias=AliasChoices("object_type", "objectType", "type"),
        serialization_alias="objectType",
    )
    object_id: UUID = Field(
        validation_alias=AliasChoices("object_id", "objectId", "id"),
        serialization_alias="objectId",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class HydratedObjectRef(ObjectRef):
    label: str
    route: str | None = None
    snippet: str | None = None
    icon: str | None = None


class PinnedObjectRefOut(BaseModel):
    id: UUID
    object_ref: HydratedObjectRef = Field(serialization_alias="objectRef")
    surface_key: str = Field(serialization_alias="surfaceKey")
    order_key: str = Field(serialization_alias="orderKey")
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")

    model_config = ConfigDict(populate_by_name=True)


class CreatePinnedObjectRefRequest(ObjectRef):
    surface_key: str = Field(
        "navbar",
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("surface_key", "surfaceKey"),
        serialization_alias="surfaceKey",
    )
    order_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("order_key", "orderKey"),
        serialization_alias="orderKey",
    )


class UpdatePinnedObjectRefRequest(BaseModel):
    surface_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("surface_key", "surfaceKey"),
        serialization_alias="surfaceKey",
    )
    order_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("order_key", "orderKey"),
        serialization_alias="orderKey",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


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

    unknown_keys = set(node) - {"type", "attrs", "content", "marks", "text"}
    if unknown_keys:
        raise ValueError(f"{path} contains unsupported ProseMirror node fields")

    if "marks" in node:
        _validate_pm_marks(node["marks"], path=f"{path}.marks")

    if node_type == "text":
        if not isinstance(node.get("text"), str):
            raise ValueError(f"{path}.text must be a string")
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
    _validate_pm_child_types(node_type, child_types, path=f"{path}.content")
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
        unknown_keys = set(mark) - {"type", "attrs"}
        if unknown_keys:
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


def _validate_pm_child_types(node_type: str, child_types: list[str], *, path: str) -> None:
    if node_type == "paragraph":
        if any(child_type not in NOTE_PM_INLINE_NODE_TYPES for child_type in child_types):
            raise ValueError(f"{path} must contain only inline nodes")
    elif node_type == "code_block":
        if any(child_type != "text" for child_type in child_types):
            raise ValueError(f"{path} must contain only text nodes")


class ResourceItemCapabilitiesOut(BaseModel):
    linkable: bool
    attachable: bool
    readable: Literal["none", "scope", "body", "media"]
    citable_result_type: str | None = Field(
        None,
        validation_alias=AliasChoices("citable_result_type", "citableResultType"),
        serialization_alias="citableResultType",
    )
    app_search_scope: bool = Field(
        validation_alias=AliasChoices("app_search_scope", "appSearchScope"),
        serialization_alias="appSearchScope",
    )
    conversation_search_scope: bool = Field(
        validation_alias=AliasChoices("conversation_search_scope", "conversationSearchScope"),
        serialization_alias="conversationSearchScope",
    )
    adjacency_source: bool = Field(
        validation_alias=AliasChoices("adjacency_source", "adjacencySource"),
        serialization_alias="adjacencySource",
    )
    adjacency_target: bool = Field(
        validation_alias=AliasChoices("adjacency_target", "adjacencyTarget"),
        serialization_alias="adjacencyTarget",
    )
    prompt_render: Literal["none", "label", "inline_body", "quote"] = Field(
        validation_alias=AliasChoices("prompt_render", "promptRender"),
        serialization_alias="promptRender",
    )
    expandable: bool

    model_config = ConfigDict(populate_by_name=True)


class ResourceItemOut(BaseModel):
    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str
    summary: str
    route: str | None = None
    missing: bool = False
    capabilities: ResourceItemCapabilitiesOut
    version_by_lane: dict[str, int] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("version_by_lane", "versionByLane"),
        serialization_alias="versionByLane",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceSurfaceItemOut(BaseModel):
    edge_id: UUID = Field(
        validation_alias=AliasChoices("edge_id", "edgeId"),
        serialization_alias="edgeId",
    )
    target: ResourceItemOut
    source_order_key: str = Field(
        validation_alias=AliasChoices("source_order_key", "sourceOrderKey"),
        serialization_alias="sourceOrderKey",
    )
    view_state: dict[str, Any] | None = Field(
        None,
        validation_alias=AliasChoices("view_state", "viewState"),
        serialization_alias="viewState",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceSurfaceOut(BaseModel):
    source: ResourceItemOut
    ordered_items: list[ResourceSurfaceItemOut] = Field(
        default_factory=list,
        validation_alias=AliasChoices("ordered_items", "orderedItems"),
        serialization_alias="orderedItems",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceLaneVersionIn(BaseModel):
    ref: str
    lane: Literal["title", "body", "outgoing_edges"]
    version: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class OrderedResourceTargetIn(BaseModel):
    ref: str
    source_order_key: str = Field(
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("source_order_key", "sourceOrderKey"),
        serialization_alias="sourceOrderKey",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ResourceSurfaceMutationRequest(BaseModel):
    client_mutation_id: str = Field(
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    base_versions: list[ResourceLaneVersionIn] = Field(
        default_factory=list,
        validation_alias=AliasChoices("base_versions", "baseVersions"),
        serialization_alias="baseVersions",
    )
    ordered_targets: list[OrderedResourceTargetIn] = Field(
        default_factory=list,
        validation_alias=AliasChoices("ordered_targets", "orderedTargets"),
        serialization_alias="orderedTargets",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ResourceBodyMutationRequest(BaseModel):
    client_mutation_id: str = Field(
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    base_versions: list[ResourceLaneVersionIn] = Field(
        default_factory=list,
        validation_alias=AliasChoices("base_versions", "baseVersions"),
        serialization_alias="baseVersions",
    )
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class ResourceTitleMutationRequest(BaseModel):
    client_mutation_id: str = Field(
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    base_versions: list[ResourceLaneVersionIn] = Field(
        default_factory=list,
        validation_alias=AliasChoices("base_versions", "baseVersions"),
        serialization_alias="baseVersions",
    )
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ResourceBodyMutationOut(BaseModel):
    client_mutation_id: str = Field(
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    item: ResourceItemOut
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )
    body_text: str = Field(
        validation_alias=AliasChoices("body_text", "bodyText"),
        serialization_alias="bodyText",
    )
    versions: dict[str, dict[str, int]] = Field(default_factory=dict)
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"),
        serialization_alias="updatedAt",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceTitleMutationOut(BaseModel):
    client_mutation_id: str = Field(
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    item: ResourceItemOut
    versions: dict[str, dict[str, int]] = Field(default_factory=dict)
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"),
        serialization_alias="updatedAt",
    )

    model_config = ConfigDict(populate_by_name=True)


class ResourceSurfaceMutationOut(BaseModel):
    client_mutation_id: str = Field(
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    surface: ResourceSurfaceOut
    changed_edge_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("changed_edge_ids", "changedEdgeIds"),
        serialization_alias="changedEdgeIds",
    )
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"),
        serialization_alias="updatedAt",
    )

    model_config = ConfigDict(populate_by_name=True)
