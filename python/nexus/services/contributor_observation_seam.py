"""One contributor-observation port for Podcast and Media ingest."""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.services._contributor_credit_writes import (
    CreditTarget,
    MediaTarget,
    PodcastTarget,
    replace_role_slices,
)
from nexus.services._contributor_identity import resolve_observation_credits
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    NotObserved,
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
    if isinstance(item.observation, NotObserved):
        return
    managed_roles = item.observation.managed_roles
    if isinstance(item.target, MediaTarget):
        media = db.scalar(select(Media).where(Media.id == item.target.media_id))
        if media is None:
            return
        if media.authors_manually_managed:
            managed_roles = managed_roles - {"author"}
    if not managed_roles:
        return
    relevant = [credit for credit in item.observation.credits if credit.role in managed_roles]
    resolved = resolve_observation_credits(db, relevant)
    outcome = replace_role_slices(
        db,
        target=item.target,
        managed_roles=managed_roles,
        resolved=list(zip(resolved, relevant, strict=True)),
        source=item.source,
    )
    if outcome.dropped_contributor_ids:
        from nexus.services.contributors import prune_contributors_if_orphaned

        prune_contributors_if_orphaned(
            db,
            contributor_ids=outcome.dropped_contributor_ids,
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
