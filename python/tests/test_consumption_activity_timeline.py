from datetime import UTC, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus, UserMediaDeletion
from nexus.errors import InvalidRequestError
from nexus.services.consumption._activity_stats import (
    ActivityQuery,
    activity_totals_sql,
    device_breakdown_rows,
    local_days_sql,
    local_hours_sql,
    longest_session_row,
    require_bucket_ceiling,
    streaks_sql,
    timeline_rows_sql,
    top_media_rows,
)
from tests.factories import add_media_to_library, get_user_default_library

pytestmark = pytest.mark.integration


def test_hour_timeline_clips_and_conserves_progress(db_session: Session, bootstrapped_user) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Timeline",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    db_session.execute(
        text("""INSERT INTO consumption_activity_spans
            (id, user_id, media_id, modality, device_id, device_class, occurred_at, duration_ms,
             progress_start, progress_end, word_start, word_end, media_position_start_ms, media_position_end_ms)
            VALUES (:id, :user_id, :media_id, 'Reading', 'device', 'Desktop', :occurred_at, 2000,
                    NULL, NULL, 0, 10, NULL, NULL)"""),
        {
            "id": uuid4(),
            "user_id": bootstrapped_user,
            "media_id": media_id,
            "occurred_at": datetime(2026, 1, 1, 0, 59, 59, tzinfo=UTC),
        },
    )
    db_session.commit()
    rows = (
        db_session.execute(
            text(timeline_rows_sql("Hour")),
            {
                "viewer_id": bootstrapped_user,
                "start": datetime(2026, 1, 1, 0, 0, tzinfo=UTC),
                "end": datetime(2026, 1, 1, 2, 0, tzinfo=UTC),
                "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
                "time_zone": "UTC",
            },
        )
        .mappings()
        .all()
    )
    assert [row["active_ms"] for row in rows] == [1000, 1000]
    assert sum(row["active_ms"] for row in rows) == 2000
    assert sum(row["forward_word_position"] for row in rows) == 10
    assert sum(row["forward_media_position_ms"] for row in rows) == 0


@pytest.mark.parametrize(
    ("start", "end", "expected_hours"),
    [
        (datetime(2026, 3, 8, 8, tzinfo=UTC), datetime(2026, 3, 8, 11, tzinfo=UTC), [0, 1, 3]),
        (datetime(2026, 11, 1, 7, tzinfo=UTC), datetime(2026, 11, 1, 10, tzinfo=UTC), [0, 1, 1]),
    ],
)
def test_hour_timeline_preserves_dst_instants(
    db_session: Session,
    bootstrapped_user,
    start: datetime,
    end: datetime,
    expected_hours: list[int],
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="DST",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','device','Desktop',:s,10800000)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": start},
    )
    db_session.commit()
    rows = (
        db_session.execute(
            text(timeline_rows_sql("Hour")),
            {
                "viewer_id": bootstrapped_user,
                "start": start,
                "end": end,
                "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
                "time_zone": "America/Los_Angeles",
            },
        )
        .mappings()
        .all()
    )
    local = [row["bucket_start"].astimezone(ZoneInfo("America/Los_Angeles")) for row in rows]
    assert [value.hour for value in local] == expected_hours
    if expected_hours == [0, 1, 1]:
        assert local[1].utcoffset() != local[2].utcoffset()


def test_week_timeline_starts_on_local_monday(db_session: Session, bootstrapped_user) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Week",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    start = datetime(2026, 1, 7, 20, tzinfo=UTC)
    end = datetime(2026, 1, 8, 2, tzinfo=UTC)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','device','Desktop',:s,1000)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": start},
    )
    db_session.commit()
    row = (
        db_session.execute(
            text(timeline_rows_sql("Week")),
            {
                "viewer_id": bootstrapped_user,
                "start": start,
                "end": end,
                "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
                "time_zone": "America/Los_Angeles",
            },
        )
        .mappings()
        .one()
    )
    local = row["bucket_start"].astimezone(ZoneInfo("America/Los_Angeles"))
    assert local.weekday() == 0 and (local.hour, local.minute) == (0, 0)


@pytest.mark.parametrize(
    ("bucket", "start", "end", "occurred_at", "expected_local_start"),
    [
        (
            "Month",
            datetime(2026, 1, 1, tzinfo=UTC),
            datetime(2026, 4, 1, tzinfo=UTC),
            datetime(2026, 2, 15, 20, tzinfo=UTC),
            "2026-02-01T00:00:00-08:00",
        ),
        (
            "Year",
            datetime(2024, 1, 1, tzinfo=UTC),
            datetime(2027, 1, 1, tzinfo=UTC),
            datetime(2026, 7, 15, 20, tzinfo=UTC),
            "2026-01-01T00:00:00-08:00",
        ),
    ],
)
def test_calendar_timeline_bucket_boundaries(
    db_session: Session,
    bootstrapped_user,
    bucket: str,
    start: datetime,
    end: datetime,
    occurred_at: datetime,
    expected_local_start: str,
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title=f"{bucket} timeline",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans "
            "(id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) "
            "VALUES (:id,:u,:m,'Reading','device','Desktop',:s,1000)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": occurred_at},
    )
    db_session.commit()
    row = (
        db_session.execute(
            text(timeline_rows_sql(bucket)),
            {
                "viewer_id": bootstrapped_user,
                "start": start,
                "end": end,
                "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
                "time_zone": "America/Los_Angeles",
            },
        )
        .mappings()
        .one()
    )
    assert (
        row["bucket_start"].astimezone(ZoneInfo("America/Los_Angeles")).isoformat()
        == expected_local_start
    )
    assert row["active_ms"] == 1_000


