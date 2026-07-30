"""One contributor-observation port for Podcast and Media ingest."""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    NotObserved,
)
from nexus.services.contributors import (
    CreditTarget,
    MediaTarget,
    PodcastTarget,
    apply_observed_role_slices_in_current_transaction,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)


@dataclass(frozen=True, slots=True)
class ContributorObservation:
    target: CreditTarget
    observation: ContributorObservationBatch
    source: str


def apply_contributor_observation_in_current_transaction(
    db: Session,
    item: ContributorObservation,
) -> None:
    apply_observed_role_slices_in_current_transaction(
        db,
        target=item.target,
        observation=item.observation,
        source=item.source,
    )


def observe_contributors(item: ContributorObservation) -> None:
    if isinstance(item.observation, NotObserved):
        return
    db = get_session_factory()()
    try:
        retry_serializable(
            db,
            "observe_contributors",
            partial(_apply_and_commit, db, item),
        )
    finally:
        db.close()


def observe_contributors_under_source_fence(
    *,
    session_factory: sessionmaker[Session],
    item: ContributorObservation,
    fence: SourcePublicationFence,
    publication_media_ids: tuple[UUID, ...],
) -> None:
    """Apply one observation through the shared port under a source claim."""
    if isinstance(item.observation, NotObserved):
        return

    def apply(db: Session, _attempt: object) -> None:
        apply_contributor_observation_in_current_transaction(db, item)

    run_source_publication_phase(
        session_factory=session_factory,
        label="apply_contributor_observation",
        fence=fence,
        media_ids=publication_media_ids,
        mutate=apply,
    )


def _apply_and_commit(db: Session, item: ContributorObservation) -> None:
    apply_contributor_observation_in_current_transaction(db, item)
    db.commit()


__all__ = [
    "ContributorObservation",
    "MediaTarget",
    "PodcastTarget",
    "apply_contributor_observation_in_current_transaction",
    "observe_contributors",
    "observe_contributors_under_source_fence",
]
