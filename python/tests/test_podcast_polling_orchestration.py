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
