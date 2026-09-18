"""Typed dossier input manifests.

Stored in ``artifact_revisions.input_manifest`` (JSONB), discriminated by
``kind`` (the spec-pinned lowercase subject scheme). Coverage on the head read is
DERIVED from these; freshness is the binding's ``manifests_equal(stored, live)``
(no LLM). Deliberately minimal — only the freshness / coverage / citation-candidate
/ migration fields each binding needs. Owned absence uses ``Presence[T]``
(``docs/rules/boundaries.md``).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.presence import Presence


class _Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Per-media disposition (A21) — how each aggregate member was treated.
# ---------------------------------------------------------------------------


class MediaDisposition(StrEnum):
    Included = "Included"
    OmittedNoReadyUnit = "OmittedNoReadyUnit"
    OmittedBudget = "OmittedBudget"
    OmittedNotAudienceVisible = "OmittedNotAudienceVisible"
    OmittedProjectionFailed = "OmittedProjectionFailed"


class MediaManifestEntry(_Manifest):
    """One media member of an aggregate manifest (Library/Podcast/Contributor)."""

    media_ref: str
    content_fingerprint: str
    disposition: MediaDisposition


class EvidenceOmission(_Manifest):
    """One evidence span the Media binding offered the model but did not cite/cover."""

    evidence_ref: str


# ---------------------------------------------------------------------------
# Conversation completeness.
# ---------------------------------------------------------------------------


class ConversationComplete(_Manifest):
    kind: Literal["Complete"] = "Complete"


# ---------------------------------------------------------------------------
# The input manifests (A21) — discriminated by `kind`.
# ---------------------------------------------------------------------------


class MediaInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["media"] = "media"
    media_ref: str
    content_fingerprint: str
    offered_claim_count: int
    omitted_evidence: list[EvidenceOmission] = Field(default_factory=list)


class ConversationInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["conversation"] = "conversation"
    conversation_ref: str
    message_refs: list[str] = Field(default_factory=list)
    context_refs: list[str] = Field(default_factory=list)
    topology_fingerprint: Presence[str]
    completeness: ConversationComplete


class LibraryInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["library"] = "library"
    library_ref: str
    media: list[MediaManifestEntry] = Field(default_factory=list)


class PodcastInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["podcast"] = "podcast"
    podcast_ref: str
    episodes: list[MediaManifestEntry] = Field(default_factory=list)


class ContributorInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["contributor"] = "contributor"
    contributor_handle: str
    works: list[MediaManifestEntry] = Field(default_factory=list)


class PageInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["page"] = "page"
    page_ref: str
    input_fingerprint: str
    block_refs: list[str] = Field(default_factory=list)
    connection_refs: list[str] = Field(default_factory=list)


class NoteInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["note"] = "note"
    note_ref: str
    input_fingerprint: str
    body_fingerprint: Presence[str]
    connection_refs: list[str] = Field(default_factory=list)


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
    included_seed_refs: list[str] = Field(default_factory=list)
    nexus_query_fingerprints: list[str] = Field(default_factory=list)
    web_query_fingerprints: list[str] = Field(default_factory=list)
    included_sources: list[IdeaIncludedSource] = Field(default_factory=list)
    omitted_sources: list[IdeaOmittedSource] = Field(default_factory=list)


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
