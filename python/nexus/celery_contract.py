"""Canonical Celery task contract for API + worker wiring.

Single source of truth for:
- required worker task names
- queue routes
- beat job task wiring
- deployment-visible contract fingerprint
"""

from __future__ import annotations

import hashlib
import json
from typing import Final

INGEST_QUEUE: Final[str] = "ingest"

# Tasks that must exist on ingest workers.
REQUIRED_WORKER_TASK_NAMES: frozenset[str] = frozenset(
    {
        "ingest_web_article",
        "ingest_epub",
        "ingest_pdf",
        "ingest_youtube_video",
        "backfill_default_library_closure_job",
        "podcast_sync_subscription_job",
        "podcast_transcribe_episode_job",
        "podcast_reindex_semantic_job",
        "podcast_active_subscription_poll_job",
        "reconcile_stale_ingest_media_job",
        "enrich_metadata",
    }
)


def build_task_routes() -> dict[str, dict[str, str]]:
    """Build deterministic task->queue routing map."""
    return {task_name: {"queue": INGEST_QUEUE} for task_name in sorted(REQUIRED_WORKER_TASK_NAMES)}


def build_beat_schedule(settings) -> dict[str, dict]:
    """Build Celery beat schedule from settings + canonical task names."""
    return {
        "podcast_active_subscription_poll": {
            "task": "podcast_active_subscription_poll_job",
            "schedule": float(settings.podcast_active_poll_schedule_seconds),
            "options": {"queue": INGEST_QUEUE},
        },
        "reconcile_stale_ingest_media": {
            "task": "reconcile_stale_ingest_media_job",
            "schedule": float(settings.ingest_reconcile_schedule_seconds),
            "options": {"queue": INGEST_QUEUE},
        },
    }


def _contract_payload() -> dict:
    routes = build_task_routes()
    return {
        "required_worker_task_names": sorted(REQUIRED_WORKER_TASK_NAMES),
        "task_routes": {k: routes[k] for k in sorted(routes)},
        "beat_jobs": {
            "podcast_active_subscription_poll": "podcast_active_subscription_poll_job",
            "reconcile_stale_ingest_media": "reconcile_stale_ingest_media_job",
        },
    }


TASK_CONTRACT_VERSION: str = hashlib.sha256(
    json.dumps(_contract_payload(), sort_keys=True).encode("utf-8")
).hexdigest()
