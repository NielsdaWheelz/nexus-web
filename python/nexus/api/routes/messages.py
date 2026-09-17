"""Message API routes.

Routes for deleting a single message. Each route is transport-only and calls
exactly one service function.

Routes:
- DELETE /api/messages/{message_id}
"""

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
    """Delete a single message.

    If this is the last message in the conversation, deletes the conversation too.

    Errors:
        E_MESSAGE_NOT_FOUND (404): Message doesn't exist or viewer is not conversation owner.
    """
    result = conversations_service.delete_message(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return ok(result, by_alias=True)
