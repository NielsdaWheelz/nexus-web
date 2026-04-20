"""Background job registry: handlers, retries, lease policy, and schedules."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from nexus.config import get_settings

JobHandler = Callable[..., Mapping[str, Any] | None]


@dataclass(frozen=True)
class JobDefinition:
    """Canonical policy for one background job kind."""

    kind: str
    handler: JobHandler
    max_attempts: int = 3
    retry_delays_seconds: tuple[int, ...] = (60, 300, 900)
    lease_seconds: int = 300
    periodic_interval_seconds: int | None = None


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
            "periodic_interval_seconds": definition.periodic_interval_seconds,
        }
        for definition in sorted(definitions.values(), key=lambda item: item.kind)
    ]
    encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def periodic_slot_start(*, now: datetime, interval_seconds: int) -> datetime:
    """Return UTC schedule bucket start for a periodic interval."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    epoch_seconds = int(now.timestamp())
    interval = max(int(interval_seconds), 1)
    slot_epoch = epoch_seconds - (epoch_seconds % interval)
    return datetime.fromtimestamp(slot_epoch, tz=UTC)


def periodic_dedupe_key(*, kind: str, slot_start: datetime) -> str:
    """Deterministic dedupe key for periodic enqueues."""
    return f"periodic:{kind}:{slot_start.isoformat()}"


@lru_cache(maxsize=1)
def _build_default_registry() -> dict[str, JobDefinition]:
    settings = get_settings()
    return {
        "ingest_web_article": JobDefinition(
            kind="ingest_web_article",
            handler=_run_ingest_web_article,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
        ),
        "ingest_epub": JobDefinition(
            kind="ingest_epub",
            handler=_run_ingest_epub,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
        ),
        "ingest_pdf": JobDefinition(
            kind="ingest_pdf",
            handler=_run_ingest_pdf,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=300,
        ),
        "ingest_youtube_video": JobDefinition(
            kind="ingest_youtube_video",
            handler=_run_ingest_youtube_video,
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
        ),
        "podcast_sync_subscription_job": JobDefinition(
            kind="podcast_sync_subscription_job",
            handler=_run_podcast_sync_subscription,
            max_attempts=3,
            retry_delays_seconds=(60, 300, 900),
            lease_seconds=900,
        ),
        "podcast_transcribe_episode_job": JobDefinition(
            kind="podcast_transcribe_episode_job",
            handler=_run_podcast_transcribe_episode,
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
        "podcast_active_subscription_poll_job": JobDefinition(
            kind="podcast_active_subscription_poll_job",
            handler=_run_podcast_active_subscription_poll,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=int(settings.podcast_active_poll_schedule_seconds),
        ),
        "reconcile_stale_ingest_media_job": JobDefinition(
            kind="reconcile_stale_ingest_media_job",
            handler=_run_reconcile_stale_ingest_media,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=300,
            periodic_interval_seconds=int(settings.ingest_reconcile_schedule_seconds),
        ),
        "sync_gutenberg_catalog_job": JobDefinition(
            kind="sync_gutenberg_catalog_job",
            handler=_run_sync_gutenberg_catalog,
            max_attempts=1,
            retry_delays_seconds=(0,),
            lease_seconds=7200,
            periodic_interval_seconds=86400,
        ),
        "backfill_default_library_closure_job": JobDefinition(
            kind="backfill_default_library_closure_job",
            handler=_run_backfill_default_library_closure,
            max_attempts=5,
            retry_delays_seconds=(60, 300, 900, 3600, 21600),
            lease_seconds=900,
        ),
    }


def _run_ingest_web_article(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_web_article import ingest_web_article

    return ingest_web_article(
        media_id=str(payload["media_id"]),
        actor_user_id=str(payload["actor_user_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_ingest_epub(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_epub import ingest_epub

    return ingest_epub(
        media_id=str(payload["media_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_ingest_pdf(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_pdf import ingest_pdf

    return ingest_pdf(
        media_id=str(payload["media_id"]),
        request_id=_optional_str(payload.get("request_id")),
        embedding_only=bool(payload.get("embedding_only", False)),
    )


def _run_ingest_youtube_video(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.ingest_youtube_video import ingest_youtube_video

    return ingest_youtube_video(
        media_id=str(payload["media_id"]),
        actor_user_id=str(payload["actor_user_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_enrich_metadata(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.enrich_metadata import enrich_metadata

    return enrich_metadata(
        media_id=str(payload["media_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_podcast_sync_subscription(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_sync_subscription import podcast_sync_subscription_job

    return podcast_sync_subscription_job(
        user_id=str(payload["user_id"]),
        podcast_id=str(payload["podcast_id"]),
        request_id=_optional_str(payload.get("request_id")),
    )


def _run_podcast_transcribe_episode(*, payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job

    return podcast_transcribe_episode_job(
        media_id=str(payload["media_id"]),
        requested_by_user_id=_optional_str(payload.get("requested_by_user_id")),
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


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None
