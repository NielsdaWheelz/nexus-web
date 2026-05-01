"""Worker entrypoint for library intelligence builds."""

from __future__ import annotations

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.services.library_intelligence import (
    mark_library_intelligence_build_failed,
    run_library_intelligence_build,
)


def library_intelligence_build_job(build_id: str) -> dict[str, object]:
    build_uuid = UUID(build_id)
    session_factory = get_session_factory()
    db = session_factory()
    try:
        return run_library_intelligence_build(db, build_uuid)
    except Exception as exc:
        db.rollback()
        mark_library_intelligence_build_failed(
            db,
            build_uuid,
            error_code=ApiErrorCode.E_INTERNAL.value,
            message=str(exc),
        )
        raise
    finally:
        db.close()
