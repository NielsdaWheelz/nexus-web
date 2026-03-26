"""Stream liveness markers stored in Postgres."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.logging import get_logger

logger = get_logger(__name__)

LIVENESS_TTL_SECONDS = 600


async def set_liveness_marker(assistant_message_id: UUID) -> None:
    """Set the liveness marker before first byte is yielded."""
    expires_at = datetime.now(UTC) + timedelta(seconds=LIVENESS_TTL_SECONDS)
    db = get_session_factory()()
    try:
        db.execute(
            text(
                """
                INSERT INTO stream_liveness_markers (
                    assistant_message_id,
                    expires_at,
                    created_at,
                    updated_at
                )
                VALUES (:assistant_message_id, :expires_at, now(), now())
                ON CONFLICT (assistant_message_id)
                DO UPDATE SET
                    expires_at = EXCLUDED.expires_at,
                    updated_at = now()
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "expires_at": expires_at,
            },
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning(
            "liveness_set_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(exc),
        )
    finally:
        db.close()


async def refresh_liveness_marker(assistant_message_id: UUID) -> None:
    """Refresh the liveness marker TTL (sliding window)."""
    expires_at = datetime.now(UTC) + timedelta(seconds=LIVENESS_TTL_SECONDS)
    db = get_session_factory()()
    try:
        db.execute(
            text(
                """
                UPDATE stream_liveness_markers
                SET expires_at = :expires_at,
                    updated_at = now()
                WHERE assistant_message_id = :assistant_message_id
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "expires_at": expires_at,
            },
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.debug(
            "liveness_refresh_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(exc),
        )
    finally:
        db.close()


async def clear_liveness_marker(assistant_message_id: UUID | None) -> None:
    """Clear the liveness marker at finalize."""
    if assistant_message_id is None:
        return
    db = get_session_factory()()
    try:
        db.execute(
            text(
                """
                DELETE FROM stream_liveness_markers
                WHERE assistant_message_id = :assistant_message_id
                """
            ),
            {"assistant_message_id": assistant_message_id},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning(
            "liveness_clear_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(exc),
        )
    finally:
        db.close()


def check_liveness_marker(assistant_message_id: UUID | None) -> bool:
    """Check if a stream is currently active (has liveness marker).

    Returns:
        True when an unexpired marker exists, else False.
    """
    if assistant_message_id is None:
        return False
    db = get_session_factory()()
    try:
        db.execute(text("DELETE FROM stream_liveness_markers WHERE expires_at <= now()"))
        exists = db.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM stream_liveness_markers
                    WHERE assistant_message_id = :assistant_message_id
                      AND expires_at > now()
                )
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).scalar_one()
        db.commit()
        return bool(exists)
    except Exception as exc:
        db.rollback()
        logger.warning(
            "liveness_check_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(exc),
        )
        return False
    finally:
        db.close()
