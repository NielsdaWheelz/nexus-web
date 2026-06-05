"""Worker job handler for durable source-ingest attempts."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.media_source_ingest import run_source_attempt

logger = get_logger(__name__)


def ingest_media_source(
    media_id: str,
    attempt_id: str,
    actor_user_id: str,
    request_id: str | None = None,
) -> dict[str, object]:
    media_uuid = UUID(media_id)
    attempt_uuid = UUID(attempt_id)
    actor_uuid = UUID(actor_user_id)
    db = get_session_factory()()
    try:
        result = run_source_attempt(
            db=db,
            media_id=media_uuid,
            attempt_id=attempt_uuid,
            actor_user_id=actor_uuid,
            request_id=request_id,
        )
        logger.info(
            "ingest_media_source_completed",
            media_id=media_id,
            attempt_id=attempt_id,
            result=result,
            request_id=request_id,
        )
        return result
    finally:
        db.close()
