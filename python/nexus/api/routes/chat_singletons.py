"""Chat-singleton and chat-reference API routes.

Read-only endpoints for the reader-pane Doc-chat and Library-chat tabs:

- GET /api/chat-singletons/media/{media_id}    → §7.2
- GET /api/chat-singletons/library/{library_id} → §7.3
- GET /api/chat-references/media/{media_id}    → §7.4

Singletons are lazily materialized on the first POST /chat-runs that targets a
singleton (§4.7). These read endpoints never create rows; they return
`conversation_id=null, message_count=0` when the singleton does not yet exist
so the UI can render the empty-state row.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.permissions import can_read_media, is_library_member
from nexus.db.models import Library, Media
from nexus.errors import ApiErrorCode, ForbiddenError, NotFoundError
from nexus.responses import success_response
from nexus.services import chat_run_singletons as singletons_service
from nexus.services import conversations as conversations_service

router = APIRouter(tags=["chat-singletons"])


# =============================================================================
# Response schemas (route-local; not part of the shared schemas module)
# =============================================================================


class ChatSingletonStateOut(BaseModel):
    """Read response for the singleton-state endpoints (§7.2, §7.3)."""

    conversation_id: UUID | None
    message_count: int

    model_config = ConfigDict(extra="forbid")


# =============================================================================
# Routes
# =============================================================================


@router.get("/chat-singletons/media/{media_id}")
def get_chat_singleton_for_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return the viewer's doc-chat singleton state for this media (§7.2).

    Errors:
        E_MEDIA_NOT_FOUND (404): Media does not exist.
        E_SINGLETON_TARGET_FORBIDDEN (403): Media exists but viewer cannot read it.
    """
    _require_media_visible_to_viewer(db, viewer.user_id, media_id)
    conversation_id, message_count = singletons_service.get_singleton_state_for_media(
        db, viewer.user_id, media_id
    )
    return success_response(
        ChatSingletonStateOut(
            conversation_id=conversation_id,
            message_count=message_count,
        ).model_dump(mode="json")
    )


@router.get("/chat-singletons/library/{library_id}")
def get_chat_singleton_for_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return the viewer's library-chat singleton state for this library (§7.3).

    Errors:
        E_LIBRARY_NOT_FOUND (404): Library does not exist.
        E_SINGLETON_TARGET_FORBIDDEN (403): Library exists but viewer is not a member.
    """
    _require_library_visible_to_viewer(db, viewer.user_id, library_id)
    conversation_id, message_count = singletons_service.get_singleton_state_for_library(
        db, viewer.user_id, library_id
    )
    return success_response(
        ChatSingletonStateOut(
            conversation_id=conversation_id,
            message_count=message_count,
        ).model_dump(mode="json")
    )


@router.get("/chat-references/media/{media_id}")
def list_chat_references_for_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(
        default=conversations_service.DEFAULT_REFERENCE_LIMIT,
        ge=1,
        le=conversations_service.MAX_REFERENCE_LIMIT,
        description="Maximum results (1-200)",
    ),
    offset: int = Query(default=0, ge=0, description="Offset for pagination"),
) -> dict:
    """List non-singleton conversations referencing this media (§7.4).

    Errors:
        E_MEDIA_NOT_FOUND (404): Media does not exist.
        E_SINGLETON_TARGET_FORBIDDEN (403): Media exists but viewer cannot read it.
    """
    _require_media_visible_to_viewer(db, viewer.user_id, media_id)
    items, next_offset = conversations_service.list_referencing_conversations_for_media(
        db,
        viewer.user_id,
        media_id,
        limit=limit,
        offset=offset,
    )
    return {
        "data": {
            "conversations": [item.model_dump(mode="json") for item in items],
            "next_offset": next_offset,
        }
    }


# =============================================================================
# Access helpers (route-local; consolidate the 404-then-403 split for §7.2-7.4)
# =============================================================================


def _require_media_visible_to_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Raise 404 if media does not exist; 403 if it exists but viewer cannot read it."""
    media_exists = db.execute(select(exists().where(Media.id == media_id))).scalar()
    if not media_exists:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if not can_read_media(db, viewer_id, media_id):
        raise ForbiddenError(
            ApiErrorCode.E_SINGLETON_TARGET_FORBIDDEN,
            "Viewer cannot access this media.",
        )


def _require_library_visible_to_viewer(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Raise 404 if library does not exist; 403 if it exists but viewer is not a member."""
    library_exists = db.execute(select(exists().where(Library.id == library_id))).scalar()
    if not library_exists:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    if not is_library_member(db, viewer_id, library_id):
        raise ForbiddenError(
            ApiErrorCode.E_SINGLETON_TARGET_FORBIDDEN,
            "Viewer cannot access this library.",
        )
