"""Typed dossier input manifests + failure support (CP2-TYPES, CONTRACTS.md A21).

Stored in ``artifact_revisions.input_manifest`` (JSONB), discriminated by
``kind`` (the spec-pinned lowercase subject scheme). Coverage on the head read is
DERIVED from these; freshness is the binding's ``manifests_equal(stored, live)``
(no LLM). Deliberately minimal — only the freshness / coverage / citation-candidate
/ migration fields each binding needs. Owned absence uses ``Presence[T]``
(``docs/rules/boundaries.md``).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.presence import Absent, Presence
from nexus.services.artifacts.dossier_types import MigratedIncompleteReason


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
# Conversation completeness (A21) — Complete | Incomplete{reason}.
# ---------------------------------------------------------------------------


class ConversationCompletenessReason(StrEnum):
    """Why a conversation manifest is not fully covered. ``MigratedCoverageGap`` is
    the migration-only reason (old leaf/count could not reconstruct all branches)."""

    MigratedCoverageGap = "MigratedCoverageGap"


class ConversationComplete(_Manifest):
    kind: Literal["Complete"] = "Complete"


class ConversationIncomplete(_Manifest):
    kind: Literal["Incomplete"] = "Incomplete"
    reason: ConversationCompletenessReason


ConversationCompleteness = Annotated[
    ConversationComplete | ConversationIncomplete, Field(discriminator="kind")
]


# ---------------------------------------------------------------------------
# The seven input manifests (A21) — discriminated by `kind`.
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
    completeness: ConversationCompleteness


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
    block_refs: list[str] = Field(default_factory=list)
    connection_refs: list[str] = Field(default_factory=list)


class NoteInputManifestV1(_Manifest):
    version: Literal["v1"] = "v1"
    kind: Literal["note"] = "note"
    note_ref: str
    body_fingerprint: Presence[str]
    connection_refs: list[str] = Field(default_factory=list)


InputManifestV1 = Annotated[
    MediaInputManifestV1
    | ConversationInputManifestV1
    | LibraryInputManifestV1
    | PodcastInputManifestV1
    | ContributorInputManifestV1
    | PageInputManifestV1
    | NoteInputManifestV1,
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------------------
# Failure support (A21) — Presence-wrapped in `artifact_build_failures.support`.
# ---------------------------------------------------------------------------


class MigratedIncompleteSupport(_Manifest):
    """Provenance for a migrated ``MigratedIncomplete`` build. ``content_sha256`` is
    the SHA-256 of the legacy body (NOT the body) and is required for a
    ``LegacyZeroCitation`` reason."""

    reason: MigratedIncompleteReason
    legacy_revision_id: UUID
    legacy_status: str
    legacy_completed_at: Presence[datetime]
    content_sha256: Presence[str]

    @model_validator(mode="after")
    def _require_sha_for_zero_citation(self) -> MigratedIncompleteSupport:
        if self.reason is MigratedIncompleteReason.LegacyZeroCitation and isinstance(
            self.content_sha256, Absent
        ):
            raise ValueError("content_sha256 is required for LegacyZeroCitation support")
        return self


class MigratedFailureSupport(_Manifest):
    """Provenance for a migrated ``MigratedFailure`` build (normalized legacy error)."""

    legacy_revision_id: UUID
    legacy_error_code: Presence[str]
    legacy_error_detail: Presence[str]
    legacy_completed_at: Presence[datetime]
