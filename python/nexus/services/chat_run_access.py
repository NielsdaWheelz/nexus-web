"""ChatRun ownership loader."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import ApiErrorCode, NotFoundError


def get_run_for_owner(db: Session, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run
