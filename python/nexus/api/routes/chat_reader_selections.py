"""Reader-selection preview route."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import ok
from nexus.schemas.chat_reader_selection import ReaderSelectionKey
from nexus.services.chat_reader_selection import reader_selection_preview

router = APIRouter(tags=["chat-reader-selections"])


@router.get("/chat-reader-selections/highlights/{highlight_id}")
def get_reader_selection_preview(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    media_id: Annotated[UUID, Query(description="The key's parent media id")],
) -> dict:
    key = ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id)
    return ok(reader_selection_preview(db, viewer_id=viewer.user_id, key=key))
