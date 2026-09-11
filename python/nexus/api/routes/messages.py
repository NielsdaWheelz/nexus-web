"""Message API routes.

Routes for listing messages in a conversation and deleting a single message.
Each route is transport-only and calls exactly one service function.

Routes:
- GET    /api/conversations/{conversation_id}/messages
- DELETE /api/messages/{message_id}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_generation_catalog_service, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.responses import ok, ok_page
from nexus.services import conversations as conversations_service
from nexus.services.generation_catalog import GenerationCatalogService

router = APIRouter(tags=["messages"])


@router.get(
    "/conversations/{conversation_id}/messages",
    dependencies=[Depends(require_tool_projection_revision)],
)
async def list_messages(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    before_cursor: str | None = Query(default=None, description="Older-history cursor"),
    window: str | None = Query(
        default=None,
        description="Message window: start (oldest page) or latest (newest page)",
    ),
) -> dict:
    """List messages in a conversation.

    Returns messages ordered by seq ASC, id ASC (oldest first, chat order).
    Supports forward cursor pagination and latest-window older-history pagination.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_INVALID_REQUEST (400): Conflicting pagination mode arguments.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    catalog_snapshot = await catalog.read_chat()
    get_repeatable_read_db(db)
    messages, page = conversations_service.list_messages(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        catalog_snapshot=catalog_snapshot,
        limit=limit,
        cursor=cursor,
        before_cursor=before_cursor,
        window=window,
    )
    return ok_page(messages, page)


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
