"""Stream liveness marker — Redis keys to track active streams.

Per PR-08 spec §6:
- Set BEFORE first byte is yielded (after phase 1, before streaming loop)
- Refreshed on every delta yield and every keepalive ping (sliding TTL)
- Cleared in finalize's finally: block — even on cancellation/exception
- Used by replay logic (§4.3) and sweeper (§7) to distinguish running vs orphaned

Redis key: stream_active:{assistant_message_id}
TTL: 600 seconds (10 minutes, refreshed on each event)
"""

from uuid import UUID

from nexus.logging import get_logger

logger = get_logger(__name__)

LIVENESS_TTL_SECONDS = 600


async def set_liveness_marker(redis_client, assistant_message_id: UUID) -> None:
    """Set the liveness marker before first byte is yielded."""
    if redis_client is None:
        return
    try:
        key = f"stream_active:{assistant_message_id}"
        redis_client.setex(key, LIVENESS_TTL_SECONDS, "1")
    except Exception as e:
        logger.warning(
            "liveness_set_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(e),
        )


async def refresh_liveness_marker(redis_client, assistant_message_id: UUID) -> None:
    """Refresh the liveness marker TTL (sliding window)."""
    if redis_client is None:
        return
    try:
        key = f"stream_active:{assistant_message_id}"
        redis_client.expire(key, LIVENESS_TTL_SECONDS)
    except Exception as e:
        # Non-critical — log but don't fail the stream
        logger.debug(
            "liveness_refresh_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(e),
        )


async def clear_liveness_marker(redis_client, assistant_message_id: UUID) -> None:
    """Clear the liveness marker at finalize."""
    if redis_client is None:
        return
    try:
        key = f"stream_active:{assistant_message_id}"
        redis_client.delete(key)
    except Exception as e:
        logger.warning(
            "liveness_clear_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(e),
        )


def check_liveness_marker(redis_client, assistant_message_id: UUID) -> bool:
    """Check if a stream is currently active (has liveness marker).

    Returns:
        True if stream_active key exists, False otherwise.
    """
    if redis_client is None:
        return False
    try:
        key = f"stream_active:{assistant_message_id}"
        return bool(redis_client.exists(key))
    except Exception as e:
        logger.warning(
            "liveness_check_failed",
            assistant_message_id=str(assistant_message_id),
            error=str(e),
        )
        return False
