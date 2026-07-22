from __future__ import annotations

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.db.models import MediaKind
from nexus.schemas.presence import absent
from nexus.schemas.resonance import (
    ContinueSlateReasonOut,
    MediaSlateTargetOut,
    PodcastSlateTargetOut,
    SlateOut,
)
from nexus.services.resonance._evidence import (
    AddedToNexusEvidence,
    Anchor,
    Author,
    CandidateEvidence,
    ContinuityEvidence,
    EdgeEvidence,
    NewEpisodeEvidence,
    PublishedEvidence,
    SemanticEvidence,
    SharedAuthorEvidence,
    _day_precision_published_on,
)
from nexus.services.resonance._ranking import (
    RESONANCE_EDGE_ORIGINS,
    SLATE_SEMANTIC_CALIBRATION,
    SLATE_UNIQUE_CANDIDATE_LIMIT,
    slate_semantic_qualifies,
)
from nexus.services.resonance._reading_slate import (
    RankedCandidate,
    compose_lectern,
    rank_lectern_candidates,
    rank_library_candidates,
    reason_kind,
)
from nexus.services.resource_graph.refs import ResourceRef

pytestmark = pytest.mark.unit


def _ref(value: int) -> ResourceRef:
    return ResourceRef(scheme="media", id=UUID(int=value))


def _candidate(
    value: int,
    *,
    as_of: datetime,
    anchor_rank: int = 0,
    similarity: float = 0.9,
    engaged_at: datetime | None = None,
    arrival_at: datetime | None = None,
    activity_at: datetime | None = None,
    continuity: ContinuityEvidence | None = None,
    arrivals: tuple[AddedToNexusEvidence | PublishedEvidence | NewEpisodeEvidence, ...] = (),
    semantic: bool = True,
) -> CandidateEvidence:
    anchor = Anchor(ref=_ref(10_000 + anchor_rank), label=f"Anchor {anchor_rank}", rank=anchor_rank)
    return CandidateEvidence(
        target_ref=_ref(value),
        media_kind=MediaKind.web_article,
        continuity=continuity,
        arrivals=arrivals,
        edges=(),
        shared_authors=(),
        semantics=(SemanticEvidence(anchor=anchor, similarity=similarity),) if semantic else (),
        last_engaged_at=engaged_at,
        latest_exact_arrival_at=arrival_at,
        latest_exact_activity_at=activity_at or as_of,
    )


def test_empty_slate_wire_shape_is_exact_and_boundary_is_strict() -> None:
    assert SlateOut(items=[]).model_dump(by_alias=True, mode="json") == {"items": []}
    with pytest.raises(ValidationError):
        SlateOut.model_validate({"items": [], "unknown": True})


@pytest.mark.parametrize(
    ("target", "payload"),
    [
        (
            MediaSlateTargetOut,
            {
                "ref": f"podcast:{UUID(int=1)}",
                "media_kind": MediaKind.pdf,
                "href": f"/media/{UUID(int=1)}",
            },
        ),
        (
            PodcastSlateTargetOut,
            {
                "ref": f"media:{UUID(int=1)}",
                "href": f"/podcasts/{UUID(int=1)}",
            },
        ),
    ],
)
def test_slate_target_discriminant_requires_the_matching_ref_scheme(target, payload) -> None:
    with pytest.raises(ValidationError):
        target(
            title="Mismatched target",
            subtitle=absent(),
            image_url=absent(),
            **payload,
        )


def test_slate_instant_fields_reject_naive_datetimes() -> None:
    with pytest.raises(ValidationError):
        ContinueSlateReasonOut(
            progress=absent(),
            last_engaged_at=datetime(2026, 7, 21, 12),
        )


def test_semantic_slate_rejects_every_uncalibrated_tuple_dimension() -> None:
    calibration = SLATE_SEMANTIC_CALIBRATION
    assert not slate_semantic_qualifies(
        provider="other",
        model=calibration.model,
        dimensions=calibration.dimensions,
        similarity=1.0,
    )
    assert not slate_semantic_qualifies(
        provider=calibration.provider,
        model="other",
        dimensions=calibration.dimensions,
        similarity=1.0,
    )
    assert not slate_semantic_qualifies(
        provider=calibration.provider,
        model=calibration.model,
        dimensions=calibration.dimensions + 1,
        similarity=1.0,
    )


