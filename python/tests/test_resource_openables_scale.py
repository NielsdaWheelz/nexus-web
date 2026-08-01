"""Opt-in operational scale gate for Switchboard openable-resource search.

Run only this gate with:

    NEXUS_RUN_OPENABLES_SCALE_GATE=1 \
      .venv/bin/pytest tests/test_resource_openables_scale.py -s

The fixture is intentionally generated inside the test transaction. Routine
test runs collect this contract but skip its expensive 110 service calls and
110,000-row fixture.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from math import ceil
from statistics import fmean
from time import perf_counter_ns
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock
from nexus.schemas.resource_openables import ResourceOpenableSearchRequest
from nexus.services.resource_items import openables
from nexus.services.resource_items.openables import search_openable_resources

pytestmark = [pytest.mark.integration, pytest.mark.slow]

_RUN_ENV = "NEXUS_RUN_OPENABLES_SCALE_GATE"
_OWNED_RESOURCE_COUNT = 10_000
_INDEXED_CHUNK_COUNT = 100_000
_WARMUP_QUERY_COUNT = 10
_MEASURED_QUERY_COUNT = 100
_P95_BUDGET_MS = 250.0
_MAX_SQL_STATEMENTS_PER_QUERY = 16
_NOTE_SUBSTRING_INDEX = "ix_note_blocks_body_text_trgm"


def _plan_index_names(plan: object) -> set[str]:
    if isinstance(plan, list):
        return {name for item in plan for name in _plan_index_names(item)}
    if not isinstance(plan, dict):
        return set()
    names = {value for key, value in plan.items() if key == "Index Name" and isinstance(value, str)}
    return names | {name for value in plan.values() for name in _plan_index_names(value)}


def _seed_scale_fixture(db: Session, *, viewer_id: UUID) -> tuple[int, int]:
    db.execute(
        text(
            """
            INSERT INTO note_blocks (id, user_id, body_pm_json, body_text)
            SELECT
                gen_random_uuid(),
                :viewer_id,
                '{"type":"doc","content":[]}'::jsonb,
                'nexus scale resource '
                    || lpad(series::text, 5, '0')
                    || ' cohort '
                    || (series % 50)::text
            FROM generate_series(1, :resource_count) AS series
            """
        ),
        {
            "viewer_id": viewer_id,
            "resource_count": _OWNED_RESOURCE_COUNT,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO content_index_states (owner_kind, owner_id, revision, status)
            SELECT 'note_block', id, 1, 'ready'
            FROM note_blocks
            WHERE user_id = :viewer_id
            """
        ),
        {"viewer_id": viewer_id},
    )
    chunks_per_resource = _INDEXED_CHUNK_COUNT // _OWNED_RESOURCE_COUNT
    db.execute(
        text(
            """
            INSERT INTO content_chunks (
                owner_kind,
                owner_id,
                chunk_idx,
                source_kind,
                chunk_text,
                token_count,
                heading_path,
                summary_locator
            )
            SELECT
                'note_block',
                note.id,
                chunk_idx,
                'note',
                note.body_text || ' chunk ' || chunk_idx::text,
                8,
                '[]'::jsonb,
                '{}'::jsonb
            FROM note_blocks note
            CROSS JOIN generate_series(0, :last_chunk_index) AS chunk_idx
            WHERE note.user_id = :viewer_id
            """
        ),
        {
            "viewer_id": viewer_id,
            "last_chunk_index": chunks_per_resource - 1,
        },
    )

    owned_resources = db.scalar(
        select(func.count()).select_from(NoteBlock).where(NoteBlock.user_id == viewer_id)
    )
    indexed_chunks = db.scalar(
        text(
            """
            SELECT count(*)
            FROM content_chunks chunk
            JOIN note_blocks note
              ON chunk.owner_kind = 'note_block'
             AND chunk.owner_id = note.id
            JOIN content_index_states state
              ON state.owner_kind = chunk.owner_kind
             AND state.owner_id = chunk.owner_id
             AND state.status = 'ready'
            WHERE note.user_id = :viewer_id
            """
        ),
        {"viewer_id": viewer_id},
    )
    assert isinstance(owned_resources, int)
    assert isinstance(indexed_chunks, int)
    return owned_resources, indexed_chunks


def _request(index: int) -> ResourceOpenableSearchRequest:
    query = f"openables-missing-{index}" if index % 2 == 0 else f"cohort {index % 50}"
    return ResourceOpenableSearchRequest.model_validate(
        {
            "q": query,
            "schemes": {"kind": "Absent"},
        }
    )


def _p95(samples: list[float]) -> float:
    assert samples
    return sorted(samples)[ceil(len(samples) * 0.95) - 1]


