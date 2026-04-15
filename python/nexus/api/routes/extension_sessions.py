"""Browser extension session routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.services.extension_sessions import (
    create_extension_session,
    revoke_extension_session_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/extension-sessions", status_code=201)
def create_extension_session_route(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    session, token = create_extension_session(db=db, user_id=viewer.user_id)
    return success_response(
        {
            "id": session.id,
            "token": token,
            "created_at": session.created_at,
        }
    )


@router.delete("/extension-sessions/current", status_code=204)
def revoke_current_extension_session_route(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Extension token required")

    if not revoke_extension_session_token(db, authorization[7:].strip()):
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid extension token")

    return Response(status_code=204)
