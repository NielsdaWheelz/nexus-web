"""Message API routes: delete one message and its subtree."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.services import conversations as conversations_service

router = APIRouter(tags=["messages"])


@router.delete("/messages/{message_id}")
def delete_message(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Delete a message; the conversation too when it was the last one."""

    return ok(
        conversations_service.delete_message(
            db=db,
            viewer_id=viewer.user_id,
            message_id=message_id,
        ),
        by_alias=True,
    )
