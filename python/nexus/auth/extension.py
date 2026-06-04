"""FastAPI dependency for scoped browser extension capture tokens."""

from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.middleware import Viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.extension_sessions import resolve_extension_session_user


def get_extension_viewer(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Viewer:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Extension token required")

    user_id = resolve_extension_session_user(db, token)
    if user_id is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid extension token")

    default_library_id = ensure_user_and_default_library(db, user_id)
    return Viewer(user_id=user_id, default_library_id=default_library_id)
