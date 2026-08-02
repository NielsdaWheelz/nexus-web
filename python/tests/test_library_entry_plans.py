"""Local query-plan release gate for the Library All/Smart-Views cutover.

This is the *local, modest-fixture slice* of the spec's "Performance release
gate" (`docs/cutovers/library-all-and-smart-views-hard-cutover.md`, AC15). It
seeds one viewer with a mix of Default/named/consumption facts and runs
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the *exact* SELECT the
`library_entries` service composes for each view in the plan matrix — the house
pattern established by
`python/tests/test_consumption_activity_operations.py::_assert_explain_analyze`.

It asserts, per plan, a generous fixed warm execution budget, no external
(disk-spill) sort, and no node whose `Actual Loops` betrays a candidate-
correlated nested-loop blowup. The run's stdout (use ``-s``) *is* the recorded
gate evidence: fixture cardinalities plus per-case timing, rows, buffer
hits/reads, and worst-node loop count.

Two things this deliberately does NOT do, because they belong to the release
step and not to a repo test:

- The production-like-cardinality, 2x-regression comparison against a recorded
  production-like fixture. No such fixture exists in-repo; that comparison is a
  release-time step run against the recorded baseline plans.
- Adding any index. Per the spec, NO index may be added without amending the
  spec first. If a case below trips the full-scan / spill / loop tripwire, the
  correct action is to report it and amend the spec — never to add an index to
  make this test green.
"""

from __future__ import annotations

from collections.abc import Iterator
from time import perf_counter
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind, Podcast, PodcastEpisode
from nexus.services import library_entries
from nexus.services.library_entries import (
    Added,
    AllItems,
    AllTypes,
    Canonical,
    ExactType,
    InProgress,
    LibraryEntryView,
    Title,
    Unfiled,
)
from tests.factories import (
    add_media_to_library,
    add_test_podcast_subscription,
    create_test_library,
    create_test_media,
    get_user_default_library,
)

pytestmark = pytest.mark.integration

# Generous fixed warm budget, mirroring the consumption-activity one-user gate.
_WARM_BUDGET_MS = 500.0
_PAGE_LIMIT = 100


# ---------------------------------------------------------------------------
# Fixture seeding — one viewer, via the service/factory layer.
# ---------------------------------------------------------------------------


def _set_reader_progress(db: Session, viewer_id: UUID, media_id: UUID, *, fraction: float) -> None:
    """Give one web_article media a canonical reader engagement fact (the exact
    mechanism `test_libraries.py::_set_reader_progress` uses): ``fraction`` below
    the finished threshold (0.95) derives ``InProgress``, at/above it ``Finished``."""
    db.execute(
        text(
            "INSERT INTO reader_engagement_states "
            "(id, user_id, media_id, last_engaged_at, max_total_progression) "
            "VALUES (:id, :u, :m, now(), :f)"
        ),
        {"id": uuid4(), "u": viewer_id, "m": media_id, "f": fraction},
    )


class _Fixture:
    def __init__(
        self,
        *,
        default_library_id: UUID,
        named_library_id: UUID,
        total_media: int,
        default_all: int,
        default_unfiled: int,
        default_in_progress: int,
        named_all: int,
    ) -> None:
        self.default_library_id = default_library_id
        self.named_library_id = named_library_id
        self.total_media = total_media
        self.default_all = default_all
        self.default_unfiled = default_unfiled
        self.default_in_progress = default_in_progress
        self.named_all = named_all


