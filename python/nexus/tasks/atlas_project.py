"""Worker task: grand atlas projection.

Two enqueue shapes flow into the one job kind:
- on-demand (``payload["user_id"]``): project one user's corpus.
- periodic sweep (no user_id): project every user with library entries.
No LLM — pure computation, a simple synchronous session pattern.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.atlas_projection import (
    list_projectable_user_ids,
    run_projection,
)

logger = get_logger(__name__)


def atlas_project(*, payload: Mapping[str, Any]) -> dict:
    factory = get_session_factory()
    raw_user_id = payload.get("user_id")
    if raw_user_id is not None:
        user_ids = [UUID(str(raw_user_id))]
    else:
        with factory() as db:
            user_ids = list_projectable_user_ids(db)

    positioned = 0
    for user_id in user_ids:
        with factory() as db:
            result = run_projection(db, user_id)
            db.commit()
        positioned += int(result["positioned"])

    logger.info("atlas_project_completed", users=len(user_ids), positioned=positioned)
    return {"users": len(user_ids), "positioned": positioned}
