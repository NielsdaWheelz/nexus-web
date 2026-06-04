"""Per user + device workspace session persistence service layer."""

from uuid import UUID

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import WorkspaceSession
from nexus.schemas.workspace_session import WorkspaceSessionOut


def _to_out(session: WorkspaceSession | None) -> WorkspaceSessionOut | None:
    """Project a stored session row into its API shape, or None when absent."""
    if session is None:
        return None
    return WorkspaceSessionOut(state=session.state, updated_at=session.updated_at.isoformat())


def get_workspace_session(db: Session, user_id: UUID, device_id: str) -> WorkspaceSessionOut | None:
    """Get this device's own workspace session."""
    return _to_out(
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id == device_id,
        )
        .first()
    )


def get_most_recent_session_elsewhere(
    db: Session, user_id: UUID, device_id: str
) -> WorkspaceSessionOut | None:
    """Get the user's most recent workspace session from another device."""
    return _to_out(
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id != device_id,
        )
        .order_by(WorkspaceSession.updated_at.desc(), WorkspaceSession.id.desc())
        .first()
    )


def upsert_workspace_session(
    db: Session, user_id: UUID, device_id: str, state: dict[str, object]
) -> WorkspaceSessionOut:
    """Upsert this device's workspace session (last-write-wins)."""
    session = (
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id == device_id,
        )
        .first()
    )

    if session is None:
        session = WorkspaceSession(
            user_id=user_id,
            device_id=device_id,
            state=state,
        )
        db.add(session)
        try:
            db.commit()
            db.refresh(session)
            return WorkspaceSessionOut(
                state=session.state, updated_at=session.updated_at.isoformat()
            )
        except IntegrityError:
            db.rollback()
            session = (
                db.query(WorkspaceSession)
                .filter(
                    WorkspaceSession.user_id == user_id,
                    WorkspaceSession.device_id == device_id,
                )
                .one()
            )

    session.state = state
    session.updated_at = func.now()
    db.commit()
    db.refresh(session)
    return WorkspaceSessionOut(state=session.state, updated_at=session.updated_at.isoformat())
