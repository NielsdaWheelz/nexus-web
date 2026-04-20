"""Unit tests for periodic polling orchestration wiring."""

import pytest

pytestmark = pytest.mark.unit


def test_registry_marks_periodic_jobs_with_positive_intervals():
    from nexus.jobs.registry import get_default_registry

    registry = get_default_registry()
    periodic_jobs = {
        kind: definition
        for kind, definition in registry.items()
        if definition.periodic_interval_seconds is not None
    }
    assert set(periodic_jobs.keys()) == {
        "podcast_active_subscription_poll_job",
        "reconcile_stale_ingest_media_job",
        "sync_gutenberg_catalog_job",
    }, f"Unexpected periodic job set: {sorted(periodic_jobs.keys())}"
    for kind, definition in periodic_jobs.items():
        assert int(definition.periodic_interval_seconds or 0) > 0, (
            f"Expected periodic interval > 0 for {kind}, got {definition.periodic_interval_seconds}"
        )


def test_worker_import_registers_all_required_tasks():
    from apps.worker.main import create_worker

    from nexus.jobs.registry import get_default_registry

    worker = create_worker()
    registry_kinds = set(get_default_registry().keys())
    worker_kinds = set(worker.registry.keys())
    assert worker_kinds == registry_kinds, (
        "Worker must load all canonical job kinds from registry. "
        f"Worker={sorted(worker_kinds)}, Registry={sorted(registry_kinds)}"
    )
