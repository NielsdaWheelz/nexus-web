"""Focused unit proof for Podcast refresh orchestration vocabulary and wiring."""

from uuid import uuid4

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


def test_registry_owns_due_prune_and_exact_sync_dead_letter():
    from nexus.jobs.registry import get_default_registry
    from nexus.services.podcasts.types import (
        PODCAST_REFRESH_RUN_PRUNE_INTERVAL_SECONDS,
        PODCAST_SYNC_JOB_LEASE_SECONDS,
    )

    registry = get_default_registry()
    due = registry["podcast_refresh_due_job"]
    prune = registry["podcast_refresh_run_prune_job"]
    sync = registry["podcast_sync_subscription_job"]

    assert due.periodic_interval_seconds == 900
    assert prune.periodic_interval_seconds == PODCAST_REFRESH_RUN_PRUNE_INTERVAL_SECONDS
    assert sync.lease_seconds == PODCAST_SYNC_JOB_LEASE_SECONDS
    assert sync.dead_letter_handler is not None
    assert sync.failed_result_statuses == ()
    assert "podcast_active_subscription_poll_job" not in registry


def test_due_schedule_is_runtime_configurable_but_prune_is_fixed(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("PODCAST_REFRESH_DUE_SCHEDULE_SECONDS", "1800")
    _clear_registry_cache()

    from nexus.jobs.registry import get_default_registry

    registry = get_default_registry()
    assert registry["podcast_refresh_due_job"].periodic_interval_seconds == 1800
    assert registry["podcast_refresh_run_prune_job"].periodic_interval_seconds == 86_400


@pytest.mark.parametrize(
    ("items", "expected"),
    [
        ([], ("Complete", 0, 0, 0, 0, 0, 0, 0)),
        ([("Pending", 0)], ("Running", 1, 0, 0, 0, 0, 0, 0)),
        ([("Running", 0)], ("Running", 1, 0, 0, 0, 0, 0, 0)),
        (
            [("Complete", 2), ("Pending", 0)],
            ("Running", 2, 1, 1, 0, 0, 0, 2),
        ),
        ([("Complete", 2)], ("Complete", 1, 1, 1, 0, 0, 0, 2)),
        ([("SourceLimited", 3)], ("Complete", 1, 1, 0, 1, 0, 0, 3)),
        (
            [("Complete", 2), ("Failed", 0)],
            ("Partial", 2, 2, 1, 0, 1, 0, 2),
        ),
        (
            [("SourceLimited", 1), ("Skipped", 0)],
            ("Partial", 2, 2, 0, 1, 0, 1, 1),
        ),
        ([("Failed", 0)], ("Failed", 1, 1, 0, 0, 1, 0, 0)),
        ([("Failed", 0), ("Skipped", 0)], ("Failed", 2, 2, 0, 0, 1, 1, 0)),
        ([("Skipped", 0)], ("Complete", 1, 1, 0, 0, 0, 1, 0)),
    ],
)
def test_refresh_aggregation_is_ordered_and_total(items, expected):
    from nexus.services.podcasts.refresh import aggregate_refresh_item_statuses

    result = aggregate_refresh_item_statuses(items)
    assert (
        result.status,
        result.requested_count,
        result.finished_count,
        result.succeeded_count,
        result.source_limited_count,
        result.failed_count,
        result.skipped_count,
        result.new_episode_count,
    ) == expected


def test_sync_payload_is_closed_and_epoch_generation_dedupes():
    from nexus.services.podcasts.refresh import (
        podcast_sync_dedupe_key,
        podcast_sync_payload,
    )
    from nexus.services.podcasts.sync import PodcastSyncPayload

    subscription_id = uuid4()
    user_id = uuid4()
    podcast_id = uuid4()
    wire = podcast_sync_payload(
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
        sync_generation=7,
    )
    assert PodcastSyncPayload.parse(wire).wire() == wire
    assert podcast_sync_dedupe_key(subscription_id, 7) == f"podcast-sync:{subscription_id}:7"

    with pytest.raises(ValueError, match="unexpected fields"):
        PodcastSyncPayload.parse({**wire, "request_id": "legacy"})
    for invalid in (0, -1):
        with pytest.raises(ValueError, match="positive integer"):
            PodcastSyncPayload.parse({**wire, "sync_generation": invalid})
    for invalid in (1.0, "1", True):
        with pytest.raises(ValueError, match="must be an integer"):
            PodcastSyncPayload.parse({**wire, "sync_generation": invalid})


def test_refresh_handle_is_canonical_tamper_evident(monkeypatch: pytest.MonkeyPatch):
    import base64

    from nexus.config import clear_settings_cache
    from nexus.services.podcasts.handles import (
        InvalidPodcastRefreshRunHandle,
        seal_podcast_refresh_run,
        unseal_podcast_refresh_run,
    )

    monkeypatch.setenv(
        "STREAM_TOKEN_SIGNING_KEY",
        base64.b64encode(b"r" * 32).decode("ascii"),
    )
    clear_settings_cache()
    run_id = uuid4()
    handle = seal_podcast_refresh_run(run_id)
    assert unseal_podcast_refresh_run(handle) == run_id
    assert len(handle.split(".")[1]) == 22
    assert len(handle.split(".")[2]) == 22

    replacement = "A" if handle[-1] != "A" else "B"
    with pytest.raises(InvalidPodcastRefreshRunHandle):
        unseal_podcast_refresh_run(f"{handle[:-1]}{replacement}")