def test_timeline_rebuckets_same_fact_for_requested_timezone(
    db_session: Session, bootstrapped_user
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Travel",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    occurred_at = datetime(2026, 1, 1, 1, tzinfo=UTC)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','device','Desktop',:s,1000)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": occurred_at},
    )
    db_session.commit()
    params = {
        "viewer_id": bootstrapped_user,
        "start": datetime(2025, 12, 31, tzinfo=UTC),
        "end": datetime(2026, 1, 2, tzinfo=UTC),
        "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
    }
    utc_row = (
        db_session.execute(text(timeline_rows_sql("Day")), params | {"time_zone": "UTC"})
        .mappings()
        .one()
    )
    los_angeles_row = (
        db_session.execute(
            text(timeline_rows_sql("Day")), params | {"time_zone": "America/Los_Angeles"}
        )
        .mappings()
        .one()
    )
    assert utc_row["bucket_start"].astimezone(ZoneInfo("UTC")).date().isoformat() == "2026-01-01"
    assert (
        los_angeles_row["bucket_start"]
        .astimezone(ZoneInfo("America/Los_Angeles"))
        .date()
        .isoformat()
        == "2025-12-31"
    )


def test_timeline_bucket_ceiling_rejects_instead_of_truncating(
    db_session: Session,
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    require_bucket_ceiling(
        db_session,
        bucket="Hour",
        start=start,
        end=start + timedelta(hours=400),
        time_zone="UTC",
    )
    with pytest.raises(InvalidRequestError, match="exceeds 400 buckets"):
        require_bucket_ceiling(
            db_session,
            bucket="Hour",
            start=start,
            end=start + timedelta(hours=401),
            time_zone="UTC",
        )


def test_totals_local_days_and_fallback_hours(db_session: Session, bootstrapped_user) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Totals",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    start = datetime(2026, 11, 1, 7, tzinfo=UTC)
    end = datetime(2026, 11, 1, 10, tzinfo=UTC)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms,word_start,word_end) VALUES (:id,:u,:m,'Reading','device','Desktop',:s,10800000,0,9)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": start},
    )
    db_session.commit()
    params = {
        "viewer_id": bootstrapped_user,
        "start": start,
        "end": end,
        "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
        "time_zone": "America/Los_Angeles",
    }
    totals = db_session.execute(text(activity_totals_sql()), params).mappings().one()
    hours = db_session.execute(text(local_hours_sql()), params).mappings().all()
    days = db_session.execute(text(local_days_sql()), params).mappings().all()
    assert (totals["active_ms"], totals["forward_word_position"]) == (10_800_000, 9)
    assert (
        len(hours) == 24
        and [row["hour"] for row in hours] == list(range(24))
        and hours[1]["active_ms"] == 7_200_000
    )
    assert [(row["local_date"].isoformat(), row["active_ms"]) for row in days] == [
        ("2026-11-01", 10_800_000)
    ]