def test_openables_meets_warm_real_backend_scale_gate(
    db_session: Session,
    bootstrapped_user: UUID,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if os.environ.get(_RUN_ENV) != "1":
        pytest.skip(f"set {_RUN_ENV}=1 to run the 110,000-row operational scale gate")

    owned_resources, indexed_chunks = _seed_scale_fixture(
        db_session,
        viewer_id=bootstrapped_user,
    )
    assert owned_resources >= _OWNED_RESOURCE_COUNT
    assert indexed_chunks >= _INDEXED_CHUNK_COUNT

    candidate_passes = 0
    actual_reference_candidates = openables.reference_candidates

    def tracked_reference_candidates(*args: Any, **kwargs: Any):
        nonlocal candidate_passes
        candidate_passes += 1
        return actual_reference_candidates(*args, **kwargs)

    monkeypatch.setattr(openables, "reference_candidates", tracked_reference_candidates)

    for index in range(_WARMUP_QUERY_COUNT):
        response = search_openable_resources(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(index),
        )
        assert bool(response.items) is (index % 2 == 1)

    candidate_passes = 0
    statement_counts: list[int] = []
    captured_candidate: tuple[str, Mapping[str, object]] | None = None
    first_query_sql_ms: list[tuple[float, str]] = []
    statement_started_ns: dict[int, int] = {}

    def observe(
        _connection: object,
        _cursor: object,
        statement: str,
        parameters: object,
        context: object,
        _executemany: bool,
    ) -> None:
        nonlocal captured_candidate
        statement_counts[-1] += 1
        statement_started_ns[id(context)] = perf_counter_ns()
        if (
            captured_candidate is None
            and "FROM note_blocks nb" in statement
            and "ORDER BY score DESC" in statement
            and isinstance(parameters, Mapping)
        ):
            captured_candidate = (statement, dict(parameters))

    def record_statement_duration(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        context: object,
        _executemany: bool,
    ) -> None:
        started_ns = statement_started_ns.pop(id(context), None)
        if len(statement_counts) == 1 and isinstance(started_ns, int):
            first_query_sql_ms.append(
                (
                    (perf_counter_ns() - started_ns) / 1_000_000,
                    " ".join(statement.split())[:240],
                )
            )

    bind = db_session.get_bind()
    event.listen(bind, "before_cursor_execute", observe)
    event.listen(bind, "after_cursor_execute", record_statement_duration)
    durations_ms: list[float] = []
    matching_durations_ms: list[float] = []
    missing_durations_ms: list[float] = []
    try:
        for index in range(_MEASURED_QUERY_COUNT):
            statement_counts.append(0)
            started_ns = perf_counter_ns()
            response = search_openable_resources(
                db_session,
                viewer_id=bootstrapped_user,
                request=_request(index),
            )
            duration_ms = (perf_counter_ns() - started_ns) / 1_000_000
            durations_ms.append(duration_ms)
            if index % 2 == 0:
                missing_durations_ms.append(duration_ms)
                assert not response.items
            else:
                matching_durations_ms.append(duration_ms)
                assert response.items
    finally:
        event.remove(bind, "before_cursor_execute", observe)
        event.remove(bind, "after_cursor_execute", record_statement_duration)

    latency_p95_ms = _p95(durations_ms)
    missing_statement_counts = statement_counts[::2]
    matching_statement_counts = statement_counts[1::2]

    explain: object | None = None
    if captured_candidate is not None:
        candidate_sql, candidate_parameters = captured_candidate
        explain = (
            db_session.connection()
            .exec_driver_sql(
                f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {candidate_sql}",
                candidate_parameters,
            )
            .scalar_one()
        )

    report = {
        "candidate_passes": candidate_passes,
        "explain_analyze_buffers": (explain[0] if isinstance(explain, list) and explain else None),
        "first_query_slowest_sql_ms": [
            {"duration_ms": duration_ms, "statement": statement}
            for duration_ms, statement in sorted(first_query_sql_ms, reverse=True)[:5]
        ],
        "fixture": {
            "indexed_chunks": indexed_chunks,
            "owned_resources": owned_resources,
        },
        "latency_ms": {
            "max": max(durations_ms),
            "mean": fmean(durations_ms),
            "min": min(durations_ms),
            "p95": latency_p95_ms,
            "matching_p95": _p95(matching_durations_ms),
            "missing_p95": _p95(missing_durations_ms),
        },
        "measured_queries": len(durations_ms),
        "sql_statements_per_query": {
            "matching": matching_statement_counts[0],
            "missing": missing_statement_counts[0],
        },
        "warmup_queries": _WARMUP_QUERY_COUNT,
    }
    print(f"OPENABLES_SCALE_REPORT={json.dumps(report, sort_keys=True, default=str)}")

    assert candidate_passes == _MEASURED_QUERY_COUNT
    assert len(statement_counts) == _MEASURED_QUERY_COUNT
    assert max(statement_counts) <= _MAX_SQL_STATEMENTS_PER_QUERY
    assert set(missing_statement_counts) == {1}
    assert set(matching_statement_counts) == {3}
    assert latency_p95_ms < _P95_BUDGET_MS
    assert isinstance(explain, list) and explain
    assert explain[0]["Plan"]["Actual Loops"] >= 1
    assert explain[0]["Execution Time"] >= 0
    assert _NOTE_SUBSTRING_INDEX in _plan_index_names(explain[0]["Plan"])
