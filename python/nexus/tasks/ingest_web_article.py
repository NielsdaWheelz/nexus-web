"""Celery task for web article ingestion.

This task:
1. Fetches page via Node subprocess (Playwright + jsdom + Readability)
2. Resolves canonical URL from final redirect URL
3. Performs atomic deduplication by canonical URL
4. Sanitizes HTML and generates canonical text
5. Persists fragment and transitions to ready_for_reading

Per s2_pr04.md spec:
- Task is idempotent - exits early if already ready_for_reading with fragment
- Uses actor_user_id for dedup library attachment
- max_retries=0 (manual retry only via API)
- All failures use failure_stage='extract'
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.celery import celery_app
from nexus.db.models import FailureStage, Fragment, Media, MediaKind, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.node_ingest import IngestError, IngestResult, run_node_ingest
from nexus.services.sanitize_html import sanitize_html
from nexus.services.url_normalize import normalize_url_for_display

logger = get_logger(__name__)


@celery_app.task(bind=True, max_retries=0, name="ingest_web_article")
def ingest_web_article(
    self,
    media_id: str,
    actor_user_id: str,
    request_id: str | None = None,
) -> dict:
    """Ingest a web article asynchronously.

    Args:
        media_id: UUID of the media row to ingest.
        actor_user_id: UUID of the user who triggered ingestion (for dedup library attach).
        request_id: Optional request ID for log correlation.

    Returns:
        Dict with result status and any relevant info.

    Note:
        This task is idempotent. If the media is already ready_for_reading
        with a fragment, the task exits successfully without changes.
    """
    # Convert string UUIDs to UUID objects
    media_uuid = UUID(media_id)
    actor_uuid = UUID(actor_user_id)

    logger.info(
        "ingest_web_article_started",
        media_id=media_id,
        actor_user_id=actor_user_id,
        request_id=request_id,
    )

    # Get session factory (worker doesn't use FastAPI DI)
    session_factory = get_session_factory()
    db = session_factory()

    try:
        result = _do_ingest(db, media_uuid, actor_uuid, request_id)
        logger.info(
            "ingest_web_article_completed",
            media_id=media_id,
            result=result,
            request_id=request_id,
        )
        return result
    except Exception as e:
        logger.error(
            "ingest_web_article_failed",
            media_id=media_id,
            error=str(e),
            request_id=request_id,
        )
        # Mark as failed if we haven't already
        try:
            _mark_failed(
                db,
                media_uuid,
                ApiErrorCode.E_INGEST_FAILED,
                f"Unexpected error: {e}",
            )
        except Exception:
            pass
        raise
    finally:
        db.close()


def _do_ingest(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict:
    """Core ingestion logic.

    Returns:
        Dict with status and details.
    """
    # Step 1: Load media and check idempotency
    media = db.get(Media, media_id)
    if not media:
        return {"status": "skipped", "reason": "media_not_found"}

    # Idempotency check: if already ready with fragment, exit early
    if media.processing_status == ProcessingStatus.ready_for_reading:
        fragment_exists = db.execute(
            text("SELECT EXISTS(SELECT 1 FROM fragments WHERE media_id = :id AND idx = 0)"),
            {"id": media_id},
        ).scalar()
        if fragment_exists:
            return {"status": "skipped", "reason": "already_ready"}

    # Step 2: Increment processing_attempts and mark extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_status = ProcessingStatus.extracting
    media.processing_started_at = datetime.now(UTC)
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.updated_at = datetime.now(UTC)
    db.commit()

    # Step 3: Run node ingest
    url = media.requested_url
    if not url:
        _mark_failed(db, media_id, ApiErrorCode.E_INGEST_FAILED, "No requested_url on media")
        return {"status": "failed", "reason": "no_url"}

    ingest_result = run_node_ingest(url)

    if isinstance(ingest_result, IngestError):
        _mark_failed(db, media_id, ingest_result.error_code, ingest_result.message)
        return {"status": "failed", "reason": str(ingest_result.error_code.value)}

    # Step 4: Compute canonical URL from final URL
    assert isinstance(ingest_result, IngestResult)
    canonical_url = normalize_url_for_display(ingest_result.final_url)

    # Step 5: Atomic dedup by canonical URL
    dedup_result = _try_set_canonical_url(db, media_id, canonical_url)

    if dedup_result == "duplicate":
        # Find winner and attach to actor's library, then delete loser
        _handle_duplicate(db, media_id, canonical_url, actor_user_id)
        return {"status": "deduped", "canonical_url": canonical_url}

    if dedup_result == "media_gone":
        return {"status": "skipped", "reason": "media_deleted"}

    # Step 6: Sanitize HTML
    try:
        html_sanitized = sanitize_html(ingest_result.content_html, ingest_result.base_url)
    except Exception as e:
        _mark_failed(db, media_id, ApiErrorCode.E_SANITIZATION_FAILED, f"Sanitization failed: {e}")
        return {"status": "failed", "reason": "sanitization_failed"}

    # Step 7: Generate canonical text
    try:
        canonical_text = generate_canonical_text(html_sanitized)
    except Exception as e:
        _mark_failed(
            db, media_id, ApiErrorCode.E_SANITIZATION_FAILED, f"Canonicalization failed: {e}"
        )
        return {"status": "failed", "reason": "canonicalization_failed"}

    # Step 8: Persist fragment and update media
    now = datetime.now(UTC)

    # Create fragment
    fragment = Fragment(
        media_id=media_id,
        idx=0,
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
        created_at=now,
    )
    db.add(fragment)
    db.flush()  # Flush to get fragment.id for block insertion

    # Step 8b: Create fragment blocks for context window computation
    # Parse canonical_text into blocks based on \n\n separators
    block_specs = parse_fragment_blocks(canonical_text)
    insert_fragment_blocks(db, fragment.id, block_specs)

    # Update media
    media = db.get(Media, media_id)
    if not media:
        return {"status": "failed", "reason": "media_deleted_during_ingest"}

    # Update title if we got one from extraction
    if ingest_result.title:
        media.title = ingest_result.title[:255]  # Truncate to max length

    media.processing_status = ProcessingStatus.ready_for_reading
    media.processing_completed_at = now
    media.updated_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None

    db.commit()

    return {
        "status": "success",
        "canonical_url": canonical_url,
        "title": ingest_result.title,
    }


def _try_set_canonical_url(
    db: Session,
    media_id: UUID,
    canonical_url: str,
) -> str:
    """Atomically try to set canonical_url on media.

    Uses SELECT FOR UPDATE to lock the row, then UPDATE with flush
    to trigger unique constraint check.

    Returns:
        "success" - canonical_url set successfully
        "duplicate" - another media has this canonical_url
        "media_gone" - media row was deleted
    """
    # Lock the media row
    result = db.execute(
        text("SELECT id FROM media WHERE id = :id FOR UPDATE"),
        {"id": media_id},
    )
    row = result.fetchone()
    if not row:
        return "media_gone"

    # Try to set canonical_url
    try:
        db.execute(
            text("UPDATE media SET canonical_url = :url WHERE id = :id"),
            {"url": canonical_url, "id": media_id},
        )
        db.flush()
        db.commit()
        return "success"
    except IntegrityError:
        db.rollback()
        return "duplicate"


def _handle_duplicate(
    db: Session,
    loser_id: UUID,
    canonical_url: str,
    actor_user_id: UUID,
) -> None:
    """Handle deduplication when canonical_url collision detected.

    Per spec:
    1. Find winner media by canonical_url
    2. Get actor's default library
    3. Attach winner to actor's library (if not already)
    4. Delete loser media

    Critical: Attach winner BEFORE deleting loser to ensure actor doesn't lose access.
    """
    # Find winner
    result = db.execute(
        text("""
            SELECT id FROM media
            WHERE kind = :kind AND canonical_url = :url AND id != :loser_id
            LIMIT 1
        """),
        {"kind": MediaKind.web_article.value, "url": canonical_url, "loser_id": loser_id},
    )
    winner_row = result.fetchone()

    if not winner_row:
        # No winner found (race condition - someone else deleted it?)
        # Just delete the loser
        db.execute(text("DELETE FROM media WHERE id = :id"), {"id": loser_id})
        db.commit()
        return

    winner_id = winner_row[0]

    # Get actor's default library
    result = db.execute(
        text("""
            SELECT id FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
        """),
        {"user_id": actor_user_id},
    )
    library_row = result.fetchone()

    if library_row:
        library_id = library_row[0]

        # S4: use shared helper for intrinsic provenance (attach winner to default library)
        from nexus.services.default_library_closure import ensure_default_intrinsic

        ensure_default_intrinsic(db, library_id, winner_id)

    # Delete loser (cascades library_media entries)
    db.execute(text("DELETE FROM media WHERE id = :id"), {"id": loser_id})
    db.commit()


def _mark_failed(
    db: Session,
    media_id: UUID,
    error_code: ApiErrorCode,
    message: str,
) -> None:
    """Mark media as failed with error details."""
    now = datetime.now(UTC)
    db.execute(
        text("""
            UPDATE media SET
                processing_status = :status,
                failure_stage = :stage,
                last_error_code = :code,
                last_error_message = :message,
                failed_at = :now,
                updated_at = :now
            WHERE id = :id
        """),
        {
            "status": ProcessingStatus.failed.value,
            "stage": FailureStage.extract.value,
            "code": error_code.value,
            "message": message[:1000],  # Truncate long messages
            "now": now,
            "id": media_id,
        },
    )
    db.commit()


# =============================================================================
# Synchronous execution helper (for tests and dev mode)
# =============================================================================


def run_ingest_sync(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
) -> dict:
    """Run ingestion synchronously (for tests and dev mode).

    Same logic as the Celery task but uses the provided session.

    Args:
        db: Database session to use.
        media_id: UUID of the media to ingest.
        actor_user_id: UUID of the user who triggered ingestion.
        request_id: Optional request ID for logging.

    Returns:
        Dict with result status.
    """
    return _do_ingest(db, media_id, actor_user_id, request_id)
