"""Per user + device workspace sessions: last write wins; an unreadable row reads as absent."""

from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import WorkspaceSession
from nexus.logging import get_logger
from nexus.schemas.workspace_session import WorkspaceSessionsOut, WorkspaceState

logger = get_logger(__name__)


def _readable(state: dict[str, object] | None) -> WorkspaceState | None:
    if state is None:
        return None
    try:
        return WorkspaceState.model_validate(state)
    except ValidationError as error:
        logger.warning("workspace_session_unreadable", errors=error.error_count())
        return None


def get_workspace_sessions(db: Session, user_id: UUID, device_id: str) -> WorkspaceSessionsOut:
    own = db.scalar(
        select(WorkspaceSession.state).where(
            WorkspaceSession.user_id == user_id, WorkspaceSession.device_id == device_id
        )
    )
    elsewhere = db.scalar(
        select(WorkspaceSession.state)
        .where(WorkspaceSession.user_id == user_id, WorkspaceSession.device_id != device_id)
        .order_by(WorkspaceSession.updated_at.desc(), WorkspaceSession.id.desc())
        .limit(1)
    )
    return WorkspaceSessionsOut(own=_readable(own), most_recent_elsewhere=_readable(elsewhere))


def put_workspace_session(
    db: Session, user_id: UUID, device_id: str, state: WorkspaceState
) -> None:
    payload = state.model_dump(mode="json", by_alias=True)
    db.execute(
        insert(WorkspaceSession)
        .values(user_id=user_id, device_id=device_id, state=payload)
        .on_conflict_do_update(
            index_elements=["user_id", "device_id"],
            set_={"state": payload, "updated_at": func.now()},
        )
    )
    db.commit()
