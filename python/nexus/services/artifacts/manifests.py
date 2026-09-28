"""The eight typed dossier input manifests.

Stored in ``artifact_revisions.input_manifest`` (jsonb) and read by the web as
generated types (docs/local-rules/typed-wire.md). Freshness compares a stored
manifest with the subject's live one; the head's coverage projection is derived
from the same value.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence


class _Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MediaDisposition(StrEnum):
    Included = "Included"
    OmittedNoReadyUnit = "OmittedNoReadyUnit"
    OmittedBudget = "OmittedBudget"
    OmittedNotAudienceVisible = "OmittedNotAudienceVisible"
    OmittedProjectionFailed = "OmittedProjectionFailed"


class MediaManifestEntry(_Manifest):
    media_ref: str
    content_fingerprint: str
    disposition: MediaDisposition


class EvidenceOmission(_Manifest):
    evidence_ref: str


class ConversationComplete(_Manifest):
    kind: Literal["Complete"] = "Complete"


class MediaInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["media"] = "media"
    media_ref: str
    content_fingerprint: str
    offered_claim_count: int
    omitted_evidence: list[EvidenceOmission]


class ConversationInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["conversation"] = "conversation"
    conversation_ref: str
    message_refs: list[str]
    context_refs: list[str]
    topology_fingerprint: Presence[str]
    completeness: ConversationComplete


class LibraryInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["library"] = "library"
    library_ref: str
    media: list[MediaManifestEntry]


class PodcastInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["podcast"] = "podcast"
    podcast_ref: str
    episodes: list[MediaManifestEntry]


class ContributorInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["contributor"] = "contributor"
    contributor_handle: str
    works: list[MediaManifestEntry]


class PageInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["page"] = "page"
    page_ref: str
    input_fingerprint: str
    block_refs: list[str]
    connection_refs: list[str]


class NoteInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["note"] = "note"
    note_ref: str
    input_fingerprint: str
    body_fingerprint: Presence[str]
    connection_refs: list[str]


class IdeaIncludedSource(_Manifest):
    ref: str
    content_fingerprint: str
    role: Literal["seed", "nexus", "web"]


class IdeaOmittedSource(_Manifest):
    locator: str
    reason: str


class IdeaInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["idea"] = "idea"
    idea_subject_id: str
    included_seed_refs: list[str]
    nexus_query_fingerprints: list[str]
    web_query_fingerprints: list[str]
    included_sources: list[IdeaIncludedSource]
    omitted_sources: list[IdeaOmittedSource]


AggregateManifestV1 = LibraryInputManifestV1 | PodcastInputManifestV1 | ContributorInputManifestV1

InputManifestV1 = Annotated[
    MediaInputManifestV1
    | ConversationInputManifestV1
    | LibraryInputManifestV1
    | PodcastInputManifestV1
    | ContributorInputManifestV1
    | PageInputManifestV1
    | NoteInputManifestV1
    | IdeaInputManifestV1,
    Field(discriminator="kind"),
]


def aggregate_entries(manifest: AggregateManifestV1) -> list[MediaManifestEntry]:
    """The media members of an aggregate manifest under its per-kind key."""
    if isinstance(manifest, LibraryInputManifestV1):
        return manifest.media
    if isinstance(manifest, PodcastInputManifestV1):
        return manifest.episodes
    return manifest.works
