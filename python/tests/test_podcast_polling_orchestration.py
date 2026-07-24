"""Unit tests for worker entrypoint wiring and periodic polling orchestration."""

import pytest

pytestmark = pytest.mark.unit


def _clear_registry_cache() -> None:
    from nexus.config import clear_settings_cache
    from nexus.jobs import registry

    clear_settings_cache()
    registry._build_default_registry.cache_clear()
    registry.get_task_contract_version.cache_clear()


@pytest.fixture(autouse=True)
def _clear_registry_between_tests(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
    _clear_registry_cache()
    yield
    _clear_registry_cache()


def test_registry_uses_production_periodic_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS", raising=False)
    monkeypatch.delenv("INGEST_RECONCILE_SCHEDULE_SECONDS", raising=False)
    monkeypatch.delenv("SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS", raising=False)
    monkeypatch.delenv("BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS", raising=False)
    monkeypatch.delenv("ATLAS_PROJECT_SCHEDULE_SECONDS", raising=False)
    _clear_registry_cache()

    from nexus.jobs.registry import get_default_registry

    registry = get_default_registry()
    periodic_jobs = {
        kind: definition
        for kind, definition in registry.items()
        if definition.periodic_interval_seconds is not None
    }
    # Reconciliation, Dawn, and storage orphan cleanup are production background
    # schedules. Auth handoff purge remains registered but is maintenance-only,
    # so neither deployed lane can schedule it.
    assert set(periodic_jobs.keys()) == {
        "reconcile_stale_ingest_media_job",
        "purge_expired_auth_handoff_codes",
        "dawn_write_job",
        "storage_orphan_sweep",
    }, (
        "Expected production defaults plus registered maintenance schedules. "
        f"Periodic jobs={sorted(periodic_jobs)}"
    )


def test_registry_enables_periodic_jobs_from_positive_schedule_env(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS", "3600")
    monkeypatch.setenv("INGEST_RECONCILE_SCHEDULE_SECONDS", "7200")
    monkeypatch.setenv("SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS", "86400")
    monkeypatch.setenv("BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS", "86400")
    monkeypatch.setenv("ATLAS_PROJECT_SCHEDULE_SECONDS", "86400")
    _clear_registry_cache()

    from nexus.jobs.registry import get_default_registry

    registry = get_default_registry()
    periodic_jobs = {
        kind: definition.periodic_interval_seconds
        for kind, definition in registry.items()
        if definition.periodic_interval_seconds is not None
    }
    assert set(periodic_jobs.keys()) == {
        "podcast_active_subscription_poll_job",
        "reconcile_stale_ingest_media_job",
        "sync_gutenberg_catalog_job",
        "prune_background_jobs_job",
        "purge_expired_auth_handoff_codes",
        "dawn_write_job",
        "atlas_project_job",
        "storage_orphan_sweep",
    }, f"Unexpected periodic job set: {sorted(periodic_jobs.keys())}"
    assert periodic_jobs["podcast_active_subscription_poll_job"] == 3600
    assert periodic_jobs["reconcile_stale_ingest_media_job"] == 7200
    assert periodic_jobs["sync_gutenberg_catalog_job"] == 86400
    assert periodic_jobs["prune_background_jobs_job"] == 86400
    assert periodic_jobs["dawn_write_job"] == 3600
    assert periodic_jobs["atlas_project_job"] == 86400


def test_task_contract_version_is_not_schedule_env_dependent(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("INGEST_RECONCILE_SCHEDULE_SECONDS", raising=False)
    _clear_registry_cache()

    from nexus.jobs.registry import get_task_contract_version

    default_version = get_task_contract_version()

    monkeypatch.setenv("INGEST_RECONCILE_SCHEDULE_SECONDS", "3600")
    _clear_registry_cache()

    scheduled_version = get_task_contract_version()
    assert scheduled_version == default_version, (
        "Task contract version must fingerprint job capabilities, not runtime schedule env. "
        f"default={default_version}, scheduled={scheduled_version}"
    )


def test_worker_import_registers_all_required_tasks(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("WORKER_ALLOWED_JOB_KINDS", raising=False)
    monkeypatch.setenv("WORKER_LANE", "interactive")
    _clear_registry_cache()

    from apps.worker.main import create_worker

    from nexus.jobs.registry import get_default_registry

    worker = create_worker()
    registry_kinds = set(get_default_registry().keys())
    worker_kinds = set(worker.registry.keys())
    assert worker_kinds == registry_kinds, (
        "Worker must load all canonical job kinds from registry. "
        f"Worker={sorted(worker_kinds)}, Registry={sorted(registry_kinds)}"
    )
    assert "reconcile_stale_ingest_media_job" not in set(worker.allowed_kinds or ()), (
        "Interactive worker must not claim background jobs."
    )


def test_worker_rejects_missing_lane(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("WORKER_LANE", raising=False)
    monkeypatch.delenv("WORKER_ALLOWED_JOB_KINDS", raising=False)
    _clear_registry_cache()

    from apps.worker.main import create_worker

    with pytest.raises(RuntimeError, match="WORKER_LANE must be"):
        create_worker()


def test_reconciliation_is_claimable_only_by_background_lane(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("INGEST_RECONCILE_SCHEDULE_SECONDS", "3600")
    monkeypatch.delenv("WORKER_ALLOWED_JOB_KINDS", raising=False)
    monkeypatch.setenv("WORKER_LANE", "interactive")
    _clear_registry_cache()

    from apps.worker.main import create_worker

    worker = create_worker()
    assert "reconcile_stale_ingest_media_job" not in set(worker.allowed_kinds or ()), (
        "Interactive worker must not claim reconciliation."
    )

    monkeypatch.setenv("WORKER_LANE", "background")
    _clear_registry_cache()
    worker = create_worker()
    assert "reconcile_stale_ingest_media_job" in set(worker.allowed_kinds or ())


def test_worker_allows_only_explicit_maintenance_job_kinds(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WORKER_LANE", "maintenance")
    monkeypatch.setenv("NEXUS_ALLOW_WORKER_MAINTENANCE", "1")
    monkeypatch.setenv("WORKER_ALLOWED_JOB_KINDS", "prune_background_jobs_job")
    _clear_registry_cache()

    from apps.worker.main import create_worker

    worker = create_worker()
    allowed_kinds = set(worker.allowed_kinds or ())
    assert allowed_kinds == {"prune_background_jobs_job"}


def test_create_worker_installs_db_backed_rate_limiter(monkeypatch: pytest.MonkeyPatch):
    """The first job of any kind on a fresh worker (e.g. oracle) needs a working
    rate limiter, so startup must install it rather than individual task kinds."""
    from apps.worker.main import create_worker

    from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter

    monkeypatch.setenv("WORKER_LANE", "interactive")
    monkeypatch.delenv("WORKER_ALLOWED_JOB_KINDS", raising=False)
    _clear_registry_cache()
    set_rate_limiter(RateLimiter(session_factory=None))  # fresh-process limiter state

    create_worker()

    assert get_rate_limiter().backend_available, (
        "create_worker() must install a DB-backed rate limiter; without it the first "
        "LLM job on a fresh worker fails E_RATE_LIMITER_UNAVAILABLE."
    )


def test_prune_background_jobs_handler_wiring(monkeypatch: pytest.MonkeyPatch):
    observed_request_ids: list[str | None] = []

    def fake_prune_background_jobs_job(request_id: str | None = None) -> dict[str, int]:
        observed_request_ids.append(request_id)
        return {"deleted_count": 3}

    monkeypatch.setattr(
        "nexus.tasks.prune_background_jobs.prune_background_jobs_job",
        fake_prune_background_jobs_job,
    )
    _clear_registry_cache()

    from uuid import uuid4

    from nexus.jobs.queue import JobExecutionContext
    from nexus.jobs.registry import get_default_registry

    result = get_default_registry()["prune_background_jobs_job"].handler(
        payload={"request_id": "req-prune"},
        context=JobExecutionContext(job_id=uuid4(), worker_id="worker-test", attempt_no=1),
    )
    assert result == {"deleted_count": 3}
    assert observed_request_ids == ["req-prune"]
