"""Per user + device workspace session persistence service layer."""

from uuid import UUID

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import WorkspaceSession


def get_workspace_session(db: Session, user_id: UUID, device_id: str) -> WorkspaceSession | None:
    """Get this device's own workspace session."""
    return (
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id == device_id,
        )
        .first()
    )


def get_most_recent_session_elsewhere(
    db: Session, user_id: UUID, device_id: str
) -> WorkspaceSession | None:
    """Get the user's most recent workspace session from another device."""
    return (
        db.query(WorkspaceSession)
        .filter(
            WorkspaceSession.user_id == user_id,
            WorkspaceSession.device_id != device_id,
        )
        .order_by(WorkspaceSession.updated_at.desc())
        .first()
    )


def upsert_workspace_session(
    db: Session, user_id: UUID, device_id: str, state: dict[str, object]
) -> WorkspaceSession:
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
            return session
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
    return session
