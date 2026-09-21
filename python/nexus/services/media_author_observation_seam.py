"""Author observations carried from a source handler to the ingest runner."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from nexus.services.contributor_taxonomy import ContributorObservationBatch, NotObserved

_AUTHOR_OBSERVATIONS_KEY = "author_observations"

# (target media id or None for the attempt's terminal media, batch, source).
SourceAuthorObservation = tuple[UUID | None, ContributorObservationBatch, str]


def attach_author_observation(
    result: dict[str, object],
    *,
    observation: ContributorObservationBatch,
    source: str,
    media_id: UUID | None = None,
) -> None:
    """Attach one author observation; NOT_OBSERVED is dropped, never recorded."""
    if isinstance(observation, NotObserved):
        return
    bucket = cast(list[SourceAuthorObservation], result.setdefault(_AUTHOR_OBSERVATIONS_KEY, []))
    bucket.append((media_id, observation, source))


def take_author_observations(result: dict[str, object]) -> list[SourceAuthorObservation]:
    """Pop the observations a handler left, so credited names never reach a job result."""
    if _AUTHOR_OBSERVATIONS_KEY not in result:
        return []
    return cast(list[SourceAuthorObservation], result.pop(_AUTHOR_OBSERVATIONS_KEY))
