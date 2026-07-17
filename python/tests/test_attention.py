"""Integration tests for the attention ledger (sessions + overrides + derivation).

Service-level tests seed committed users/media via ``direct_db`` and call the
``services.attention`` functions directly. Route-level tests use the safe
``auth_client`` + ``direct_db`` pattern (never savepoint db_session + client).
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.schemas.attention import AttentionBlock
from nexus.services import attention
from nexus.services.consumption import service as consumption_service
from tests.factories import add_media_to_library, create_test_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_user_and_media(
    direct_db: DirectSessionManager,
    *,
    kind: str = MediaKind.web_article.value,
) -> tuple[UUID, UUID]:
    """Seed a user plus a media item the user can read.

    ``record_attention`` validates media visibility itself, so the media must
    be reachable through a library the user belongs to."""
    user_id = uuid4()
    media_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.add(
            Media(
                id=media_id,
                kind=kind,
                title="Attention Test Media",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.flush()
        library_id = create_test_library(session, user_id)
        add_media_to_library(session, library_id, media_id)
        session.commit()
    # Parent-first registration; LIFO teardown deletes children first.
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("reading_sessions", "media_id", media_id)
    direct_db.register_cleanup("consumption_overrides", "media_id", media_id)
    return user_id, media_id


def _record(
    direct_db: DirectSessionManager,
    user_id: UUID,
    media_id: UUID,
    *,
    dwell: int,
    progression: float | None = None,
    device: str = "device-1",
) -> None:
    with direct_db.session() as session:
        attention.record_attention(
            session,
            user_id,
            media_id,
            AttentionBlock(
                dwell_ms_delta=dwell,
                device_id=device,
                spans_touched=[],
                progression=progression,
            ),
        )


def _session_rows(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text("""
                SELECT dwell_ms, max_progression, started_at, last_active_at
                FROM reading_sessions
                WHERE user_id = :u AND media_id = :m
                ORDER BY started_at ASC
            """),
            {"u": user_id, "m": media_id},
        ).fetchall()


def _consumption(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID):
    # Read-state is now derived by the consumption projection (docs read attention's
    # session aggregates); attention no longer owns read-state.
    with direct_db.session() as session:
        return consumption_service.media_read_states(
            session, viewer_id=user_id, media_ids=[media_id]
        )[media_id]


class TestRecordAttention:
    def test_creates_session_with_dwell_and_progression(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=45_000, progression=0.3)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 45_000
        assert rows[0][1] == pytest.approx(0.3, abs=1e-6)

    def test_continues_session_within_gap(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=10_000, progression=0.2)
        _record(direct_db, user_id, media_id, dwell=5_000, progression=0.5)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 15_000
        assert rows[0][1] == pytest.approx(0.5, abs=1e-6)
        assert rows[0][2] == rows[0][3] or rows[0][3] >= rows[0][2]

    def test_progression_is_max_not_last(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=1_000, progression=0.8)
        _record(direct_db, user_id, media_id, dwell=1_000, progression=0.4)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][1] == pytest.approx(0.8, abs=1e-6)

    def test_opens_new_session_after_gap(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=10_000, progression=0.2)
        # Age the open session beyond the 30-minute gap.
        with direct_db.session() as session:
            session.execute(
                text("""
                    UPDATE reading_sessions
                    SET last_active_at = now() - interval '31 minutes',
                        started_at = now() - interval '31 minutes'
                    WHERE user_id = :u AND media_id = :m
                """),
                {"u": user_id, "m": media_id},
            )
            session.commit()

        _record(direct_db, user_id, media_id, dwell=7_000, progression=0.9)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 2
        assert {rows[0][0], rows[1][0]} == {10_000, 7_000}

    def test_continues_session_with_null_progression(self, direct_db: DirectSessionManager):
        # Regression: a dwell-only save on an OPEN session binds progression as
        # a bare NULL in the UPDATE; without a typed cast Postgres rejects the
        # statement (AmbiguousParameter) and every such save 500s.
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=10_000, progression=0.4)
        _record(direct_db, user_id, media_id, dwell=5_000, progression=None)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 15_000
        assert rows[0][1] == pytest.approx(0.4, abs=1e-6)

    def test_no_op_save_does_not_touch_existing_session(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)

        _record(direct_db, user_id, media_id, dwell=12_000, progression=0.3)
        _record(direct_db, user_id, media_id, dwell=0, progression=None)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 12_000

    def test_records_audio_session(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db, kind=MediaKind.podcast_episode.value)

        _record(direct_db, user_id, media_id, dwell=15_000, progression=0.1)
        _record(direct_db, user_id, media_id, dwell=15_000, progression=0.2)

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 30_000


class TestConsumptionState:
    def test_unread_with_no_sessions(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        assert _consumption(direct_db, user_id, media_id).state == "unread"

    def test_finished_from_progression(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        _record(direct_db, user_id, media_id, dwell=5_000, progression=0.96)
        assert _consumption(direct_db, user_id, media_id).state == "finished"

    def test_finished_from_total_dwell(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        _record(direct_db, user_id, media_id, dwell=130_000, progression=0.1)
        assert _consumption(direct_db, user_id, media_id).state == "finished"

    def test_in_progress_from_session_dwell(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        _record(direct_db, user_id, media_id, dwell=35_000, progression=0.4)
        state = _consumption(direct_db, user_id, media_id)
        assert state.state == "in_progress"
        assert state.progress_fraction == pytest.approx(0.4, abs=1e-6)

    def test_short_dwell_stays_unread(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        _record(direct_db, user_id, media_id, dwell=10_000, progression=None)
        assert _consumption(direct_db, user_id, media_id).state == "unread"

    def test_override_wins_over_session(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        _record(direct_db, user_id, media_id, dwell=5_000, progression=1.0)
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO consumption_overrides (user_id, media_id, status)
                    VALUES (:u, :m, 'unread')
                """),
                {"u": user_id, "m": media_id},
            )
            session.commit()
        state = _consumption(direct_db, user_id, media_id)
        # New model: an explicit override changes STATE only; the derived progress
        # fraction stays as-is (spec §5.2 / consumption projection).
        assert state.state == "unread"
        assert state.progress_fraction == pytest.approx(1.0, abs=1e-6)