def test_semantic_slate_floor_is_inclusive_and_requires_finite_similarity() -> None:
    calibration = SLATE_SEMANTIC_CALIBRATION
    exact_tuple = {
        "provider": calibration.provider,
        "model": calibration.model,
        "dimensions": calibration.dimensions,
    }
    assert slate_semantic_qualifies(
        **exact_tuple,
        similarity=calibration.min_similarity,
    )
    assert not slate_semantic_qualifies(
        **exact_tuple,
        similarity=math.nextafter(calibration.min_similarity, -math.inf),
    )
    for similarity in (math.nan, math.inf, -math.inf):
        assert not slate_semantic_qualifies(**exact_tuple, similarity=similarity)


def test_relational_family_ties_use_anchor_rank_before_target_ref() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    later_ref_winner = _candidate(2, as_of=as_of, anchor_rank=0)
    earlier_ref_loser = _candidate(1, as_of=as_of, anchor_rank=1)
    ranked = rank_lectern_candidates([earlier_ref_loser, later_ref_winner], as_of=as_of)
    assert [row.target_ref for row in ranked["GraphThread"]] == [
        later_ref_winner.target_ref,
        earlier_ref_loser.target_ref,
    ]


@pytest.mark.parametrize(
    ("candidate", "expected_family"),
    [
        (
            lambda as_of: _candidate(
                1,
                as_of=as_of,
                continuity=ContinuityEvidence(
                    progress=0.4, last_engaged_at=as_of - timedelta(days=1)
                ),
                arrivals=(
                    AddedToNexusEvidence(kind="AddedToNexus", added_at=as_of - timedelta(hours=1)),
                ),
            ),
            "Continuity",
        ),
        (
            lambda as_of: _candidate(
                2,
                as_of=as_of,
                continuity=ContinuityEvidence(
                    progress=0.4, last_engaged_at=as_of - timedelta(days=31)
                ),
                arrivals=(
                    NewEpisodeEvidence(kind="NewEpisode", published_at=as_of - timedelta(hours=1)),
                ),
                activity_at=as_of - timedelta(days=100),
            ),
            "Arrival",
        ),
        (
            lambda as_of: _candidate(
                3,
                as_of=as_of,
                activity_at=as_of - timedelta(days=90),
            ),
            "Rediscovery",
        ),
        (lambda as_of: _candidate(4, as_of=as_of), "GraphThread"),
        (
            lambda as_of: _candidate(
                5,
                as_of=as_of,
                activity_at=as_of - timedelta(days=100),
                semantic=False,
            ),
            None,
        ),
    ],
)
def test_lectern_family_qualification_and_precedence(candidate, expected_family) -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    ranked = rank_lectern_candidates([candidate(as_of)], as_of=as_of)
    actual = next((family for family, rows in ranked.items() if rows), None)
    assert actual == expected_family


def test_arrival_window_uses_calendar_days_and_reason_precedence() -> None:
    as_of = datetime(2026, 7, 21, 1, tzinfo=UTC)
    boundary = _candidate(
        1,
        as_of=as_of,
        semantic=False,
        arrivals=(
            AddedToNexusEvidence(kind="AddedToNexus", added_at=as_of - timedelta(hours=1)),
            PublishedEvidence(kind="Published", published_on=as_of.date() - timedelta(days=13)),
            NewEpisodeEvidence(kind="NewEpisode", published_at=as_of - timedelta(hours=2)),
        ),
    )
    too_old = _candidate(
        2,
        as_of=as_of,
        semantic=False,
        arrivals=(
            PublishedEvidence(kind="Published", published_on=as_of.date() - timedelta(days=14)),
        ),
    )
    ranked = rank_lectern_candidates([too_old, boundary], as_of=as_of)
    assert [row.target_ref for row in ranked["Arrival"]] == [boundary.target_ref]
    assert reason_kind(ranked["Arrival"][0]) == "NewEpisode"


