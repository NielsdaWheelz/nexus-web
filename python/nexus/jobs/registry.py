"""Background job registry: one policy record and one handler per kind.

A handler path names either a task that already takes ``(payload, context)`` or a
``_run_*`` adapter here that parses the payload and calls the owning service.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID

from nexus.config import get_settings
from nexus.jobs.dead_letter_projections import DeadLetterProjection
from nexus.jobs.history_projections import HistoryProjection
from nexus.jobs.process_executor import ChildRuntime
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResourceClass,
    JobResult,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from nexus.services.generation.runtime import Runtime

type Payload = Mapping[str, Any]
type ResourceFailureProjection = Literal["Job", "SourceAttemptMedia"]
JobHandler = Callable[..., JobResult]
Context = JobExecutionContext

CHAT_RUN_LEASE_SECONDS = 1_200


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
    periodic_priority: int = 200
    failed_result_statuses: tuple[str, ...] = ()
    dead_letter_projection: DeadLetterProjection = "None"
    history_projection: HistoryProjection = "None"
    resource_failure_projection: ResourceFailureProjection = "Job"
    child_runtime: ChildRuntime = "Base"
    # Dead rows of this kind are never pruned: a failed import, teardown, chat
    # run or dossier stays operator-discoverable and requeueable.
    never_prune_dead: bool = False
    never_prune_succeeded: bool = False


def get_default_registry() -> dict[str, JobDefinition]:
    """The canonical runtime registry for every durable job kind."""
    return _build_default_registry()


def resolve_job_handler(path: str) -> JobHandler:
    """Import one declaratively named handler only at its execution boundary."""
    module_name, separator, attribute_name = path.partition(":")
    if not separator:
        raise ValueError(f"Job handler path is malformed: {path!r}")
    return cast(JobHandler, getattr(importlib.import_module(module_name), attribute_name))


def periodic_slot_start(*, now: datetime, interval_seconds: int) -> datetime:
    """Floor a UTC instant to its periodic schedule bucket."""
    if interval_seconds <= 0:
        raise ValueError("periodic interval must be positive")
    epoch_seconds = int(now.replace(tzinfo=now.tzinfo or UTC).timestamp())
    return datetime.fromtimestamp(epoch_seconds - (epoch_seconds % interval_seconds), tz=UTC)


def periodic_dedupe_key(*, kind: str, slot_start: datetime) -> str:
    """Deterministic cluster-wide dedupe key for one periodic slot."""
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
            dead_letter_projection="SourceAttempt",
            resource_failure_projection="SourceAttemptMedia",
            history_projection="SourceAttempt",
            never_prune_dead=True,
        ),
        "media_content_reindex_job": JobDefinition(
            kind="media_content_reindex_job",
            handler_path="nexus.tasks.media_content_reindex:media_content_reindex_job",
            resource_class="Heavy",
            max_attempts=3,
            retry_delays_seconds=(60, 300),
            lease_seconds=900,
            history_projection="ContentIndex",
            never_prune_dead=True,
        ),
        "enrich_metadata": JobDefinition(
            kind="enrich_metadata",
            handler_path="nexus.jobs.registry:_run_enrich_metadata",
            resource_class="Light",
            max_attempts=2,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            dead_letter_projection="Generation",
            never_prune_dead=True,
            never_prune_succeeded=True,
        ),
        "chat_run": JobDefinition(
            kind="chat_run",
            handler_path="nexus.jobs.registry:_run_chat_run",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(30, 120, 300),
            lease_seconds=CHAT_RUN_LEASE_SECONDS,
            dead_letter_projection="ChatRun",
            never_prune_dead=True,
        ),
        # Paid: a retry after a worker death reruns the synthesis from scratch.
        "dossier_build": JobDefinition(
            kind="dossier_build",
            handler_path="nexus.jobs.registry:_run_dossier_build",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(30, 120, 300),
            lease_seconds=900,
            dead_letter_projection="Generation",
            never_prune_dead=True,
        ),
        "podcast_sync_subscription_job": JobDefinition(
            kind="podcast_sync_subscription_job",
            handler_path="nexus.jobs.registry:_run_podcast_sync_subscription",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
            dead_letter_projection="PodcastSubscriptionSync",
        ),
        "podcast_backfill_subscription": JobDefinition(
            kind="podcast_backfill_subscription",
            handler_path="nexus.jobs.registry:_run_podcast_backfill_subscription",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
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
            periodic_interval_seconds=settings.podcast_refresh_due_schedule_seconds,
        ),
        "reconcile_stale_ingest_media_job": JobDefinition(
            kind="reconcile_stale_ingest_media_job",
            handler_path="nexus.jobs.registry:_run_reconcile_stale_ingest_media",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=settings.ingest_reconcile_schedule_seconds or None,
            # Recovery runs ahead of every other queued kind.
            periodic_priority=-1000,
        ),
        "sync_gutenberg_catalog_job": JobDefinition(
            kind="sync_gutenberg_catalog_job",
            handler_path="nexus.jobs.registry:_run_sync_gutenberg_catalog",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=7200,
            periodic_interval_seconds=settings.sync_gutenberg_catalog_schedule_seconds or None,
        ),
        "prune_background_jobs_job": JobDefinition(
            kind="prune_background_jobs_job",
            handler_path="nexus.jobs.registry:_run_prune_background_jobs",
            resource_class="Light",
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=3600,
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
            dead_letter_projection="Generation",
        ),
        "media_unit_build": JobDefinition(
            kind="media_unit_build",
            handler_path="nexus.jobs.registry:_run_media_unit_build",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=450,
            child_runtime="Llm",
            dead_letter_projection="Generation",
            never_prune_dead=True,
        ),
        "connection_discovery_scan": JobDefinition(
            kind="connection_discovery_scan",
            handler_path="nexus.jobs.registry:_run_connection_discovery_scan",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
            child_runtime="Llm",
            dead_letter_projection="Generation",
        ),
        "atlas_project_job": JobDefinition(
            kind="atlas_project_job",
            handler_path="nexus.jobs.registry:_run_atlas_project",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(120, 600, 1800),
            lease_seconds=300,
            periodic_interval_seconds=settings.atlas_project_schedule_seconds or None,
        ),
        "media_teardown": JobDefinition(
            kind="media_teardown",
            handler_path="nexus.tasks.media_teardown:media_teardown",
            resource_class="Light",
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=300,
            dead_letter_projection="MediaTeardownIntent",
            never_prune_dead=True,
        ),
        "storage_object_cleanup": JobDefinition(
            kind="storage_object_cleanup",
            handler_path="nexus.tasks.storage_object_cleanup:storage_object_cleanup",
            resource_class="Light",
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=300,
            never_prune_dead=True,
        ),
        "storage_orphan_sweep": JobDefinition(
            kind="storage_orphan_sweep",
            handler_path="nexus.jobs.registry:_run_storage_orphan_sweep",
            resource_class="Light",
            max_attempts=3,
            retry_delays_seconds=(300, 900, 3600),
            lease_seconds=300,
            periodic_interval_seconds=settings.storage_orphan_sweep_interval_seconds,
            never_prune_dead=True,
        ),
    }


def _run_ingest_media_source(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.logging import get_logger
    from nexus.services.media_source_ingest import run_source_attempt

    result = run_source_attempt(
        session_factory=get_session_factory(),
        media_id=UUID(str(payload["media_id"])),
        attempt_id=UUID(str(payload["attempt_id"])),
        actor_user_id=UUID(str(payload["actor_user_id"])),
        request_id=payload.get("request_id"),
        context=context,
    )
    get_logger(__name__).info(
        "ingest_media_source_completed",
        media_id=str(payload["media_id"]),
        attempt_id=str(payload["attempt_id"]),
        result=result,
        request_id=payload.get("request_id"),
    )
    return result


def _run_enrich_metadata(*, payload: Payload, context: Context) -> JobResult:
    from nexus.tasks.enrich_metadata import enrich_metadata

    return enrich_metadata(
        media_id=str(payload["media_id"]),
        request_id=payload.get("request_id"),
        requester_user_id=UUID(str(payload["requester_user_id"])),
        context=context,
    )


def _run_chat_run(*, payload: Payload, context: Context) -> JobResult:
    from nexus.services.chat.worker import chat_run

    return chat_run(run_id=str(payload["run_id"]), context=context)


def _run_dossier_build(*, payload: Payload, context: Context) -> JobResult:
    """Compose the web search provider and run one build attempt.

    ``run.run_build`` owns every terminal write; an unexpected exception goes to
    the queue's retry and dead-letter policy, which the head reads as Suspended.
    """
    import httpx

    from nexus.services.dossier.run import run_build
    from nexus.services.generation.runtime import run_generation_job
    from nexus.services.tool_runtime.catalog import compose_configured_web_search_provider

    build_id = UUID(str(payload["build_id"]))

    async def handler(db: Session, runtime: Runtime) -> JobResult:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0), trust_env=False
        ) as client:
            web = compose_configured_web_search_provider(client, settings=get_settings())
            reschedule = await run_build(
                db, build_id=build_id, ctx=context, runtime=runtime, web=web
            )
        return reschedule or {"status": "ok", "build_id": str(build_id)}

    return run_generation_job("dossier_build", context, handler)


def _run_podcast_sync_subscription(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.services.podcasts import sync

    with get_session_factory()() as db:
        return sync.run(db, dict(payload))


def _run_podcast_backfill_subscription(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.services.podcasts import backfill

    with get_session_factory()() as db:
        return backfill.run_step(db, dict(payload))


def _run_podcast_reindex_semantic(*, payload: Payload, context: Context) -> JobResult:
    from nexus.services.transcripts.request_reason import require_transcript_request_reason
    from nexus.tasks.podcast_reindex_semantic import podcast_reindex_semantic_job

    return podcast_reindex_semantic_job(
        media_id=str(payload["media_id"]),
        request_reason=require_transcript_request_reason(payload.get("request_reason")),
        context=context,
    )


def _run_note_reindex(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.models import NoteBlock
    from nexus.db.session import get_session_factory
    from nexus.logging import get_logger
    from nexus.services import connection_discovery
    from nexus.services.note_indexing import rebuild_note_content_index
    from nexus.services.resource_graph.refs import ResourceRef

    block_id = UUID(str(payload["note_block_id"]))
    reason = str(payload["reason"])
    with get_session_factory()() as db:
        try:
            index_result = rebuild_note_content_index(db, note_block_id=block_id, reason=reason)
            block = db.get(NoteBlock, block_id)
            if block is not None:
                connection_discovery.queue_connection_discovery_scan(
                    db,
                    user_id=block.user_id,
                    ref=ResourceRef(scheme="note_block", id=block_id),
                    reason="note_reindex",
                )
            db.commit()
        except Exception:
            db.rollback()
            get_logger(__name__).exception(
                "note_reindex_task_failed",
                note_block_id=str(block_id),
                reason=reason,
                job_id=str(context.job_id),
            )
            raise
    return {
        "owner": {"kind": index_result.owner.kind, "id": str(index_result.owner.id)},
        "status": index_result.status,
        "chunk_count": index_result.chunk_count,
    }


def _run_podcast_refresh_due(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.services.podcasts import sync

    with get_session_factory()() as db:
        limit = get_settings().podcast_refresh_due_limit
        return {"subscription_count": sync.admit_due(db, limit=limit)}


def _run_reconcile_stale_ingest_media(*, payload: Payload, context: Context) -> JobResult:
    from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

    return reconcile_stale_ingest_media_job(request_id=payload.get("request_id"))


def _run_sync_gutenberg_catalog(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.logging import get_logger
    from nexus.services.gutenberg import sync_project_gutenberg_catalog

    with get_session_factory()() as db:
        result = sync_project_gutenberg_catalog(db)
    get_logger(__name__).info(
        "gutenberg_catalog_sync_completed",
        request_id=str(payload["request_id"]),
        scheduler_identity=str(payload["scheduler_identity"]),
        result=result,
    )
    return result


def _run_prune_background_jobs(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.jobs.queue import prune_terminal_jobs
    from nexus.logging import get_logger

    settings = get_settings()
    definitions = get_default_registry().values()
    with get_session_factory()() as db:
        deleted = prune_terminal_jobs(
            db,
            succeeded_after_days=settings.background_job_prune_succeeded_after_days,
            dead_after_days=settings.background_job_prune_dead_after_days,
            limit=settings.background_job_prune_batch_size,
            excluded_dead_kinds={d.kind for d in definitions if d.never_prune_dead},
            excluded_succeeded_kinds={d.kind for d in definitions if d.never_prune_succeeded},
        )
        db.commit()
    get_logger(__name__).info(
        "background_jobs_pruned", deleted_count=deleted, request_id=str(payload["request_id"])
    )
    return {"deleted_count": deleted}


def _run_purge_expired_auth_handoff_codes(*, payload: Payload, context: Context) -> JobResult:
    from nexus.db.session import get_session_factory
    from nexus.logging import get_logger
    from nexus.services.auth_handoff_codes import purge_expired_auth_handoff_codes

    with get_session_factory()() as db:
        deleted = purge_expired_auth_handoff_codes(db)
        db.commit()
    get_logger(__name__).info(
        "auth_handoff_codes_purged", deleted_count=deleted, request_id=str(payload["request_id"])
    )
    return {"deleted_count": deleted}


def _run_oracle_reading_generate(*, payload: Payload, context: Context) -> JobResult:
    from nexus.services.oracle.readings import run_reading_job

    return run_reading_job(reading_id=UUID(str(payload["reading_id"])), context=context)


def _run_media_unit_build(*, payload: Payload, context: Context) -> JobResult:
    from nexus.tasks.media_unit_build import media_unit_build

    return media_unit_build(
        media_id=str(payload["media_id"]),
        content_fingerprint=str(payload["content_fingerprint"]),
        context=context,
    )


def _run_connection_discovery_scan(*, payload: Payload, context: Context) -> JobResult:
    from nexus.services.connection_discovery import connection_discovery_scan_job

    return connection_discovery_scan_job(payload, context=context)


def _run_atlas_project(*, payload: Payload, context: Context) -> JobResult:
    from nexus.services.atlas import atlas_project_job

    return atlas_project_job()


def _run_storage_orphan_sweep(*, payload: Payload, context: Context) -> JobResult:
    from nexus.tasks.storage_orphan_sweep import storage_orphan_sweep

    return storage_orphan_sweep(context=context)
