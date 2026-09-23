"""Browser extension session routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import ok, success_response
from nexus.services.extension_sessions import (
    create_extension_session,
    describe_extension_session,
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


@router.get("/extension-sessions/current")
def read_current_extension_session_route(
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """The account behind the bearer and the byte limits its captures must respect."""
    return ok(describe_extension_session(db, viewer.user_id))


@router.delete("/extension-sessions/current", status_code=204)
def revoke_current_extension_session_route(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Extension token required")

    if not revoke_extension_session_token(db, token):
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid extension token")

    return Response(status_code=204)