def _seed_plan_fixture(db: Session, viewer_id: UUID) -> _Fixture:
    """Seed a modest but meaningful single-viewer fixture:

    - Group A (100): filed only in Default, InProgress — unfiled candidates that
      also dominate the InProgress projection.
    - Group B (6): Default + named library A, Finished — filed, so not Unfiled.
    - Group B2 (4): Default + named library B, Finished.
    - Group C (4): named library A only (reachable through Default's virtual set
      but NOT direct-Default), InProgress.
    - Group D (3): named library B only, Unread (no consumption fact).
    - Group E (8): filed only in Default — 4 Finished, 4 Unread — Unfiled but a
      finished/unread subset so completion filtering does real work.
    - Group F (20): Podcast-episode Media filed only in Default whose one active
      parent subscription contributes a single Podcast root instead.

    So Default AllItems/Unfiled/InProgress each exceed the page limit (they get a
    real continuation page), while named-library A holds only ~10 entries.
    """
    default_id = get_user_default_library(db, viewer_id)
    assert default_id is not None
    named_a = create_test_library(db, viewer_id, "Named A")
    named_b = create_test_library(db, viewer_id, "Named B")

    total = 0

    def _media(title: str, *, kind: str = MediaKind.web_article.value) -> UUID:
        nonlocal total
        total += 1
        return create_test_media(db, title=title, kind=kind)

    # Group A: 100 default-only InProgress (unfiled candidates + InProgress core).
    for i in range(100):
        mid = _media(f"A unfiled inprogress {i:03d}")
        add_media_to_library(db, default_id, mid)
        _set_reader_progress(db, viewer_id, mid, fraction=0.4)

    # Group B: 6 default + named A, Finished.
    for i in range(6):
        mid = _media(f"B default+namedA finished {i:03d}")
        add_media_to_library(db, default_id, mid)
        add_media_to_library(db, named_a, mid)
        _set_reader_progress(db, viewer_id, mid, fraction=1.0)

    # Group B2: 4 default + named B, Finished.
    for i in range(4):
        mid = _media(f"B2 default+namedB finished {i:03d}")
        add_media_to_library(db, default_id, mid)
        add_media_to_library(db, named_b, mid)
        _set_reader_progress(db, viewer_id, mid, fraction=0.98)

    # Group C: 4 named-A-only, InProgress (reachable via Default virtual set only).
    for i in range(4):
        mid = _media(f"C namedA-only inprogress {i:03d}")
        add_media_to_library(db, named_a, mid)
        _set_reader_progress(db, viewer_id, mid, fraction=0.5)

    # Group D: 3 named-B-only, Unread (no consumption fact).
    for i in range(3):
        mid = _media(f"D namedB-only unread {i:03d}")
        add_media_to_library(db, named_b, mid)

    # Group E: 8 default-only — 4 Finished, 4 Unread.
    for i in range(4):
        mid = _media(f"E default-only finished {i:03d}")
        add_media_to_library(db, default_id, mid)
        _set_reader_progress(db, viewer_id, mid, fraction=0.97)
    for i in range(4):
        mid = _media(f"E default-only unread {i:03d}")
        add_media_to_library(db, default_id, mid)

    # Group F: descendant episode storage remains in Default, while the active
    # parent contributes the sole Default root for this family.
    podcast_id = uuid4()
    db.add(
        Podcast(
            id=podcast_id,
            provider="podcast_index",
            provider_podcast_id=f"plan-root-{podcast_id}",
            title="Plan Root Podcast",
            feed_url=f"https://example.com/{podcast_id}.xml",
        )
    )
    add_test_podcast_subscription(db, user_id=viewer_id, podcast_id=podcast_id)
    for i in range(20):
        mid = _media(
            f"F active-parent episode {i:03d}",
            kind=MediaKind.podcast_episode.value,
        )
        db.add(PodcastEpisode(media_id=mid, podcast_id=podcast_id))
        add_media_to_library(db, default_id, mid)

    db.commit()

    # Default roots = 125 non-subsumed Media plus one active Podcast parent.
    default_all = 100 + 6 + 4 + 4 + 3 + 8 + 1
    # Unfiled = direct-Default with no other non-system placement = A + E.
    default_unfiled = 100 + 8
    # InProgress = A + C.
    default_in_progress = 100 + 4
    # Named A physical entries = B + C.
    named_all = 6 + 4

    return _Fixture(
        default_library_id=default_id,
        named_library_id=named_a,
        total_media=total,
        default_all=default_all,
        default_unfiled=default_unfiled,
        default_in_progress=default_in_progress,
        named_all=named_all,
    )


