"""Integration tests for internal ingest recovery operations."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.jobs.queue import enqueue_job
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_internal_reconcile_endpoint_enqueues_recovery_job(
    auth_client,
    direct_db: DirectSessionManager,
):
    actor = create_test_user_id()
    with direct_db.session() as db:
        before_ids = {
            row[0]
            for row in db.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE kind = 'reconcile_stale_ingest_media_job'
                    """
                )
            ).fetchall()
        }

    response = auth_client.post("/internal/ingest/reconcile", headers=auth_headers(actor))

    assert response.status_code == 200, (
        f"Expected 200 from reconcile enqueue endpoint, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["task"] == "reconcile_stale_ingest_media_job", (
        f"Expected reconciler task name in payload, got: {data}"
    )
    assert data["enqueued"] is True, f"Expected enqueue confirmation, got: {data}"

    with direct_db.session() as db:
        after_ids = {
            row[0]
            for row in db.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE kind = 'reconcile_stale_ingest_media_job'
                    """
                )
            ).fetchall()
        }

    new_ids = sorted(after_ids - before_ids)
    assert len(new_ids) == 1, (
        "Expected exactly one new reconcile job row after enqueue endpoint call. "
        f"before={len(before_ids)}, after={len(after_ids)}, new_ids={new_ids}"
    )
    direct_db.register_cleanup("background_jobs", "id", new_ids[0])


def test_internal_reconcile_health_reports_stale_backlog(
    auth_client,
    direct_db: DirectSessionManager,
):
    actor = create_test_user_id()
    media_id = uuid4()
    attempt_id = uuid4()
    owner_id = uuid4()

    direct_db.register_cleanup("media_source_attempts", "id", attempt_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("users", "id", owner_id)

    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": owner_id})
        db.execute(
            text("""
                INSERT INTO media (
                    id, kind, title, processing_status, processing_attempts,
                    processing_started_at, created_by_user_id
                )
                VALUES (
                    :id, 'pdf', 'stale', 'extracting', 1,
                    now() - interval '2 hours', :owner_id
                )
            """),
            {
                "id": media_id,
                "owner_id": owner_id,
            },
        )
        db.execute(
            text(
                """
                INSERT INTO media_source_attempts (
                    id, media_id, created_by_user_id, source_type, attempt_no,
                    status, intent_key, source_payload
                )
                VALUES (
                    :attempt_id, :media_id, :owner_id, 'uploaded_pdf_file', 1,
                    'running', :intent_key, '{}'::jsonb
                )
                """
            ),
            {
                "attempt_id": attempt_id,
                "media_id": media_id,
                "owner_id": owner_id,
                "intent_key": f"health:{media_id}",
            },
        )
        db.commit()

    response = auth_client.get("/internal/ingest/reconcile/health", headers=auth_headers(actor))
    assert response.status_code == 200, (
        f"Expected 200 from reconcile health endpoint, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["stale_source_attempt_count"] >= 1, (
        f"Expected stale source count after inserting stale source state, got: {data}"
    )
    assert data["degraded"] is True, f"Expected degraded=True when stale rows exist, got: {data}"
    assert data["stale_threshold_seconds"] >= 1, (
        f"Expected positive stale threshold in health payload, got: {data}"
    )
    assert data["oldest_stale_source_attempt_age_seconds"]["kind"] == "Present"
    assert data["oldest_stale_source_attempt_age_seconds"]["value"] >= 7_199, (
        f"Expected stale age from database clock, got: {data}"
    )


def _insert_dead_job(db, *, kind: str, payload: dict[str, object]) -> UUID:
    job = enqueue_job(db, kind=kind, payload=payload, max_attempts=3)
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'dead',
                attempts = 3,
                error_code = 'E_INTERNAL',
                last_error = 'operator-visible failure',
                finished_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    return job.id


def test_internal_source_dead_replay_reuses_exact_operation(
    auth_client,
    direct_db: DirectSessionManager,
):
    actor = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(actor))
    media_id = uuid4()
    attempt_id = uuid4()
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO media (
                    id, kind, title, processing_status, created_by_user_id
                )
                VALUES (:media_id, 'pdf', 'suspended source', 'extracting', :actor)
                """
            ),
            {"media_id": media_id, "actor": actor},
        )
        db.execute(
            text(
                """
                INSERT INTO media_source_attempts (
                    id, media_id, created_by_user_id, source_type, attempt_no,
                    status, intent_key, source_payload
                )
                VALUES (
                    :attempt_id, :media_id, :actor, 'uploaded_pdf_file', 1,
                    'running', :intent_key, '{}'::jsonb
                )
                """
            ),
            {
                "attempt_id": attempt_id,
                "media_id": media_id,
                "actor": actor,
                "intent_key": f"dead-source:{media_id}",
            },
        )
        job_id = _insert_dead_job(
            db,
            kind="ingest_media_source",
            payload={
                "media_id": str(media_id),
                "attempt_id": str(attempt_id),
                "actor_user_id": str(actor),
                "request_id": None,
            },
        )
        db.execute(
            text("UPDATE media_source_attempts SET job_id = :job_id WHERE id = :attempt_id"),
            {"job_id": job_id, "attempt_id": attempt_id},
        )
        db.commit()

    direct_db.register_cleanup("background_jobs", "id", job_id)
    direct_db.register_cleanup("media_source_attempts", "id", attempt_id)
    direct_db.register_cleanup("media", "id", media_id)
    response = auth_client.post(
        f"/internal/ingest/source/{media_id}/retry-dead",
        headers=auth_headers(actor),
    )
    assert response.status_code == 200, response.text
    assert UUID(response.json()["data"]["job_id"]) == job_id
    with direct_db.session() as db:
        row = db.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at, error_code
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": job_id},
        ).one()
    assert row == ("pending", 0, None, None, "E_INTERNAL")


def test_internal_content_index_dead_replay_reuses_exact_revision(
    auth_client,
    direct_db: DirectSessionManager,
):
    actor = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(actor))
    media_id = uuid4()
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO media (
                    id, kind, title, processing_status, created_by_user_id
                )
                VALUES (:media_id, 'pdf', 'suspended index', 'ready_for_reading', :actor)
                """
            ),
            {"media_id": media_id, "actor": actor},
        )
        db.execute(
            text(
                """
                INSERT INTO content_index_states (
                    owner_kind, owner_id, status, status_reason, revision
                )
                VALUES ('media', :media_id, 'indexing', 'source_success', 7)
                """
            ),
            {"media_id": media_id},
        )
        job_id = _insert_dead_job(
            db,
            kind="media_content_reindex_job",
            payload={
                "media_id": str(media_id),
                "revision": 7,
                "reason": "source_success",
                "request_id": {"kind": "Absent"},
            },
        )
        db.commit()

    direct_db.register_cleanup("background_jobs", "id", job_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    response = auth_client.post(
        f"/internal/ingest/content-index/{media_id}/retry-dead",
        headers=auth_headers(actor),
    )
    assert response.status_code == 200, response.text
    assert UUID(response.json()["data"]["job_id"]) == job_id
    with direct_db.session() as db:
        row = db.execute(
            text("SELECT status, attempts FROM background_jobs WHERE id = :job_id"),
            {"job_id": job_id},
        ).one()
    assert row == ("pending", 0)
