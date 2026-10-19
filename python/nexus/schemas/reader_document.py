"""The whole publication a reader mounts: one read, one snapshot, one identity.

Points address a unit by its string id: the fragment id for a signed-in reader
and the offline copy, the fragment ordinal on the public share (which never
hands out ids). Offsets are codepoints into the unit's ``canonical_text``.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.source_issues import SourceIssue
from nexus.schemas.x_source import XSourceAuthor


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class ReaderXPostOwnerOut(_Out):
    media_id: UUID
    generation: int = Field(ge=1)
    fragment_id: UUID


class ReaderXReferenceOut(_Out):
    relation: Literal["quoted", "replied_to", "retweeted"]
    referenced_revision_id: str
    source_url: str
    target_unit_id: str | None
    availability: Literal["available", "unavailable", "not_captured"]


class ReaderXPostOut(_Out):
    logical_post_id: str | None
    source_revision_id: str
    relation: Literal["primary", "quoted", "replied_to", "retweeted", "embedded"]
    parent_unit_id: str | None
    embed_occurrence_key: str | None
    insertion_offset: int | None = Field(ge=0)
    referenced_revision_id: str | None
    checked_in_capture: bool | None
    source_url: str
    author: XSourceAuthor
    created_at: datetime | None
    is_edited: bool
    availability: Literal["available", "unavailable"]
    body_captured_at: datetime | None
    checked_at: datetime | None
    references: list[ReaderXReferenceOut]
    owner: ReaderXPostOwnerOut | None


class ReaderXCaptureOut(_Out):
    scope: Literal["author_thread", "post"]
    saved_at: datetime
    primary_post_count: int = Field(ge=0)
    root_revision_id: str | None
    search_exhausted: bool | None
    limits: list[Literal["post_limit", "operation_limit"]]
    unresolved_parent_count: int = Field(ge=0)
    unchecked_post_count: int = Field(ge=0)
    unavailable_context_count: int = Field(ge=0)
    uncaptured_context_count: int = Field(ge=0)


class ReaderUnitOut(_Out):
    id: str
    idx: int
    html_sanitized: str
    canonical_text: str
    char_count: int
    href_path: str | None
    t_start_ms: int | None
    t_end_ms: int | None
    speaker_label: str | None
    x_post: ReaderXPostOut | None = None


class ReaderPointOut(_Out):
    unit_id: str
    offset: int


class ReaderSectionOut(_Out):
    id: str
    label: str
    depth: int
    at: ReaderPointOut
    anchor_id: str | None


class ReaderTocNodeOut(_Out):
    id: str
    label: str
    at: ReaderPointOut | None
    section_id: str | None
    children: list["ReaderTocNodeOut"]


class ReaderTextDocumentOut(_Out):
    kind: Literal["web_article", "epub", "transcript"]
    identity: str
    title: str
    units: list[ReaderUnitOut]
    sections: list[ReaderSectionOut]
    toc_nodes: list[ReaderTocNodeOut]
    source_issues: list[SourceIssue]
    embeds: list[DocumentEmbedOut]
    x_capture: ReaderXCaptureOut | None = None


class ReaderPdfFileOut(_Out):
    url: str
    expires_at: datetime | None


class ReaderPdfDocumentOut(_Out):
    kind: Literal["pdf"]
    identity: str
    title: str
    page_count: int | None
    file: ReaderPdfFileOut


ReaderDocumentOut = Annotated[
    ReaderTextDocumentOut | ReaderPdfDocumentOut, Field(discriminator="kind")
]
