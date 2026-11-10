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

FAILED_EXECUTION_LIMIT = 3


@dataclass(frozen=True)
class JobDefinition:
    lane: Lane
    # fn(*, payload, context) -> JobResult.
    handler: str
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
    # fn(db, job): lock domain rows before the queue row during worker settlement.
    lock_owner: str | None = None
    # fn(db, job) in the transaction that makes the job dead.
    on_dead: str | None = None
    # fn(db, job, execution_id) after each retry, dead, reclaim or reschedule: job is
    # the row after the transition, execution_id the attempt the transition ended.
    on_history: str | None = None


def resolve(path: str) -> Any:
    module, _, name = path.partition(":")
    return getattr(importlib.import_module(module), name)


@cache
def registry() -> dict[str, JobDefinition]:
    s = get_settings()
    return {
        # Interactive lane: a user is waiting; handlers run in process.
        "chat_run": JobDefinition(
            "interactive",
            "nexus.services.chat.worker:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            keep_dead=True,
            on_dead="nexus.services.chat.worker:on_dead_letter",
        ),
        "enrich_metadata": JobDefinition(
            "background",
            "nexus.tasks.enrich_metadata:run_job",
            keep_succeeded=True,
            keep_dead=True,
        ),
        "discover_document_parts": JobDefinition(
            "interactive",
            "nexus.tasks.discover_document_parts:run_job",
            keep_succeeded=True,
            keep_dead=True,
        ),
        "oracle_reading_generate": JobDefinition(
            "interactive",
            "nexus.services.oracle.readings:run_job",
        ),
        # Background lane: one fresh, memory-bounded child per job.
        "suggestion_shortlist_refresh": JobDefinition(
            "background",
            "nexus.services.suggestion_shortlists:run_suggestion_refresh_job",
            keep_dead=True,
        ),
        "ingest_media_source": JobDefinition(
            "background",
            "nexus.services.source_runner:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            heavy=True,
            keep_dead=True,
            parser_temp_key="attempt_id",
            on_failure="nexus.services.source_publication:on_failure",
            on_dead="nexus.services.source_publication:on_dead_letter",
            on_history="nexus.services.import_history:on_source_job_outcome",
        ),
        "capture_x_quote": JobDefinition(
            "background",
            "nexus.tasks.capture_x_quote:run_job",
            keep_succeeded=True,
            keep_dead=True,
        ),
        "archive_x_capture_assets": JobDefinition(
            "background",
            "nexus.tasks.archive_x_capture_assets:run_job",
            keep_succeeded=True,
            keep_dead=True,
        ),
        "x_capture_content_reindex": JobDefinition(
            "background",
            "nexus.tasks.x_capture_content_reindex:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:x_capture_index",
        ),
        "media_content_reindex_job": JobDefinition(
            "background",
            "nexus.services.content_indexing:run_media_reindex_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            heavy=True,
            keep_dead=True,
            on_history="nexus.services.import_history:on_index_job_outcome",
        ),
        "authored_text_reindex_job": JobDefinition(
            "background",
            "nexus.services.authored_text_indexing:run_authored_text_reindex_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            on_dead="nexus.jobs.dead_letters:authored_text_index",
        ),
        "media_unit_build": JobDefinition(
            "background",
            "nexus.tasks.media_unit_build:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:media_unit_build",
        ),
        "connection_discovery_scan": JobDefinition(
            "background",
            "nexus.services.connection_discovery:connection_discovery_scan_job",
        ),
        "daily_brief_due_job": JobDefinition(
            "background",
            "nexus.services.suggestion_shortlists:run_daily_due_job",
            periodic_seconds=60,
        ),
        "feed_opml_step": JobDefinition(
            "background",
            "nexus.services.feeds.opml:run_job",
            keep_dead=True,
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            on_dead="nexus.jobs.dead_letters:feed_opml",
        ),
        "feed_page": JobDefinition(
            "background",
            "nexus.services.feeds.traversal:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:feed_run",
        ),
        "podcast_chapters": JobDefinition(
            "background",
            "nexus.services.podcasts.chapters:run_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            on_dead="nexus.jobs.dead_letters:podcast_chapters",
        ),
        "media_teardown": JobDefinition(
            "background",
            "nexus.services.media_deletion:run_teardown_job",
            lock_owner="nexus.jobs.dead_letters:lock_owner",
            keep_dead=True,
            on_dead="nexus.jobs.dead_letters:media_teardown",
        ),
        # Background upkeep, one job per slot.
        "feed_refresh_due_job": JobDefinition(
            "background",
            "nexus.services.feeds.sync:run_due_job",
            periodic_seconds=s.feed_refresh_due_schedule_seconds,
        ),
        "atlas_project_job": JobDefinition(
            "background",
            "nexus.services.atlas:atlas_project_job",
            periodic_seconds=s.atlas_project_schedule_seconds or None,
        ),
        "storage_orphan_sweep": JobDefinition(
            "background",
            "nexus.tasks.storage_orphan_sweep:storage_orphan_sweep",
            periodic_seconds=6 * 3600,
            keep_dead=True,
        ),
        "prune_background_jobs_job": JobDefinition(
            "background",
            "nexus.jobs.queue:prune_job",
            periodic_seconds=3600,
        ),
        "purge_expired_auth_handoff_codes": JobDefinition(
            "background",
            "nexus.services.auth_handoff_codes:purge_job",
            periodic_seconds=3600,
        ),
    }
