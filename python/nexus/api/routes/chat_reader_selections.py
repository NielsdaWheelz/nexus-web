"""Reader-selection preview API route.

Transport-only: the single GET returns the pending-quote-card projection for a
locked Highlight. The service raises typed reader-selection ApiErrors which the
global exception handler maps to HTTP; this route catches none of them.

All routes require authentication.
Response envelope: {"data": ...}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.chat_reader_selection import ReaderSelectionKey
from nexus.services.chat_reader_selection import reader_selection_preview

router = APIRouter(tags=["chat-reader-selections"])


@router.get("/chat-reader-selections/highlights/{highlight_id}")
def get_reader_selection_preview(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    media_id: Annotated[UUID, Query(description="The key's parent media id")],
) -> dict:
    """Return the pending-card ``ReaderSelectionPreview`` for a locked Highlight.

    Builds the ``ReaderSelectionKey{media_id, highlight_id}`` and projects the
    immutable snapshot plus its compare-on-send revision.

    Errors (typed reader-selection ApiErrors mapped by the global handler):
        E_READER_SELECTION_NOT_FOUND (404): Highlight/media absent, media
            mismatch, or unreadable source.
        E_READER_SELECTION_FORBIDDEN (403): Highlight not readable.
        E_READER_SELECTION_GEOMETRY_ONLY: geometry-only highlight cannot be quoted.
        E_READER_SELECTION_TOO_LARGE: a bounded selection field exceeds its limit.
    """
    key = ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id)
    preview = reader_selection_preview(db, viewer_id=viewer.user_id, key=key)
    return ok(preview)
