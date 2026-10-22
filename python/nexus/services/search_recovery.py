"""The content index's read-only recovery offer, independent of its materialization.

Media and Imports may expose the creator's exact dead-job remedy without importing
index writers or reader apparatus. The write owner reauthorizes the same facts when
``repair_dead_media_reindex`` admits the request.
"""

from dataclasses import dataclass
from uuid import UUID

from nexus.schemas.imports import RepairSearchOffer
from nexus.services.capabilities import SearchRecoveryAnswer


@dataclass(frozen=True, slots=True)
class SearchRecoveryFacts:
    revision: int
    dead_job_id: UUID | None
    """The current revision's job, when it is dead."""
    is_creator: bool
    ready_for_reading: bool


def search_recovery(facts: SearchRecoveryFacts) -> SearchRecoveryAnswer:
    """Only a readable media's creator may rerun its current revision's dead job."""
    if facts.dead_job_id is None or not facts.ready_for_reading:
        return None
    if not facts.is_creator:
        return "NotOwner"
    return RepairSearchOffer(expected_revision=facts.revision, expected_job_id=facts.dead_job_id)