def test_arrival_sort_type_uses_only_facts_on_the_newest_date() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    added_today_with_older_episode = _candidate(
        1,
        as_of=as_of,
        semantic=False,
        arrivals=(
            AddedToNexusEvidence(kind="AddedToNexus", added_at=as_of - timedelta(hours=1)),
            NewEpisodeEvidence(kind="NewEpisode", published_at=as_of - timedelta(days=10)),
        ),
    )
    published_today = _candidate(
        2,
        as_of=as_of,
        semantic=False,
        arrivals=(PublishedEvidence(kind="Published", published_on=as_of.date()),),
    )

    ranked = rank_lectern_candidates(
        [added_today_with_older_episode, published_today], as_of=as_of
    )["Arrival"]

    assert [row.target_ref for row in ranked] == [
        published_today.target_ref,
        added_today_with_older_episode.target_ref,
    ]
    assert reason_kind(ranked[1]) == "NewEpisode"


@pytest.mark.parametrize(
    "value",
    [
        "2026-W30-1",
        "2026-07",
        "2026",
        "2026-7-21",
        "2026-02-31",
        "2025-02-29",
        "0000-01-01",
    ],
)
def test_only_canonical_day_precision_dates_become_published_evidence(value: str) -> None:
    assert _day_precision_published_on(value) is None


def test_canonical_day_precision_date_is_preserved_without_an_artificial_instant() -> None:
    assert _day_precision_published_on("2026-07-21") == datetime(2026, 7, 21).date()


def test_relation_reason_precedence_is_edge_then_shared_author_then_semantic() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    anchor = Anchor(ref=_ref(99), label="Anchor", rank=0)
    shared = SharedAuthorEvidence(
        anchor=anchor,
        authors=(Author(id=UUID(int=7), display_name="Canonical Author"),),
    )
    base = _candidate(1, as_of=as_of)
    with_shared = replace(base, shared_authors=(shared,))
    shared_ranked = rank_lectern_candidates([with_shared], as_of=as_of)["GraphThread"][0]
    assert reason_kind(shared_ranked) == "SharedAuthor"

    edge = EdgeEvidence(
        anchor=anchor,
        edge_id=UUID(int=8),
        edge_kind="context",
        edge_origin="user",
        created_at=as_of,
    )
    with_edge = replace(with_shared, edges=(edge,))
    edge_ranked = rank_lectern_candidates([with_edge], as_of=as_of)["GraphThread"][0]
    assert reason_kind(edge_ranked) == "Connected"


def test_library_secondary_order_uses_exact_arrival_not_engagement_twice() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    older_arrival = _candidate(
        1,
        as_of=as_of,
        engaged_at=as_of - timedelta(days=2),
        arrival_at=as_of - timedelta(days=20),
    )
    newer_arrival = _candidate(
        2,
        as_of=as_of,
        engaged_at=as_of - timedelta(days=2),
        arrival_at=as_of - timedelta(days=10),
    )
    ranked = rank_library_candidates([older_arrival, newer_arrival], as_of=as_of)
    assert [row.target_ref for row in ranked["GraphThread"]] == [
        newer_arrival.target_ref,
        older_arrival.target_ref,
    ]


def test_each_library_family_is_capped_after_contextual_assignment() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    graph = [_candidate(value, as_of=as_of) for value in range(1, 26)]
    rediscovery = [
        _candidate(
            value,
            as_of=as_of,
            activity_at=as_of - timedelta(days=100),
        )
        for value in range(101, 126)
    ]
    ranked = rank_library_candidates([*graph, *rediscovery], as_of=as_of)
    assert len(ranked["GraphThread"]) == 20
    assert len(ranked["Rediscovery"]) == 20


