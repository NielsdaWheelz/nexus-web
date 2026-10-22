"""Pages, mixed resource outlines and their atomic command vocabulary.

Every model is closed and snake_case. The canonical single-block prose grammar
and annotation payload live in schemas.note_bodies; references remain edges.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.note_bodies import Body
from nexus.schemas.resource_graph import ConnectionOut, InsertionSource, LinkEndpoint
from nexus.schemas.resource_items import ResourceItemOut

Title = Annotated[str, Field(min_length=1, max_length=200)]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


# pages, the daily page, note rows and annotations


class NotePageSummaryOut(_Closed):
    id: UUID
    title: str
    updated_at: datetime


class InitialNote(_Closed):
    kind: Literal["note"]
    note_id: UUID
    link_id: UUID
    body_pm_json: Body


class InitialResource(_Closed):
    kind: Literal["resource"]
    link_id: UUID
    target: LinkEndpoint


InitialItem = Annotated[InitialNote | InitialResource, Field(discriminator="kind")]


class CreatePageRequest(_Closed):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: UUID
    title: Title
    initial_item: InitialItem


class DailyCaptureRequest(_Closed):
    note_id: UUID
    link_id: UUID
    text: str


class NoteBlockOut(_Closed):
    id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    body_version: int
    embedded_item: ResourceItemOut | None = None


# outlines


class PageContentOut(_Closed):
    kind: Literal["page"]
    title: str
    title_version: int
    daily_date: date | None


class NoteContentOut(_Closed):
    """``places`` counts cross-owner retaining graph facts and saved dossier heads."""

    kind: Literal["note"]
    body_pm_json: dict[str, Any]
    body_text: str
    body_version: int
    embedded_item: ResourceItemOut | None = None
    places: int


class ResourceContentOut(_Closed):
    kind: Literal["resource"]


class OutlineNodeOut(_Closed):
    item: ResourceItemOut
    content: Annotated[
        PageContentOut | NoteContentOut | ResourceContentOut, Field(discriminator="kind")
    ]


class OutlineOccurrenceOut(_Closed):
    connection: ConnectionOut
    content: Annotated[
        PageContentOut | NoteContentOut | ResourceContentOut, Field(discriminator="kind")
    ]


class OutlineOut(_Closed):
    """One visible endpoint's mixed adjacency in its own order, bounded by a cursor."""

    source: OutlineNodeOut
    insertion_source: LinkEndpoint | None
    links_version: int
    items: list[OutlineOccurrenceOut]
    next_cursor: str | None


class DailyPageOut(_Closed):
    """A latent day carries its page's future id and default title, and no links."""

    local_date: date
    materialized: bool
    outline: OutlineOut


# outline commands: idempotent primitives (services/outline.py states each retry rule)


class SetBody(_Closed):
    kind: Literal["set_body"]
    note_id: UUID
    body_pm_json: Body
    expected_version: int


class SetTitle(_Closed):
    kind: Literal["set_title"]
    page_id: UUID
    title: Title
    expected_version: int


class EnsureDaily(_Closed):
    kind: Literal["ensure_daily"]
    local_date: date
    page_id: UUID


class Position(_Closed):
    after: UUID | None
    expected_links_version: int = Field(ge=1)


class InsertNote(_Closed):
    kind: Literal["insert_note"]
    link_id: UUID
    note_id: UUID
    source: InsertionSource
    body_pm_json: Body
    position: Position | None


class InsertLink(_Closed):
    kind: Literal["insert_link"]
    link_id: UUID
    source: InsertionSource
    target: LinkEndpoint
    position: Position | None
    require_created: bool


class Move(_Closed):
    kind: Literal["move"]
    endpoint: str
    edge_id: UUID
    after: UUID | None
    expected_links_version: int = Field(ge=1)


class Unlink(_Closed):
    kind: Literal["unlink"]
    link_id: UUID
    expected: UnlinkExpected | None


class UnlinkExpected(_Closed):
    endpoint: str
    links_version: int = Field(ge=1)


class Relink(_Closed):
    kind: Literal["relink"]
    endpoint: str
    link_id: UUID
    destination: str
    new_link_id: UUID
    position: Position | None
    expected_source_links_version: int = Field(ge=1)


class Remove(_Closed):
    kind: Literal["remove"]
    endpoint: str
    link_id: UUID
    expected_body_version: int | None
    expected_links_version: int | None = Field(ge=1)


class ConsumeNote(_Closed):
    kind: Literal["consume_note"]
    endpoint: str
    link_id: UUID
    expected_body_version: int
    expected_links_version: int | None = Field(ge=1)


OutlineCommand = Annotated[
    SetBody
    | SetTitle
    | EnsureDaily
    | InsertNote
    | InsertLink
    | Move
    | Unlink
    | Relink
    | Remove
    | ConsumeNote,
    Field(discriminator="kind"),
]


class OutlineCommandsRequest(_Closed):
    commands: list[OutlineCommand] = Field(min_length=1, max_length=1000)
