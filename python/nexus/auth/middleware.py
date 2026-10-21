"""Who is asking: the internal secret, the bearer and the viewer, before any route runs.

Paths in ``PUBLIC_PATHS`` pass untouched. When an internal secret is configured (staging and
prod) every other request must carry it as ``X-Nexus-Internal`` (403 ``E_INTERNAL_ONLY``).
Route-authenticated paths (a handoff code, an extension bearer, a share token) stop there;
every other request needs a verified bearer (401 ``E_UNAUTHENTICATED``, 503
``E_AUTH_UNAVAILABLE``) and gets ``request.state.viewer``. The first sight of a user and token
email in this process mirrors them (``services.bootstrap``); a failure there is 500
``E_INTERNAL`` and is retried by the next request.
"""

import hmac
import re
from dataclasses import dataclass
from uuid import UUID

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.verifier import TokenVerifier
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.responses import error_response
from nexus.services.bootstrap import ensure_user_and_default_library

logger = get_logger(__name__)

PUBLIC_PATHS = frozenset(
    {"/livez", "/readyz", "/version", "/docs", "/redoc", "/openapi.json", "/ingest/email"}
)
_ROUTE_AUTHENTICATED = re.compile(
    r"/auth/handoff-codes/consume|/auth/extension-sessions/current|/extension/.*"
    r"|/public/resource-share(/.*)?"
)


@dataclass
class Viewer:
    user_id: UUID
    email: str | None = None  # the token's, lowercased; an extension bearer carries none


class AuthMiddleware:
    def __init__(self, app: ASGIApp, verifier: TokenVerifier, internal_secret: str | None):
        self.app = app
        self.verifier = verifier
        self.internal_secret = internal_secret
        # (user, token email) mirrored by this process: a changed email mirrors on first sight
        self._seen: set[tuple[UUID, str | None]] = set()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in PUBLIC_PATHS:
            return await self.app(scope, receive, send)
        try:
            viewer = await self._viewer(scope)
        except ApiError as error:
            body = error_response(error.code, error.message)
            return await JSONResponse(body, status_code=error.status_code)(scope, receive, send)
        if viewer is not None:
            scope.setdefault("state", {})["viewer"] = viewer
        await self.app(scope, receive, send)

    async def _viewer(self, scope: Scope) -> Viewer | None:
        headers = Headers(scope=scope)
        if self.internal_secret is not None and not hmac.compare_digest(
            headers.get("x-nexus-internal", "").encode(), self.internal_secret.encode()
        ):
            logger.warning("auth_failure", reason="internal_secret")
            raise ApiError(ApiErrorCode.E_INTERNAL_ONLY, "Internal API access required")
        if _ROUTE_AUTHENTICATED.fullmatch(scope["path"]):
            return None
        token = parse_bearer_token(headers.get("authorization"))
        if token is None:
            logger.warning("auth_failure", reason="missing_bearer")
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Authentication required")
        user_id, email = await self.verifier.verify(token)
        if (user_id, email) not in self._seen:
            try:
                await run_in_threadpool(_bootstrap, user_id, email)
            # justify-ignore-error: logged once per request; the request answers a generic 500.
            except Exception:
                logger.exception("bootstrap_failed", user_id=str(user_id))
                raise ApiError(ApiErrorCode.E_INTERNAL, "Internal server error") from None
            self._seen.add((user_id, email))
        return Viewer(user_id=user_id, email=email)


def _bootstrap(user_id: UUID, email: str | None) -> None:
    with get_session_factory()() as db:
        ensure_user_and_default_library(db, user_id, email)


async def get_viewer(request: Request) -> Viewer:
    """The authenticated viewer; a route-authenticated or public path has none (401)."""
    viewer = getattr(request.state, "viewer", None)
    if viewer is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Authentication required")
    return viewer