# ---------------------------------------------------------------------------
# Capture the exact statement + params the service executes for a page.
# ---------------------------------------------------------------------------


def _capture_entries_query(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    limit: int,
    cursor: str | None,
    collection_revision: int | None,
) -> tuple[str, dict[str, Any], object]:
    """Run ``list_library_entries`` once (warming caches) while wrapping the
    session's ``execute`` to record the compiled text + params of the entry page
    SELECT. Returns ``(sql, params, page_info)``. The page SELECT is uniquely
    identified by its ``FROM facts`` / ``LIMIT :limit`` shape; hydration and
    authorization statements never match."""
    captured: list[tuple[str, dict[str, Any]]] = []
    original_execute = db.execute

    def _wrapper(statement: Any, params: Any = None, *args: Any, **kwargs: Any) -> Any:
        result = original_execute(statement, params, *args, **kwargs)
        sql_text = getattr(statement, "text", None)
        if isinstance(sql_text, str) and "FROM facts" in sql_text and "LIMIT :limit" in sql_text:
            captured.append((sql_text, dict(params or {})))
        return result

    db.execute = _wrapper  # type: ignore[method-assign]
    try:
        page = library_entries.list_library_entries(
            db,
            viewer_id,
            library_id,
            view=view,
            limit=limit,
            cursor=cursor,
            collection_revision=collection_revision,
        )
    finally:
        del db.execute  # restore the class method

    assert captured, "entry page SELECT was not captured"
    sql_text, params = captured[-1]
    return sql_text, params, page


