"""Author-observation seam between source adapters and the ingest runner.

A source handler finishes its parser/LLM work and leaves zero or more typed
author observations on the ``dict`` it returns to ``run_source_attempt`` under
``author_observations``, each a ``(media_id, observation, source)`` tuple. After
the source transaction commits, the runner drains them and applies each through
the author facade in a fresh session (spec 2.4), then crosses ready.

``media_id`` may be ``None`` to target the attempt's terminal media id (the
common single-media lane); a handler that already knows a distinct media id (an
X quoted-post sub-media, say) sets it explicitly.

The carrier never survives into the returned or logged job result: it holds
in-memory observation values with credited names, so the runner pops it before
returning.
"""

from __future__ import annotations

from uuid import UUID

from nexus.services.contributor_taxonomy import ContributorObservationBatch, NotObserved

_AUTHOR_OBSERVATIONS_KEY = "author_observations"

# One drained observation: (target media id or None, observation batch, source).
SourceAuthorObservation = tuple[UUID | None, ContributorObservationBatch, str]


def attach_author_observation(
    result: dict[str, object],
    *,
    observation: ContributorObservationBatch,
    source: str,
    media_id: UUID | None = None,
) -> None:
    """Attach one author observation to a source-handler result.

    ``NOT_OBSERVED`` is dropped here so lanes can attach unconditionally; it
    never erases prior credits (spec 2.1). (The X lane does not use this seam:
    it applies its observations in-handler via ``_apply_x_author_observations``
    and never touches the result key.)
    """
    if isinstance(observation, NotObserved):
        return
    bucket = result.setdefault(_AUTHOR_OBSERVATIONS_KEY, [])
    assert isinstance(bucket, list)
    bucket.append((media_id, observation, source))


def take_author_observations(result: dict[str, object]) -> list[SourceAuthorObservation]:
    """Pop and return the observations a handler left (empty when none).

    Popping — not reading — is deliberate: the returned/logged job result must
    never carry credited names.
    """
    raw = result.pop(_AUTHOR_OBSERVATIONS_KEY, None)
    if not isinstance(raw, list):
        return []
    return list(raw)
