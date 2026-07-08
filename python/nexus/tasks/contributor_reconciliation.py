"""Worker task for contributor reconciliation candidate refresh."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.contributor_reconciliation import (
    refresh_contributor_reconciliation_for_media,
    refresh_contributor_reconciliation_for_podcast,
)

logger = get_logger(__name__)


def contributor_reconciliation(
    *,
    scope: str,
    media_id: str | None = None,
    podcast_id: str | None = None,
    reason: str = "unspecified",
    request_id: str | None = None,
) -> dict[str, object]:
    db = get_session_factory()()
    try:
        if scope == "media" and media_id is not None:
            result = refresh_contributor_reconciliation_for_media(
                db,
                media_id=UUID(media_id),
                reason=reason,
            )
        elif scope == "podcast" and podcast_id is not None:
            result = refresh_contributor_reconciliation_for_podcast(
                db,
                podcast_id=UUID(podcast_id),
                reason=reason,
            )
        else:
            return {"status": "skipped", "reason": "unsupported_scope"}
        logger.info(
            "contributor_reconciliation_completed",
            scope=scope,
            media_id=media_id,
            podcast_id=podcast_id,
            result=result,
            request_id=request_id,
        )
        return result
    finally:
        db.close()
