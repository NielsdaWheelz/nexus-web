"""Unit tests for podcast active polling orchestration wiring."""

import pytest

pytestmark = pytest.mark.unit


def test_celery_registers_scheduled_active_polling_job():
    from nexus.celery import celery_app

    beat_schedule = celery_app.conf.beat_schedule or {}
    assert "podcast_active_subscription_poll" in beat_schedule, (
        "expected celery beat schedule to include podcast active subscription polling job"
    )
    scheduled = beat_schedule["podcast_active_subscription_poll"]
    assert scheduled["task"] == "podcast_active_subscription_poll_job", (
        f"unexpected task name for podcast polling schedule: {scheduled}"
    )
    assert float(scheduled["schedule"]) > 0.0, (
        f"expected positive schedule interval, got: {scheduled}"
    )

    task_routes = celery_app.conf.task_routes or {}
    assert task_routes.get("podcast_active_subscription_poll_job") == {"queue": "ingest"}, (
        "expected podcast active polling task route to ingest queue"
    )
    assert task_routes.get("ingest_pdf") == {"queue": "ingest"}, (
        "expected ingest_pdf task route to ingest queue"
    )
    assert task_routes.get("reconcile_stale_ingest_media_job") == {"queue": "ingest"}, (
        "expected stale ingest reconciler task route to ingest queue"
    )
    assert "reconcile_stale_ingest_media" in beat_schedule, (
        "expected celery beat schedule to include stale ingest reconciler"
    )


def test_worker_import_registers_all_required_tasks():
    from apps.worker.main import REQUIRED_TASK_NAMES, celery_app

    registered = set(celery_app.tasks.keys())
    missing = REQUIRED_TASK_NAMES - registered
    assert not missing, f"worker missing required task registrations: {sorted(missing)}"
