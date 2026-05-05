"""Schemas for notes, universal object refs, and object links."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

OBJECT_TYPES = Literal[
    "page",
    "note_block",
    "media",
    "highlight",
    "conversation",
    "message",
    "podcast",
    "content_chunk",
    "contributor",
]
NOTE_BLOCK_KINDS = Literal["bullet", "heading", "todo", "quote", "code", "image", "embed"]
OBJECT_LINK_RELATIONS = Literal[
    "references",
    "embeds",
    "note_about",
    "used_as_context",
    "derived_from",
    "related",
]

OBJECT_TYPE_VALUES = {
    "page",
    "note_block",
    "media",
    "highlight",
    "conversation",
    "message",
    "podcast",
    "content_chunk",
    "contributor",
}
NOTE_BLOCK_KIND_VALUES = {"bullet", "heading", "todo", "quote", "code", "image", "embed"}
NOTE_PM_BODY_NODE_TYPES = {"paragraph", "code_block"}
NOTE_PM_NODE_TYPES = {
    "outline_doc",
    "outline_block",
    "paragraph",
    "text",
    "hard_break",
    "object_ref",
    "code_block",
    "image",
}
NOTE_PM_INLINE_NODE_TYPES = {"text", "hard_break", "object_ref", "image"}
NOTE_PM_MARK_TYPES = {"strong", "em", "code", "link", "strikethrough"}


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


class NoteBlockOut(BaseModel):
    id: UUID
    page_id: UUID = Field(serialization_alias="pageId")
    parent_block_id: UUID | None = Field(None, serialization_alias="parentBlockId")
    order_key: str = Field(serialization_alias="orderKey")
    block_kind: NOTE_BLOCK_KINDS = Field(serialization_alias="blockKind")
    body_pm_json: dict[str, Any] = Field(serialization_alias="bodyPmJson")
    body_markdown: str = Field(serialization_alias="bodyMarkdown")
    body_text: str = Field(serialization_alias="bodyText")
    collapsed: bool
    children: list["NoteBlockOut"] = Field(default_factory=list)
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class NotePageSummaryOut(BaseModel):
    id: UUID
    title: str
    description: str | None = None
    updated_at: datetime = Field(serialization_alias="updatedAt")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class NotePageOut(NotePageSummaryOut):
    blocks: list[NoteBlockOut] = Field(default_factory=list)


class CreatePageRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdatePageRequest(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class LinkedObjectRequest(BaseModel):
    object_type: OBJECT_TYPES = Field(validation_alias=AliasChoices("object_type", "objectType"))
    object_id: UUID = Field(validation_alias=AliasChoices("object_id", "objectId"))
    relation_type: OBJECT_LINK_RELATIONS = Field("note_about")

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
        raise ValueError(f"{path}.type must be paragraph or code_block")

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
        if node_type == "outline_block":
            raise ValueError(f"{path}.content must include a paragraph")
        return node_type
    if node_type in {"hard_break", "object_ref", "image"}:
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
    if node_type == "object_ref":
        if not isinstance(attrs, dict):
            raise ValueError(f"{path} must be an object")
        object_type = attrs.get("objectType")
        object_id = attrs.get("objectId")
        if not isinstance(object_type, str) or object_type not in OBJECT_TYPE_VALUES:
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
        return

    if node_type == "outline_block":
        if not isinstance(attrs, dict):
            raise ValueError(f"{path} must be an object")
        block_id = attrs.get("id")
        kind = attrs.get("kind", "bullet")
        collapsed = attrs.get("collapsed", False)
        if not isinstance(block_id, str) or not block_id:
            raise ValueError(f"{path}.id must be a non-empty string")
        if not isinstance(kind, str) or kind not in NOTE_BLOCK_KIND_VALUES:
            raise ValueError(f"{path}.kind must be a known note block kind")
        if not isinstance(collapsed, bool):
            raise ValueError(f"{path}.collapsed must be a boolean")


def _validate_pm_child_types(node_type: str, child_types: list[str], *, path: str) -> None:
    if node_type == "paragraph":
        if any(child_type not in NOTE_PM_INLINE_NODE_TYPES for child_type in child_types):
            raise ValueError(f"{path} must contain only inline nodes")
    elif node_type == "code_block":
        if any(child_type != "text" for child_type in child_types):
            raise ValueError(f"{path} must contain only text nodes")
    elif node_type == "outline_doc":
        if any(child_type != "outline_block" for child_type in child_types):
            raise ValueError(f"{path} must contain only outline_block nodes")
    elif node_type == "outline_block":
        if not child_types or child_types[0] != "paragraph":
            raise ValueError(f"{path} must start with a paragraph node")
        if any(child_type != "outline_block" for child_type in child_types[1:]):
            raise ValueError(f"{path} may contain only nested outline_block nodes after paragraph")


class CreateNoteBlockRequest(BaseModel):
    id: UUID | None = None
    page_id: UUID | None = None
    parent_block_id: UUID | None = None
    after_block_id: UUID | None = None
    before_block_id: UUID | None = None
    block_kind: NOTE_BLOCK_KINDS = "bullet"
    body_pm_json: dict[str, Any] | None = None
    body_markdown: str | None = None
    linked_object: LinkedObjectRequest | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return validate_note_body_pm_json(value)


class UpdateNoteBlockRequest(BaseModel):
    block_kind: NOTE_BLOCK_KINDS | None = None
    body_pm_json: dict[str, Any] | None = None
    collapsed: bool | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return validate_note_body_pm_json(value)


class MoveNoteBlockRequest(BaseModel):
    parent_block_id: UUID | None = None
    before_block_id: UUID | None = None
    after_block_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class SplitNoteBlockRequest(BaseModel):
    offset: int = Field(..., ge=0)

    model_config = ConfigDict(extra="forbid")


class ObjectLinkOut(BaseModel):
    id: UUID
    relation_type: OBJECT_LINK_RELATIONS = Field(serialization_alias="relationType")
    a: HydratedObjectRef
    b: HydratedObjectRef
    a_locator: dict[str, Any] | None = Field(None, serialization_alias="aLocator")
    b_locator: dict[str, Any] | None = Field(None, serialization_alias="bLocator")
    a_order_key: str | None = Field(None, serialization_alias="aOrderKey")
    b_order_key: str | None = Field(None, serialization_alias="bOrderKey")
    metadata: dict[str, Any]
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")

    model_config = ConfigDict(populate_by_name=True)


class CreateObjectLinkRequest(BaseModel):
    relation_type: OBJECT_LINK_RELATIONS = "related"
    a_type: OBJECT_TYPES
    a_id: UUID
    b_type: OBJECT_TYPES
    b_id: UUID
    a_locator: dict[str, Any] | None = None
    b_locator: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")


class UpdateObjectLinkRequest(BaseModel):
    relation_type: OBJECT_LINK_RELATIONS | None = None
    a_order_key: str | None = Field(default=None, min_length=1, max_length=64)
    b_order_key: str | None = Field(default=None, min_length=1, max_length=64)
    metadata: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")


class CreateMessageContextItemRequest(BaseModel):
    message_id: UUID = Field(validation_alias=AliasChoices("message_id", "messageId"))
    object_type: OBJECT_TYPES = Field(validation_alias=AliasChoices("object_type", "objectType"))
    object_id: UUID = Field(validation_alias=AliasChoices("object_id", "objectId"))
    ordinal: int | None = Field(None, ge=0)
    evidence_span_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("evidence_span_ids", "evidenceSpanIds"),
        serialization_alias="evidenceSpanIds",
    )
    context_snapshot: dict[str, Any] | None = Field(
        None,
        validation_alias=AliasChoices("context_snapshot", "contextSnapshot"),
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MessageContextItemOut(BaseModel):
    id: UUID
    message_id: UUID = Field(serialization_alias="messageId")
    object_ref: ObjectRef = Field(serialization_alias="objectRef")
    ordinal: int
    context_snapshot: dict[str, Any] = Field(serialization_alias="contextSnapshot")
    created_at: datetime = Field(serialization_alias="createdAt")

    model_config = ConfigDict(populate_by_name=True)
