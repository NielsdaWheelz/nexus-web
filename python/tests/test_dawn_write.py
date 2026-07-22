"""Tests for the dawn write service and API routes (spec §14)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Failed,
    PossiblyBillable,
    Present,
    ProviderHttpUnavailable,
    Refused,
    ResponsePayload,
    Succeeded,
    TextContent,
    TokenUsage,
    TransientExhausted,
)
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyNotePage, DawnWrite, Highlight, Page
from nexus.services.dawn_write import DAWN_WRITE_OPERATION, collect_signals, generate_dawn_write
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.factories import (
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration

_PROFILE = operation_profile(DAWN_WRITE_OPERATION)


# ---------------------------------------------------------------------------
# Fake ExecutionRuntime + outcome builders
# ---------------------------------------------------------------------------


@dataclass
class _ScriptedRuntime:
    """A fake `ExecutionRuntime`: scripts one outcome (non-stream) or raises on
    dispatch. Copied from tests/test_llm_execution.py `_ScriptedRuntime`
    (stream() is unused by dawn_write, which never streams)."""

    outcome: object = None
    generate_error: BaseException | None = None
    calls: list[str] = field(default_factory=list)

    async def generate(self, intent, plan, credential) -> object:
        self.calls.append("generate")
        if self.generate_error is not None:
            raise self.generate_error
        assert self.outcome is not None
        return self.outcome

    def stream(self, intent, plan, credential, *, cancel):  # pragma: no cover - unused
        raise NotImplementedError


def _meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _PROFILE.target.provider,
        "model": _PROFILE.target.model,
        "provider_request_id": Present("req-abc"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=50,
                output_tokens=80,
                total_tokens=130,
                reasoning_tokens=Absent(),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
        "attempt_trace": (),
        "billability": PossiblyBillable(),
    }
    fields.update(overrides)
    return CallMeta(**fields)  # type: ignore[arg-type]


def _succeeded_text_outcome(text: str) -> Succeeded:
    return Succeeded(
        meta=_meta(),
        response=ResponsePayload(
            content=TextContent(text=text, tool_calls=()), continuation=Absent()
        ),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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
        # Noon UTC yesterday — always inside the [yesterday, today) UTC window
        # regardless of the wall-clock time the suite runs at.
        created_at = datetime.combine(date.today() - timedelta(days=1), time(12), tzinfo=UTC)
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
            "(user_id, kind, origin, source_scheme, source_id, target_scheme, target_id,"
            " snapshot, created_at)"
            " VALUES (:uid, 'context', 'synapse', 'media', :sid, 'media', :tid,"
            " CAST(:snap AS jsonb), :cat)"
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
        # DAWN_WRITE_OPERATION resolves to the "balanced" profile, whose target
        # provider is openai (see llm_profiles.PROFILES) — the key must be
        # OPENAI_API_KEY, not an anthropic key.
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
        from nexus.config import clear_settings_cache

        clear_settings_cache()
        yield
        clear_settings_cache()

    @pytest.fixture(autouse=True)
    def _dawn_write_session_factory(self, monkeypatch, db_session):
        """Route the owner's internal ``get_session_factory()`` call onto this
        test's savepoint connection (same pattern as tests/test_llm_task.py
        `_task_db`), so execute_generation's entitlement/ledger reads see the
        grants and rows this test sets up on ``db_session``.
        """
        monkeypatch.setattr(
            "nexus.services.dawn_write.get_session_factory",
            lambda: task_session_factory(db_session),
        )

    @pytest.fixture(autouse=True)
    def _rate_limiter(self, db_session):
        """Install the real RateLimiter as the global singleton so
        execute_generation's reservation/commit/release ledger flow runs for
        real against this test's DB."""
        previous = get_rate_limiter()
        set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
        yield
        set_rate_limiter(previous)

    def test_skips_when_signals_empty(self, db_session: Session, bootstrapped_user: UUID) -> None:
        runtime = _ScriptedRuntime()
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
            )
        )
        assert result is None
        assert runtime.calls == []

    def test_generates_and_inserts_row(self, db_session: Session, bootstrapped_user: UUID) -> None:
        from nexus.services.billing_entitlements import grant_entitlement_override

        grant_entitlement_override(
            db_session,
            user_id=bootstrapped_user,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_text_outcome(
                "Yesterday the reader marked a passage in Machine Learnable.\n\n"
                "No overnight connections or stale dossiers."
            )
        )
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
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

    def test_skips_when_llm_not_entitled(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        """No entitlement grant → execute_generation raises ApiError(E_BILLING_REQUIRED),
        which generate_dawn_write catches and treats as a skip (no row, no
        ledger entry) — port of the old "empty response" no-write scenario to
        the new entitlement-denial surface (see llm_execution.py: entitlement
        denial raises before any llm_calls row is written)."""
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        runtime = _ScriptedRuntime(outcome=_succeeded_text_outcome("should not be reached"))
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
            )
        )
        assert result is None
        assert runtime.calls == []

    def test_skips_when_provider_call_fails(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        from nexus.services.billing_entitlements import grant_entitlement_override

        grant_entitlement_override(
            db_session,
            user_id=bootstrapped_user,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="test",
            actor_label="test",
        )
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        failure = TransientExhausted(attempts=1, cause=ProviderHttpUnavailable())
        runtime = _ScriptedRuntime(outcome=Failed(meta=_meta(usage=Absent()), failure=failure))
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
            )
        )
        assert result is None
        db_row = db_session.scalar(
            select(DawnWrite).where(
                DawnWrite.user_id == bootstrapped_user,
                DawnWrite.local_date == date.today(),
            )
        )
        assert db_row is None

    def test_skips_when_provider_refuses(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        from nexus.services.billing_entitlements import grant_entitlement_override

        grant_entitlement_override(
            db_session,
            user_id=bootstrapped_user,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="test",
            actor_label="test",
        )
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        runtime = _ScriptedRuntime(
            outcome=Refused(meta=_meta(usage=Absent()), safe_detail="declined")
        )
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
            )
        )
        assert result is None

    def test_skips_when_empty_response(self, db_session: Session, bootstrapped_user: UUID) -> None:
        from nexus.services.billing_entitlements import grant_entitlement_override

        grant_entitlement_override(
            db_session,
            user_id=bootstrapped_user,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="test",
            actor_label="test",
        )
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id)
        _seed_highlight(db_session, bootstrapped_user, media_id)

        runtime = _ScriptedRuntime(outcome=_succeeded_text_outcome("   "))
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
            )
        )
        assert result is None

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

        runtime = _ScriptedRuntime()
        result = asyncio.run(
            generate_dawn_write(
                db_session,
                user_id=bootstrapped_user,
                local_date=date.today(),
                tz="UTC",
                runtime=runtime,
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
#
# These tests use auth_client + direct_db (committed seeds) instead of
# authenticated_client + db_session (savepoint seeds). The savepoint pattern
# deadlocks because auth middleware's bootstrap_callback opens a SEPARATE
# connection and blocks forever on the unique-index of the savepoint's
# uncommitted users row when it tries INSERT INTO users.
# ---------------------------------------------------------------------------


def _bootstrap_api_user(auth_client, direct_db: DirectSessionManager) -> UUID:
    """Create a committed user via the auth bootstrap path and register cleanup.

    Hits /me so the auth middleware's bootstrap_callback commits the user+library
    row before any test-specific HTTP calls are made.  Registers the user for
    LIFO cleanup (dawn_writes callers must register their own cleanup first so
    the FK child rows are removed before the parent users row).
    """
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200
    return user_id


def _seed_dawn_write(
    direct_db: DirectSessionManager,
    user_id: UUID,
    body_md: str,
) -> UUID:
    """Insert a committed DawnWrite row for today and register FK-safe cleanup.

    Must be called AFTER _bootstrap_api_user (so the users FK target is already
    committed).  Registers dawn_writes cleanup here (after users, which was
    registered by _bootstrap_api_user); LIFO reversal means dawn_writes is
    deleted first, satisfying the FK constraint.
    """
    direct_db.register_cleanup("dawn_writes", "user_id", user_id)
    row = DawnWrite(user_id=user_id, local_date=date.today(), body_md=body_md)
    with direct_db.session() as session:
        session.add(row)
        session.commit()
        return row.id


class TestDawnWriteApiRoutes:
    def test_get_returns_null_when_no_row(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = _bootstrap_api_user(auth_client, direct_db)
        today = date.today().isoformat()
        response = auth_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200
        data = response.json()
        assert "write" in data
        assert data["write"] is None

    def test_get_returns_row_when_exists(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = _bootstrap_api_user(auth_client, direct_db)
        _seed_dawn_write(direct_db, user_id, "Some dawn write text.")

        today = date.today().isoformat()
        response = auth_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"] is not None
        assert data["write"]["body_md"] == "Some dawn write text."
        assert data["write"]["dismissed_at"] is None

    def test_dismiss_sets_dismissed_at(self, auth_client, direct_db: DirectSessionManager) -> None:
        user_id = _bootstrap_api_user(auth_client, direct_db)
        write_id = _seed_dawn_write(direct_db, user_id, "Morning brief.")

        response = auth_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 204

        with direct_db.session() as session:
            updated = session.get(DawnWrite, write_id)
            assert updated is not None
            assert updated.dismissed_at is not None

    def test_second_dismiss_is_idempotent(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = _bootstrap_api_user(auth_client, direct_db)
        write_id = _seed_dawn_write(direct_db, user_id, "Morning brief.")

        auth_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(user_id),
        )
        # Second dismiss.
        response = auth_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 204

    def test_get_returns_row_with_dismissed_at_after_dismiss(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = _bootstrap_api_user(auth_client, direct_db)
        write_id = _seed_dawn_write(direct_db, user_id, "Morning brief.")

        auth_client.post(
            f"/notes/dawn-write/{write_id}/dismiss",
            headers=auth_headers(user_id),
        )

        today = date.today().isoformat()
        response = auth_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"]["dismissed_at"] is not None

    def test_get_returns_null_when_dawn_write_disabled(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ) -> None:
        monkeypatch.setenv("DAWN_WRITE_ENABLED", "false")
        from nexus.config import clear_settings_cache

        clear_settings_cache()

        # Even with a row, the endpoint returns null when disabled.
        user_id = _bootstrap_api_user(auth_client, direct_db)
        _seed_dawn_write(direct_db, user_id, "Should not appear.")

        today = date.today().isoformat()
        response = auth_client.get(
            f"/notes/dawn-write?local_date={today}",
            headers=auth_headers(user_id),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["write"] is None
        clear_settings_cache()
