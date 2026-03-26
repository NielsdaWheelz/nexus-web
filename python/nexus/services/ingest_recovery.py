"""Operational helpers for ingest recovery."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger

logger = get_logger(__name__)


def get_stale_ingest_backlog_health(
    db: Session,
    *,
    stale_extracting_seconds: int | None = None,
) -> dict:
    """Return stale-ingest backlog health for operator visibility."""
    settings = get_settings()
    threshold_seconds = int(
        stale_extracting_seconds
        if stale_extracting_seconds is not None
        else settings.ingest_stale_extracting_seconds
    )
    now = datetime.now(UTC)
    stale_before = now - timedelta(seconds=threshold_seconds)

    stale_count, oldest_started_at = db.execute(
        select(
            func.count(Media.id),
            func.min(Media.processing_started_at),
        )
        .where(Media.processing_status == ProcessingStatus.extracting)
        .where(Media.kind.in_(("pdf", "epub")))
        .where(Media.processing_started_at.is_not(None))
        .where(Media.processing_started_at < stale_before)
    ).one()

    stale_count_int = int(stale_count or 0)
    oldest_age_seconds = (
        int((now - oldest_started_at).total_seconds()) if oldest_started_at is not None else None
    )

    return {
        "stale_count": stale_count_int,
        "oldest_stale_age_seconds": oldest_age_seconds,
        "stale_threshold_seconds": threshold_seconds,
        "degraded": stale_count_int > 0,
    }


def enqueue_stale_ingest_reconcile(*, request_id: str | None = None) -> bool:
    """Best-effort enqueue of stale-ingest reconciler task."""
    session_factory = get_session_factory()
    db = session_factory()
    try:
        enqueue_job(
            db,
            kind="reconcile_stale_ingest_media_job",
            payload={"request_id": request_id},
        )
        db.commit()
        return True
    except Exception as exc:
        db.rollback()
        logger.error(
            "stale_ingest_reconcile_enqueue_failed",
            error=str(exc),
            request_id=request_id,
        )
        return False
    finally:
        db.close()
