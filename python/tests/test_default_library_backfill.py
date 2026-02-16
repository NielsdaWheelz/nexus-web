"""Tests for S4 PR-05: default library backfill jobs and requeue endpoint.

Tests cover:
- Backfill job state machine (pending -> running -> completed/failed)
- Claim idempotency and status guards
- Retry logic with deterministic delays
- Requeue endpoint semantics (reset, idempotent running, 404 missing)
- Materialize closure for source
- Guardrail health check
- Validate backfill job tuple integrity
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.default_library_closure import (
    BACKFILL_MAX_ATTEMPTS,
    BACKFILL_PENDING_AGE_P95_GUARDRAIL_SECONDS,
    BACKFILL_PENDING_COUNT_GUARDRAIL,
    BACKFILL_RETRY_DELAYS_SECONDS,
    claim_backfill_job_pending,
    get_backfill_backlog_health,
    mark_backfill_job_completed,
    mark_backfill_job_failed,
    materialize_closure_for_source,
    requeue_backfill_job,
    reset_backfill_job_to_pending_for_retry,
    validate_backfill_job_tuple,
)
from tests.helpers import create_test_user_id

# =============================================================================
# Helpers
# =============================================================================


def _create_user(db: Session, user_id: UUID) -> UUID:
    """Create user + default library, return default library id."""
    return ensure_user_and_default_library(db, user_id)


def _create_non_default_library(db: Session, owner_id: UUID, name: str = "shared") -> UUID:
    """Create a non-default library owned by owner_id, return library id."""
    lib_id = uuid4()
    db.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :owner, :name, false)
        """),
        {"id": lib_id, "owner": owner_id, "name": name},
    )
    return lib_id


def _add_membership(db: Session, library_id: UUID, user_id: UUID, role: str = "member") -> None:
    """Add membership row."""
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:lib, :uid, :role)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "uid": user_id, "role": role},
    )


def _create_media(db: Session) -> UUID:
    """Create a bare media row, return media id."""
    media_id = uuid4()
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, 'pdf', 'test', 'pending')
        """),
        {"id": media_id},
    )
    return media_id


def _add_library_media(db: Session, library_id: UUID, media_id: UUID) -> None:
    """Insert library_media row."""
    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:lib, :media)
            ON CONFLICT DO NOTHING
        """),
        {"lib": library_id, "media": media_id},
    )


def _insert_backfill_job(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
    status: str = "pending",
    attempts: int = 0,
    error_code: str | None = None,
) -> None:
    """Insert a backfill job row directly.

    Respects the check constraint: finished_at must be non-null for
    failed/completed statuses.
    """
    now = datetime.now(UTC)
    finished = now if status in ("failed", "completed") else None
    db.execute(
        text("""
            INSERT INTO default_library_backfill_jobs
                (default_library_id, source_library_id, user_id,
                 status, attempts, last_error_code, created_at, updated_at,
                 finished_at)
            VALUES (:dl, :src, :uid, :status, :att, :err, :now, :now, :fin)
        """),
        {
            "dl": default_library_id,
            "src": source_library_id,
            "uid": user_id,
            "status": status,
            "att": attempts,
            "err": error_code,
            "now": now,
            "fin": finished,
        },
    )


def _get_job_status(db: Session, dl: UUID, src: UUID, uid: UUID) -> str | None:
    """Read current job status."""
    row = db.execute(
        text("""
            SELECT status FROM default_library_backfill_jobs
            WHERE default_library_id = :dl
              AND source_library_id = :src
              AND user_id = :uid
        """),
        {"dl": dl, "src": src, "uid": uid},
    ).fetchone()
    return row[0] if row else None


def _get_job_attempts(db: Session, dl: UUID, src: UUID, uid: UUID) -> int | None:
    """Read current job attempts."""
    row = db.execute(
        text("""
            SELECT attempts FROM default_library_backfill_jobs
            WHERE default_library_id = :dl
              AND source_library_id = :src
              AND user_id = :uid
        """),
        {"dl": dl, "src": src, "uid": uid},
    ).fetchone()
    return row[0] if row else None


# =============================================================================
# State machine tests
# =============================================================================


