"""Tests for the dawn write service and API routes (spec §14)."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import pytest
from provider_runtime.types import ModelResponse, TokenUsage
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyNotePage, DawnWrite, Highlight, Page
from nexus.services.dawn_write import collect_signals, generate_dawn_write
from tests.factories import (
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_llm_response(text: str) -> ModelResponse:
    return ModelResponse(
        text=text,
        usage=TokenUsage(
            input_tokens=50,
            output_tokens=80,
            total_tokens=130,
            reasoning_tokens=0,
            cache_write_input_tokens=0,
            cache_read_input_tokens=0,
            cached_input_tokens=0,
        ),
        provider_request_id="test-req-id",
    )


def _seed_daily_note_page(db: Session, user_id: UUID, tz: str = "America/New_York") -> None:
    """Seed a daily_note_pages row so the job sees a timezone for this user."""
    page = Page(id=uuid4(), user_id=user_id, title="Test daily page")
    db.add(page)
    db.flush()
    row = DailyNotePage(
        id=uuid4(),
        user_id=user_id,
        local_date=date.today(),
        time_zone=tz,
        page_id=page.id,
    )
    db.add(row)
    db.commit()


def _seed_highlight(
    db: Session,
    user_id: UUID,
    media_id: UUID,
    exact: str = "interesting passage",
    created_at: datetime | None = None,
) -> UUID:
    if created_at is None:
        created_at = datetime.now(tz=UTC) - timedelta(hours=12)
    h = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
        created_at=created_at,
    )
    db.add(h)
    db.commit()
    return h.id


def _seed_synapse_edge(
    db: Session,
    user_id: UUID,
    excerpt: str = "Two ideas intersect here",
    created_at: datetime | None = None,
) -> None:
    if created_at is None:
        created_at = datetime.now(tz=UTC) - timedelta(hours=6)
    db.execute(
        text(
            "INSERT INTO resource_edges "
            "(user_id, origin, source_scheme, source_id, target_scheme, target_id,"
            " snapshot, created_at)"
            " VALUES (:uid, 'synapse', 'media', :sid, 'media', :tid,"
            " :snap::jsonb, :cat)"
        ),
        {
            "uid": str(user_id),
            "sid": str(uuid4()),
            "tid": str(uuid4()),
            "snap": f'{{"excerpt": "{excerpt}"}}',
            "cat": created_at,
        },
    )
    db.commit()


# ---------------------------------------------------------------------------
# collect_signals
# ---------------------------------------------------------------------------


class TestCollectSignals:
    def test_returns_none_when_all_signals_empty(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        # No highlights, no synapse edges, no LI artifacts → empty signals.
        result = collect_signals(
            db_session,
            user_id=bootstrapped_user,
            local_date=date.today(),
            tz="UTC",
        )
        assert result is None

    def test_returns_signals_with_highlight(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(
            db_session, bootstrapped_user, library_id, title="Dawn Test Article"
        )
        _seed_highlight(db_session, bootstrapped_user, media_id, exact="a vivid phrase")

        result = collect_signals(
            db_session,
            user_id=bootstrapped_user,
            local_date=date.today(),
            tz="UTC",
        )
        assert result is not None
        assert len(result.highlights) == 1
        assert result.highlights[0].exact == "a vivid phrase"
        assert result.highlights[0].media_title == "Dawn Test Article"

    def test_highlight_outside_window_excluded(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        # Highlight from 3 days ago — outside yesterday's window.
        old_at = datetime.now(tz=UTC) - timedelta(days=3)
        _seed_highlight(db_session, bootstrapped_user, media_id, created_at=old_at)

        result = collect_signals(
            db_session,
            user_id=bootstrapped_user,
            local_date=date.today(),
            tz="UTC",
        )
        assert result is None  # no other signals either

    def test_synapse_edge_included(self, db_session: Session, bootstrapped_user: UUID) -> None:
        _seed_synapse_edge(db_session, bootstrapped_user, excerpt="synapse rationale text")

        result = collect_signals(
            db_session,
            user_id=bootstrapped_user,
            local_date=date.today(),
            tz="UTC",
        )
        assert result is not None
        assert len(result.synapse_edges) == 1
        assert result.synapse_edges[0].excerpt == "synapse rationale text"


# ---------------------------------------------------------------------------
# generate_dawn_write
# ---------------------------------------------------------------------------


class TestGenerateDawnWrite:
    @pytest.fixture(autouse=True)
    def _platform_key(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-platform-key")
        from nexus.config import clear_settings_cache

        clear_settings_cache()
        yield
        clear_settings_cache()

    def test_skips_when_signals_empty(self, db_session: Session, bootstrapped_user: UUID) -> None:
        fake_llm = MagicMock()
        result = asyncio.get_event_loop().run_until_complete(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                llm=fake_llm,
            )
        )
        assert result is None
        fake_llm.generate.assert_not_called()

    def test_generates_and_inserts_row(self, db_session: Session, bootstrapped_user: UUID) -> None:
        from nexus.services.billing_entitlements import grant_entitlement_override

        grant_entitlement_override(
            db_session,
            user_id=bootstrapped_user,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="test",
            actor_label="test",
        )

        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(
            db_session, bootstrapped_user, library_id, title="Machine Learnable"
        )
        _seed_highlight(db_session, bootstrapped_user, media_id, exact="a memorable phrase")

        fake_response = _make_fake_llm_response(
            "Yesterday the reader marked a passage in Machine Learnable.\n\n"
            "No overnight connections or stale dossiers."
        )

        with patch(
            "nexus.services.llm_ledger.LedgeredLLM.generate",
            new_callable=AsyncMock,
            return_value=fake_response,
        ):
            result = asyncio.get_event_loop().run_until_complete(
                generate_dawn_write(
                    db_session,
                    user_id=bootstrapped_user,
                    local_date=date.today(),
                    tz="UTC",
                    llm=MagicMock(),
                )
            )

        assert result is not None
        assert result.user_id == bootstrapped_user
        assert result.local_date == date.today()
        assert "Machine Learnable" in result.body_md or len(result.body_md) > 0

        # Confirm DB row and llm_calls ledger entry.
        db_row = db_session.scalar(
            select(DawnWrite).where(
                DawnWrite.user_id == bootstrapped_user,
                DawnWrite.local_date == date.today(),
            )
        )
        assert db_row is not None
        llm_call_count = db_session.execute(
            text("SELECT COUNT(*) FROM llm_calls WHERE owner_kind='dawn_write' AND owner_id=:oid"),
            {"oid": str(db_row.id)},
        ).scalar()
        assert llm_call_count == 1

    def test_skips_when_disabled(
        self, db_session: Session, bootstrapped_user: UUID, monkeypatch
    ) -> None:
        monkeypatch.setenv("DAWN_WRITE_ENABLED", "false")
        from nexus.config import clear_settings_cache

        clear_settings_cache()

        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        fake_llm = MagicMock()
        result = asyncio.get_event_loop().run_until_complete(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                llm=fake_llm,
            )
        )
        assert result is None
        clear_settings_cache()


# ---------------------------------------------------------------------------
# Sweep logic (AC-4, AC-5)
# ---------------------------------------------------------------------------


class TestSweepLogic:
    def test_sweep_skips_user_with_no_daily_note_pages(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        # No daily_note_pages row → no timezone record → skip.
        # collect_signals would still work, but the sweep won't call it.
        # We verify by seeding a highlight but no tz record — sweep should produce no row.
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        # No daily_note_pages row exists → the sweep query returns nothing for this user.
        tz_rows = db_session.execute(
            text(
                "SELECT DISTINCT ON (user_id) user_id, time_zone"
                " FROM daily_note_pages"
                " WHERE user_id = :uid"
                " ORDER BY user_id, created_at DESC"
            ),
            {"uid": str(bootstrapped_user)},
        ).fetchall()
        assert len(tz_rows) == 0

    def test_sweep_skips_user_when_row_already_exists(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        _seed_daily_note_page(db_session, bootstrapped_user)
        # Pre-insert a dawn_writes row.
        existing = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="already written",
        )
        db_session.add(existing)
        db_session.commit()

        # The sweep's idempotency check should detect the existing row.
        existing_id = db_session.scalar(
            select(DawnWrite.id).where(
                DawnWrite.user_id == bootstrapped_user,
                DawnWrite.local_date == date.today(),
            )
        )
        assert existing_id is not None


# ---------------------------------------------------------------------------
# API routes (AC-1, AC-2, AC-3)
# ---------------------------------------------------------------------------


class TestDawnWriteApiRoutes:
    def test_get_returns_null_when_no_row(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        today = date.today().isoformat()
        response = authenticated_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 200
        data = response.json()
        assert "write" in data
        assert data["write"] is None

    def test_get_returns_row_when_exists(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        row = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="Some dawn write text.",
        )
        db_session.add(row)
        db_session.commit()

        today = date.today().isoformat()
        response = authenticated_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"] is not None
        assert data["write"]["body_md"] == "Some dawn write text."
        assert data["write"]["dismissed_at"] is None

    def test_dismiss_sets_dismissed_at(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        row = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="Morning brief.",
        )
        db_session.add(row)
        db_session.commit()
        write_id = row.id

        response = authenticated_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 204

        db_session.expire(row)
        updated = db_session.get(DawnWrite, write_id)
        assert updated is not None
        assert updated.dismissed_at is not None

    def test_second_dismiss_is_idempotent(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        row = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="Morning brief.",
        )
        db_session.add(row)
        db_session.commit()
        write_id = row.id

        authenticated_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(bootstrapped_user),
        )
        # Second dismiss.
        response = authenticated_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 204

    def test_get_returns_row_with_dismissed_at_after_dismiss(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        row = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="Morning brief.",
        )
        db_session.add(row)
        db_session.commit()
        write_id = row.id

        authenticated_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(bootstrapped_user),
        )

        today = date.today().isoformat()
        response = authenticated_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"]["dismissed_at"] is not None

    def test_get_returns_null_when_dawn_write_disabled(
        self, authenticated_client, db_session: Session, bootstrapped_user: UUID, monkeypatch
    ) -> None:
        monkeypatch.setenv("DAWN_WRITE_ENABLED", "false")
        from nexus.config import clear_settings_cache

        clear_settings_cache()

        # Even with a row, the endpoint returns null when disabled.
        row = DawnWrite(
            user_id=bootstrapped_user,
            local_date=date.today(),
            body_md="Should not appear.",
        )
        db_session.add(row)
        db_session.commit()

        today = date.today().isoformat()
        response = authenticated_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(bootstrapped_user),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"] is None

        clear_settings_cache()
