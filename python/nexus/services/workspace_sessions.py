"""Per user + device workspace session persistence service layer."""

from uuid import UUID

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import WorkspaceSession
from nexus.schemas.workspace_session import WorkspaceSessionOut


def get_workspace_session(db: Session, user_id: UUID, device_id: str) -> WorkspaceSessionOut | None:
    """Get this device's own workspace session."""
    session = (
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id == device_id,
        )
        .first()
    )
    if session is None:
        return None
    return WorkspaceSessionOut(state=session.state, updated_at=session.updated_at.isoformat())


def get_most_recent_session_elsewhere(
    db: Session, user_id: UUID, device_id: str
) -> WorkspaceSessionOut | None:
    """Get the user's most recent workspace session from another device."""
    session = (
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id != device_id,
        )
        .order_by(WorkspaceSession.updated_at.desc(), WorkspaceSession.id.desc())
        .first()
    )
    if session is None:
        return None
    return WorkspaceSessionOut(state=session.state, updated_at=session.updated_at.isoformat())


def upsert_workspace_session(
    db: Session, user_id: UUID, device_id: str, state: dict[str, object]
) -> WorkspaceSessionOut:
    """Upsert this device's workspace session (last-write-wins)."""
    row = db.execute(
        insert(WorkspaceSession)
        .values(user_id=user_id, device_id=device_id, state=state)
        .on_conflict_do_update(
            index_elements=["user_id", "device_id"],
            set_={"state": state, "updated_at": func.now()},
        )
        .returning(WorkspaceSession.state, WorkspaceSession.updated_at)
    ).one()
    db.commit()
    return WorkspaceSessionOut(state=row.state, updated_at=row.updated_at.isoformat())