class TestBackfillJobStateMachine:
    """Tests for the backfill job state machine transitions."""

    def test_claim_pending_transitions_to_running(self, db_session: Session):
        """claim_backfill_job_pending: pending -> running."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _add_membership(db_session, src_id, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="pending")

        result = claim_backfill_job_pending(db_session, dl_id, src_id, user_id)

        assert result is not None
        assert result["status"] == "running"
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "running"

    def test_claim_returns_none_if_not_pending(self, db_session: Session):
        """claim_backfill_job_pending: non-pending row returns None."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="running")

        result = claim_backfill_job_pending(db_session, dl_id, src_id, user_id)
        assert result is None

    def test_claim_returns_none_if_missing(self, db_session: Session):
        """claim_backfill_job_pending: missing row returns None."""
        result = claim_backfill_job_pending(db_session, uuid4(), uuid4(), uuid4())
        assert result is None

    def test_mark_completed_transitions_running_to_completed(self, db_session: Session):
        """mark_backfill_job_completed: running -> completed."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="running")

        ok = mark_backfill_job_completed(db_session, dl_id, src_id, user_id)
        assert ok is True
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "completed"

    def test_mark_completed_rejects_non_running(self, db_session: Session):
        """mark_backfill_job_completed: pending row is not transitioned."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="pending")

        ok = mark_backfill_job_completed(db_session, dl_id, src_id, user_id)
        assert ok is False
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "pending"

    def test_mark_failed_increments_attempts(self, db_session: Session):
        """mark_backfill_job_failed: running -> failed with attempt increment."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="running", attempts=1)

        new_attempts = mark_backfill_job_failed(db_session, dl_id, src_id, user_id, "test_error")
        assert new_attempts == 2
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "failed"
        assert _get_job_attempts(db_session, dl_id, src_id, user_id) == 2

    def test_mark_failed_rejects_non_running(self, db_session: Session):
        """mark_backfill_job_failed: pending row returns 0 and no update."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="pending", attempts=0)

        new_attempts = mark_backfill_job_failed(db_session, dl_id, src_id, user_id, "test_error")
        assert new_attempts == 0
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "pending"

    def test_reset_to_pending_transitions_failed_to_pending(self, db_session: Session):
        """reset_backfill_job_to_pending_for_retry: failed -> pending."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(
            db_session,
            dl_id,
            src_id,
            user_id,
            status="failed",
            attempts=1,
            error_code="some_err",
        )

        ok = reset_backfill_job_to_pending_for_retry(db_session, dl_id, src_id, user_id)
        assert ok is True
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "pending"

    def test_reset_to_pending_rejects_non_failed(self, db_session: Session):
        """reset_backfill_job_to_pending_for_retry: running row returns False."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="running")

        ok = reset_backfill_job_to_pending_for_retry(db_session, dl_id, src_id, user_id)
        assert ok is False
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "running"


# =============================================================================
# Materialize closure tests
# =============================================================================


class TestMaterializeClosureForSource:
    """Tests for materialize_closure_for_source."""

    def test_inserts_edges_and_materializes_default_row(self, db_session: Session):
        """Materializes closure edges and library_media for default library."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)

        media1 = _create_media(db_session)
        media2 = _create_media(db_session)
        _add_library_media(db_session, src_id, media1)
        _add_library_media(db_session, src_id, media2)

        edges = materialize_closure_for_source(db_session, dl_id, src_id)
        assert edges == 2

        # Verify edges exist
        edge_count = db_session.execute(
            text("""
                SELECT COUNT(*) FROM default_library_closure_edges
                WHERE default_library_id = :dl AND source_library_id = :src
            """),
            {"dl": dl_id, "src": src_id},
        ).scalar()
        assert edge_count == 2

        # Verify library_media rows exist in default library
        lm_count = db_session.execute(
            text("""
                SELECT COUNT(*) FROM library_media
                WHERE library_id = :dl AND media_id IN (:m1, :m2)
            """),
            {"dl": dl_id, "m1": media1, "m2": media2},
        ).scalar()
        assert lm_count == 2

    def test_idempotent_on_repeat_call(self, db_session: Session):
        """Repeated materialize inserts zero new edges (idempotent)."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)

        media1 = _create_media(db_session)
        _add_library_media(db_session, src_id, media1)

        edges1 = materialize_closure_for_source(db_session, dl_id, src_id)
        assert edges1 == 1

        edges2 = materialize_closure_for_source(db_session, dl_id, src_id)
        assert edges2 == 0

    def test_empty_source_returns_zero(self, db_session: Session):
        """Source library with no media -> zero edges inserted."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)

        edges = materialize_closure_for_source(db_session, dl_id, src_id)
        assert edges == 0


# =============================================================================
# Validate tuple integrity tests
# =============================================================================


class TestValidateBackfillJobTuple:
    """Tests for validate_backfill_job_tuple."""

    def test_valid_tuple_returns_none(self, db_session: Session):
        """Valid tuple returns None (no error)."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id)

        error = validate_backfill_job_tuple(db_session, dl_id, src_id, user_id)
        assert error is None

    def test_missing_job_row(self, db_session: Session):
        """Missing job row returns error string."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)

        error = validate_backfill_job_tuple(db_session, dl_id, src_id, user_id)
        assert error == "job_row_missing"

    def test_default_library_not_owned_by_user(self, db_session: Session):
        """Default library owned by a different user -> error."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        dl_a = _create_user(db_session, user_a)
        _create_user(db_session, user_b)
        src_id = _create_non_default_library(db_session, user_a)
        # Job with user_b but user_a's default library
        _insert_backfill_job(db_session, dl_a, src_id, user_b)

        error = validate_backfill_job_tuple(db_session, dl_a, src_id, user_b)
        assert error == "default_library_invalid"

    def test_source_library_missing_returns_job_row_missing(self, db_session: Session):
        """Non-existent source library means no job row can exist (FK), so job_row_missing."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        fake_src = uuid4()
        # Cannot insert a job with a FK-violating source, so validate sees no row
        error = validate_backfill_job_tuple(db_session, dl_id, fake_src, user_id)
        assert error == "job_row_missing"

    def test_source_library_is_default(self, db_session: Session):
        """Source library is a default library -> error."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        dl_a = _create_user(db_session, user_a)
        dl_b = _create_user(db_session, user_b)
        # Using user_b's default library as source
        _insert_backfill_job(db_session, dl_a, dl_b, user_a)

        error = validate_backfill_job_tuple(db_session, dl_a, dl_b, user_a)
        assert error == "source_library_is_default"


