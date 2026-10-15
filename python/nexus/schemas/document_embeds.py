"""Document embed wire models: one embedded occurrence in a document and its resolved target."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.media import PlaybackSourceOut

DocumentEmbedProvider = Literal[
    "youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"
]
DocumentEmbedKind = Literal["video", "post", "audio", "link_preview", "unknown"]
DocumentEmbedSourceShape = Literal[
    "iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"
]
DocumentEmbedResolutionStatus = Literal["resolving", "resolved", "unsupported", "failed"]


class DocumentEmbedTextOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None
    reason: Literal["not_in_source", "redacted", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedUrlOut(BaseModel):
    status: Literal["present", "malformed", "absent"]
    value: str | None
    error_code: str | None
    reason: Literal["not_in_source", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedProviderRefOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None
    reason: Literal["unsupported_provider", "unparseable", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedLocatorOut(BaseModel):
    kind: Literal["anchored", "unanchored"]
    fragment_id: UUID | None
    canonical_start_offset: int | None = Field(ge=0)
    canonical_end_offset: int | None = Field(ge=0)
    document_order_key: str
    placeholder_text: str

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedTargetOut(BaseModel):
    status: Literal[
        "exact",
        "container",
        "missing",
        "forbidden",
        "unanchorable",
        "stale",
        "unsupported",
        "partial",
    ]
    media_id: UUID | None
    resource_ref: str | None
    href: str | None
    kind: str | None
    title: str | None
    thumbnail_url: str | None
    playback: PlaybackSourceOut | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedDisplayActionOut(BaseModel):
    kind: Literal["open_child_media", "open_original", "retry_child", "refresh_parent"]
    label: str
    href: str | None
    disabled: bool = False

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedDisplayOut(BaseModel):
    mode: Literal["resolved", "pending", "unsupported", "failed"]
    label: str
    description: str
    actions: list[DocumentEmbedDisplayActionOut]

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedOut(BaseModel):
    id: UUID
    media_id: UUID
    fragment_id: UUID | None
    occurrence_key: str
    ordinal: int
    provider: DocumentEmbedProvider
    kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: DocumentEmbedResolutionStatus
    source_url: DocumentEmbedUrlOut
    canonical_url: DocumentEmbedUrlOut
    provider_target_ref: DocumentEmbedProviderRefOut
    title: DocumentEmbedTextOut
    description: DocumentEmbedTextOut
    thumbnail_url: DocumentEmbedUrlOut
    authored_text: DocumentEmbedTextOut
    locator: DocumentEmbedLocatorOut
    target: DocumentEmbedTargetOut
    error_code: DocumentEmbedTextOut
    display: DocumentEmbedDisplayOut

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
