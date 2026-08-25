"""Background job registry: handlers, retries, lease policy, and schedules."""

from __future__ import annotations

import hashlib
import importlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Literal, cast

from nexus.config import get_settings
from nexus.jobs.dead_letter_projections import DeadLetterProjection
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResourceClass,
    RescheduleRequested,
)
from nexus.services.podcasts.types import (
    PODCAST_REFRESH_RUN_PRUNE_INTERVAL_SECONDS,
    PODCAST_SYNC_JOB_LEASE_SECONDS,
)

JobHandler = Callable[..., Mapping[str, Any] | RescheduleRequested | None]
type ResourceFailureProjection = Literal["Job", "SourceAttemptMedia"]
type ChildRuntime = Literal["Base", "Llm"]
type ChildExitCleanup = Literal["None", "SourceAttemptParserTemp"]


@dataclass(frozen=True)
class JobDefinition:
    """Canonical policy for one background job kind."""

    kind: str
    handler_path: str
    resource_class: JobResourceClass
    max_attempts: int = 3
    retry_delays_seconds: tuple[int, ...] = (60, 300, 900)
    lease_seconds: int = 300
    periodic_interval_seconds: int | None = None
    periodic_priority: int = 100
    failed_result_statuses: tuple[str, ...] = ()
    dead_letter_projection: DeadLetterProjection = "None"
    wall_timeout_seconds: float = 900.0
    resource_failure_projection: ResourceFailureProjection = "Job"
    child_runtime: ChildRuntime = "Base"
    child_exit_cleanup: ChildExitCleanup = "None"
    # Dead rows of this kind are never deleted by prune_terminal_jobs (e.g. media
    # teardown/storage cleanup jobs, where a dead row must stay
    # operator-discoverable; requeue_dead_job is their repair transition).
    never_prune_dead: bool = False


def get_default_registry() -> dict[str, JobDefinition]:
    """Return the canonical runtime registry for all durable job kinds."""
    return _build_default_registry()


def resolve_job_handler(path: str) -> JobHandler:
    """Import one declaratively named handler only at its execution boundary."""
    return cast(JobHandler, _resolve_callable(path))


def _resolve_callable(path: str) -> Callable[..., Any]:
    module_name, separator, attribute_name = path.partition(":")
    if not separator or not module_name or not attribute_name or ":" in attribute_name:
        raise ValueError(f"Job handler path is malformed: {path!r}")
    value = getattr(importlib.import_module(module_name), attribute_name, None)
    if not callable(value):
        raise ValueError(f"Job handler path is not callable: {path!r}")
    return value


@lru_cache(maxsize=1)
def get_task_contract_digest() -> str:
    """Stable digest used for runtime and release contract checks."""
    definitions = get_default_registry()
    payload = [
        {
            "kind": definition.kind,
            "max_attempts": definition.max_attempts,
            "retry_delays_seconds": list(definition.retry_delays_seconds),
            "lease_seconds": definition.lease_seconds,
            "resource_class": definition.resource_class,
            "handler_path": definition.handler_path,
            "wall_timeout_seconds": definition.wall_timeout_seconds,
            "resource_failure_projection": definition.resource_failure_projection,
            "child_runtime": definition.child_runtime,
            "periodic_priority": definition.periodic_priority,
            "child_exit_cleanup": definition.child_exit_cleanup,
        }
        for definition in sorted(definitions.values(), key=lambda item: item.kind)
    ]
    encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def periodic_slot_start(*, now: datetime, interval_seconds: int) -> datetime:
    """Return UTC schedule bucket start for a periodic interval."""
    # justify-service-invariant-check: registry schedule config is runtime data.
    if interval_seconds <= 0:
        raise ValueError("periodic interval must be positive")
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    epoch_seconds = int(now.timestamp())
    interval = int(interval_seconds)
    slot_epoch = epoch_seconds - (epoch_seconds % interval)
    return datetime.fromtimestamp(slot_epoch, tz=UTC)


def periodic_dedupe_key(*, kind: str, slot_start: datetime) -> str:
    """Deterministic dedupe key for periodic enqueues."""
    return f"periodic:{kind}:{slot_start.isoformat()}"


