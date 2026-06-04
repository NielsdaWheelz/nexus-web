"""Conversation share API routes.

Owner-only routes for getting and replacing a conversation's share targets.
Each route is transport-only and calls exactly one service function.

Routes:
- GET /api/conversations/{conversation_id}/shares
- PUT /api/conversations/{conversation_id}/shares
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.conversation import SetConversationSharesRequest
from nexus.services import shares as shares_service

router = APIRouter(tags=["conversation-shares"])


@router.get("/conversations/{conversation_id}/shares")
def get_conversation_shares(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get share targets for a conversation.

    Owner-only. Returns current share target libraries.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Not visible to viewer.
        E_OWNER_REQUIRED (403): Visible but viewer is not owner.
    """
    result = shares_service.get_conversation_shares_for_owner(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return ok(result)


@router.put("/conversations/{conversation_id}/shares")
def set_conversation_shares(
    conversation_id: UUID,
    body: SetConversationSharesRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Replace share targets for a conversation atomically.

    Owner-only. Validates all targets before writing.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Not visible to viewer.
        E_OWNER_REQUIRED (403): Visible but viewer is not owner.
        E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN (403): Default lib target.
        E_FORBIDDEN (403): Owner not member of target library.
    """
    result = shares_service.set_conversation_shares_for_owner(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        library_ids=body.library_ids,
    )
    return ok(result)