def test_lectern_ranked_union_retains_at_most_eighty_unique_targets() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    continuity = [
        _candidate(
            value,
            as_of=as_of,
            continuity=ContinuityEvidence(progress=0.5, last_engaged_at=as_of),
        )
        for value in range(1, 26)
    ]
    arrival = [
        _candidate(
            value,
            as_of=as_of,
            arrivals=(AddedToNexusEvidence(kind="AddedToNexus", added_at=as_of),),
        )
        for value in range(101, 126)
    ]
    graph = [_candidate(value, as_of=as_of) for value in range(201, 226)]
    rediscovery = [
        _candidate(value, as_of=as_of, activity_at=as_of - timedelta(days=100))
        for value in range(301, 326)
    ]

    ranked = rank_lectern_candidates(
        [*continuity, *arrival, *graph, *rediscovery],
        as_of=as_of,
    )
    retained = [candidate for family in ranked.values() for candidate in family]
    refs = {candidate.target_ref.uri for candidate in retained}

    assert {family: len(rows) for family, rows in ranked.items()} == {
        "Continuity": 20,
        "Arrival": 20,
        "GraphThread": 20,
        "Rediscovery": 20,
    }
    assert len(retained) == SLATE_UNIQUE_CANDIDATE_LIMIT
    assert len(refs) == len(retained)


def test_lectern_composition_is_unique_and_never_exceeds_ten() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    candidates = [_candidate(value, as_of=as_of) for value in range(1, 30)]
    selected = compose_lectern(rank_lectern_candidates(candidates, as_of=as_of))
    refs = [row.target_ref.uri for row in selected]
    assert len(refs) == 10
    assert len(set(refs)) == len(refs)


def test_composer_scans_for_diversity_then_falls_back_and_backfills() -> None:
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    anchor = Anchor(ref=_ref(500), label="Repeated anchor", rank=0)
    similar_rows = [
        RankedCandidate(
            evidence=_candidate(value, as_of=as_of),
            family="GraphThread",
            reason=SemanticEvidence(anchor=anchor, similarity=1.0 - value / 100.0),
        )
        for value in (1, 2, 3)
    ]
    edge_evidence = replace(
        _candidate(4, as_of=as_of),
        media_kind=MediaKind.pdf,
    )
    edge_reason = EdgeEvidence(
        anchor=Anchor(ref=_ref(501), label="Different anchor", rank=1),
        edge_id=UUID(int=4),
        edge_kind="context",
        edge_origin="user",
        created_at=as_of,
    )
    different = RankedCandidate(
        evidence=edge_evidence,
        family="GraphThread",
        reason=edge_reason,
    )
    ranked = {
        "Continuity": [],
        "Arrival": [],
        "GraphThread": [*similar_rows, different],
        "Rediscovery": [],
    }
    selected = compose_lectern(ranked)
    graph_refs = [row.target_ref for row in selected]
    assert graph_refs[:3] == [
        similar_rows[0].target_ref,
        similar_rows[1].target_ref,
        different.target_ref,
    ]
    assert similar_rows[2].target_ref in graph_refs


def test_edge_origin_priority_includes_synapse_but_excludes_assistant_and_system() -> None:
    assert "synapse" in RESONANCE_EDGE_ORIGINS
    assert "assistant" not in RESONANCE_EDGE_ORIGINS
    assert "system" not in RESONANCE_EDGE_ORIGINS
    as_of = datetime(2026, 7, 21, 12, tzinfo=UTC)
    anchor = Anchor(ref=_ref(99), label="Anchor", rank=0)
    candidate = CandidateEvidence(
        target_ref=_ref(1),
        media_kind=MediaKind.pdf,
        continuity=None,
        arrivals=(),
        edges=(
            EdgeEvidence(
                anchor=anchor,
                edge_id=UUID(int=1),
                edge_kind="context",
                edge_origin="synapse",
                created_at=as_of,
            ),
        ),
        shared_authors=(),
        semantics=(),
        last_engaged_at=None,
        latest_exact_arrival_at=None,
        latest_exact_activity_at=as_of,
    )
    assert rank_lectern_candidates([candidate], as_of=as_of)["GraphThread"]