class TestAttentionOnDay:
    def test_returns_media_and_dwell_for_calendar_day(self, direct_db: DirectSessionManager):
        user_id, media_id = _seed_user_and_media(direct_db)
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO reading_sessions
                        (user_id, media_id, device_id, started_at, last_active_at, dwell_ms)
                    VALUES
                        (:u, :m, 'device-x', '2021-07-06T10:00:00Z', '2021-07-06T10:05:00Z', 60000),
                        (:u, :m, 'device-x', '2023-07-06T12:00:00Z', '2023-07-06T12:05:00Z', 40000),
                        (:u, :m, 'device-x', '2023-08-06T12:00:00Z', '2023-08-06T12:05:00Z', 90000)
                """),
                {"u": user_id, "m": media_id},
            )
            session.commit()

        with direct_db.session() as session:
            pairs = attention.attention_on_day(session, user_id, month=7, day=6)

        assert pairs == [(media_id, 100_000)]


# The explicit read-state override is no longer an attention route: it moved to the
# consumption command port (SetUnread / EnsureMediaFinished), covered by
# tests/test_consumption_commands.py. The old /media/{id}/consumption-override route
# is deleted (lectern-player-lifecycle-hard-cutover.md §7).


class TestReaderAttentionRoute:
    def _add_media_to_user_library(self, auth_client, user_id: UUID, media_id: UUID) -> None:
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

    def test_reader_put_with_attention_writes_session(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="Reader Attention Media",
                    processing_status=ProcessingStatus.ready_for_reading,
                )
            )
            session.commit()
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("reader_media_state", "media_id", media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)

        self._add_media_to_user_library(auth_client, user_id, media_id)

        body = {
            "cursor": {
                "locator": {
                    "kind": "web",
                    "target": {"fragment_id": "fragment-1"},
                    "locations": {
                        "text_offset": 42,
                        "progression": None,
                        "total_progression": 0.5,
                        "position": 2,
                    },
                    "text": {"quote": "hello", "quote_prefix": None, "quote_suffix": None},
                },
                "base_revision": 0,
            },
            "attention": {
                "dwell_ms_delta": 45_000,
                "device_id": "device-abc",
                "spans_touched": [],
                "progression": 0.5,
            },
        }
        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=body,
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 45_000

    def test_reader_cursor_put_without_attention_is_noop_for_sessions(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.web_article.value,
                    title="Reader No-Attention Media",
                    processing_status=ProcessingStatus.ready_for_reading,
                )
            )
            session.commit()
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("reader_media_state", "media_id", media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)

        self._add_media_to_user_library(auth_client, user_id, media_id)

        locator = {
            "kind": "web",
            "target": {"fragment_id": "fragment-1"},
            "locations": {
                "text_offset": 42,
                "progression": None,
                "total_progression": 0.5,
                "position": 2,
            },
            "text": {"quote": "hello", "quote_prefix": None, "quote_suffix": None},
        }
        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"cursor": {"locator": locator, "base_revision": 0}},
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200
        assert resp.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": locator,
        }
        assert _session_rows(direct_db, user_id, media_id) == []


class TestListeningAttentionRoute:
    def _add_media_to_user_library(self, auth_client, user_id: UUID, media_id: UUID) -> None:
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

    def test_listening_put_with_dwell_writes_session(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        with direct_db.session() as session:
            session.add(
                Media(
                    id=media_id,
                    kind=MediaKind.podcast_episode.value,
                    title="Listening Attention Media",
                    processing_status=ProcessingStatus.ready_for_reading,
                )
            )
            session.commit()
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("podcast_listening_states", "media_id", media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)

        self._add_media_to_user_library(auth_client, user_id, media_id)

        # New heartbeat contract (spec §5.4): the dwell write is piggybacked on
        # the revision-fenced listening PUT inside one transaction.
        resp = auth_client.put(
            f"/media/{media_id}/listening-state",
            json={
                "positionMs": 60_000,
                "durationMs": {"kind": "Present", "value": 600_000},
                "playbackSpeed": 1.0,
                "dwellMsDelta": 15_000,
                "deviceId": "device-audio",
                "expectedWriteRevision": 0,
                "expectedResetEpoch": 0,
                "heartbeatGeneration": str(uuid4()),
                "heartbeatSequence": 1,
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["listeningState"]["writeRevision"] == 1

        rows = _session_rows(direct_db, user_id, media_id)
        assert len(rows) == 1
        assert rows[0][0] == 15_000
        assert rows[0][1] == pytest.approx(0.1, abs=1e-6)
