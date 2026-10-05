"""Message API routes: delete one message and its subtree."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.conversation import MessageDeleteOut
from nexus.services import conversations as conversations_service

router = APIRouter(tags=["messages"])


@router.delete("/messages/{message_id}")
def delete_message(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[MessageDeleteOut]:
    """Delete a message; the conversation too when it was the last one."""

    return Data(
        data=conversations_service.delete_message(
            db=db,
            viewer_id=viewer.user_id,
            message_id=message_id,
        )
    )