@lru_cache(maxsize=1)
def _build_default_registry() -> dict[str, JobDefinition]:
    settings = get_settings()
    return {
        "ingest_media_source": JobDefinition(
            kind="ingest_media_source",
            handler_path="nexus.jobs.registry:_run_ingest_media_source",
            resource_class="Heavy",
            max_attempts=3,
            retry_delays_seconds=(60, 300),
            lease_seconds=300,
            wall_timeout_seconds=settings.background_process_wall_timeout_seconds,
            resource_failure_projection="SourceAttemptMedia",
            child_exit_cleanup="SourceAttemptParserTemp",
            never_prune_dead=True,
        ),
        "media_content_reindex_job": JobDefinition(
            kind="media_content_reindex_job",
            handler_path="nexus.jobs.registry:_run_media_content_reindex",
            resource_class="Heavy",
            max_attempts=3,
            retry_delays_seconds=(60, 300),
            lease_seconds=900,
            never_prune_dead=True,
        ),
        "enrich_metadata": JobDefinition(
            kind="enrich_metadata",
            handler_path="nexus.jobs.registry:_run_enrich_metadata",
            resource_class="Heavy",
            max_attempts=2,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            child_runtime="Llm",
            never_prune_dead=True,
        ),
        "chat_run": JobDefinition(
            kind="chat_run",
            handler_path="nexus.jobs.registry:_run_chat_run",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(30, 120, 300),
            lease_seconds=900,
            dead_letter_projection="ChatRun",
            never_prune_dead=True,
        ),
        # Universal dossier generation (resource-inspector-and-universal-dossiers
        # hard cutover). One job kind for all eight subject bindings, dispatched
        # through the DossierBindingRegistry by the durable job body itself
        # (CONTRACTS.md A19/B1a). Paid + non-idempotent:
        # a moderate retry budget covers a worker crash/restart before the
        # per-step Uncertain checkpoint commits; once a step is Uncertain on
        # replay, run_build raises (never auto-redispatches a billed call) and
        # the job dead-letters into the Suspended advisory instead of retrying.
        "dossier_build": JobDefinition(
            kind="dossier_build",
            handler_path="nexus.jobs.registry:_run_dossier_build",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(30, 120, 300),
            lease_seconds=900,
            dead_letter_projection="DossierBuild",
            never_prune_dead=True,
        ),
        "podcast_sync_subscription_job": JobDefinition(
            kind="podcast_sync_subscription_job",
            handler_path="nexus.jobs.registry:_run_podcast_sync_subscription",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=PODCAST_SYNC_JOB_LEASE_SECONDS,
            dead_letter_projection="PodcastSubscriptionSync",
        ),
        "podcast_backfill_subscription": JobDefinition(
            kind="podcast_backfill_subscription",
            handler_path="nexus.jobs.registry:_run_podcast_backfill_subscription",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
            failed_result_statuses=("failed",),
            dead_letter_projection="PodcastBackfill",
            never_prune_dead=True,
        ),
        "podcast_reindex_semantic_job": JobDefinition(
            kind="podcast_reindex_semantic_job",
            handler_path="nexus.jobs.registry:_run_podcast_reindex_semantic",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300),
            lease_seconds=300,
            never_prune_dead=True,
        ),
        "note_reindex_job": JobDefinition(
            kind="note_reindex_job",
            handler_path="nexus.jobs.registry:_run_note_reindex",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
            dead_letter_projection="NoteContentIndex",
        ),
        "podcast_refresh_due_job": JobDefinition(
            kind="podcast_refresh_due_job",
            handler_path="nexus.jobs.registry:_run_podcast_refresh_due",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=int(settings.podcast_refresh_due_schedule_seconds),
        ),
        "podcast_refresh_run_prune_job": JobDefinition(
            kind="podcast_refresh_run_prune_job",
            handler_path="nexus.jobs.registry:_run_podcast_refresh_run_prune",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=PODCAST_REFRESH_RUN_PRUNE_INTERVAL_SECONDS,
        ),
        "reconcile_stale_ingest_media_job": JobDefinition(
            kind="reconcile_stale_ingest_media_job",
            handler_path="nexus.jobs.registry:_run_reconcile_stale_ingest_media",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.ingest_reconcile_schedule_seconds)
                if settings.ingest_reconcile_schedule_seconds > 0
                else None
            ),
            periodic_priority=-1000,
        ),
        "sync_gutenberg_catalog_job": JobDefinition(
            kind="sync_gutenberg_catalog_job",
            handler_path="nexus.jobs.registry:_run_sync_gutenberg_catalog",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=7200,
            periodic_interval_seconds=(
                int(settings.sync_gutenberg_catalog_schedule_seconds)
                if settings.sync_gutenberg_catalog_schedule_seconds > 0
                else None
            ),
        ),
        "prune_background_jobs_job": JobDefinition(
            kind="prune_background_jobs_job",
            handler_path="nexus.jobs.registry:_run_prune_background_jobs",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.background_job_prune_schedule_seconds)
                if settings.background_job_prune_schedule_seconds > 0
                else None
            ),
        ),
        "purge_expired_auth_handoff_codes": JobDefinition(
            kind="purge_expired_auth_handoff_codes",
            handler_path="nexus.jobs.registry:_run_purge_expired_auth_handoff_codes",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=3600,
        ),
        "oracle_reading_generate": JobDefinition(
            kind="oracle_reading_generate",
            handler_path="nexus.jobs.registry:_run_oracle_reading_generate",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=450,
        ),
        "media_unit_build": JobDefinition(
            kind="media_unit_build",
            handler_path="nexus.jobs.registry:_run_media_unit_build",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=450,
            # Provider replay state lives in the job payload. Dead uncertain
            # transitions stay operator-discoverable.
            never_prune_dead=True,
            child_runtime="Llm",
        ),
        "synapse_scan": JobDefinition(
            kind="synapse_scan",
            handler_path="nexus.jobs.registry:_run_synapse_scan",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
            failed_result_statuses=("failed",),
            child_runtime="Llm",
        ),
        "dawn_write_job": JobDefinition(
            kind="dawn_write_job",
            handler_path="nexus.jobs.registry:_run_dawn_write_sweep",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=900,
            periodic_interval_seconds=(
                int(settings.dawn_write_schedule_seconds)
                if settings.dawn_write_schedule_seconds > 0
                else None
            ),
            child_runtime="Llm",
        ),
        "atlas_project_job": JobDefinition(
            kind="atlas_project_job",
            handler_path="nexus.jobs.registry:_run_atlas_project",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(120, 600, 1800),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.atlas_project_schedule_seconds)
                if settings.atlas_project_schedule_seconds > 0
                else None
            ),
        ),
        # Durable media teardown (spec §3.1). Dead rows are never pruned so a stuck
        # teardown stays operator-discoverable; requeue_dead_job is its repair path.
        # The dead-letter handler voids only the exact matching intent when the media
        # row is still live.
        "media_teardown": JobDefinition(
            kind="media_teardown",
            handler_path="nexus.jobs.registry:_run_media_teardown",
            resource_class="Light",
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=300,
            dead_letter_projection="MediaTeardownIntent",
            never_prune_dead=True,
        ),
        # Durable final-sweep reservation for in-process object writes (spec §3.1).
        # Dead rows stay unpruned; only Retained|Deleted success is prunable.
        "storage_object_cleanup": JobDefinition(
            kind="storage_object_cleanup",
            handler_path="nexus.jobs.registry:_run_storage_object_cleanup",
            resource_class="Light",
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=300,
            never_prune_dead=True,
        ),
        # Singleton recurring orphan sweep (spec §3.1), scheduled by the periodic
        # mechanism. Dead runs stay unpruned for requeue_dead_job repair.
        "storage_orphan_sweep": JobDefinition(
            kind="storage_orphan_sweep",
            handler_path="nexus.jobs.registry:_run_storage_orphan_sweep",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(300, 900, 3600),
            lease_seconds=300,
            periodic_interval_seconds=int(settings.storage_orphan_sweep_interval_seconds),
            never_prune_dead=True,
        ),
    }


