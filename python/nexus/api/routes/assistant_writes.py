"""The account's assistant writes: the history page and the one undo."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.assistant_writes import AssistantWritePage
from nexus.services.tools import assistant_writes

router = APIRouter(tags=["assistant-writes"])


@router.get("/assistant-writes")
def list_assistant_writes(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    generation_id: Annotated[UUID | None, Query()] = None,
    before: Annotated[UUID | None, Query()] = None,
) -> Data[AssistantWritePage]:
    page = assistant_writes.history(
        db, viewer_id=viewer.user_id, generation_id=generation_id, before=before
    )
    return Data(data=page)


@router.post("/assistant-writes/{tool_call_id}/undo", status_code=204)
def undo_assistant_write(
    tool_call_id: UUID, viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession
) -> Response:
    """Idempotent: an undone write answers 204 again."""

    assistant_writes.undo(db, viewer_id=viewer.user_id, tool_call_id=tool_call_id)
    return Response(status_code=204)