# =============================================================================
# Requeue service tests
# =============================================================================


class TestRequeueBackfillJob:
    """Tests for requeue_backfill_job service function."""

    def test_requeue_failed_resets_to_pending(self, db_session: Session):
        """Failed job is reset to pending with zeroed attempts."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(
            db_session,
            dl_id,
            src_id,
            user_id,
            status="failed",
            attempts=3,
            error_code="some_err",
        )

        data = requeue_backfill_job(db_session, dl_id, src_id, user_id)
        assert data["status"] == "pending"
        assert data["attempts"] == 0
        assert data["idempotent"] is False
        assert _get_job_status(db_session, dl_id, src_id, user_id) == "pending"

    def test_requeue_completed_resets_to_pending(self, db_session: Session):
        """Completed job is reset to pending."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="completed")

        data = requeue_backfill_job(db_session, dl_id, src_id, user_id)
        assert data["status"] == "pending"
        assert data["idempotent"] is False

    def test_requeue_pending_is_idempotent_reset(self, db_session: Session):
        """Pending job is reset (attempts zeroed) but still not idempotent flag."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="pending")

        data = requeue_backfill_job(db_session, dl_id, src_id, user_id)
        assert data["status"] == "pending"
        assert data["idempotent"] is False

    def test_requeue_running_is_idempotent_noop(self, db_session: Session):
        """Running job returns idempotent=True, no state change."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src_id = _create_non_default_library(db_session, user_id)
        _insert_backfill_job(db_session, dl_id, src_id, user_id, status="running")

        data = requeue_backfill_job(db_session, dl_id, src_id, user_id)
        assert data["idempotent"] is True
        assert data["enqueue_dispatched"] is False
        assert data["status"] == "running"

    def test_requeue_missing_raises_not_found(self, db_session: Session):
        """Missing job raises NotFoundError."""
        with pytest.raises(NotFoundError):
            requeue_backfill_job(db_session, uuid4(), uuid4(), uuid4())


# =============================================================================
# Guardrail tests
# =============================================================================


class TestBackfillBacklogHealth:
    """Tests for get_backfill_backlog_health."""

    def test_health_returns_expected_keys(self, db_session: Session):
        """Health check returns dict with expected keys and types."""
        health = get_backfill_backlog_health(db_session)
        assert "pending_count" in health
        assert "pending_age_p95_seconds" in health
        assert "degraded" in health
        assert isinstance(health["pending_count"], int)
        assert isinstance(health["pending_age_p95_seconds"], float)
        assert isinstance(health["degraded"], bool)

    def test_pending_jobs_counted(self, db_session: Session):
        """Pending jobs appear in count."""
        user_id = create_test_user_id()
        dl_id = _create_user(db_session, user_id)
        src1 = _create_non_default_library(db_session, user_id, "s1")
        src2 = _create_non_default_library(db_session, user_id, "s2")
        _insert_backfill_job(db_session, dl_id, src1, user_id, status="pending")
        _insert_backfill_job(db_session, dl_id, src2, user_id, status="pending")

        health = get_backfill_backlog_health(db_session)
        assert health["pending_count"] >= 2


# =============================================================================
# Constants sanity tests
# =============================================================================


class TestBackfillConstants:
    """Verify spec-mandated constant values."""

    def test_retry_delays(self):
        assert BACKFILL_RETRY_DELAYS_SECONDS == (60, 300, 900, 3600, 21600)

    def test_max_attempts(self):
        assert BACKFILL_MAX_ATTEMPTS == 5

    def test_guardrail_age(self):
        assert BACKFILL_PENDING_AGE_P95_GUARDRAIL_SECONDS == 900

    def test_guardrail_count(self):
        assert BACKFILL_PENDING_COUNT_GUARDRAIL == 500