def _walk(node: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield node
    for child in node.get("Plans", []):
        yield from _walk(child)


# Caching nodes. Postgres inserts these to make a repeated inner-loop scan
# cheap: it runs the underlying scan ONCE (its own Actual Loops == 1) and
# replays the buffered result. A high Actual Loops on a Materialize/Memoize is
# therefore the intended optimization — near-zero per-loop time — not a
# candidate-correlated blowup, so it is excluded from the loop tripwire. A
# genuine per-candidate re-scan surfaces on a real Scan/Join node instead and is
# still caught.
_CACHE_NODE_TYPES = frozenset({"Materialize", "Memoize"})


class _PlanEvidence:
    def __init__(self, label: str, plan_json: list[dict[str, Any]], *, total_media: int) -> None:
        root = plan_json[0]
        top = root["Plan"]
        nodes = list(_walk(top))
        self.label = label
        self.execution_ms: float = float(root["Execution Time"])
        self.planning_ms: float = float(root.get("Planning Time", 0.0))
        self.rows: int = int(top.get("Actual Rows", 0))
        # Postgres buffer stats accumulate up the tree, so the root carries totals.
        self.shared_hit: int = int(top.get("Shared Hit Blocks", 0))
        self.shared_read: int = int(top.get("Shared Read Blocks", 0))
        # Gated metric: worst re-execution count among nodes that do real work
        # per loop (caching nodes excluded — see above).
        self.max_loops: int = max(
            int(n.get("Actual Loops", 1))
            for n in nodes
            if n.get("Node Type") not in _CACHE_NODE_TYPES
        )
        # Recorded for transparency: worst loop count including cached replays.
        self.max_loops_cached: int = max(int(n.get("Actual Loops", 1)) for n in nodes)
        self.external_sorts: list[str] = [
            n["Sort Method"]
            for n in nodes
            if isinstance(n.get("Sort Method"), str) and "external" in n["Sort Method"].lower()
        ]
        # A candidate-correlated nested-loop blowup re-executes a real scan node
        # once per candidate; its loop count then scales with the candidate set
        # rather than staying near the seeded cardinality (~145 here). Bound
        # generously (8x total media) so healthy plans pass with wide margin
        # while an O(N^2) per-candidate re-scan trips it.
        self.loop_bound: int = max(total_media * 8, 256)
        self.hot_loop_nodes: tuple[str, ...] = tuple(
            (
                f"{node.get('Node Type')}["
                f"{node.get('Relation Name') or node.get('CTE Name') or node.get('Alias') or '?'}"
                f"]={int(node.get('Actual Loops', 1))}"
            )
            for node in nodes
            if node.get("Node Type") not in _CACHE_NODE_TYPES
            and int(node.get("Actual Loops", 1)) > self.loop_bound
        )


def _run_case(
    db: Session,
    *,
    label: str,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    cursor: str | None,
    collection_revision: int | None,
    total_media: int,
) -> tuple[_PlanEvidence, object]:
    sql, params, page_info = _capture_entries_query(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        view=view,
        limit=_PAGE_LIMIT,
        cursor=cursor,
        collection_revision=collection_revision,
    )
    if isinstance(view.entry_type, ExactType):
        final_select = sql.rsplit("FROM facts", maxsplit=1)[1]
        predicate = (
            "AND facts.target_kind = 'podcast'"
            if view.entry_type.value == "podcast"
            else "AND facts.target_kind = 'media' AND facts.media_kind = :entry_type"
        )
        assert predicate in final_select, f"{label}: exact-Type predicate missing from final SELECT"
        predicate_offset = final_select.index(predicate)
        assert predicate_offset < final_select.index("LIMIT :limit"), (
            f"{label}: exact-Type predicate must precede limit+1"
        )
        if cursor is not None:
            assert predicate_offset < final_select.index(":ks_"), (
                f"{label}: exact-Type predicate must precede the continuation keyset"
            )
        assert params["limit"] == _PAGE_LIMIT + 1, (
            f"{label}: service must fetch limit+1 after applying exact Type"
        )
    explain_sql = text(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}")
    # One warm-up execution before the measured EXPLAIN ANALYZE (spec: "after one
    # warm-up"); the capture call above already ran the query once too.
    db.execute(explain_sql, params).scalar_one()
    started = perf_counter()
    plan_json = db.execute(explain_sql, params).scalar_one()
    wall_ms = (perf_counter() - started) * 1000.0

    assert isinstance(plan_json, list) and plan_json
    evidence = _PlanEvidence(label, plan_json, total_media=total_media)
    # Emit evidence BEFORE asserting so a tripwire failure still records the row.
    print(
        f"  {label:<44} exec={evidence.execution_ms:8.2f}ms "
        f"plan={evidence.planning_ms:6.2f}ms wall={wall_ms:7.1f}ms "
        f"rows={evidence.rows:4d} sharedHit={evidence.shared_hit:6d} "
        f"sharedRead={evidence.shared_read:5d} workLoops={evidence.max_loops:5d} "
        f"(bound {evidence.loop_bound}) cachedReplayLoops={evidence.max_loops_cached}"
        + (f" hotLoopNodes={','.join(evidence.hot_loop_nodes)}" if evidence.hot_loop_nodes else "")
    )
    return evidence, page_info


class TestLibraryEntryPlanGate:
    """Local slice of the spec's blocking `EXPLAIN (ANALYZE, BUFFERS)` gate."""

    def test_view_plan_matrix_meets_local_budget(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        viewer_id = bootstrapped_user
        fixture = _seed_plan_fixture(db_session, viewer_id)

        assert (
            library_entries.count_default_root_inventory(
                db_session,
                viewer_id=viewer_id,
                library_id=fixture.default_library_id,
            )
            == fixture.default_all
        )

        print("\n[library-entry plan gate] fixture cardinalities:")
        print(f"  total media seeded ............ {fixture.total_media}")
        print(f"  Default AllItems(all) ......... {fixture.default_all}")
        print(f"  Default Unfiled(all) .......... {fixture.default_unfiled}")
        print(f"  Default InProgress ............ {fixture.default_in_progress}")
        print(f"  Named A AllItems(all) ......... {fixture.named_all}")
        print(f"  warm budget ................... {_WARM_BUDGET_MS:.0f} ms, limit {_PAGE_LIMIT}")
        print("[library-entry plan gate] per-case evidence:")

        default_id = fixture.default_library_id
        named_id = fixture.named_library_id

        # (label, library_id, view, continuation?) — continuation once per
        # projection family (AllItems / Unfiled / InProgress), on the sets sized
        # above the page limit.
        first_page_cases: list[tuple[str, UUID, LibraryEntryView, bool]] = [
            (
                "default AllItems(all) Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(), projection=AllItems("all"), entry_type=AllTypes()
                ),
                True,
            ),
            (
                "default AllItems(unfinished) Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(),
                    projection=AllItems("unfinished"),
                    entry_type=AllTypes(),
                ),
                False,
            ),
            (
                "default Unfiled(all) Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(), projection=Unfiled("all"), entry_type=AllTypes()
                ),
                True,
            ),
            (
                "default Unfiled(unfinished) Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(),
                    projection=Unfiled("unfinished"),
                    entry_type=AllTypes(),
                ),
                False,
            ),
            (
                "default InProgress Canonical",
                default_id,
                LibraryEntryView(order=Canonical(), projection=InProgress(), entry_type=AllTypes()),
                True,
            ),
            (
                "default AllItems(all) Title asc",
                default_id,
                LibraryEntryView(
                    order=Title("asc"), projection=AllItems("all"), entry_type=AllTypes()
                ),
                False,
            ),
            (
                "default AllItems(all) Added desc",
                default_id,
                LibraryEntryView(
                    order=Added("desc"), projection=AllItems("all"), entry_type=AllTypes()
                ),
                False,
            ),
            (
                "default Web articles Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(),
                    projection=AllItems("all"),
                    entry_type=ExactType(MediaKind.web_article),
                ),
                True,
            ),
            (
                "default Podcast shows Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(),
                    projection=AllItems("all"),
                    entry_type=ExactType("podcast"),
                ),
                False,
            ),
            (
                "default Podcast episodes Canonical",
                default_id,
                LibraryEntryView(
                    order=Canonical(),
                    projection=AllItems("all"),
                    entry_type=ExactType(MediaKind.podcast_episode),
                ),
                False,
            ),
            (
                "named AllItems(all) Canonical",
                named_id,
                LibraryEntryView(
                    order=Canonical(), projection=AllItems("all"), entry_type=AllTypes()
                ),
                False,
            ),
            (
                "named InProgress Canonical",
                named_id,
                LibraryEntryView(order=Canonical(), projection=InProgress(), entry_type=AllTypes()),
                False,
            ),
        ]

        evidence: list[_PlanEvidence] = []
        for label, library_id, view, want_continuation in first_page_cases:
            first_evidence, page_info = _run_case(
                db_session,
                label=label,
                viewer_id=viewer_id,
                library_id=library_id,
                view=view,
                cursor=None,
                collection_revision=None,
                total_media=fixture.total_media,
            )
            evidence.append(first_evidence)

            if want_continuation:
                next_cursor = getattr(page_info.next_cursor, "value", None)
                assert next_cursor is not None, (
                    f"{label}: expected a continuation cursor for a >page-limit set"
                )
                cont_evidence, _ = _run_case(
                    db_session,
                    label=f"{label} [page 2]",
                    viewer_id=viewer_id,
                    library_id=library_id,
                    view=view,
                    cursor=next_cursor,
                    collection_revision=page_info.collection_revision,
                    total_media=fixture.total_media,
                )
                evidence.append(cont_evidence)

        # Assert the gate over every recorded plan (evidence already printed).
        for ev in evidence:
            assert ev.execution_ms < _WARM_BUDGET_MS, (
                f"{ev.label}: execution {ev.execution_ms:.1f}ms exceeds "
                f"{_WARM_BUDGET_MS:.0f}ms warm budget"
            )
            assert not ev.external_sorts, (
                f"{ev.label}: disk-spill sort detected: {ev.external_sorts}"
            )
            assert ev.max_loops <= ev.loop_bound, (
                f"{ev.label}: a node's Actual Loops {ev.max_loops} exceeds the "
                f"candidate-correlation bound {ev.loop_bound} "
                f"(total media {fixture.total_media}) — investigate a "
                f"candidate-correlated nested loop; do NOT add an index without "
                f"amending the spec"
            )
