"""The whole publication a reader mounts: one read, one snapshot, one identity.

Points address a unit by its string id: the fragment id for a signed-in reader
and the offline copy, the fragment ordinal on the public share (which never
hands out ids). Offsets are codepoints into the unit's ``canonical_text``.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.media import DocumentEmbedOut
from nexus.schemas.source_issues import SourceIssue


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


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
