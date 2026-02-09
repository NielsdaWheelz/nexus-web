"""Pending assistant message sweeper task.

Per PR-08 spec §7:
- Celery beat job: sweep_pending_messages
- Query: role='assistant' AND status='pending' AND created_at < now()-5min
- If stream_active:{message_id} exists in Redis → skip (stream still running)
- Finalize via conditional update: set error_code='E_ORPHANED_PENDING'
- Insert message_llm row if none exists (ON CONFLICT DO NOTHING)
- Log count + oldest age
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import text as sa_text

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.stream_liveness import check_liveness_marker

logger = get_logger(__name__)

STALE_THRESHOLD_MINUTES = 5


def sweep_pending_messages(redis_client=None) -> int:
    """Sweep stale pending assistant messages.

    Args:
        redis_client: Redis client for liveness checks. If None, skip liveness check.

    Returns:
        Number of messages finalized.
    """
    session_factory = get_session_factory()
    db = session_factory()
    finalized_count = 0

    try:
        threshold = datetime.now(UTC) - timedelta(minutes=STALE_THRESHOLD_MINUTES)

        # Find stale pending assistant messages
        rows = db.execute(
            sa_text("""
                SELECT id, created_at
                FROM messages
                WHERE role = 'assistant'
                  AND status = 'pending'
                  AND created_at < :threshold
                ORDER BY created_at ASC
            """),
            {"threshold": threshold},
        ).fetchall()

        if not rows:
            return 0

        oldest_age_seconds = None

        for row in rows:
            message_id = row[0]
            created_at = row[1]

            age_seconds = (datetime.now(UTC) - created_at).total_seconds()
            if oldest_age_seconds is None or age_seconds > oldest_age_seconds:
                oldest_age_seconds = age_seconds

            # Check liveness marker — skip if stream is still active
            if check_liveness_marker(redis_client, message_id):
                logger.debug(
                    "sweeper_skip_active",
                    message_id=str(message_id),
                    age_seconds=int(age_seconds),
                )
                continue

            # Conditional update: only finalize if still pending
            result = db.execute(
                sa_text("""
                    UPDATE messages
                    SET content = :content,
                        status = 'error',
                        error_code = 'E_ORPHANED_PENDING',
                        updated_at = :now
                    WHERE id = :id AND status = 'pending'
                """),
                {
                    "content": "Request timed out — please try again.",
                    "now": datetime.now(UTC),
                    "id": message_id,
                },
            )

            if result.rowcount == 1:
                # Insert message_llm row if none exists
                db.execute(
                    sa_text("""
                        INSERT INTO message_llm (
                            message_id, provider, model_name,
                            key_mode_requested, key_mode_used,
                            error_class, prompt_version, created_at
                        )
                        SELECT
                            :message_id, 'openai', 'unknown',
                            'auto', 'platform',
                            'E_ORPHANED_PENDING', 'sweeper', now()
                        WHERE NOT EXISTS (
                            SELECT 1 FROM message_llm WHERE message_id = :message_id
                        )
                    """),
                    {"message_id": message_id},
                )
                finalized_count += 1

                logger.info(
                    "sweeper_finalized",
                    message_id=str(message_id),
                    age_seconds=int(age_seconds),
                )

        db.commit()

        if finalized_count > 0:
            logger.info(
                "sweeper_complete",
                finalized_count=finalized_count,
                total_stale=len(rows),
                oldest_age_seconds=int(oldest_age_seconds) if oldest_age_seconds else 0,
            )

        return finalized_count

    except Exception as e:
        logger.error("sweeper_error", error=str(e))
        db.rollback()
        return 0
    finally:
        db.close()
