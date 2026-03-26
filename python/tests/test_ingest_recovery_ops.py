"""Integration tests for internal ingest recovery operations."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text

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
    owner_id = uuid4()
    started_at = datetime.now(UTC) - timedelta(hours=2)

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
                    :id, 'pdf', 'stale', 'extracting', 1, :started_at, :owner_id
                )
            """),
            {
                "id": media_id,
                "started_at": started_at,
                "owner_id": owner_id,
            },
        )
        db.commit()

    response = auth_client.get("/internal/ingest/reconcile/health", headers=auth_headers(actor))
    assert response.status_code == 200, (
        f"Expected 200 from reconcile health endpoint, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["stale_count"] >= 1, (
        f"Expected stale_count >= 1 after inserting stale media row, got: {data}"
    )
    assert data["degraded"] is True, f"Expected degraded=True when stale rows exist, got: {data}"
    assert data["stale_threshold_seconds"] >= 1, (
        f"Expected positive stale threshold in health payload, got: {data}"
    )
