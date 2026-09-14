"""Nexus selection history: which in-app destinations a selection may name."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.nexus_history import NexusHistoryQuery, NexusSelectionRecordRequest
from nexus.services.nexus_history import (
    MAX_NEXUS_RECENT_TARGETS,
    get_history_for_viewer,
    record_selection_for_viewer,
)
from tests.testkit.auth import UserRecord


def _record(db: Session, viewer_id: UUID, href: str, label: str) -> None:
    record_selection_for_viewer(
        db,
        viewer_id,
        request=NexusSelectionRecordRequest(
            client_mutation_id=str(uuid4()),
            query="imports",
            target_href=href,
            label_snapshot=label,
            source="Static",
        ),
    )


def test_imports_is_a_recordable_nexus_destination_and_an_unknown_section_is_not(
    db_session: Session, test_user: UserRecord
) -> None:
    """Nexus resolves the same destination the rail does, so the pane route is
    recordable history; a section that is not a destination stays refused."""
    _record(db_session, test_user.id, "/imports?view=NeedsAttention", "Imports")

    recorded = get_history_for_viewer(
        db_session,
        test_user.id,
        request=NexusHistoryQuery(query="imports", target_hrefs=["/imports?view=NeedsAttention"]),
    )
    assert [row.target_href for row in recorded.recent] == ["/imports?view=NeedsAttention"], (
        "an Imports selection must be recorded with the pane state it named: "
        f"{[row.target_href for row in recorded.recent]!r}"
    )

    with pytest.raises(ApiError) as refused:
        _record(db_session, test_user.id, "/import-inbox", "Import inbox")
    assert refused.value.code is ApiErrorCode.E_INVALID_REQUEST, (
        f"/import-inbox is not a Nexus destination and must be refused, got {refused.value.code}"
    )


def test_history_read_scores_the_whole_candidate_union_nexus_sends(
    db_session: Session, test_user: UserRecord
) -> None:
    """Nexus scores its complete displayed union: every destination plus the
    hrefs of its open panes. Every destination must be recordable history, and a
    pane href Nexus cannot journal must cost nothing — an unknown candidate has
    no history, which is no score, not a malformed command."""
    import json
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).parents[3] / "testdata/contracts/nexus-history.json").read_text()
    )
    destinations: list[str] = fixture["destinationHrefs"]
    for href in destinations:
        _record(db_session, test_user.id, href, href)

    pane_hrefs = [
        f"/artifacts/{uuid4()}",
        "/conversations/new",
        "/podcasts/subscriptions",
        f"/media/{uuid4()}",
    ]
    result = get_history_for_viewer(
        db_session,
        test_user.id,
        request=NexusHistoryQuery(query="imports", target_hrefs=[*destinations, *pane_hrefs]),
    )
    assert set(result.frecency_by_href) == set(destinations), (
        "every destination Nexus displays must be recordable, scoreable history; "
        f"unscored: {sorted(set(destinations) - set(result.frecency_by_href))!r}"
    )
    assert len(result.recent) == MAX_NEXUS_RECENT_TARGETS
    assert {row.target_href for row in result.recent} <= set(destinations)


def test_history_scores_only_requested_candidates_with_complete_distinct_recents(
    db_session: Session, test_user: UserRecord
) -> None:
    from datetime import timedelta

    from sqlalchemy import func, select

    from nexus.db.models import NexusUsage

    now = db_session.scalar(select(func.now()))
    assert now is not None
    media_hrefs = [f"/media/{uuid4()}" for _ in range(8)]
    for i, href in enumerate(media_hrefs):
        for query in ("", "reader"):
            db_session.add(
                NexusUsage(
                    id=UUID(int=2 * i + (2 if query else 1)),
                    user_id=test_user.id,
                    query_normalized=query,
                    target_href=href,
                    label_snapshot=f"{i}:{query or 'blank'}",
                    source="Search",
                    use_count=2,
                    visit_timestamps=[now.isoformat()],
                    last_used_at=now - timedelta(minutes=i),
                )
            )
    db_session.flush()
    expected_recent = [(href, f"{i}:reader") for i, href in enumerate(media_hrefs[:5])]
    requested = media_hrefs[-1] + "?offset=99"
    result = get_history_for_viewer(
        db_session,
        test_user.id,
        request=NexusHistoryQuery(query="reader", target_hrefs=[requested]),
    )
    assert [(row.target_href, row.label_snapshot) for row in result.recent] == expected_recent
    assert result.frecency_by_href == {requested: round(270 / 370, 6)}, (
        "query-specific and target-only scores must retain their original weights without unrelated history"
    )
    empty = get_history_for_viewer(
        db_session,
        test_user.id,
        request=NexusHistoryQuery(query=None, target_hrefs=[]),
    )
    assert empty.recent == result.recent
    assert empty.frecency_by_href == {}


def test_history_growth_keeps_database_results_bounded(
    db_session: Session, test_user: UserRecord
) -> None:
    """Observe real driver results and plans as retained history grows 100-fold.

    These sizes qualify a growth profile, not a product retention ceiling. The
    newly inserted rows are warm; this does not claim cold-cache or API capacity.
    """
    import json
    import os
    import time
    from pathlib import Path

    from sqlalchemy import event, text

    from nexus.schemas.nexus_history import MAX_NEXUS_HISTORY_TARGETS
    from tests.testkit.unreachable_state import seed_nexus_history_growth

    targets = [f"/media/{UUID(int=i + 1)}" for i in range(MAX_NEXUS_HISTORY_TARGETS)]
    expected_recent = [(targets[i], f"target-{i}:reader") for i in range(5)]
    expected_scores = dict.fromkeys(targets, round(270 / 370, 6))
    request = NexusHistoryQuery(query="reader", target_hrefs=targets)
    connection = db_session.connection()
    observations = []
    statements = []

    def observe_driver_result(_connection, cursor, statement, parameters, _context, _many):
        if "FROM nexus_usages" in statement:
            statements.append((statement, dict(parameters), cursor.rowcount))

    first = 0
    for row_count in (1_000, 100_000):
        recipe_sha256 = seed_nexus_history_growth(
            db_session, test_user.id, first=first, last=row_count - 1
        )
        first = row_count
        db_session.execute(text("ANALYZE nexus_usages"))
        statements.clear()
        event.listen(connection, "after_cursor_execute", observe_driver_result)
        try:
            started = time.monotonic()
            result = get_history_for_viewer(db_session, test_user.id, request=request)
            seconds = time.monotonic() - started
        finally:
            event.remove(connection, "after_cursor_execute", observe_driver_result)
        assert [(row.target_href, row.label_snapshot) for row in result.recent] == expected_recent
        assert result.frecency_by_href == expected_scores
        assert statements, "history proof observed no real database result"
        returned_rows = [rows for _sql, _params, rows in statements]
        assert all(rows >= 0 for rows in returned_rows), "driver did not report materialized rows"
        assert sum(returned_rows) <= 5 + 2 * len(targets), (
            "history materialized unrelated retained rows",
            row_count,
            returned_rows,
        )
        plans = [
            connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params
            ).scalar_one()
            for sql, params, _rows in statements
        ]
        observations.append(
            {
                "retained_rows": row_count,
                "returned_rows": returned_rows,
                "seconds": seconds,
                "response_bytes": len(result.model_dump_json().encode()),
                "plans": plans,
            }
        )
    receipt = {
        "scope": "real service/driver; newly inserted warm history; not API/cold-cache capacity",
        "recipe_sha256": recipe_sha256,
        "candidate_count": len(targets),
        "observations": observations,
    }
    destination = Path(__file__).parents[3] / "test-results/runs" / os.environ["NEXUS_TEST_RUN_ID"]
    (destination / "nexus-history-growth.json").write_text(json.dumps(receipt) + "\n")
    for observation in observations:
        pending = [entry["Plan"] for plan in observation["plans"] for entry in plan]
        while pending:
            node = pending.pop()
            if node["Node Type"] == "Sort":
                assert node["Actual Rows"] <= 5, (
                    "history sorted unrelated retained rows",
                    observation["retained_rows"],
                    node,
                )
            pending.extend(node.get("Plans", []))


def test_history_recency_preserves_latest_source_across_repeated_target_growth(
    db_session: Session, test_user: UserRecord
) -> None:
    """A long newest-target prefix must not hide older distinct recents."""
    import json
    import os
    import time
    from pathlib import Path

    from sqlalchemy import event, text

    from tests.testkit.unreachable_state import seed_nexus_history_growth

    repeated = f"/media/{UUID(int=1)}"
    others = [f"/media/{UUID(int=i + 2)}" for i in range(5)]
    connection = db_session.connection()
    statements = []

    def observe_driver_result(_connection, cursor, statement, parameters, _context, _many):
        if "FROM nexus_usages" in statement:
            statements.append((statement, dict(parameters), cursor.rowcount))

    observations = []
    first = 0
    for count in (1_000, 100_000):
        recipe_sha256 = seed_nexus_history_growth(
            db_session, test_user.id, first=first, last=count - 1, repeated_target=True
        )
        first = count
        db_session.execute(text("ANALYZE nexus_usages"))
        statements.clear()
        event.listen(connection, "after_cursor_execute", observe_driver_result)
        try:
            started = time.monotonic()
            result = get_history_for_viewer(
                db_session, test_user.id, request=NexusHistoryQuery(query=None, target_hrefs=[])
            )
            seconds = time.monotonic() - started
        finally:
            event.remove(connection, "after_cursor_execute", observe_driver_result)
        assert [(row.target_href, row.label_snapshot, row.source) for row in result.recent] == [
            (repeated, f"repeat-{count - 1}", "Oracle"),
            *(
                (href, f"other-{index}:reader", "Workspace")
                for index, href in enumerate(others[:4])
            ),
        ]
        assert result.frecency_by_href == {}
        assert statements and sum(rows for _sql, _params, rows in statements) == 5
        assert all(rows >= 0 for _sql, _params, rows in statements)
        observations.append(
            {
                "repeated_rows": count,
                "other_rows": 10,
                "seconds": seconds,
                "plans": [
                    connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params
                    ).scalar_one()
                    for sql, params, _rows in statements
                ],
            }
        )
    receipt = {
        "scope": "real warm service/driver; repeated target; not cold-cache or API capacity",
        "recipe_sha256": recipe_sha256,
        "observations": observations,
    }
    destination = Path(__file__).parents[3] / "test-results/runs" / os.environ["NEXUS_TEST_RUN_ID"]
    (destination / "nexus-history-repeated-target.json").write_text(json.dumps(receipt) + "\n")


def test_history_input_contract_covers_the_finite_candidate_union() -> None:
    import json
    from pathlib import Path

    from pydantic import ValidationError

    from nexus.schemas.nexus_history import MAX_NEXUS_HISTORY_TARGETS
    from nexus.services.nexus_history import MAX_NEXUS_RECENT_TARGETS
    from nexus.services.resource_items.openables import OPENABLE_SEARCH_RESULT_LIMIT

    fixture = json.loads(
        (Path(__file__).parents[3] / "testdata/contracts/nexus-history.json").read_text()
    )
    assert fixture["sourceMaxima"]["openables"] == OPENABLE_SEARCH_RESULT_LIMIT
    assert fixture["sourceMaxima"]["recents"] == MAX_NEXUS_RECENT_TARGETS
    assert (
        sum(fixture["sourceMaxima"].values()) == MAX_NEXUS_HISTORY_TARGETS == fixture["maxTargets"]
    )
    hrefs = [f"/media/{uuid4()}" for _ in range(fixture["maxTargets"])]
    request = NexusHistoryQuery(query="🧠" * fixture["maxQueryCodePoints"], target_hrefs=hrefs)
    assert request.target_hrefs == hrefs
    with pytest.raises(ValidationError):
        NexusHistoryQuery(query=None, target_hrefs=[*hrefs, "/imports"])
    with pytest.raises(ValidationError):
        NexusHistoryQuery(query="🧠" * (fixture["maxQueryCodePoints"] + 1), target_hrefs=[])
    with pytest.raises(ValidationError):
        NexusHistoryQuery(query=None, target_hrefs=["x" * (fixture["maxHrefCodePoints"] + 1)])
    assert len(fixture["destinationHrefs"]) == fixture["sourceMaxima"]["destinations"]
    label = "\U00010000" * fixture["maxLabelCodePoints"]
    recorded = NexusSelectionRecordRequest(
        client_mutation_id="history-contract",
        target_href="/libraries",
        label_snapshot=label,
        source="Static",
    )
    assert recorded.label_snapshot == label, (
        "the label snapshot bound must count unicode code points, not bytes"
    )
    with pytest.raises(ValidationError):
        NexusSelectionRecordRequest(
            client_mutation_id="history-contract",
            target_href="/libraries",
            label_snapshot=label + "\U00010000",
            source="Static",
        )