def _run_ingest_media_source(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_media_source import ingest_media_source

    return ingest_media_source(
        media_id=str(payload["media_id"]),
        attempt_id=str(payload["attempt_id"]),
        actor_user_id=str(payload["actor_user_id"]),
        request_id=_optional_str(payload.get("request_id")),
        context=context,
    )


def _run_media_content_reindex(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.media_content_reindex import media_content_reindex_job

    return media_content_reindex_job(payload=payload, context=context)


def _run_enrich_metadata(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.enrich_metadata import enrich_metadata

    return enrich_metadata(
        media_id=str(payload["media_id"]),
        request_id=_optional_str(payload.get("request_id")),
        context=context,
    )


def _run_chat_run(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.chat_run import chat_run

    return chat_run(run_id=str(payload["run_id"]), context=context)


def _run_dossier_build(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.artifacts import dossier_build

    return dossier_build(payload=payload, context=context)


def _run_podcast_sync_subscription(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_sync_subscription import podcast_sync_subscription_job

    return podcast_sync_subscription_job(payload=payload, context=context)


def _run_podcast_backfill_subscription(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_backfill_subscription import podcast_backfill_subscription

    return podcast_backfill_subscription(payload=payload, context=context)


def _run_podcast_reindex_semantic(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_reindex_semantic import podcast_reindex_semantic_job

    return podcast_reindex_semantic_job(
        media_id=str(payload["media_id"]),
        requested_by_user_id=_optional_str(payload.get("requested_by_user_id")),
        request_reason=str(payload.get("request_reason", "operator_requeue")),
        request_id=_optional_str(payload.get("request_id")),
        context=context,
    )


def _run_note_reindex(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.note_reindex import note_reindex_job

    return note_reindex_job(
        note_block_id=str(payload["note_block_id"]),
        reason=str(payload.get("reason", "note_edit")),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_podcast_refresh_due(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_refresh_due import podcast_refresh_due_job

    return podcast_refresh_due_job()


def _run_podcast_refresh_run_prune(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_refresh_run_prune import podcast_refresh_run_prune_job

    return podcast_refresh_run_prune_job()


def _run_reconcile_stale_ingest_media(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

    return reconcile_stale_ingest_media_job(
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_sync_gutenberg_catalog(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.sync_gutenberg_catalog import sync_gutenberg_catalog_job

    return sync_gutenberg_catalog_job(
        request_id=_optional_str(payload.get("request_id")),
        scheduler_identity=_optional_str(payload.get("scheduler_identity")),
    )


def _run_prune_background_jobs(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.prune_background_jobs import prune_background_jobs_job

    return prune_background_jobs_job(request_id=_optional_str(payload.get("request_id")))


def _run_purge_expired_auth_handoff_codes(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.purge_expired_auth_handoff_codes import purge_expired_auth_handoff_codes_job

    return purge_expired_auth_handoff_codes_job(
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_oracle_reading_generate(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.oracle_reading import oracle_reading_generate

    return oracle_reading_generate(
        reading_id=str(payload["reading_id"]),
        context=context,
    )


def _run_media_unit_build(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.media_unit_build import media_unit_build

    return media_unit_build(
        media_id=str(payload["media_id"]),
        content_fingerprint=str(payload["content_fingerprint"]),
        context=context,
    )


def _run_synapse_scan(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.synapse_scan import synapse_scan

    return synapse_scan(
        user_id=str(payload["user_id"]),
        ref=str(payload["ref"]),
        reason=str(payload.get("reason", "manual")),
        context=context,
    )


def _run_dawn_write_sweep(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.dawn_write import dawn_write_sweep

    return dawn_write_sweep(context=context)


def _run_atlas_project(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | None:
    from nexus.tasks.atlas_project import atlas_project

    return atlas_project(payload=payload)


def _run_media_teardown(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.media_teardown import media_teardown

    return media_teardown(payload=payload, context=context)


def _run_storage_object_cleanup(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.storage_object_cleanup import storage_object_cleanup

    return storage_object_cleanup(payload=payload, context=context)


def _run_storage_orphan_sweep(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    from nexus.tasks.storage_orphan_sweep import storage_orphan_sweep

    return storage_orphan_sweep(payload=payload, context=context)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None
