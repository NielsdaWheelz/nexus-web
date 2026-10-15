"""Wire schemas for resource items: identity and actions, then notes' surfaces and edits.

Every key is snake_case on the wire.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, TypeGuard
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.metadata_enrichment import MetadataRetry
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
    "object_embed",
    "code_block",
    "image",
}
NOTE_PM_INLINE_NODE_TYPES = {"text", "hard_break", "image"}
NOTE_PM_MARK_TYPES = {"strong", "em", "code", "link", "strikethrough", "underline"}


class AbsentExpectedBody(BaseModel):
    kind: Literal["absent"]

    model_config = ConfigDict(extra="forbid")


class VersionExpectedBody(BaseModel):
    kind: Literal["version"]
    version: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


ExpectedNoteBody = Annotated[AbsentExpectedBody | VersionExpectedBody, Field(discriminator="kind")]


class NoteBodyVersionsOut(BaseModel):
    body: int = Field(ge=1)
    links: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


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
    if node_type in {"hard_break", "object_embed", "image"}:
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
            if not _safe_note_link_href(attrs["href"]):
                raise ValueError(f"{mark_path}.attrs.href must be a safe link")
            title = attrs.get("title")
            if title is not None and not isinstance(title, str):
                raise ValueError(f"{mark_path}.attrs.title must be a string or null")


def _safe_note_link_href(href: str) -> bool:
    if not href or any(
        char.isspace() or ord(char) < 32 or ord(char) == 127 or char == "\\" for char in href
    ):
        return False
    if href.startswith("/"):
        return not href.startswith("//")
    try:
        parsed = urlsplit(href)
        if parsed.scheme in {"http", "https"}:
            if "%" in parsed.netloc:
                return False
            _ = parsed.port  # reject malformed or out-of-range ports, as the browser does
            return bool(parsed.hostname)
    except ValueError:
        return False
    return parsed.scheme == "mailto" and bool(parsed.path) and not parsed.netloc


def _validate_pm_attrs(node_type: str, attrs: dict[str, Any] | None, *, path: str) -> None:
    if node_type == "object_embed":
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


# identity and actions (resource actions slice); the surface and mutation models below are notes'.
_OUT = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class ResourceActivationOut(BaseModel):
    """Where opening a ref goes; ``href`` is null exactly when ``kind`` is none."""

    model_config = _OUT

    resource_ref: str
    kind: Literal["route", "external", "none"]
    href: str | None


class ResourceItemOut(BaseModel):
    model_config = _OUT

    ref: str
    scheme: ResourceScheme
    id: UUID
    label: str
    summary: str
    activation: ResourceActivationOut
    missing: bool
    version_by_lane: dict[str, int]


BlockReason = Literal["PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable"]
TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
DownloadKind = Literal["podcast_episode", "pdf", "epub", "web_article"]

SimpleActionKind = Literal[
    "Open",
    "OpenInNewPane",
    "MediaMetadata",
    "Share",
    "Chat",
    "LinkResource",
    "PlayNext",
    "DownloadOriginal",
    "EditAuthors",
    "ResetProgress",
    "RemoveMedia",
    "LibraryPlacement",
    "LibrarySettings",
    "DeleteLibrary",
    "PodcastSettings",
    "RefreshPodcast",
    "RetryPodcastBackfill",
    "DeleteConversation",
    "ForkMessage",
    "WalkMessageSources",
    "RerunMessage",
    "RegenerateMessage",
    "DeleteMessage",
    "EditHighlight",
    "LearnHighlight",
    "EditHighlightBounds",
    "DeleteHighlight",
    "EditPageTitle",
    "DeletePage",
    "EditNoteBody",
    "RegenerateArtifact",
]


class SimpleAction(BaseModel):
    model_config = _OUT

    kind: SimpleActionKind
    blocked: BlockReason | None


class RetryMetadataAction(BaseModel):
    model_config = _OUT

    kind: Literal["RetryMetadata"] = "RetryMetadata"
    blocked: BlockReason | None
    retry: MetadataRetry


class RefreshSourceAction(BaseModel):
    """Refresh from the attempt the viewer saw; a refresh admission replays by it."""

    model_config = _OUT

    kind: Literal["RefreshSource"] = "RefreshSource"
    blocked: BlockReason | None
    expected_attempt_id: UUID | None


class ReviewMetadataResultAction(BaseModel):
    """Acknowledge the exact no-findings metadata job the viewer has not reviewed."""

    model_config = _OUT

    kind: Literal["ReviewMetadataResult"] = "ReviewMetadataResult"
    blocked: BlockReason | None
    job_id: UUID


class RecoveryAction(BaseModel):
    """One import obligation's offer (source, then search; at most one each), carrying
    the attempt/job/revision the viewer saw."""

    model_config = _OUT

    kind: Literal["Recovery"] = "Recovery"
    blocked: BlockReason | None
    offer: Annotated[
        RetrySourceOffer | RepairSourceOffer | RepairSearchOffer, Field(discriminator="kind")
    ]


class DownloadAction(BaseModel):
    """What android needs to keep this media offline: an episode's audio or a reading copy."""

    model_config = _OUT

    kind: Literal["Download"] = "Download"
    blocked: BlockReason | None
    media_kind: DownloadKind
    title: str
    audio_url: str | None


