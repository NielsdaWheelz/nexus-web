"""Conversations and Messages API routes.

Route handlers for conversation and message CRUD operations.
Routes are transport-only: each calls exactly one service function.

Per PR-02 spec:
- Conversations: GET/POST/DELETE
- Messages: GET (list), DELETE

All routes require authentication.
Response envelope: {"data": ...} or {"data": [...], "page": {...}}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

import json
import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.conversation import (
    AssistantVerifierRunListResponse,
    ConversationScopeRequest,
    MessageArtifactCreateRequest,
    MessageArtifactExportLedgerListResponse,
    MessageArtifactFollowUpRequest,
    MessageArtifactFollowUpResponse,
    MessageArtifactListResponse,
    MessageArtifactResponse,
    MessageCitationAuditListResponse,
    MessageRerankLedgerListResponse,
    MessageRetrievalCandidateLedgerListResponse,
    RenameBranchRequest,
    SetActivePathRequest,
    SetConversationSharesRequest,
    SourceManifestListResponse,
)
from nexus.services import chat_runs as chat_runs_service
from nexus.services import conversation_branches as conversation_branches_service
from nexus.services import conversations as conversations_service
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
    return success_response(result.model_dump(mode="json"))


@router.post("/conversations/resolve", status_code=200)
def resolve_conversation(
    body: ConversationScopeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Resolve the canonical conversation for a durable scope."""
    result = conversations_service.resolve_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_scope=body,
    )
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


@router.get(
    "/conversations/{conversation_id}/source-manifests",
    response_model=SourceManifestListResponse,
)
def list_source_manifests(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.list_source_manifests(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


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

    Cascades to messages, message_context, conversation_media, conversation_shares, and chat runs.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return Response(status_code=204)


# =============================================================================
# Conversation Share Endpoints (S4 PR-06)
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


@router.get("/messages/{message_id}/verifier-runs", response_model=AssistantVerifierRunListResponse)
def list_message_verifier_runs(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.list_message_verifier_runs(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/verifier-runs",
    response_model=AssistantVerifierRunListResponse,
)
def list_conversation_message_verifier_runs(
    conversation_id: UUID,
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.list_message_verifier_runs(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        message_id=message_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.get(
    "/messages/{message_id}/citation-audits", response_model=MessageCitationAuditListResponse
)
def list_message_citation_audits(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.list_message_citation_audits(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/citation-audits",
    response_model=MessageCitationAuditListResponse,
)
def list_conversation_message_citation_audits(
    conversation_id: UUID,
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.list_message_citation_audits(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        message_id=message_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


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


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/retrieval-candidate-ledgers",
    response_model=MessageRetrievalCandidateLedgerListResponse,
)
def list_conversation_message_retrieval_candidate_ledgers(
    conversation_id: UUID,
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
        conversation_id=conversation_id,
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


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/rerank-ledgers",
    response_model=MessageRerankLedgerListResponse,
)
def list_conversation_message_rerank_ledgers(
    conversation_id: UUID,
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
        conversation_id=conversation_id,
        message_id=message_id,
        tool_call_id=tool_call_id,
    )
    return success_response([item.model_dump(mode="json") for item in result])


@router.get("/artifacts", response_model=MessageArtifactListResponse)
def list_artifacts(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    message_id: Annotated[
        UUID,
        Query(description="Message whose durable artifacts should be listed"),
    ],
) -> dict:
    artifacts = conversations_service.list_artifacts(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return success_response([artifact.model_dump(mode="json") for artifact in artifacts])


@router.post("/artifacts", status_code=201, response_model=MessageArtifactResponse)
def create_artifact(
    body: MessageArtifactCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    artifact = conversations_service.create_artifact(
        db=db,
        viewer_id=viewer.user_id,
        request=body,
    )
    return success_response(artifact.model_dump(mode="json"))


@router.get("/artifacts/{artifact_id}", response_model=MessageArtifactResponse)
def get_artifact(
    artifact_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    artifact = conversations_service.get_artifact(
        db=db,
        viewer_id=viewer.user_id,
        artifact_id=artifact_id,
    )
    return success_response(artifact.model_dump(mode="json"))


@router.post("/artifacts/{artifact_id}/export")
def export_artifact(
    artifact_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    format: str = Query(default="markdown", description="Export format"),
) -> Response:
    export = conversations_service.export_artifact(
        db=db,
        viewer_id=viewer.user_id,
        artifact_id=artifact_id,
        export_format=format,
    )
    return _artifact_export_response(export)


@router.get(
    "/artifacts/{artifact_id}/exports",
    response_model=MessageArtifactExportLedgerListResponse,
)
def list_artifact_exports(
    artifact_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    exports = conversations_service.list_artifact_exports(
        db=db,
        viewer_id=viewer.user_id,
        artifact_id=artifact_id,
    )
    return success_response([export.model_dump(mode="json") for export in exports])


def _artifact_export_response(export) -> Response:
    title = export.artifact.title or export.artifact.artifact_kind or "artifact"
    filename = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "artifact"
    content_types = {
        "markdown": ("md", "text/markdown; charset=utf-8"),
        "json": ("json", "application/json; charset=utf-8"),
        "html": ("html", "text/html; charset=utf-8"),
        "csv": ("csv", "text/csv; charset=utf-8"),
        "pdf": ("pdf", "application/pdf"),
    }
    extension, media_type = content_types[export.format]
    if export.format == "json":
        body = (
            json.dumps(export.content, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            + "\n"
        )
    elif export.format == "pdf":
        body = str(export.content).encode("latin-1")
    else:
        body = str(export.content)
    return Response(
        content=body,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{filename}.{extension}"',
            "X-Nexus-Artifact-Export-Id": str(export.export_id),
            "X-Nexus-Artifact-Version": str(export.artifact_version),
            "X-Nexus-Artifact-Content-SHA256": export.content_sha256,
            "X-Nexus-Artifact-Manifest-SHA256": export.manifest_sha256,
        },
    )


@router.post("/artifacts/{artifact_id}/ask", response_model=MessageArtifactFollowUpResponse)
def create_artifact_follow_up(
    artifact_id: UUID,
    body: MessageArtifactFollowUpRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversations_service.create_artifact_follow_up(
        db=db,
        viewer_id=viewer.user_id,
        artifact_id=artifact_id,
        request=body,
    )
    return success_response(result.model_dump(mode="json"))


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
    Cascades to message_context.

    Errors:
        E_MESSAGE_NOT_FOUND (404): Message doesn't exist or viewer is not conversation owner.
    """
    conversations_service.delete_message(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return Response(status_code=204)
