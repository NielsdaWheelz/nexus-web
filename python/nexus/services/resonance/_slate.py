"""Slate vocabulary, tuning, ranking and composition. Pure: no database.

Every evidence value arrives from acquisition with its ``rank`` — the position
of its target in that evidence kind's strength order — so ranking here is a
sort over already-decided strength, never a second implementation of it.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from uuid import UUID

from nexus.db.models import MediaKind
from nexus.schemas.resonance import ResonanceEdgeOrigin
from nexus.services.resource_graph.refs import ResourceRef

SLATE_LIMIT = 10
SLATE_ANCHOR_LIMIT = 5
SLATE_FAMILY_CANDIDATE_LIMIT = 20
CONTINUITY_MAX_IDLE_DAYS = 30
ARRIVAL_WINDOW_DAYS = 14
REDISCOVERY_MIN_AGE_DAYS = 90
RESONANCE_EDGE_ORIGINS: tuple[ResonanceEdgeOrigin, ...] = (
    "user",
    "citation",
    "note_body",
    "highlight_note",
    "document_embed",
    "synapse",
)

# Human-reviewed production calibration: a semantic neighbour ranks only when
# its row carries this exact embedding identity at this similarity.
SEMANTIC_PROVIDER = "openai"
SEMANTIC_MODEL = "openai_text_embedding_3_small_256_v1"
SEMANTIC_DIMENSIONS = 256
SEMANTIC_MIN_SIMILARITY = 0.80

Family = Literal["Continuity", "Arrival", "GraphThread", "Rediscovery"]
_ARRIVAL_PRIORITY = {"NewEpisode": 0, "Published": 1, "AddedToNexus": 2}
_RELATION_PRIORITY = {"Connected": 0, "SharedAuthor": 1, "Similar": 2}


@dataclass(frozen=True, slots=True)
class Anchor:
    ref: ResourceRef
    label: str
    rank: int


@dataclass(frozen=True, slots=True)
class ContinuityEvidence:
    progress: float | None
    last_engaged_at: datetime
    kind: Literal["Continue"] = "Continue"


@dataclass(frozen=True, slots=True)
class ArrivalEvidence:
    """One dated arrival. ``occurred_at`` is absent for a publication date,
    which is a calendar day with no instant."""

    kind: Literal["AddedToNexus", "Published", "NewEpisode"]
    occurred_on: date
    occurred_at: datetime | None


@dataclass(frozen=True, slots=True)
class EdgeEvidence:
    anchor: Anchor
    rank: int
    edge_origin: ResonanceEdgeOrigin
    kind: Literal["Connected"] = "Connected"


@dataclass(frozen=True, slots=True)
class SharedAuthorEvidence:
    anchor: Anchor
    rank: int
    author_id: UUID
    author_name: str
    kind: Literal["SharedAuthor"] = "SharedAuthor"


@dataclass(frozen=True, slots=True)
class SemanticEvidence:
    anchor: Anchor
    rank: int
    kind: Literal["Similar"] = "Similar"


type RelationEvidence = EdgeEvidence | SharedAuthorEvidence | SemanticEvidence


@dataclass(frozen=True, slots=True)
class CandidateEvidence:
    target_ref: ResourceRef
    media_kind: MediaKind | None
    continuity: ContinuityEvidence | None
    arrivals: tuple[ArrivalEvidence, ...]
    relation: RelationEvidence | None
    latest_exact_activity_at: datetime | None


@dataclass(frozen=True, slots=True)
class RankedCandidate:
    """One candidate placed in a family, with the one evidence value it renders
    as its reason and the total order it sorts by inside that family."""

    evidence: CandidateEvidence
    family: Family
    reason: ContinuityEvidence | ArrivalEvidence | RelationEvidence
    order: tuple[object, ...]

    @property
    def target_ref(self) -> ResourceRef:
        return self.evidence.target_ref


def rank_lectern_candidates(
    candidates: list[CandidateEvidence], *, as_of: datetime
) -> dict[Family, list[RankedCandidate]]:
    """Assign each candidate its one Lectern family, then order inside each."""
    ranked: dict[Family, list[RankedCandidate]] = {
        "Continuity": [],
        "Arrival": [],
        "GraphThread": [],
        "Rediscovery": [],
    }
    for candidate in candidates:
        continuity = candidate.continuity
        if (
            continuity is not None
            and as_of - timedelta(days=CONTINUITY_MAX_IDLE_DAYS)
            <= continuity.last_engaged_at
            <= as_of
        ):
            ranked["Continuity"].append(
                RankedCandidate(
                    candidate,
                    "Continuity",
                    continuity,
                    (-continuity.last_engaged_at.timestamp(), candidate.target_ref.uri),
                )
            )
            continue
        arrivals = _qualifying_arrivals(candidate.arrivals, as_of=as_of)
        if arrivals:
            ranked["Arrival"].append(_arrival_candidate(candidate, arrivals))
            continue
        relation = candidate.relation
        if relation is not None:
            family = _relational_family(candidate, as_of=as_of)
            ranked[family].append(_relational_candidate(candidate, relation, family))
    for rows in ranked.values():
        rows.sort(key=lambda row: row.order)
        del rows[SLATE_FAMILY_CANDIDATE_LIMIT:]
    return ranked


def rank_library_candidates(
    candidates: list[CandidateEvidence], *, as_of: datetime
) -> list[RankedCandidate]:
    """Relational evidence only, capped per family, then one flat strength order."""
    by_family: dict[Family, list[RankedCandidate]] = {"GraphThread": [], "Rediscovery": []}
    for candidate in candidates:
        relation = candidate.relation
        if relation is None:
            continue
        family = _relational_family(candidate, as_of=as_of)
        by_family[family].append(_relational_candidate(candidate, relation, family))
    ranked: list[RankedCandidate] = []
    for rows in by_family.values():
        rows.sort(key=lambda row: row.order)
        ranked.extend(rows[:SLATE_FAMILY_CANDIDATE_LIMIT])
    ranked.sort(key=lambda row: row.order)
    return ranked


def compose_lectern(ranked: dict[Family, list[RankedCandidate]]) -> list[RankedCandidate]:
    """Ten slots rotating through the four families, then backfill by priority."""
    rotation: tuple[Family, ...] = ("Continuity", "GraphThread", "Arrival", "Rediscovery")
    schedule = (rotation * 3)[:SLATE_LIMIT]
    remaining = {family: list(rows) for family, rows in ranked.items()}
    selected: list[RankedCandidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    for family in schedule:
        _take_one(remaining[family], selected=selected, counts=counts)
        if len(selected) == SLATE_LIMIT:
            return selected
    while len(selected) < SLATE_LIMIT:
        added = False
        for family in ("GraphThread", "Continuity", "Rediscovery", "Arrival"):
            if _take_one(remaining[family], selected=selected, counts=counts):
                added = True
                if len(selected) == SLATE_LIMIT:
                    return selected
        if not added:
            break
    return selected


def compose_library(ranked: list[RankedCandidate]) -> list[RankedCandidate]:
    remaining = list(ranked)
    selected: list[RankedCandidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    while len(selected) < SLATE_LIMIT and _take_one(remaining, selected=selected, counts=counts):
        pass
    return selected


def _relational_family(candidate: CandidateEvidence, *, as_of: datetime) -> Family:
    activity = candidate.latest_exact_activity_at
    if activity is not None and activity <= as_of - timedelta(days=REDISCOVERY_MIN_AGE_DAYS):
        return "Rediscovery"
    return "GraphThread"


def _relational_candidate(
    candidate: CandidateEvidence, relation: RelationEvidence, family: Family
) -> RankedCandidate:
    return RankedCandidate(
        candidate,
        family,
        relation,
        (_RELATION_PRIORITY[relation.kind], relation.rank, candidate.target_ref.uri),
    )


def _arrival_candidate(
    candidate: CandidateEvidence, arrivals: tuple[ArrivalEvidence, ...]
) -> RankedCandidate:
    """Newest arrival day first, the strongest reason on that day, then its instant."""
    newest_on = max(arrival.occurred_on for arrival in arrivals)
    newest = [arrival for arrival in arrivals if arrival.occurred_on == newest_on]
    instants = [arrival.occurred_at for arrival in newest if arrival.occurred_at is not None]
    return RankedCandidate(
        candidate,
        "Arrival",
        min(arrivals, key=lambda arrival: _ARRIVAL_PRIORITY[arrival.kind]),
        (
            -newest_on.toordinal(),
            min(_ARRIVAL_PRIORITY[arrival.kind] for arrival in newest),
            -max(instants).timestamp() if instants else float("inf"),
            candidate.target_ref.uri,
        ),
    )


def _qualifying_arrivals(
    arrivals: tuple[ArrivalEvidence, ...], *, as_of: datetime
) -> tuple[ArrivalEvidence, ...]:
    """Arrivals inside the window: instants by instant, publication days by day."""
    oldest_instant = as_of - timedelta(days=ARRIVAL_WINDOW_DAYS)
    as_of_date = as_of.astimezone(UTC).date()
    oldest_date = as_of_date - timedelta(days=ARRIVAL_WINDOW_DAYS - 1)
    qualified: list[ArrivalEvidence] = []
    for arrival in arrivals:
        occurred_at = arrival.occurred_at
        if occurred_at is None:
            if oldest_date <= arrival.occurred_on <= as_of_date:
                qualified.append(arrival)
        elif oldest_instant <= occurred_at <= as_of:
            qualified.append(arrival)
    return tuple(qualified)


def _take_one(
    remaining: list[RankedCandidate],
    *,
    selected: list[RankedCandidate],
    counts: Counter[tuple[str, object]],
) -> bool:
    """Take the best row that keeps every attribute under two, else the best row."""
    selected_refs = {candidate.target_ref.uri for candidate in selected}
    remaining[:] = [row for row in remaining if row.target_ref.uri not in selected_refs]
    if not remaining:
        return False
    index = next(
        (
            position
            for position, row in enumerate(remaining)
            if all(counts[attribute] < 2 for attribute in _diversity_attributes(row))
        ),
        0,
    )
    candidate = remaining.pop(index)
    selected.append(candidate)
    counts.update(_diversity_attributes(candidate))
    return True


def _diversity_attributes(candidate: RankedCandidate) -> tuple[tuple[str, object], ...]:
    reason = candidate.reason
    attributes: list[tuple[str, object]] = [("reason", reason.kind)]
    media_kind = candidate.evidence.media_kind
    if media_kind is not None:
        attributes.append(("media_kind", media_kind.value))
    if isinstance(reason, EdgeEvidence | SharedAuthorEvidence | SemanticEvidence):
        attributes.append(("anchor", reason.anchor.ref.uri))
    if isinstance(reason, SharedAuthorEvidence):
        attributes.append(("author", reason.author_id))
    return tuple(attributes)
