"""Background job registry: handlers, retries, lease policy, and schedules."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import TYPE_CHECKING, Any

from nexus.config import get_settings
from nexus.jobs.queue import JobRow

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

JobHandler = Callable[..., Mapping[str, Any] | None]
JobDeadLetterHandler = Callable[["Session", JobRow], None]


@dataclass(frozen=True)
class JobDefinition:
    """Canonical policy for one background job kind."""

    kind: str
    handler: JobHandler
    max_attempts: int = 3
    retry_delays_seconds: tuple[int, ...] = (60, 300, 900)
    lease_seconds: int = 300
    periodic_interval_seconds: int | None = None
    failed_result_statuses: tuple[str, ...] = ()
    dead_letter_handler: JobDeadLetterHandler | None = None


# Non-periodic kinds whose work a user directly observes (ingest progress, chat/
# oracle/intelligence output, search indexing, subscription sync, shared-library
# backfill). Every kind here must be claimable by the production worker.
# test_config.py asserts this tuple is a subset of the default allowlist and that
# the default allowlist contains only registered kinds.
USER_FACING_JOB_KINDS = (
    "ingest_media_source",
    "enrich_metadata",
    "chat_run",
    "library_intelligence_artifact_generate",
    "media_unit_build",
    "note_reindex_job",
    "podcast_sync_subscription_job",
    "podcast_reindex_semantic_job",
    "backfill_default_library_closure_job",
    "oracle_reading_generate",
    "synapse_scan",
    "contributor_reconciliation",
)


def get_default_registry() -> dict[str, JobDefinition]:
    """Return the canonical runtime registry for all durable job kinds."""
    return _build_default_registry()


@lru_cache(maxsize=1)
def get_task_contract_version() -> str:
    """Stable fingerprint used for health/deploy contract checks."""
    definitions = get_default_registry()
    payload = [
        {
            "kind": definition.kind,
            "max_attempts": definition.max_attempts,
            "retry_delays_seconds": list(definition.retry_delays_seconds),
            "lease_seconds": definition.lease_seconds,
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
            handler=_run_ingest_media_source,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
        ),
        "enrich_metadata": JobDefinition(
            kind="enrich_metadata",
            handler=_run_enrich_metadata,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=120,
            failed_result_statuses=("failed",),
        ),
        "chat_run": JobDefinition(
            kind="chat_run",
            handler=_run_chat_run,
            max_attempts=3,
            retry_delays_seconds=(30, 120, 300),
            lease_seconds=900,
            dead_letter_handler=_dead_letter_chat_run,
        ),
        "library_intelligence_artifact_generate": JobDefinition(
            kind="library_intelligence_artifact_generate",
            handler=_run_library_intelligence_artifact_generate,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=900,
        ),
        "podcast_sync_subscription_job": JobDefinition(
            kind="podcast_sync_subscription_job",
            handler=_run_podcast_sync_subscription,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
        ),
        "podcast_reindex_semantic_job": JobDefinition(
            kind="podcast_reindex_semantic_job",
            handler=_run_podcast_reindex_semantic,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
        ),
        "note_reindex_job": JobDefinition(
            kind="note_reindex_job",
            handler=_run_note_reindex,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
            dead_letter_handler=_dead_letter_note_reindex,
        ),
        "podcast_active_subscription_poll_job": JobDefinition(
            kind="podcast_active_subscription_poll_job",
            handler=_run_podcast_active_subscription_poll,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.podcast_active_poll_schedule_seconds)
                if settings.podcast_active_poll_schedule_seconds > 0
                else None
            ),
        ),
        "reconcile_stale_ingest_media_job": JobDefinition(
            kind="reconcile_stale_ingest_media_job",
            handler=_run_reconcile_stale_ingest_media,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.ingest_reconcile_schedule_seconds)
                if settings.ingest_reconcile_schedule_seconds > 0
                else None
            ),
        ),
        "sync_gutenberg_catalog_job": JobDefinition(
            kind="sync_gutenberg_catalog_job",
            handler=_run_sync_gutenberg_catalog,
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
            handler=_run_prune_background_jobs,
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
            handler=_run_purge_expired_auth_handoff_codes,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=3600,
        ),
        "backfill_default_library_closure_job": JobDefinition(
            kind="backfill_default_library_closure_job",
            handler=_run_backfill_default_library_closure,
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=900,
        ),
        "oracle_reading_generate": JobDefinition(
            kind="oracle_reading_generate",
            handler=_run_oracle_reading_generate,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,  # worst case: retrieval + 45s call + 45s repair round
        ),
        "media_unit_build": JobDefinition(
            kind="media_unit_build",
            handler=_run_media_unit_build,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
            failed_result_statuses=("failed",),
        ),
        "synapse_scan": JobDefinition(
            kind="synapse_scan",
            handler=_run_synapse_scan,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
            failed_result_statuses=("failed",),
        ),
        "dawn_write_job": JobDefinition(
            kind="dawn_write_job",
            handler=_run_dawn_write_sweep,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=(
                int(settings.dawn_write_schedule_seconds)
                if settings.dawn_write_schedule_seconds > 0
                else None
            ),
        ),
        "contributor_reconciliation": JobDefinition(
            kind="contributor_reconciliation",
            handler=_run_contributor_reconciliation,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
        ),
    }


def _run_ingest_media_source(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_media_source import ingest_media_source

    return ingest_media_source(
        media_id=str(payload["media_id"]),
        attempt_id=str(payload["attempt_id"]),
        actor_user_id=str(payload["actor_user_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_enrich_metadata(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.enrich_metadata import enrich_metadata

    return enrich_metadata(
        media_id=str(payload["media_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_chat_run(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.chat_run import chat_run

    return chat_run(run_id=str(payload["run_id"]))


def _dead_letter_chat_run(db: Session, job: JobRow) -> None:
    from nexus.tasks.chat_run import finalize_dead_lettered_chat_run

    finalize_dead_lettered_chat_run(db, job)


def _run_library_intelligence_artifact_generate(
    *, payload: Mapping[str, Any]
) -> Mapping[str, Any] | None:
    from nexus.tasks.library_intelligence import library_intelligence_artifact_generate

    return library_intelligence_artifact_generate(revision_id=str(payload["revision_id"]))


def _run_podcast_sync_subscription(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_sync_subscription import podcast_sync_subscription_job

    return podcast_sync_subscription_job(
        user_id=str(payload["user_id"]),
        podcast_id=str(payload["podcast_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_podcast_reindex_semantic(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_reindex_semantic import podcast_reindex_semantic_job

    return podcast_reindex_semantic_job(
        media_id=str(payload["media_id"]),
        requested_by_user_id=_optional_str(payload.get("requested_by_user_id")),
        request_reason=str(payload.get("request_reason", "operator_requeue")),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_note_reindex(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.note_reindex import note_reindex_job

    return note_reindex_job(
        note_block_id=str(payload["note_block_id"]),
        reason=str(payload.get("reason", "note_edit")),
        request_id=_optional_str(payload.get("request_id")),
    )


def _dead_letter_note_reindex(db: Session, job: JobRow) -> None:
    """Mark the note's content index failed once reindex retries are exhausted.

    Runs inside the worker's dead-letter transaction (no commit here). Skips a
    malformed note_block_id payload (the only non-retryable failure) so it cannot raise.
    """
    from uuid import UUID

    from nexus.errors import ApiErrorCode
    from nexus.services.content_indexing import IndexOwner, mark_content_index_failed

    note_block_id = job.payload.get("note_block_id")
    if not note_block_id:
        return
    try:
        owner_id = UUID(str(note_block_id))
    except (TypeError, ValueError):
        return
    mark_content_index_failed(
        db,
        owner=IndexOwner("note_block", owner_id),
        failure_code=ApiErrorCode.E_INTERNAL.value,
        failure_message=(job.last_error or "Note reindex exhausted retries.")[:1000],
    )


def _run_podcast_active_subscription_poll(
    *, payload: Mapping[str, Any]
) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_active_subscription_poll import podcast_active_subscription_poll_job

    return podcast_active_subscription_poll_job(
        request_id=_optional_str(payload.get("request_id")),
        scheduler_identity=_optional_str(payload.get("scheduler_identity")),
    )


def _run_reconcile_stale_ingest_media(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

    return reconcile_stale_ingest_media_job(
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_sync_gutenberg_catalog(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.sync_gutenberg_catalog import sync_gutenberg_catalog_job

    return sync_gutenberg_catalog_job(
        request_id=_optional_str(payload.get("request_id")),
        scheduler_identity=_optional_str(payload.get("scheduler_identity")),
    )


def _run_prune_background_jobs(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.prune_background_jobs import prune_background_jobs_job

    return prune_background_jobs_job(request_id=_optional_str(payload.get("request_id")))


def _run_purge_expired_auth_handoff_codes(
    *, payload: Mapping[str, Any]
) -> Mapping[str, Any] | None:
    from nexus.tasks.purge_expired_auth_handoff_codes import purge_expired_auth_handoff_codes_job

    return purge_expired_auth_handoff_codes_job(
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_backfill_default_library_closure(
    *, payload: Mapping[str, Any]
) -> Mapping[str, Any] | None:
    from nexus.tasks.backfill_default_library_closure import backfill_default_library_closure_job

    return backfill_default_library_closure_job(
        default_library_id=str(payload["default_library_id"]),
        source_library_id=str(payload["source_library_id"]),
        user_id=str(payload["user_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_oracle_reading_generate(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.oracle_reading import oracle_reading_generate

    return oracle_reading_generate(reading_id=str(payload["reading_id"]))


def _run_media_unit_build(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.media_unit_build import media_unit_build

    return media_unit_build(media_id=str(payload["media_id"]))


def _run_synapse_scan(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.synapse_scan import synapse_scan

    return synapse_scan(
        user_id=str(payload["user_id"]),
        ref=str(payload["ref"]),
        reason=str(payload.get("reason", "manual")),
    )


def _run_dawn_write_sweep(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.dawn_write import dawn_write_sweep

    return dawn_write_sweep()


def _run_contributor_reconciliation(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.contributor_reconciliation import contributor_reconciliation

    return contributor_reconciliation(
        scope=str(payload.get("scope", "media")),
        media_id=_optional_str(payload.get("media_id")),
        podcast_id=_optional_str(payload.get("podcast_id")),
        reason=str(payload.get("reason", "unspecified")),
        request_id=_optional_str(payload.get("request_id")),
    )


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None
