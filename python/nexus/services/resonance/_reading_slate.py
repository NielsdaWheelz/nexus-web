"""Pure deterministic family assignment, ranking, and Slate composition."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, assert_never

from nexus.services.resonance._evidence import (
    AddedToNexusEvidence,
    ArrivalEvidence,
    CandidateEvidence,
    EdgeEvidence,
    NewEpisodeEvidence,
    PublishedEvidence,
    RelationEvidence,
    SemanticEvidence,
    SharedAuthorEvidence,
)
from nexus.services.resonance._ranking import (
    ARRIVAL_WINDOW_DAYS,
    CONTINUITY_MAX_IDLE_DAYS,
    REDISCOVERY_MIN_AGE_DAYS,
    RESONANCE_EDGE_ORIGINS,
    SLATE_FAMILY_CANDIDATE_LIMIT,
    SLATE_LIMIT,
    SLATE_UNIQUE_CANDIDATE_LIMIT,
)
from nexus.services.resource_graph.refs import ResourceRef

Family = Literal["Continuity", "Arrival", "GraphThread", "Rediscovery"]
ReasonKind = Literal[
    "Continue",
    "AddedToNexus",
    "Published",
    "NewEpisode",
    "Connected",
    "SharedAuthor",
    "Similar",
]

_EDGE_ORIGIN_PRIORITY = {origin: priority for priority, origin in enumerate(RESONANCE_EDGE_ORIGINS)}
_EDGE_KIND_PRIORITY = {"context": 0, "supports": 1, "contradicts": 2}
_ARRIVAL_REASON_PRIORITY = {"NewEpisode": 0, "Published": 1, "AddedToNexus": 2}
_RELATION_PRIORITY = {EdgeEvidence: 0, SharedAuthorEvidence: 1, SemanticEvidence: 2}


@dataclass(frozen=True, slots=True)
class RankedCandidate:
    evidence: CandidateEvidence
    family: Family
    reason: ArrivalEvidence | RelationEvidence | None

    @property
    def target_ref(self) -> ResourceRef:
        return self.evidence.target_ref


def rank_lectern_candidates(
    candidates: list[CandidateEvidence], *, as_of: datetime
) -> dict[Family, list[RankedCandidate]]:
    ranked: dict[Family, list[RankedCandidate]] = {
        "Continuity": [],
        "Arrival": [],
        "GraphThread": [],
        "Rediscovery": [],
    }
    for candidate in candidates:
        assigned = _assign_lectern(candidate, as_of=as_of)
        if assigned is not None:
            ranked[assigned.family].append(assigned)
    for family, rows in ranked.items():
        rows.sort(key=lambda row, current=family: _family_rank_key(row, current, as_of=as_of))
        del rows[SLATE_FAMILY_CANDIDATE_LIMIT:]
    _assert_retained_union(ranked)
    return ranked


def rank_library_candidates(
    candidates: list[CandidateEvidence], *, as_of: datetime
) -> dict[Family, list[RankedCandidate]]:
    ranked: dict[Family, list[RankedCandidate]] = {
        "Continuity": [],
        "Arrival": [],
        "GraphThread": [],
        "Rediscovery": [],
    }
    for candidate in candidates:
        relation = _best_relation(candidate)
        if relation is None:
            continue
        family: Family = "Rediscovery" if _is_rediscovery(candidate, as_of=as_of) else "GraphThread"
        ranked[family].append(RankedCandidate(candidate, family, relation))
    for family in ("GraphThread", "Rediscovery"):
        ranked[family].sort(key=_library_rank_key)
        del ranked[family][SLATE_FAMILY_CANDIDATE_LIMIT:]
    _assert_retained_union(ranked)
    return ranked


def compose_lectern(ranked: dict[Family, list[RankedCandidate]]) -> list[RankedCandidate]:
    schedule: tuple[Family, ...] = (
        "Continuity",
        "GraphThread",
        "Arrival",
        "Rediscovery",
        "Continuity",
        "GraphThread",
        "Arrival",
        "Rediscovery",
        "Continuity",
        "GraphThread",
    )
    return _compose(
        ranked,
        schedule=schedule,
        backfill=("GraphThread", "Continuity", "Rediscovery", "Arrival"),
    )


def compose_library(ranked: dict[Family, list[RankedCandidate]]) -> list[RankedCandidate]:
    remaining = sorted(
        [*ranked["GraphThread"], *ranked["Rediscovery"]],
        key=_library_rank_key,
    )
    selected: list[RankedCandidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    while len(selected) < SLATE_LIMIT and _take_one(
        remaining,
        selected=selected,
        counts=counts,
    ):
        pass
    return selected


def reason_kind(candidate: RankedCandidate) -> ReasonKind:
    if candidate.family == "Continuity":
        return "Continue"
    reason = candidate.reason
    if isinstance(reason, AddedToNexusEvidence | PublishedEvidence | NewEpisodeEvidence):
        return reason.kind
    if isinstance(reason, EdgeEvidence):
        return "Connected"
    if isinstance(reason, SharedAuthorEvidence):
        return "SharedAuthor"
    if isinstance(reason, SemanticEvidence):
        return "Similar"
    # justify-defect: every qualified family has exactly one corresponding reason.
    raise AssertionError(f"missing reason for {candidate.family}")


def _assign_lectern(candidate: CandidateEvidence, *, as_of: datetime) -> RankedCandidate | None:
    continuity = candidate.continuity
    if (
        continuity is not None
        and as_of - timedelta(days=CONTINUITY_MAX_IDLE_DAYS) <= continuity.last_engaged_at <= as_of
    ):
        return RankedCandidate(candidate, "Continuity", None)

    arrivals = _qualifying_arrivals(candidate.arrivals, as_of=as_of)
    if arrivals:
        return RankedCandidate(candidate, "Arrival", _primary_arrival(arrivals))

    relation = _best_relation(candidate)
    if relation is None:
        return None
    family: Family = "Rediscovery" if _is_rediscovery(candidate, as_of=as_of) else "GraphThread"
    return RankedCandidate(candidate, family, relation)


def _is_rediscovery(candidate: CandidateEvidence, *, as_of: datetime) -> bool:
    activity = candidate.latest_exact_activity_at
    return activity is not None and activity <= as_of - timedelta(days=REDISCOVERY_MIN_AGE_DAYS)


def _qualifying_arrivals(
    arrivals: tuple[ArrivalEvidence, ...], *, as_of: datetime
) -> tuple[ArrivalEvidence, ...]:
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


def _primary_arrival(arrivals: tuple[ArrivalEvidence, ...]) -> ArrivalEvidence:
    return min(arrivals, key=lambda arrival: _ARRIVAL_REASON_PRIORITY[arrival.kind])


def _best_relation(candidate: CandidateEvidence) -> RelationEvidence | None:
    if candidate.edges:
        return min(candidate.edges, key=lambda edge: (*_edge_key(edge), edge.anchor.rank))
    if candidate.shared_authors:
        return min(
            candidate.shared_authors,
            key=lambda evidence: (*_shared_author_key(evidence), evidence.anchor.rank),
        )
    if candidate.semantics:
        return min(
            candidate.semantics,
            key=lambda evidence: (*_semantic_key(evidence), evidence.anchor.rank),
        )
    return None


def _family_rank_key(
    candidate: RankedCandidate, family: Family, *, as_of: datetime
) -> tuple[object, ...]:
    ref = candidate.target_ref.uri
    if family == "Continuity":
        continuity = candidate.evidence.continuity
        if continuity is None:
            raise AssertionError("Continuity candidate has no Continuity evidence")
        return (-continuity.last_engaged_at.timestamp(), ref)
    if family == "Arrival":
        arrivals = _qualifying_arrivals(candidate.evidence.arrivals, as_of=as_of)
        if not arrivals:
            raise AssertionError("Arrival candidate has no qualifying Arrival evidence")
        newest_date = max(arrival.occurred_on for arrival in arrivals)
        newest_date_arrivals = tuple(
            arrival for arrival in arrivals if arrival.occurred_on == newest_date
        )
        exact = [
            arrival.occurred_at
            for arrival in newest_date_arrivals
            if arrival.occurred_at is not None
        ]
        return (
            -newest_date.toordinal(),
            min(_ARRIVAL_REASON_PRIORITY[arrival.kind] for arrival in newest_date_arrivals),
            -(max(exact).timestamp()) if exact else float("inf"),
            ref,
        )
    if family in ("GraphThread", "Rediscovery"):
        relation = candidate.reason
        if not isinstance(relation, EdgeEvidence | SharedAuthorEvidence | SemanticEvidence):
            raise AssertionError("relational candidate has no relation")
        return (
            _RELATION_PRIORITY[type(relation)],
            *_relation_strength_key(relation),
            _relation_anchor_rank(relation),
            ref,
        )
    assert_never(family)


def _library_rank_key(candidate: RankedCandidate) -> tuple[object, ...]:
    relation = candidate.reason
    if not isinstance(relation, EdgeEvidence | SharedAuthorEvidence | SemanticEvidence):
        raise AssertionError("Library candidate has no relation")
    engaged = candidate.evidence.last_engaged_at
    arrival = candidate.evidence.latest_exact_arrival_at
    return (
        _RELATION_PRIORITY[type(relation)],
        *_relation_strength_key(relation),
        -(engaged.timestamp()) if engaged is not None else float("inf"),
        -(arrival.timestamp()) if arrival is not None else float("inf"),
        _relation_anchor_rank(relation),
        candidate.target_ref.uri,
    )


def _relation_strength_key(relation: RelationEvidence) -> tuple[object, ...]:
    if isinstance(relation, EdgeEvidence):
        return _edge_key(relation)
    if isinstance(relation, SharedAuthorEvidence):
        return _shared_author_key(relation)
    if isinstance(relation, SemanticEvidence):
        return _semantic_key(relation)
    assert_never(relation)


def _edge_key(edge: EdgeEvidence) -> tuple[object, ...]:
    return (
        _EDGE_ORIGIN_PRIORITY[edge.edge_origin],
        -edge.created_at.timestamp(),
        _EDGE_KIND_PRIORITY[edge.edge_kind],
        str(edge.edge_id),
    )


def _shared_author_key(evidence: SharedAuthorEvidence) -> tuple[object, ...]:
    return (-len(evidence.authors), str(evidence.authors[0].id))


def _semantic_key(evidence: SemanticEvidence) -> tuple[object, ...]:
    return (-evidence.similarity,)


def _relation_anchor_rank(relation: RelationEvidence) -> int:
    return relation.anchor.rank


def _compose(
    ranked: dict[Family, list[RankedCandidate]],
    *,
    schedule: tuple[Family, ...],
    backfill: tuple[Family, ...],
) -> list[RankedCandidate]:
    remaining = {family: list(rows) for family, rows in ranked.items()}
    selected: list[RankedCandidate] = []
    counts: Counter[tuple[str, object]] = Counter()

    for family in schedule:
        _take_one(remaining[family], selected=selected, counts=counts)
        if len(selected) == SLATE_LIMIT:
            return selected

    while len(selected) < SLATE_LIMIT:
        added = False
        for family in backfill:
            if _take_one(remaining[family], selected=selected, counts=counts):
                added = True
                if len(selected) == SLATE_LIMIT:
                    return selected
        if not added:
            break
    return selected


def _take_one(
    remaining: list[RankedCandidate],
    *,
    selected: list[RankedCandidate],
    counts: Counter[tuple[str, object]],
) -> bool:
    if not remaining:
        return False
    selected_refs = {candidate.target_ref.uri for candidate in selected}
    remaining[:] = [row for row in remaining if row.target_ref.uri not in selected_refs]
    if not remaining:
        return False
    index = next(
        (i for i, row in enumerate(remaining) if _passes_diversity(row, counts=counts)),
        0,
    )
    candidate = remaining.pop(index)
    selected.append(candidate)
    counts.update(_diversity_attributes(candidate))
    return True


def _assert_retained_union(ranked: dict[Family, list[RankedCandidate]]) -> None:
    retained = [candidate for family in ranked.values() for candidate in family]
    refs = {candidate.target_ref.uri for candidate in retained}
    if len(retained) > SLATE_UNIQUE_CANDIDATE_LIMIT or len(refs) != len(retained):
        # justify-defect: acquisition emits one candidate per target and the
        # four contextual families retain at most twenty candidates apiece.
        raise AssertionError("Slate ranked union violated its unique eighty-target bound")


def _passes_diversity(candidate: RankedCandidate, *, counts: Counter[tuple[str, object]]) -> bool:
    return all(counts[attribute] < 2 for attribute in _diversity_attributes(candidate))


def _diversity_attributes(candidate: RankedCandidate) -> tuple[tuple[str, object], ...]:
    attributes: list[tuple[str, object]] = [("reason", reason_kind(candidate))]
    media_kind = candidate.evidence.media_kind
    if media_kind is not None:
        attributes.append(("media_kind", media_kind.value))
    relation = candidate.reason
    if isinstance(relation, EdgeEvidence | SharedAuthorEvidence | SemanticEvidence):
        attributes.append(("anchor", relation.anchor.ref.uri))
    if isinstance(relation, SharedAuthorEvidence):
        attributes.append(("author", relation.authors[0].id))
    return tuple(attributes)
