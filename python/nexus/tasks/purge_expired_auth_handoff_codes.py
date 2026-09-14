"""Periodic purge of expired-unconsumed auth handoff code rows."""

from __future__ import annotations

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.auth_handoff_codes import purge_expired_auth_handoff_codes

logger = get_logger(__name__)


def purge_expired_auth_handoff_codes_job(request_id: str | None = None) -> dict[str, int]:
    session_factory = get_session_factory()
    with session_factory() as db:
        deleted = purge_expired_auth_handoff_codes(db)
        db.commit()

    logger.info(
        "auth_handoff_codes_purged",
        deleted_count=deleted,
        request_id=request_id,
    )
    return {"deleted_count": deleted}
