"""Closed replication envelopes. Counters are decimal signed-64-bit strings."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.retrieval import RetrievalLocator


def _counter(value: str) -> str:
    if str(int(value)) != value or not 0 <= int(value) <= 9223372036854775807:
        raise ValueError("expected a canonical nonnegative int64 decimal")
    return value


Counter = Annotated[str, AfterValidator(_counter)]


def _vector(value: dict[str, str]) -> dict[str, str]:
    if any(str(UUID(key)) != key for key in value):
        raise ValueError("vector replica ids must be canonical uuids")
    return value


Vector = Annotated[dict[str, Counter], AfterValidator(_vector)]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Stamp(Closed):
    lamport: Counter
    replica_id: UUID


class Register[T](Closed):
    value: T
    stamp: Stamp


class ReaderPublication(Closed):
    kind: Literal["reader"]
    generation: int = Field(gt=0)


class NotePublication(Closed):
    kind: Literal["note_text"]
    sha256: str = Field(pattern="^[0-9a-f]{64}$")


Publication = Annotated[ReaderPublication | NotePublication, Field(discriminator="kind")]


class SelectionCapture(Closed):
    publication: Publication | None
    locator: RetrievalLocator
    quote_exact: str
    prefix: str | None
    suffix: str | None
    passage_ref: str | None


class Causality(Closed):
    ref: str
    touch_vv: Vector
    delete_vv: Vector


class NotePatch(Causality):
    kind: Literal["note"]
    body_update: str | None


class PagePatch(Causality):
    kind: Literal["page"]
    local_date: str | None
    title_update: str | None


class HighlightPatch(Causality):
    kind: Literal["highlight"]
    source_ref: str
    selection: Register[SelectionCapture]
    color: Register[HighlightColor]


ResourcePatch = Annotated[NotePatch | PagePatch | HighlightPatch, Field(discriminator="kind")]


class NoteState(Causality):
    kind: Literal["note"]
    body_state: str


class PageState(Causality):
    kind: Literal["page"]
    local_date: str | None
    title_state: str


ResourceState = Annotated[NoteState | PageState | HighlightPatch, Field(discriminator="kind")]


class LinkState(Closed):
    link_id: UUID
    endpoint_a: str
    endpoint_b: str
    add_vv: Vector
    remove_vv: Vector
    position_a: Register[str] | None
    position_b: Register[str] | None


class PassageCapture(Closed):
    quote_exact: str
    publication: Publication | None
    locator: RetrievalLocator | None


class PassageState(Closed):
    anchor_id: UUID
    source_ref: str
    normalized_exact: str
    prefix: str
    suffix: str
    capture: Register[PassageCapture]


class SourceCapture(Closed):
    kind: str
    label: str
    publication: Publication | None


class SourceStub(Closed):
    source_ref: str
    capture: Register[SourceCapture]


class Change(Closed):
    command_seq: Counter
    lamport: Counter
    resources: list[ResourcePatch]
    links: list[LinkState]
    passages: list[PassageState]
    source_stubs: list[SourceStub]


class Corpus(Closed):
    resources: list[ResourceState]
    links: list[LinkState]
    passages: list[PassageState]
    source_stubs: list[SourceStub]


class ResourceProjection(Closed):
    authored_by_viewer: bool
    ref: str
    kind: Literal["note", "page", "highlight"]
    visible: bool
    body_pm_json: dict[str, object] | None
    body_text: str | None
    title: str | None
    local_date: str | None
    source_ref: str | None
    selection: SelectionCapture | None
    color: HighlightColor | None
    embedded_refs: list[str]


class MergeResult(Corpus):
    projections: list[ResourceProjection]


class ProvisionReplica(Closed):
    replica_id: UUID
    format_revision: int = Field(strict=True)


class UploadChanges(Closed):
    replica_id: UUID
    changes: list[Change] = Field(min_length=1, max_length=64)


class AcceptedChanges(Closed):
    accepted_command_seq: Counter
    head_cursor: Counter


class FeedChange(Closed):
    server_seq: Counter
    replica_id: UUID
    change: Change


class DownloadChanges(Closed):
    annotations_revision: str
    changes: list[FeedChange]
    next_cursor: Counter
    head_cursor: Counter


class SnapshotHeader(Closed):
    type: Literal["header"]
    format_revision: Literal[1]
    head_cursor: Counter
    lamport: Counter


class SnapshotResource(Closed):
    type: Literal["resource"]
    state: ResourceState


class SnapshotLink(Closed):
    type: Literal["link"]
    state: LinkState


class SnapshotPassage(Closed):
    type: Literal["passage"]
    state: PassageState


class SnapshotSourceStub(Closed):
    type: Literal["source_stub"]
    state: SourceStub


class SnapshotCounts(Closed):
    resources: int
    links: int
    passages: int
    source_stubs: int


class SnapshotFooter(Closed):
    type: Literal["footer"]
    format_revision: Literal[1]
    head_cursor: Counter
    lamport: Counter
    counts: SnapshotCounts


class ScopeStatus(Closed):
    kind: Literal["status"]
    revision: str | None
    active_refs: list[str] = Field(max_length=100)


class ScopeMetadata(Closed):
    kind: Literal["metadata"]
    revision: str | None
    cursor: str | None


class ScopeFinish(Closed):
    kind: Literal["finish"]
    revision: str


ScopeInputsRequest = Annotated[
    ScopeStatus | ScopeMetadata | ScopeFinish, Field(discriminator="kind")
]


class ScopeIdentity(Closed):
    kind: Literal["scope"]
    scope_ref: str


class ScopeWorkspaceMember(Closed):
    kind: Literal["workspace_member"]
    reading_ref: str


class ScopeMediaMember(Closed):
    kind: Literal["media_member"]
    root_ref: str
    reading_ref: str


class ScopeLibraryMember(Closed):
    kind: Literal["library_member"]
    library_ref: str
    reading_ref: str


class ScopeConversationFact(Closed):
    kind: Literal["conversation_fact"]
    conversation_ref: str
    target_ref: str


class ScopeSourceAlias(Closed):
    kind: Literal["source_alias"]
    reading_ref: str
    source_ref: str


class ScopeHighlightMember(Closed):
    kind: Literal["highlight_member"]
    highlight_ref: str
    reading_ref: str


class ScopeReading(Closed):
    kind: Literal["reading"]
    reading_ref: str
    source_ref: str
    source_kind: str
    body_generation: int | None
    source_generation: int | None


class ScopeInterval(Closed):
    kind: Literal["interval"]
    interval_key: str
    reading_ref: str
    fragment_id: UUID
    fragment_idx: int
    start_offset: int
    end_offset: int
    purpose: Literal["body", "required_note"]
    start_cut: bool
    end_cut: bool


ScopeInput = Annotated[
    ScopeIdentity
    | ScopeWorkspaceMember
    | ScopeMediaMember
    | ScopeLibraryMember
    | ScopeConversationFact
    | ScopeSourceAlias
    | ScopeHighlightMember
    | ScopeReading
    | ScopeInterval,
    Field(discriminator="kind"),
]


class ScopeInputsPage(Closed):
    revision: str
    restart: bool
    revoked_refs: list[str]
    records: list[ScopeInput]
    next_cursor: str | None


class ScopeTextRequest(Closed):
    revision: str
    reading_ref: str
    cursor: str | None


class ScopeTextChunk(Closed):
    interval_key: str
    fragment_id: UUID
    fragment_idx: int
    start_offset: int
    text: str


class ScopeTextPage(Closed):
    revision: str
    restart: bool
    revoked_refs: list[str]
    reading_ref: str
    chunks: list[ScopeTextChunk]
    next_cursor: str | None
