"""Schemas for notes and universal object refs (pins, picker, ref chips)."""

from datetime import date, datetime
from typing import Any, Literal, TypeGuard, get_args
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

OBJECT_TYPES = Literal[
    "page",
    "note_block",
    "media",
    "highlight",
    "conversation",
    "message",
    "podcast",
    "content_chunk",
    "fragment",
    "contributor",
    "evidence_span",
    "tag",
]
OBJECT_TYPE_VALUES = frozenset(get_args(OBJECT_TYPES))
NOTE_BLOCK_KINDS = Literal["bullet", "heading", "todo", "quote", "code", "image", "embed"]

NOTE_BLOCK_KIND_VALUES = {"bullet", "heading", "todo", "quote", "code", "image", "embed"}
NOTE_PM_BODY_NODE_TYPES = {"paragraph", "code_block", "object_embed"}
NOTE_PM_NODE_TYPES = {
    "outline_doc",
    "outline_block",
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


class NoteBlockOut(BaseModel):
    id: UUID
    page_id: UUID = Field(
        validation_alias=AliasChoices("page_id", "pageId"), serialization_alias="pageId"
    )
    parent_block_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("parent_block_id", "parentBlockId"),
        serialization_alias="parentBlockId",
    )
    order_key: str = Field(
        validation_alias=AliasChoices("order_key", "orderKey"), serialization_alias="orderKey"
    )
    block_kind: NOTE_BLOCK_KINDS = Field(
        validation_alias=AliasChoices("block_kind", "blockKind"), serialization_alias="blockKind"
    )
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )
    body_markdown: str = Field(
        validation_alias=AliasChoices("body_markdown", "bodyMarkdown"),
        serialization_alias="bodyMarkdown",
    )
    body_text: str = Field(
        validation_alias=AliasChoices("body_text", "bodyText"), serialization_alias="bodyText"
    )
    collapsed: bool
    children: list["NoteBlockOut"] = Field(default_factory=list)
    created_at: datetime = Field(
        validation_alias=AliasChoices("created_at", "createdAt"), serialization_alias="createdAt"
    )
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"), serialization_alias="updatedAt"
    )

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class NotePageSummaryOut(BaseModel):
    id: UUID
    title: str
    description: str | None = None
    document_version: int = Field(
        validation_alias=AliasChoices("document_version", "documentVersion"),
        serialization_alias="documentVersion",
    )
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"), serialization_alias="updatedAt"
    )

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class NotePageOut(NotePageSummaryOut):
    blocks: list[NoteBlockOut] = Field(default_factory=list)


class DailyNotePageOut(BaseModel):
    local_date: date = Field(
        validation_alias=AliasChoices("local_date", "localDate"), serialization_alias="localDate"
    )
    time_zone: str = Field(
        validation_alias=AliasChoices("time_zone", "timeZone"), serialization_alias="timeZone"
    )
    page: NotePageOut

    model_config = ConfigDict(populate_by_name=True)


class CreatePageRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdatePageRequest(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class _NoteBodyPmJsonValidated(BaseModel):
    """Mixin attaching the shared `body_pm_json` ProseMirror validator.

    `validate_note_body_pm_json` is defined below; the wrapper only calls it at
    validation time, so the forward reference resolves fine.
    """

    @field_validator("body_pm_json", check_fields=False)
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return validate_note_body_pm_json(value)


class PageDocumentBlockRequest(_NoteBodyPmJsonValidated):
    id: UUID
    block_kind: NOTE_BLOCK_KINDS = Field(
        ...,
        validation_alias=AliasChoices("block_kind", "blockKind"),
        serialization_alias="blockKind",
    )
    body_pm_json: dict[str, Any] = Field(
        ...,
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PageDocumentParentRef(BaseModel):
    scheme: Literal["page", "note_block"]
    id: UUID

    model_config = ConfigDict(extra="forbid")


class PageDocumentChildRequest(BaseModel):
    block_id: UUID = Field(
        ...,
        validation_alias=AliasChoices("block_id", "blockId"),
        serialization_alias="blockId",
    )
    source_order_key: str = Field(
        ...,
        min_length=1,
        max_length=64,
        validation_alias=AliasChoices("source_order_key", "sourceOrderKey"),
        serialization_alias="sourceOrderKey",
    )
    collapsed: bool = False

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PageDocumentContainmentRequest(BaseModel):
    parent: PageDocumentParentRef
    children: list[PageDocumentChildRequest]

    model_config = ConfigDict(extra="forbid")


class PatchPageDocumentRequest(BaseModel):
    client_mutation_id: str = Field(
        ...,
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    base_document_version: int = Field(
        ...,
        ge=1,
        validation_alias=AliasChoices("base_document_version", "baseDocumentVersion"),
        serialization_alias="baseDocumentVersion",
    )
    title: str | None = Field(None, min_length=1, max_length=200)
    focus_block_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("focus_block_id", "focusBlockId"),
        serialization_alias="focusBlockId",
    )
    blocks: list[PageDocumentBlockRequest] = Field(
        default_factory=list,
    )
    containment: list[PageDocumentContainmentRequest] = Field(default_factory=list)
    deleted_block_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("deleted_block_ids", "deletedBlockIds"),
        serialization_alias="deletedBlockIds",
    )
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @model_validator(mode="after")
    def validate_document_operations(self) -> "PatchPageDocumentRequest":
        block_ids = [block.id for block in self.blocks]
        if len(block_ids) != len(set(block_ids)):
            raise ValueError("blocks contains duplicate block ids")
        if len(self.deleted_block_ids) != len(set(self.deleted_block_ids)):
            raise ValueError("deleted_block_ids contains duplicate block ids")
        block_set = set(block_ids)
        deleted_set = set(self.deleted_block_ids)
        if block_set & deleted_set:
            raise ValueError("A block cannot be changed or created and deleted")
        child_ids: list[UUID] = []
        parent_refs: set[tuple[str, UUID]] = set()
        for group in self.containment:
            parent_ref = (group.parent.scheme, group.parent.id)
            if parent_ref in parent_refs:
                raise ValueError("containment contains duplicate parent refs")
            parent_refs.add(parent_ref)
            child_ids.extend(child.block_id for child in group.children)
            order_keys = [child.source_order_key for child in group.children]
            if len(order_keys) != len(set(order_keys)):
                raise ValueError("containment siblings contain duplicate order keys")
        if len(child_ids) != len(set(child_ids)):
            raise ValueError("containment contains duplicate child blocks")
        if set(child_ids) != block_set:
            raise ValueError("containment children must exactly match blocks")
        return self


class PatchPageDocumentResponse(BaseModel):
    client_mutation_id: str = Field(
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    page: NotePageOut
    document_version: int = Field(
        validation_alias=AliasChoices("document_version", "documentVersion"),
        serialization_alias="documentVersion",
    )
    changed_block_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("changed_block_ids", "changedBlockIds"),
        serialization_alias="changedBlockIds",
    )
    changed_edge_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("changed_edge_ids", "changedEdgeIds"),
        serialization_alias="changedEdgeIds",
    )
    reindex_job_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("reindex_job_id", "reindexJobId"),
        serialization_alias="reindexJobId",
    )
    focused_block: NoteBlockOut | None = Field(
        None,
        validation_alias=AliasChoices("focused_block", "focusedBlock"),
        serialization_alias="focusedBlock",
    )

    model_config = ConfigDict(populate_by_name=True)


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
        if node_type == "outline_block":
            raise ValueError(f"{path}.content must include a paragraph")
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
        # Editor document grammar: object_embed nodes carry a fixed
        # relationType="embeds" attr (not link vocabulary — embeds-as-a-verb
        # died with the link-verb table).
        embed_relation_attr = attrs.get("relationType")
        if embed_relation_attr is not None and embed_relation_attr != "embeds":
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
        if not child_types or child_types[0] not in NOTE_PM_BODY_NODE_TYPES:
            raise ValueError(f"{path} must start with a note body node")
        if any(child_type != "outline_block" for child_type in child_types[1:]):
            raise ValueError(f"{path} may contain only nested outline_block nodes after paragraph")


class QuickCaptureRequest(_NoteBodyPmJsonValidated):
    id: UUID
    client_mutation_id: str = Field(
        ...,
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    local_date: date | None = Field(
        None,
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
    body_pm_json: dict[str, Any] | None = None
    body_markdown: str | None = None

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @model_validator(mode="after")
    def require_body(self) -> "QuickCaptureRequest":
        if self.body_pm_json is None and not (self.body_markdown or "").strip():
            raise ValueError("body_pm_json or body_markdown is required")
        return self


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