def test_spring_forward_local_hours_keeps_the_missing_hour_as_zero(
    db_session: Session, bootstrapped_user
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Spring hours",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    start = datetime(2026, 3, 8, 8, tzinfo=UTC)
    end = datetime(2026, 3, 8, 11, tzinfo=UTC)
    db_session.execute(
        text(
            "INSERT INTO consumption_activity_spans "
            "(id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) "
            "VALUES (:id,:u,:m,'Reading','device','Desktop',:s,10800000)"
        ),
        {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": start},
    )
    db_session.commit()
    hours = (
        db_session.execute(
            text(local_hours_sql()),
            {
                "viewer_id": bootstrapped_user,
                "start": start,
                "end": end,
                "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
                "time_zone": "America/Los_Angeles",
            },
        )
        .mappings()
        .all()
    )
    assert [row["hour"] for row in hours] == list(range(24))
    assert hours[2]["active_ms"] == 0
    assert hours[0]["active_ms"] == 3_600_000
    assert hours[1]["active_ms"] == 3_600_000
    assert hours[3]["active_ms"] == 3_600_000


def test_streaks_obey_threshold_and_live_today_rule(db_session: Session, bootstrapped_user) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Streak",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    for day in (1, 2, 4):
        db_session.execute(
            text(
                "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','d','Desktop',:s,300000)"
            ),
            {
                "id": uuid4(),
                "u": bootstrapped_user,
                "m": media_id,
                "s": datetime(2026, 1, day, 12, tzinfo=UTC),
            },
        )
    db_session.commit()
    params = {
        "viewer_id": bootstrapped_user,
        "start": datetime(2026, 1, 1, tzinfo=UTC),
        "end": datetime(2026, 1, 5, tzinfo=UTC),
        "as_of_created_at": datetime(2027, 1, 1, tzinfo=UTC),
        "time_zone": "UTC",
        "is_live": True,
        "today_local": datetime(2026, 1, 5).date(),
    }
    assert dict(db_session.execute(text(streaks_sql()), params).mappings().one()) == {
        "longest_streak": 2,
        "ending_streak": 1,
    }


def test_longest_session_is_not_newest(db_session: Session, bootstrapped_user) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Longest",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    for when, duration in (
        (datetime(2026, 1, 1, 10, tzinfo=UTC), 600000),
        (datetime(2026, 1, 1, 11, tzinfo=UTC), 1000),
    ):
        db_session.execute(
            text(
                "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','d','Desktop',:s,:duration)"
            ),
            {"id": uuid4(), "u": bootstrapped_user, "m": media_id, "s": when, "duration": duration},
        )
    db_session.commit()
    row = longest_session_row(
        db_session,
        viewer_id=bootstrapped_user,
        query=ActivityQuery(
            start=datetime(2026, 1, 1, 9, tzinfo=UTC),
            end=datetime(2026, 1, 1, 12, tzinfo=UTC),
            time_zone="UTC",
        ),
        as_of=datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert (
        row is not None
        and row["active_ms"] == 600000
        and row["session_start"] == datetime(2026, 1, 1, 10, tzinfo=UTC)
    )


def test_top_media_other_and_visibility_revocation(db_session: Session, bootstrapped_user) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_ids = []
    for value in range(27):
        media_id = uuid4()
        media_ids.append(media_id)
        db_session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=f"Media {value:02}",
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        db_session.flush()
        add_media_to_library(db_session, library_id, media_id)
        db_session.execute(
            text(
                "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading','d','Desktop',:s,:duration)"
            ),
            {
                "id": uuid4(),
                "u": bootstrapped_user,
                "m": media_id,
                "s": datetime(2026, 1, 1, tzinfo=UTC),
                "duration": (value + 1) * 1000,
            },
        )
    db_session.commit()
    query = ActivityQuery(
        start=datetime(2026, 1, 1, tzinfo=UTC),
        end=datetime(2026, 1, 2, tzinfo=UTC),
        time_zone="UTC",
    )
    rows, other = top_media_rows(
        db_session, viewer_id=bootstrapped_user, query=query, as_of=datetime(2027, 1, 1, tzinfo=UTC)
    )
    assert len(rows) == 25 and other == 3000 and rows[0]["active_ms"] == 27000
    db_session.add(UserMediaDeletion(user_id=bootstrapped_user, media_id=media_ids[26]))
    db_session.commit()
    rows, other = top_media_rows(
        db_session, viewer_id=bootstrapped_user, query=query, as_of=datetime(2027, 1, 1, tzinfo=UTC)
    )
    assert all(row["media_id"] != media_ids[26] for row in rows) and all(
        row["title"] != "Media 26" for row in rows
    )


def test_device_breakdown_is_visible_and_filter_scoped(
    db_session: Session, bootstrapped_user
) -> None:
    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Devices",
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    db_session.flush()
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    add_media_to_library(db_session, library_id, media_id)
    for device, klass, duration in (("a", "Desktop", 1000), ("b", "Mobile", 2000)):
        db_session.execute(
            text(
                "INSERT INTO consumption_activity_spans (id,user_id,media_id,modality,device_id,device_class,occurred_at,duration_ms) VALUES (:id,:u,:m,'Reading',:d,:c,:s,:duration)"
            ),
            {
                "id": uuid4(),
                "u": bootstrapped_user,
                "m": media_id,
                "d": device,
                "c": klass,
                "s": datetime(2026, 1, 1, tzinfo=UTC),
                "duration": duration,
            },
        )
    db_session.commit()
    base = dict(
        start=datetime(2026, 1, 1, tzinfo=UTC),
        end=datetime(2026, 1, 2, tzinfo=UTC),
        time_zone="UTC",
    )
    rows = device_breakdown_rows(
        db_session,
        viewer_id=bootstrapped_user,
        query=ActivityQuery(**base),
        as_of=datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert [(row["device_id"], row["active_ms"], row["device_classes"]) for row in rows] == [
        ("a", 1000, ["Desktop"]),
        ("b", 2000, ["Mobile"]),
    ]
    rows = device_breakdown_rows(
        db_session,
        viewer_id=bootstrapped_user,
        query=ActivityQuery(**base, device_id="b"),
        as_of=datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert [(row["device_id"], row["active_ms"]) for row in rows] == [("b", 2000)]
