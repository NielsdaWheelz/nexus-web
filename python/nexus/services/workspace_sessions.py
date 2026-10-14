"""Per user + device workspace sessions: last write wins; stored state must validate."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import WorkspaceSession
from nexus.schemas.workspace_session import WorkspaceSessionsOut, WorkspaceState


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
    # justify-defect: saved state was validated on write. Only a missing row is
    # absent; invalid persisted state must fail before entry can overwrite it.
    return WorkspaceSessionsOut(
        own=WorkspaceState.model_validate(own) if own is not None else None,
        most_recent_elsewhere=WorkspaceState.model_validate(elsewhere)
        if elsewhere is not None
        else None,
    )


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