class OpenSourceAction(BaseModel):
    model_config = _OUT

    kind: Literal["OpenSource"] = "OpenSource"
    blocked: BlockReason | None
    href: str


class PlaybackAction(BaseModel):
    model_config = _OUT

    kind: Literal["Playback"] = "Playback"
    blocked: BlockReason | None
    player_descriptor: PlayerDescriptor


class ConsumptionAction(BaseModel):
    model_config = _OUT

    kind: Literal["Consumption"] = "Consumption"
    blocked: BlockReason | None
    finished: bool
    episode: bool


class PodcastSubscriptionAction(BaseModel):
    model_config = _OUT

    kind: Literal["PodcastSubscription"] = "PodcastSubscription"
    blocked: BlockReason | None
    subscribed: bool


class TranscriptAction(BaseModel):
    model_config = _OUT

    kind: Literal["Transcript"] = "Transcript"
    blocked: BlockReason | None
    state: TranscriptState


class LecternMembershipAction(BaseModel):
    model_config = _OUT

    kind: Literal["LecternMembership"] = "LecternMembership"
    blocked: BlockReason | None
    lectern_item_id: UUID | None


class HighlightNoteAction(BaseModel):
    model_config = _OUT

    kind: Literal["HighlightNote"] = "HighlightNote"
    blocked: BlockReason | None
    note_block_id: UUID | None


ResourceActionOut = Annotated[
    SimpleAction
    | RefreshSourceAction
    | RetryMetadataAction
    | ReviewMetadataResultAction
    | RecoveryAction
    | DownloadAction
    | OpenSourceAction
    | PlaybackAction
    | ConsumptionAction
    | PodcastSubscriptionAction
    | TranscriptAction
    | LecternMembershipAction
    | HighlightNoteAction,
    Field(discriminator="kind"),
]


class ResourceActionsOut(BaseModel):
    """One ref's verbs now. Inapplicable verbs are omitted; forbidden ones carry ``blocked``.
    A missing ref has no verbs and a none activation. ``label`` is the name confirmations
    quote (a media's bare title)."""

    model_config = _OUT

    ref: str
    label: str
    activation: ResourceActivationOut
    missing: bool
    actions: list[ResourceActionOut]


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
    link_id: UUID
    target: ResourceSurfaceNode
    collapsed: bool
    has_link_note: bool

    model_config = ConfigDict(extra="forbid")


class ResourceSurfaceOut(BaseModel):
    source: ResourceSurfaceNode
    ordered_items: list[ResourceSurfaceOccurrence]

    model_config = ConfigDict(extra="forbid")


class ResourceLaneVersionIn(BaseModel):
    ref: str
    lane: Literal["title", "body", "links"]
    version: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class SurfaceContext(BaseModel):
    root_ref: str
    link_path: list[UUID]

    model_config = ConfigDict(extra="forbid")


class SurfaceStartPosition(BaseModel):
    kind: Literal["start"]

    model_config = ConfigDict(extra="forbid")


class SurfaceAfterPosition(BaseModel):
    kind: Literal["after"]
    link_id: UUID

    model_config = ConfigDict(extra="forbid")


