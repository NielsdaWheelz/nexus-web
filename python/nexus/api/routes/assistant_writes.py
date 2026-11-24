"""The account's assistant writes: the history page and the one undo."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.assistant_writes import AssistantWriteOut
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.services.tools import assistant_writes

router = APIRouter(tags=["assistant-writes"])


@router.get("/assistant-writes")
def list_assistant_writes(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    request: Request,
) -> Data[CollectionIndex[AssistantWriteOut]]:
    query = parse_index_query(request.query_params.multi_items(), domain_keys={"generation_id"})
    raw = query.get("generation_id")
    try:
        generation_id = UUID(raw) if raw is not None else None
    except ValueError as error:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid generation id"
        ) from error
    return Data(
        data=assistant_writes.history(db, viewer_id=viewer.user_id, generation_id=generation_id)
    )


@router.post("/assistant-writes/{tool_call_id}/undo", status_code=204)
def undo_assistant_write(
    tool_call_id: UUID, viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession
) -> Response:
    """Idempotent: an undone write answers 204 again."""

    assistant_writes.undo(db, viewer_id=viewer.user_id, tool_call_id=tool_call_id)
    return Response(status_code=204)
