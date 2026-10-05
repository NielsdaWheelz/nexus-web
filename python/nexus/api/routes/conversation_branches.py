"""Conversation tree routes: the tree, the active leaf, and fork titles."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.api.deps import require_chat_contract_revision, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.conversation import ConversationTreeOut, ForkTitleRequest, SetActivePathRequest
from nexus.services import conversation_branches as service

router = APIRouter(tags=["conversation-branches"])
_CHAT_CONTRACT = [
    Depends(require_chat_contract_revision),
    Depends(require_tool_projection_revision),
]
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/conversations/{conversation_id}/tree", dependencies=_CHAT_CONTRACT)
def get_conversation_tree(
    conversation_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ConversationTreeOut]:
    tree = service.get_conversation_tree(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    return Data(data=tree)


@router.post(
    "/conversations/{conversation_id}/active-path", status_code=204, dependencies=_CHAT_CONTRACT
)
def set_active_path(
    conversation_id: UUID, body: SetActivePathRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    service.select_active_leaf(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        leaf_message_id=body.active_leaf_message_id,
    )
    return Response(status_code=204)


@router.patch("/messages/{message_id}/fork-title", status_code=204)
def rename_fork(
    message_id: UUID, body: ForkTitleRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    service.rename_fork(db, viewer_id=viewer.user_id, message_id=message_id, title=body.title)
    return Response(status_code=204)
