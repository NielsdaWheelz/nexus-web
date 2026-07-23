"""The one generic dossier definition (CP2-ENGINE, A3).

``DossierDefinition`` is a single value, NOT a registry: the generated-output +
citation contract, the build/revision lifecycle constants, and the shared
read/history/event vocabulary that every subject binding shares. Per-subject
variation lives entirely in the :class:`SubjectPolicy` and :class:`DossierBinding`
registries; this value holds only what is the same for all seven subjects.
"""

from __future__ import annotations

from dataclasses import dataclass

from nexus.services.artifacts.dossier_types import (
    ArtifactBuildEventType,
    DossierBuildFailureCode,
)


@dataclass(frozen=True, slots=True)
class DossierDefinition:
    """The subject-invariant dossier contract."""

    # One durable job kind dispatches every subject through the binding registry.
    job_kind: str
    # The durable-op conflict/dedupe key is per-attempt: ``{prefix}:{build_id}``.
    dispatch_dedupe_prefix: str
    # The LLM/provider ledger attribution owner kind for a build.
    ledger_owner_kind: str
    # The single LISTEN/NOTIFY channel for the build-event stream.
    build_event_channel: str
    # Zero materialized citations fails the build (A10); the floor is one.
    min_materialized_citations: int
    # The closed, sequenced build-event log types (A5).
    event_types: tuple[ArtifactBuildEventType, ...]
    # The closed modeled-failure codes (A7); everything else is a defect.
    failure_codes: tuple[DossierBuildFailureCode, ...]


DOSSIER_DEFINITION = DossierDefinition(
    job_kind="dossier_build",
    dispatch_dedupe_prefix="dossier_build",
    ledger_owner_kind="artifact_build",
    build_event_channel="artifact_build_events",
    min_materialized_citations=1,
    event_types=tuple(ArtifactBuildEventType),
    failure_codes=tuple(DossierBuildFailureCode),
)
