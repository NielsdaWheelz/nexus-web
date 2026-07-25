"""Operational guards for Consumption Activity's one-user fact reads."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from time import perf_counter
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.ops.consumption_activity_counts import (
    ACTIVITY_REPLAY_REVIEW_THRESHOLD,
    ACTIVITY_SPAN_REVIEW_THRESHOLD,
    ConsumptionActivityCounts,
    read_global_counts,
    report_payload,
)
from nexus.services.consumption import _activity_stats, service
from nexus.services.consumption._activity_stats import ActivityQuery
from tests.factories import add_media_to_library, get_user_default_library

pytestmark = pytest.mark.integration

_ONE_USER_STATS_BUDGET_SECONDS = service.CONSUMPTION_STATS_LATENCY_BUDGET_MS / 1_000


def _visible_media(db: Session, user_id: UUID) -> UUID:
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Operations fixture",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    db.flush()
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    add_media_to_library(db, library_id, media_id)
    return media_id


def _seed_modest_one_user_fixture(db: Session, user_id: UUID) -> tuple[ActivityQuery, UUID]:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=2)
    media_id = _visible_media(db, user_id)
    db.execute(
        text(
            """INSERT INTO consumption_activity_spans
                (id, user_id, media_id, modality, device_id, device_class, occurred_at, duration_ms,
                 progress_start, progress_end, word_start, word_end)
                VALUES (:id, :user_id, :media_id, 'Reading', 'ops-private-device', 'Desktop',
                        :occurred_at, 10000, :progress_start, :progress_end, :word_start, :word_end)"""
        ),
        [
            {
                "id": uuid4(),
                "user_id": user_id,
                "media_id": media_id,
                "occurred_at": start + timedelta(minutes=index * 2),
                "progress_start": index / 96,
                "progress_end": (index + 1) / 96,
                "word_start": index * 10,
                "word_end": (index + 1) * 10,
            }
            for index in range(96)
        ],
    )
    db.execute(
        text(
            """INSERT INTO consumption_completion_facts
                (id, user_id, media_id, modality, created_at)
                VALUES (:id, :user_id, :media_id, 'Reading', :created_at)"""
        ),
        {"id": uuid4(), "user_id": user_id, "media_id": media_id, "created_at": start},
    )
    db.commit()
    return ActivityQuery(start=start, end=end, time_zone="UTC"), media_id


def _assert_explain_analyze(db: Session, sql: str, params: dict[str, object]) -> None:
    result = db.execute(text(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}"), params).scalar_one()
    assert isinstance(result, list) and result
    assert result[0]["Plan"]["Actual Loops"] >= 1
    assert result[0]["Execution Time"] >= 0


def test_global_count_report_is_read_only_and_thresholds_are_advisory(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    before = read_global_counts(db_session)
    media_id = _visible_media(db_session, bootstrapped_user)
    db_session.execute(
        text(
            """INSERT INTO consumption_activity_spans
                (id, user_id, media_id, modality, device_id, device_class, occurred_at, duration_ms)
                VALUES (:id, :user_id, :media_id, 'Reading', 'ops', 'Desktop', now(), 1)"""
        ),
        {"id": uuid4(), "user_id": bootstrapped_user, "media_id": media_id},
    )
    db_session.execute(
        text(
            """INSERT INTO consumption_completion_facts
                (id, user_id, media_id, modality)
                VALUES (:id, :user_id, :media_id, 'Reading')"""
        ),
        {"id": uuid4(), "user_id": bootstrapped_user, "media_id": media_id},
    )
    db_session.execute(
        text(
            """INSERT INTO resource_mutations
                (id, user_id, mutation_scope, client_mutation_id, request_hash, changed_lanes, response_json)
                VALUES (:id, :user_id, 'Consumption.Activity', :client_mutation_id, :request_hash,
                        '{}'::jsonb, '{}'::jsonb)"""
        ),
        {
            "id": uuid4(),
            "user_id": bootstrapped_user,
            "client_mutation_id": f"ops-{uuid4()}",
            "request_hash": "0" * 64,
        },
    )
    db_session.commit()

    after = read_global_counts(db_session)
    assert after.activity_spans == before.activity_spans + 1
    assert after.completion_facts == before.completion_facts + 1
    assert after.activity_replays == before.activity_replays + 1
    report = report_payload(after)
    assert report["review_thresholds"] == {
        "activity_spans": ACTIVITY_SPAN_REVIEW_THRESHOLD,
        "activity_replays": ACTIVITY_REPLAY_REVIEW_THRESHOLD,
    }
    assert report["review_recommended"] == {
        "activity_spans": after.activity_spans >= ACTIVITY_SPAN_REVIEW_THRESHOLD,
        "activity_replays": after.activity_replays >= ACTIVITY_REPLAY_REVIEW_THRESHOLD,
    }
    assert report_payload(
        ConsumptionActivityCounts(
            activity_spans=ACTIVITY_SPAN_REVIEW_THRESHOLD,
            completion_facts=0,
            activity_replays=ACTIVITY_REPLAY_REVIEW_THRESHOLD,
        )
    )["review_recommended"] == {"activity_spans": True, "activity_replays": True}


def test_principal_activity_queries_explain_and_one_user_stats_meet_budget(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    query, _media_id = _seed_modest_one_user_fixture(db_session, bootstrapped_user)
    as_of = _activity_stats.as_of_created_at(db_session)
    params = _activity_stats._activity_params(  # noqa: SLF001 - contract-level query audit
        viewer_id=bootstrapped_user, query=query, as_of=as_of
    )

    timeline_sql, timeline_filters = _activity_stats._filtered_sql(  # noqa: SLF001
        _activity_stats.timeline_rows_sql("Day"), query
    )
    _assert_explain_analyze(db_session, timeline_sql, params | timeline_filters)

    session_relation, session_filters = _activity_stats._filtered_sql(  # noqa: SLF001
        _activity_stats.sessionized_spans_sql(), query
    )
    session_sql = f"""
        WITH session_spans AS ({session_relation}), sessions AS (
            SELECT media_id, modality, device_id, island
            FROM session_spans
            GROUP BY media_id, modality, device_id, island
        )
        SELECT * FROM sessions
    """
    _assert_explain_analyze(
        db_session,
        session_sql,
        params
        | {
            "context_start": query.start
            - timedelta(milliseconds=_activity_stats.ACTIVITY_SESSION_GAP_MS),
            "context_end": query.end
            + timedelta(milliseconds=_activity_stats.ACTIVITY_SESSION_GAP_MS),
        }
        | session_filters,
    )

    completion_sql, completion_filters = _activity_stats._visible_completion_facts_sql(  # noqa: SLF001
        query
    )
    _assert_explain_analyze(
        db_session,
        completion_sql,
        {
            "viewer_id": bootstrapped_user,
            "start": query.start,
            "end": query.end,
            "as_of_created_at": as_of,
            "time_zone": query.time_zone,
        }
        | completion_filters,
    )

    # Warm the connection and statement caches before the user-facing budget.
    service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        bucket="Day",
        current_device_id="current-device",
    )
    started = perf_counter()
    stats = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        bucket="Day",
        current_device_id="current-device",
    )
    assert perf_counter() - started < _ONE_USER_STATS_BUDGET_SECONDS
    assert stats.activity.totals.active_ms == 960_000
    assert stats.completion.total == 1
