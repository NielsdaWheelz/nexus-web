"""Message context item routes."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.notes import CreateMessageContextItemRequest
from nexus.services.message_context_items import create_message_context_item

router = APIRouter(prefix="/message-context-items", tags=["message-context-items"])


@router.post("", status_code=201)
def create_context_item(
    request: CreateMessageContextItemRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    item = create_message_context_item(db, viewer.user_id, request)
    return success_response(item.model_dump(mode="json", by_alias=True))
