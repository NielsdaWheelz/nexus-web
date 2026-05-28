"""Conversations and Messages API routes.

Route handlers for conversation and message CRUD operations.
Routes are transport-only: each calls exactly one service function.

Route contract:
- Conversations: GET/POST/DELETE
- Messages: GET (list), DELETE

All routes require authentication.
Response envelope: {"data": ...} or {"data": [...], "page": {...}}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.conversation import (
    AddPinnedSourceRequest,
    MessageRerankLedgerListResponse,
    MessageRetrievalCandidateLedgerListResponse,
    RenameBranchRequest,
    SetActivePathRequest,
    SetConversationSharesRequest,
)
from nexus.services import chat_runs as chat_runs_service
from nexus.services import conversation_branches as conversation_branches_service
from nexus.services import conversations as conversations_service
from nexus.services import pinned_sources as pinned_sources_service
from nexus.services import shares as shares_service

router = APIRouter(tags=["conversations"])


# =============================================================================
# Conversation Endpoints
# =============================================================================


@router.get("/conversations")
def list_conversations(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    scope: str | None = Query(default=None, description="Scope: mine|all|shared"),
) -> dict:
    """List conversations with scope-based visibility.

    Scopes:
    - mine (default): only owned conversations.
    - all: all visible conversations (owned + shared + public).
    - shared: visible but not owned.

    Returns conversations ordered by updated_at DESC, id DESC.
    Supports cursor-based pagination.

    Errors:
        E_INVALID_REQUEST (400): Invalid scope value.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    # Explicit app-level scope validation (no framework enum/422 leakage)
    effective_scope = scope if scope is not None else "mine"
    if effective_scope not in ("mine", "all", "shared"):
        from nexus.errors import InvalidRequestError

        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid scope: {effective_scope}. Must be one of: mine, all, shared",
        )

    conversations, page = conversations_service.list_conversations(
        db=db,
        viewer_id=viewer.user_id,
        limit=limit,
        cursor=cursor,
        scope=effective_scope,
    )
    return {
        "data": [c.model_dump(mode="json") for c in conversations],
        "page": page.model_dump(mode="json"),
    }


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create an empty private conversation.

    Returns 201 Created with the conversation object.
    """
    result = conversations_service.create_conversation(
        db=db,
        viewer_id=viewer.user_id,
    )
    db.commit()
    return success_response(result.model_dump(mode="json"))


@router.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a conversation by ID.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    result = conversations_service.get_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/conversations/{conversation_id}/tree")
def get_conversation_tree(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.get_conversation_tree(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.post("/conversations/{conversation_id}/active-path")
def set_conversation_active_path(
    conversation_id: UUID,
    body: SetActivePathRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.set_active_path(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        active_leaf_message_id=body.active_leaf_message_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/conversations/{conversation_id}/forks")
def list_conversation_forks(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    search: str | None = Query(default=None, description="Fork search query"),
) -> dict:
    result = conversation_branches_service.list_forks(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        search=search,
    )
    return success_response(result.model_dump(mode="json"))


@router.patch("/conversations/{conversation_id}/forks/{branch_id}")
def rename_conversation_fork(
    conversation_id: UUID,
    branch_id: UUID,
    body: RenameBranchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.rename_branch(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        branch_id=branch_id,
        title=body.title,
    )
    return success_response(result.model_dump(mode="json"))


@router.delete("/conversations/{conversation_id}/forks/{branch_id}", status_code=204)
def delete_conversation_fork(
    conversation_id: UUID,
    branch_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    conversation_branches_service.delete_branch(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        branch_id=branch_id,
    )
    return Response(status_code=204)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a conversation.

    Cascades to messages, message_context_items, conversation_media, conversation_shares, and chat runs.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_SINGLETON_UNDELETABLE (409): Conversation is a singleton (doc-chat or library-chat).
    """
    conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return Response(status_code=204)


# =============================================================================
# Conversation Share Endpoints
# =============================================================================


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
    return success_response(result.model_dump(mode="json"))


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
    return success_response(result.model_dump(mode="json"))


@router.get("/conversations/{conversation_id}/pinned-sources")
def list_conversation_pinned_sources(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = pinned_sources_service.list_pinned_sources(
        db=db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    return {"data": [row.model_dump(mode="json") for row in rows]}


@router.post("/conversations/{conversation_id}/pinned-sources", status_code=201)
def add_conversation_pinned_source(
    conversation_id: UUID,
    body: AddPinnedSourceRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    row = pinned_sources_service.add_pinned_source(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        request=body,
    )
    return success_response(row.model_dump(mode="json"))


@router.delete(
    "/conversations/{conversation_id}/pinned-sources/{ordinal}",
    status_code=204,
)
def remove_conversation_pinned_source(
    conversation_id: UUID,
    ordinal: int,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    pinned_sources_service.remove_pinned_source(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        ordinal=ordinal,
    )
    return Response(status_code=204)


# =============================================================================
# Message Endpoints
# =============================================================================


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
) -> dict:
    """List messages in a conversation.

    Returns messages ordered by seq ASC, id ASC (oldest first, chat order).
    Supports cursor-based pagination.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    messages, page = conversations_service.list_messages(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        limit=limit,
        cursor=cursor,
    )
    return {
        "data": [m.model_dump(mode="json") for m in messages],
        "page": page.model_dump(mode="json"),
    }


@router.get(
    "/messages/{message_id}/retrieval-candidate-ledgers",
    response_model=MessageRetrievalCandidateLedgerListResponse,
)
def list_message_retrieval_candidate_ledgers(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    tool_call_id: Annotated[
        UUID | None,
        Query(description="Optional retrieval tool-call filter"),
    ] = None,
) -> dict:
    result = conversations_service.list_message_retrieval_candidate_ledgers(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
        tool_call_id=tool_call_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.get("/messages/{message_id}/rerank-ledgers", response_model=MessageRerankLedgerListResponse)
def list_message_rerank_ledgers(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    tool_call_id: Annotated[
        UUID | None,
        Query(description="Optional retrieval tool-call filter"),
    ] = None,
) -> dict:
    result = conversations_service.list_message_rerank_ledgers(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
        tool_call_id=tool_call_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.post("/messages/{assistant_message_id}/retry", status_code=200)
def retry_failed_assistant_response(
    assistant_message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = chat_runs_service.retry_failed_assistant_response(
        db=db,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=idempotency_key,
    )
    return success_response(result.model_dump(mode="json"))


@router.delete("/messages/{message_id}", status_code=204)
def delete_message(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a single message.

    If this is the last message in the conversation, deletes the conversation too.
    Cascades to message_context_items.

    Errors:
        E_MESSAGE_NOT_FOUND (404): Message doesn't exist or viewer is not conversation owner.
    """
    conversations_service.delete_message(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return Response(status_code=204)
