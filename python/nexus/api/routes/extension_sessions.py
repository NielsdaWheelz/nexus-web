"""Extension session routes: mint (account credential), read and revoke (the bearer)."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import Data
from nexus.schemas.extension_capture import ExtensionSessionOut, ExtensionTokenOut
from nexus.services.extension_sessions import (
    create_extension_session,
    describe_extension_session,
    revoke_extension_session_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/extension-sessions", status_code=201)
def create_session(
    viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession
) -> Data[ExtensionTokenOut]:
    """A new token per call; the extension keeps the last and may revoke any."""
    session, token = create_extension_session(db, viewer.user_id)
    return Data(data=ExtensionTokenOut(id=session.id, token=token, created_at=session.created_at))


@router.get("/extension-sessions/current")
def read_session(
    viewer: Annotated[Viewer, Depends(get_extension_viewer)], db: DbSession
) -> Data[ExtensionSessionOut]:
    """The account behind the bearer and the byte limits its captures must respect."""
    return Data(data=describe_extension_session(db, viewer.user_id))


@router.delete("/extension-sessions/current", status_code=204)
def revoke_session(request: Request, db: DbSession) -> Response:
    """A revoked or unknown token is 401, which the extension reads as done."""
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None or not revoke_extension_session_token(db, token):
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid extension token")
    return Response(status_code=204)
