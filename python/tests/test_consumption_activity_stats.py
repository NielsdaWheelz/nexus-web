"""Facade-level Postgres contracts for Consumption activity statistics."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Highlight,
    Media,
    MediaKind,
    NoteBlock,
    ProcessingStatus,
    UserMediaDeletion,
)
from nexus.errors import InvalidRequestError
from nexus.schemas.presence import Present
from nexus.schemas.resource_graph import CreateLinkRequest
from nexus.services.consumption import service
from nexus.services.consumption._activity_stats import ActivityQuery
from nexus.services.resource_graph import user_relations
from tests.factories import (
    add_media_to_library,
    add_test_podcast_episode_identity,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def _media(
    db: Session, user_id: UUID, *, title: str, kind: str = MediaKind.web_article.value
) -> UUID:
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=kind,
            title=title,
            canonical_source_url=f"https://example.com/{media_id}",
            processing_status=ProcessingStatus.ready_for_reading,
        )
    )
    db.flush()
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    add_media_to_library(db, library_id, media_id)
    return media_id


def _span(
    db: Session,
    *,
    user_id: UUID,
    media_id: UUID,
    occurred_at: datetime,
    duration_ms: int,
    device_id: str = "private-device",
    progress_start: float | None = None,
    progress_end: float | None = None,
    word_start: int | None = None,
    word_end: int | None = None,
) -> None:
    db.execute(
        text(
            """INSERT INTO consumption_activity_spans
                (id, user_id, media_id, modality, device_id, device_class, occurred_at, duration_ms,
                 progress_start, progress_end, word_start, word_end)
                VALUES (:id, :user_id, :media_id, 'Reading', :device_id, 'Desktop', :occurred_at,
                        :duration_ms, :progress_start, :progress_end, :word_start, :word_end)"""
        ),
        {
            "id": uuid4(),
            "user_id": user_id,
            "media_id": media_id,
            "device_id": device_id,
            "occurred_at": occurred_at,
            "duration_ms": duration_ms,
            "progress_start": progress_start,
            "progress_end": progress_end,
            "word_start": word_start,
            "word_end": word_end,
        },
    )


def _query(*, start: datetime, end: datetime, device_id: str | None = None) -> ActivityQuery:
    return ActivityQuery(start=start, end=end, time_zone="UTC", device_id=device_id)


def test_sessions_are_cursor_stable_and_keep_private_device_ids_private(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(hours=5)
    first_media = _media(db_session, bootstrapped_user, title="First")
    second_media = _media(db_session, bootstrapped_user, title="Second")
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=first_media,
        occurred_at=start,
        duration_ms=1_000,
    )
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=second_media,
        occurred_at=start + timedelta(hours=1),
        duration_ms=1_000,
    )
    db_session.commit()

    query = _query(start=start, end=end)
    first = service.get_activity_sessions(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        cursor=None,
        limit=1,
        current_device_id="this-device",
    )
    assert len(first.sessions) == 1
    assert isinstance(first.next_cursor, Present)
    cursor = first.next_cursor.value
    assert "private-device" not in cursor

    # A later insert is outside the continuation's as-of snapshot.
    later_media = _media(db_session, bootstrapped_user, title="Inserted after page one")
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=later_media,
        occurred_at=start + timedelta(hours=2),
        duration_ms=1_000,
    )
    db_session.commit()
    second = service.get_activity_sessions(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        cursor=cursor,
        limit=1,
        current_device_id="this-device",
    )
    assert [row.title for row in second.sessions] == ["First"]
    assert isinstance(second.next_cursor, Present) is False

    with pytest.raises(InvalidRequestError):
        service.get_activity_sessions(
            db_session,
            viewer_id=bootstrapped_user,
            query=_query(start=start, end=end - timedelta(minutes=1)),
            cursor=cursor,
            limit=1,
            current_device_id="this-device",
        )
    with pytest.raises(InvalidRequestError):
        service.get_activity_sessions(
            db_session,
            viewer_id=bootstrapped_user,
            query=query,
            cursor=cursor[:-1] + ("A" if cursor[-1] != "A" else "B"),
            limit=1,
            current_device_id="this-device",
        )


def test_sessions_use_running_max_and_split_at_exactly_thirty_minutes(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    media_id = _media(db_session, bootstrapped_user, title="Session boundaries")
    for occurred_at, duration_ms in (
        (start, 30_000),
        (start + timedelta(seconds=1), 1_000),
        (start + timedelta(minutes=30, seconds=29), 1_000),
        (start + timedelta(hours=1, seconds=30), 1_000),
    ):
        _span(
            db_session,
            user_id=bootstrapped_user,
            media_id=media_id,
            occurred_at=occurred_at,
            duration_ms=duration_ms,
        )
    db_session.commit()

    page = service.get_activity_sessions(
        db_session,
        viewer_id=bootstrapped_user,
        query=_query(start=start, end=start + timedelta(hours=2)),
        cursor=None,
        limit=10,
        current_device_id="this-device",
    )

    assert len(page.sessions) == 2
    newest, earlier = page.sessions
    assert (newest.started_at, newest.active_ms) == (
        start + timedelta(hours=1, seconds=30),
        1_000,
    )
    # The middle one-second span is contained by the first span. The third
    # span is <30m from the running maximum end but >=30m from the immediately
    # preceding short span, so LAG-based grouping would incorrectly split it.
    assert (earlier.started_at, earlier.ended_at, earlier.active_ms) == (
        start,
        start + timedelta(minutes=30, seconds=30),
        32_000,
    )


def test_stats_zero_fill_timeline_clip_sessions_and_hide_revoked_media(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, 1, tzinfo=UTC)
    end = start + timedelta(hours=3)
    visible = _media(db_session, bootstrapped_user, title="Visible")
    revoked = _media(db_session, bootstrapped_user, title="Revoked")
    tearing_down = _media(db_session, bootstrapped_user, title="Tearing down")
    # One source span crosses the requested lower bound; its session metrics and
    # progress must be clipped at that bound.
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=visible,
        occurred_at=start - timedelta(minutes=1),
        duration_ms=120_000,
        progress_start=0.0,
        progress_end=1.0,
        word_start=0,
        word_end=120,
    )
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=revoked,
        occurred_at=start + timedelta(hours=1),
        duration_ms=1_000,
    )
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=tearing_down,
        occurred_at=start + timedelta(hours=2),
        duration_ms=1_000,
    )
    db_session.add(UserMediaDeletion(user_id=bootstrapped_user, media_id=revoked))
    db_session.execute(
        text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
        {"id": uuid4(), "media_id": tearing_down},
    )
    db_session.commit()

    stats = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=_query(start=start, end=end),
        bucket="Hour",
        current_device_id="this-device",
    )
    assert len(stats.activity.timeline) == 3
    assert [row.active_ms for row in stats.activity.timeline] == [60_000, 0, 0]
    assert len(stats.activity.local_hours) == 24
    assert stats.activity.totals.active_ms == 60_000
    assert [row.title for row in stats.activity.media.rows] == ["Visible"]
    assert len(stats.activity.sessions.rows) == 1
    session = stats.activity.sessions.rows[0]
    assert session.active_ms == 60_000
    assert isinstance(session.first_progress, Present) and session.first_progress.value == 0.5
    assert isinstance(session.last_progress, Present) and session.last_progress.value == 1.0
    assert session.forward_word_position == 60
    payload = json.dumps(stats.model_dump(mode="json", by_alias=True))
    assert "private-device" not in payload
    assert "ncd1." in payload


def test_completion_ignores_device_but_respects_current_visibility(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    visible = _media(db_session, bootstrapped_user, title="Completed")
    revoked = _media(db_session, bootstrapped_user, title="Revoked completion")
    tearing_down = _media(db_session, bootstrapped_user, title="Tearing-down completion")
    for media_id in (visible, revoked, tearing_down):
        db_session.execute(
            text(
                """INSERT INTO consumption_completion_facts
                    (id, user_id, media_id, modality, created_at)
                    VALUES (:id, :user_id, :media_id, 'Reading', :created_at)"""
            ),
            {
                "id": uuid4(),
                "user_id": bootstrapped_user,
                "media_id": media_id,
                "created_at": start,
            },
        )
    db_session.add(UserMediaDeletion(user_id=bootstrapped_user, media_id=revoked))
    db_session.execute(
        text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
        {"id": uuid4(), "media_id": tearing_down},
    )
    db_session.commit()

    stats = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=_query(start=start, end=end, device_id="no-such-device"),
        bucket="Day",
        current_device_id="this-device",
    )
    assert stats.completion.applied_filters == ["time"]
    assert stats.completion.inapplicable_filters == ["device"]
    assert stats.completion.total == 1
    assert [row.title for row in stats.completion.media] == ["Completed"]


def test_contributor_attribution_dedupes_direct_and_parent_podcast_roles(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    media_id = _media(
        db_session,
        bootstrapped_user,
        title="Episode",
        kind=MediaKind.podcast_episode.value,
    )
    podcast_id = uuid4()
    contributor_id = uuid4()
    db_session.execute(
        text(
            """INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                VALUES (:id, 'test', :provider_id, 'Podcast', :feed_url)"""
        ),
        {
            "id": podcast_id,
            "provider_id": str(podcast_id),
            "feed_url": f"https://example.com/{podcast_id}.xml",
        },
    )
    db_session.execute(
        text(
            """INSERT INTO podcast_episodes (media_id, podcast_id)
                VALUES (:media_id, :podcast_id)"""
        ),
        {"media_id": media_id, "podcast_id": podcast_id},
    )
    add_test_podcast_episode_identity(
        db_session,
        podcast_id=podcast_id,
        media_id=media_id,
        value="episode",
    )
    db_session.execute(
        text("INSERT INTO contributors (id, handle, display_name) VALUES (:id, 'ada', 'Ada')"),
        {"id": contributor_id},
    )
    for target, role, ordinal in (("media_id", "author", 0), ("podcast_id", "narrator", 0)):
        db_session.execute(
            text(
                f"""INSERT INTO contributor_credits
                    (id, contributor_id, {target}, credited_name, normalized_credited_name, role, ordinal, source)
                    VALUES (:id, :contributor_id, :target_id, 'Ada', 'ada', :role, :ordinal, 'test')"""
            ),
            {
                "id": uuid4(),
                "contributor_id": contributor_id,
                "target_id": media_id if target == "media_id" else podcast_id,
                "role": role,
                "ordinal": ordinal,
            },
        )
    _span(
        db_session,
        user_id=bootstrapped_user,
        media_id=media_id,
        occurred_at=start,
        duration_ms=1_000,
    )
    db_session.execute(
        text(
            """INSERT INTO consumption_completion_facts
                (id, user_id, media_id, modality, created_at)
                VALUES (:id, :user_id, :media_id, 'Listening', :created_at)"""
        ),
        {"id": uuid4(), "user_id": bootstrapped_user, "media_id": media_id, "created_at": start},
    )
    db_session.commit()

    stats = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=_query(start=start, end=end),
        bucket="Day",
        current_device_id="this-device",
    )
    assert [
        (row.contributor_handle, row.roles, row.active_ms)
        for row in stats.activity.contributors.rows
    ] == [("ada", ["author", "narrator"], 1_000)]
    assert [
        (row.contributor_handle, row.roles, row.total) for row in stats.completion.contributors
    ] == [("ada", ["author", "narrator"], 1)]

    db_session.execute(
        text("DELETE FROM contributor_credits WHERE contributor_id = :contributor_id"),
        {"contributor_id": contributor_id},
    )
    replacement_id = uuid4()
    db_session.execute(
        text(
            """INSERT INTO contributors (id, handle, display_name)
               VALUES (:id, 'grace', 'Grace')"""
        ),
        {"id": replacement_id},
    )
    db_session.execute(
        text(
            """INSERT INTO contributor_credits
                (id, contributor_id, media_id, credited_name, normalized_credited_name, role, ordinal, source)
                VALUES (:id, :contributor_id, :media_id, 'Grace', 'grace', 'author', 0, 'test')"""
        ),
        {"id": uuid4(), "contributor_id": replacement_id, "media_id": media_id},
    )
    db_session.commit()
    corrected = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=_query(start=start, end=end),
        bucket="Day",
        current_device_id="this-device",
    )
    assert [row.contributor_handle for row in corrected.activity.contributors.rows] == ["grace"]
    assert [row.contributor_handle for row in corrected.completion.contributors] == ["grace"]


def test_retained_artifacts_use_owner_counts_and_drop_hidden_highlights(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    media_id = _media(db_session, bootstrapped_user, title="Annotated")
    peer_media_id = _media(db_session, bootstrapped_user, title="Linked peer")
    highlight_id = uuid4()
    note_block_id = uuid4()
    db_session.add_all(
        [
            Highlight(
                id=highlight_id,
                user_id=bootstrapped_user,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact="selected",
                prefix="",
                suffix="",
                created_at=start,
                updated_at=start,
            ),
            NoteBlock(
                id=note_block_id,
                user_id=bootstrapped_user,
                body_pm_json={"type": "doc", "content": []},
                body_text="A retained note",
                created_at=start,
                updated_at=start,
            ),
        ]
    )
    link = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=CreateLinkRequest(
            client_mutation_id=str(uuid4()),
            source={"kind": "resource", "ref": f"media:{media_id}"},
            target={"kind": "resource", "ref": f"media:{peer_media_id}"},
        ),
    )
    db_session.execute(
        text("UPDATE resource_edges SET created_at = :created_at WHERE id = :edge_id"),
        {"created_at": start, "edge_id": link.connection.edge_id},
    )
    db_session.commit()

    query = _query(start=start, end=end)
    initial = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        bucket="Day",
        current_device_id="this-device",
    )
    assert (
        initial.retained_artifacts.highlights,
        initial.retained_artifacts.note_blocks,
        initial.retained_artifacts.neutral_links,
    ) == (1, 1, 1)

    db_session.execute(
        text("DELETE FROM highlights WHERE id = :id"),
        {"id": highlight_id},
    )
    db_session.execute(
        text("DELETE FROM note_blocks WHERE id = :id"),
        {"id": note_block_id},
    )
    db_session.execute(
        text("DELETE FROM resource_edges WHERE id = :id"),
        {"id": link.connection.edge_id},
    )
    db_session.commit()
    after_source_deletion = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        bucket="Day",
        current_device_id="this-device",
    )
    assert (
        after_source_deletion.retained_artifacts.highlights,
        after_source_deletion.retained_artifacts.note_blocks,
        after_source_deletion.retained_artifacts.neutral_links,
    ) == (0, 0, 0)

    db_session.add_all(
        [
            Highlight(
                id=uuid4(),
                user_id=bootstrapped_user,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact="replacement",
                prefix="",
                suffix="",
                created_at=start,
                updated_at=start,
            ),
            NoteBlock(
                id=uuid4(),
                user_id=bootstrapped_user,
                body_pm_json={"type": "doc", "content": []},
                body_text="A replacement retained note",
                created_at=start,
                updated_at=start,
            ),
        ]
    )
    replacement_link = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=CreateLinkRequest(
            client_mutation_id=str(uuid4()),
            source={"kind": "resource", "ref": f"media:{media_id}"},
            target={"kind": "resource", "ref": f"media:{peer_media_id}"},
        ),
    )
    db_session.execute(
        text("UPDATE resource_edges SET created_at = :created_at WHERE id = :edge_id"),
        {"created_at": start, "edge_id": replacement_link.connection.edge_id},
    )
    db_session.add(UserMediaDeletion(user_id=bootstrapped_user, media_id=media_id))
    db_session.commit()
    after_deletion = service.get_activity_stats(
        db_session,
        viewer_id=bootstrapped_user,
        query=query,
        bucket="Day",
        current_device_id="this-device",
    )
    assert (
        after_deletion.retained_artifacts.highlights,
        after_deletion.retained_artifacts.note_blocks,
        after_deletion.retained_artifacts.neutral_links,
    ) == (0, 1, 0)
