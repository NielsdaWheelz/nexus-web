"""Every durable job kind: its lane, policy, handler and hooks, in one table.

Handlers and hooks are ``module:fn`` paths, imported only where they run. A
handler runs on its lane: in the interactive worker's own process, or in one
bounded child per job on the background lane. A hook runs inside a queue
transition's transaction in the worker process itself, so a background kind's
hooks live in import-light modules (``apps/worker/main.py`` refuses to start a
background supervisor that imported a storage, provider or parser graph).
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal

from nexus.config import get_settings

type Lane = Literal["interactive", "background"]


@dataclass(frozen=True)
class JobDefinition:
    lane: Lane
    # fn(*, payload, context) -> JobResult.
    handler: str
    max_attempts: int = 3
    # Attempt n failing waits retry_delays[n - 1] (the last delay repeats).
    retry_delays: tuple[int, ...] = (60, 300, 900)
    # Holds the one cluster-wide Heavy capacity lease while running.
    heavy: bool = False
    # Enqueued once per UTC slot of this length.
    periodic_seconds: int | None = None
    periodic_priority: int = 200
    # Terminal rows the hourly prune keeps.
    keep_succeeded: bool = False
    keep_dead: bool = False
    # Payload key naming the parser-temp root removed after each child.
    parser_temp_key: str | None = None
    # fn(db, job) -> Mapping | None, under the claim before a failed attempt settles:
    # a result says the owner's work already finished, and the job completes with it.
    on_failure: str | None = None
    # fn(db, job) in the transaction that makes the job dead.
    on_dead: str | None = None
    # fn(db, job, execution_id) after each retry, dead, reclaim or reschedule: job is
    # the row after the transition, execution_id the attempt the transition ended.
    on_history: str | None = None


def resolve(path: str) -> Any:
    module, _, name = path.partition(":")
    return getattr(importlib.import_module(module), name)


_GENERATION_DEAD = "nexus.services.generation.ledger:on_dead_letter"
_HOURS = (60, 300, 900, 3600, 21600)


@cache
def registry() -> dict[str, JobDefinition]:
    s = get_settings()
    return {
        # Interactive lane: a user is waiting; handlers run in process.
        "chat_run": JobDefinition(
            "interactive",
            "nexus.services.chat.worker:run_job",
            retry_delays=(30, 120, 300),
            keep_dead=True,
            on_dead="nexus.services.chat.worker:on_dead_letter",
        ),
        # Paid: a retry after a worker death reruns the synthesis from scratch.
        "dossier_build": JobDefinition(
            "interactive",
            "nexus.services.dossier.run:run_job",
            retry_delays=(30, 120, 300),
            keep_dead=True,
            on_dead=_GENERATION_DEAD,
        ),
        "enrich_metadata": JobDefinition(
            "interactive",
            "nexus.tasks.enrich_metadata:run_job",
            max_attempts=2,
            retry_delays=(0,),
            keep_succeeded=True,
            keep_dead=True,
            on_dead=_GENERATION_DEAD,
        ),
        "oracle_reading_generate": JobDefinition(
            "interactive",
            "nexus.services.oracle.readings:run_job",
            retry_delays=(0,),
            on_dead=_GENERATION_DEAD,
        ),
        "podcast_sync_subscription_job": JobDefinition(
            "interactive",
            "nexus.services.podcasts.sync:run_job",
            on_dead="nexus.services.podcasts.sync:dead_letter",
        ),
        # Background lane: one fresh, memory-bounded child per job.
        "ingest_media_source": JobDefinition(
            "background",
            "nexus.services.source_runner:run_job",
            retry_delays=(60, 300),
            heavy=True,
            keep_dead=True,
            parser_temp_key="attempt_id",
            on_failure="nexus.services.source_publication:on_failure",
            on_dead="nexus.services.source_publication:on_dead_letter",
            on_history="nexus.services.import_history:on_source_job_outcome",
        ),
        "media_content_reindex_job": JobDefinition(
            "background",
            "nexus.services.content_indexing:run_media_reindex_job",
            retry_delays=(60, 300),
            heavy=True,
            keep_dead=True,
            on_history="nexus.services.import_history:on_index_job_outcome",
        ),
        "note_reindex_job": JobDefinition(
            "background",
            "nexus.services.note_indexing:run_note_reindex_job",
            on_dead="nexus.jobs.dead_letters:note_index",
        ),
        "media_unit_build": JobDefinition(
            "background",
            "nexus.tasks.media_unit_build:run_job",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:media_unit_build",
        ),
        "connection_discovery_scan": JobDefinition(
            "background",
            "nexus.services.connection_discovery:connection_discovery_scan_job",
            on_dead=_GENERATION_DEAD,
        ),
        "podcast_backfill_subscription": JobDefinition(
            "background",
            "nexus.services.podcasts.backfill:run_job",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:podcast_backfill",
        ),
        "media_teardown": JobDefinition(
            "background",
            "nexus.services.media_deletion:run_teardown_job",
            max_attempts=5,
            retry_delays=_HOURS,
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:media_teardown",
        ),
        # Background upkeep, one job per slot.
        "podcast_refresh_due_job": JobDefinition(
            "background",
            "nexus.services.podcasts.sync:run_due_job",
            max_attempts=1,
            retry_delays=(0,),
            periodic_seconds=s.podcast_refresh_due_schedule_seconds,
        ),
        "atlas_project_job": JobDefinition(
            "background",
            "nexus.services.atlas:atlas_project_job",
            retry_delays=(120, 600, 1800),
            periodic_seconds=s.atlas_project_schedule_seconds or None,
        ),
        "storage_orphan_sweep": JobDefinition(
            "background",
            "nexus.tasks.storage_orphan_sweep:storage_orphan_sweep",
            retry_delays=(300, 900, 3600),
            periodic_seconds=6 * 3600,
            keep_dead=True,
        ),
        "prune_background_jobs_job": JobDefinition(
            "background",
            "nexus.jobs.queue:prune_job",
            max_attempts=1,
            retry_delays=(0,),
            periodic_seconds=3600,
        ),
        "purge_expired_auth_handoff_codes": JobDefinition(
            "background",
            "nexus.services.auth_handoff_codes:purge_job",
            max_attempts=1,
            retry_delays=(0,),
            periodic_seconds=3600,
        ),
    }