SurfacePosition = Annotated[
    SurfaceStartPosition | SurfaceAfterPosition,
    Field(discriminator="kind"),
]


class SurfaceBodyEdit(BaseModel):
    ref: str
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


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
    link_id: UUID
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
    link_id: UUID
    position: SurfacePosition

    model_config = ConfigDict(extra="forbid")


class SurfaceRemoval(BaseModel):
    endpoint_ref: str
    link_id: UUID
    context: SurfaceContext

    model_config = ConfigDict(extra="forbid")


class RemoveOccurrenceSurfaceCommand(BaseModel):
    type: Literal["remove_occurrence"]
    entries: list[SurfaceRemoval] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class RelinkSurfaceCommand(BaseModel):
    type: Literal["relink"]
    link_id: UUID
    destination_ref: str
    position: SurfacePosition

    model_config = ConfigDict(extra="forbid")


class JoinNotesSurfaceCommand(BaseModel):
    type: Literal["join_notes"]
    earlier_link_id: UUID
    later_link_id: UUID
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class OutlineNote(BaseModel):
    kind: Literal["note"]
    note_id: UUID
    body_pm_json: dict[str, Any]
    parent_index: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")

    @field_validator("parent_index")
    @classmethod
    def validate_parent_index(cls, value: int | None) -> int:
        if value is None:
            raise ValueError("Omit parent_index for a root item")
        return value

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class OutlineResource(BaseModel):
    kind: Literal["resource"]
    target_ref: str
    parent_index: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")

    @field_validator("target_ref")
    @classmethod
    def validate_target_ref(cls, value: str) -> str:
        if isinstance(parse_resource_ref(value), ResourceRefParseFailure):
            raise ValueError("target_ref must be a canonical ResourceRef")
        return value

    @field_validator("parent_index")
    @classmethod
    def validate_parent_index(cls, value: int | None) -> int:
        if value is None:
            raise ValueError("Omit parent_index for a root item")
        return value


OutlineItem = Annotated[OutlineNote | OutlineResource, Field(discriminator="kind")]


class PasteOutlineSurfaceCommand(BaseModel):
    type: Literal["paste_outline"]
    position: SurfacePosition
    items: list[OutlineItem] = Field(min_length=1, max_length=1000)

    model_config = ConfigDict(extra="forbid")


class ReverseEditSurfaceCommand(BaseModel):
    type: Literal["reverse_edit"]
    receipt_id: UUID

    model_config = ConfigDict(extra="forbid")


SurfaceCommand = Annotated[
    InsertNoteSurfaceCommand
    | SplitNoteSurfaceCommand
    | InsertResourceSurfaceCommand
    | MoveOccurrenceSurfaceCommand
    | RemoveOccurrenceSurfaceCommand
    | RelinkSurfaceCommand
    | JoinNotesSurfaceCommand
    | PasteOutlineSurfaceCommand
    | ReverseEditSurfaceCommand,
    Field(discriminator="type"),
]


class ResourceSurfaceCommandRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn]
    context: SurfaceContext
    body_edits: list[SurfaceBodyEdit]
    command: SurfaceCommand

    model_config = ConfigDict(extra="forbid")


class ResourceSurfaceCommandOut(BaseModel):
    client_mutation_id: str
    receipt_id: UUID
    reverse_versions: list[ResourceLaneVersionIn]
    nodes: list[ResourceSurfaceNode]
    surfaces: list[ResourceSurfaceOut]

    model_config = ConfigDict(extra="forbid")


class ResourceBodyMutationRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn] = Field(default_factory=list)
    body_pm_json: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class ResourceTitleMutationRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    base_versions: list[ResourceLaneVersionIn] = Field(default_factory=list)
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(extra="forbid")


class ResourceBodyMutationOut(BaseModel):
    client_mutation_id: str
    item: ResourceItemOut
    body_pm_json: dict[str, Any]
    body_text: str
    versions: dict[str, dict[str, int]]
    updated_at: datetime


class ResourceTitleMutationOut(BaseModel):
    client_mutation_id: str
    item: ResourceItemOut
    versions: dict[str, dict[str, int]]
    updated_at: datetime
