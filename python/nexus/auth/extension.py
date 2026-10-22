"""FastAPI dependency for scoped browser extension capture tokens."""

from fastapi import Request

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.middleware import Viewer
from nexus.db.session import DbSession
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.extension_sessions import resolve_extension_session_user


def get_extension_viewer(
    request: Request,
    db: DbSession,
) -> Viewer:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Extension token required")

    user_id = resolve_extension_session_user(db, token)
    if user_id is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid extension token")
    return Viewer(user_id=user_id)
