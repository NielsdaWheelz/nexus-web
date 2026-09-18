"""Authentication middleware for FastAPI.

Provides:
- AuthMiddleware: Global middleware for bearer token + internal header verification
- get_viewer: Dependency for accessing authenticated viewer identity
"""

import asyncio
import hmac
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.verifier import TokenVerifier
from nexus.errors import ApiError, ApiErrorCode
from nexus.offline_reading_paths import is_offline_reading_package_path
from nexus.responses import error_response
from nexus.stream_paths import is_stream_path

logger = logging.getLogger(__name__)

# Header names
AUTHORIZATION_HEADER = "authorization"
INTERNAL_HEADER = "x-nexus-internal"

# Paths that don't require authentication
PUBLIC_PATHS = {
    "/livez",
    "/readyz",
    "/version",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/billing/stripe/webhook",
    "/ingest/email",
}
EXTENSION_AUTH_PATHS = {
    "/auth/extension-sessions/current",
    "/media/capture/article",
    "/media/capture/file",
    "/media/capture/url",
}
# Paths that require the X-Nexus-Internal trust signal but no Bearer token,
# because the route authenticates the caller via a credential in the request
# body (e.g. single-use handoff code + verifier). The user has no Supabase
# session yet at this point in the flow — that's what consume produces.
INTERNAL_ONLY_PATHS = {
    "/auth/handoff-codes/consume",
}


@dataclass
class Viewer:
    """Authenticated viewer identity.

    Attributes:
        user_id: The viewer's user ID (from JWT sub claim).
        default_library_id: The viewer's default library ID.
        email: The viewer's email (from JWT email claim, if present).
    """

    user_id: UUID
    default_library_id: UUID
    email: str | None = None


class AuthMiddleware(BaseHTTPMiddleware):
    """Authentication middleware for FastAPI.

    Enforces:
    - Bearer token authentication on all non-public paths
    - Internal header verification in staging/prod environments
    - User/default library bootstrap via callback

    Order of checks:
    1. Skip if public path
    2. Verify internal header (if required)
    3. Extract and parse bearer token
    4. Verify token via TokenVerifier
    5. Call bootstrap callback to ensure user/library exist
    6. Attach Viewer to request state
    """

    def __init__(
        self,
        app: ASGIApp,
        verifier: TokenVerifier,
        bootstrap_callback: Callable[..., UUID],
        requires_internal_header: bool = False,
        internal_secret: str | None = None,
    ):
        """Initialize the auth middleware.

        Args:
            app: The ASGI application.
            verifier: TokenVerifier implementation for JWT verification.
            bootstrap_callback: Function(user_id, email=None) -> default_library_id.
                              Called after successful auth to ensure user exists.
            requires_internal_header: Whether to enforce X-Nexus-Internal header.
            internal_secret: The expected internal secret value.
        """
        super().__init__(app)
        self.verifier = verifier
        self.requires_internal_header = requires_internal_header
        self.internal_secret = internal_secret
        self.bootstrap_callback = bootstrap_callback
        # Bootstrap repairs durable first-login invariants. Once it succeeds,
        # the Viewer projection is process-stable for this user; keep that
        # result here so ordinary authenticated requests do not pay a threadpool
        # handoff (or a database checkout) merely to hit a downstream cache.
        # Concurrent cold misses fan into one shielded task per user so one
        # request cancellation cannot cancel bootstrap for its peers.
        self._default_library_id_by_user: dict[UUID, UUID] = {}
        self._bootstrap_task_by_user: dict[UUID, asyncio.Task[UUID]] = {}

    async def dispatch(self, request: Request, call_next) -> Response:
        """Process the request through auth checks."""
        # Skip auth for public paths
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        # Stream routes authenticate via the stream-token bearer (get_stream_viewer)
        # instead of Supabase auth. The iss/aud requirement on stream tokens prevents
        # accidental acceptance of supabase JWTs if one hits a stream endpoint.
        if is_stream_path(request.url.path):
            return await call_next(request)

        # This exact direct route verifies its scoped one-use bearer at the
        # route boundary. No other offline-reading path skips BFF/Supabase auth.
        if is_offline_reading_package_path(request.url.path):
            return await call_next(request)

        # Step 1: Check internal header if required
        if self.requires_internal_header:
            error_response_obj = self._verify_internal_header(request)
            if error_response_obj:
                return error_response_obj

        if request.url.path in EXTENSION_AUTH_PATHS:
            return await call_next(request)

        if request.url.path in INTERNAL_ONLY_PATHS:
            return await call_next(request)

        # Owned oracle plate bytes are public-domain and need no per-user auth, but
        # the route stays BFF-only: the internal-header check above already ran, so
        # reaching here means the request came through the BFF. Bearer-exempt.
        if request.url.path.startswith("/oracle/plates/"):
            return await call_next(request)

        # Anonymous resource reads remain BFF-only. The internal-header check
        # above has already succeeded; the route authenticates its bearer link
        # independently and never receives a fabricated Viewer.
        if request.url.path == "/public/resource-share" or request.url.path.startswith(
            "/public/resource-share/"
        ):
            return await call_next(request)

        auth_started_at = time.monotonic()

        # Step 2: Extract bearer token
        token, error_response_obj = self._extract_bearer_token(request)
        if error_response_obj:
            return error_response_obj

        # Step 3: Verify token
        try:
            payload = self.verifier.verify(token)
        except ApiError as e:
            return self._error_json_response(e.code, e.message, e.status_code)

        # Step 4: Parse user_id and email from claims
        user_id = UUID(payload["sub"])
        raw_email = payload.get("email")
        email = (raw_email.strip().lower() or None) if isinstance(raw_email, str) else None

        # Step 5: Bootstrap user/library.
        # bootstrap_callback runs a blocking DB transaction; dispatch is async,
        # so call it off the event loop. Calling it inline blocks the loop on
        # pool checkout under contention, which stalls response flushing and the
        # post-response db.close() of in-flight requests — turning transient pool
        # pressure into a self-sustaining deadlock.
        default_library_id = self._default_library_id_by_user.get(user_id)
        if default_library_id is None:
            bootstrap_task = self._bootstrap_task_by_user.get(user_id)
            if bootstrap_task is None:
                bootstrap_task = asyncio.create_task(
                    self._bootstrap_and_cache(user_id, email),
                )
                bootstrap_task.add_done_callback(self._consume_bootstrap_task_result)
                self._bootstrap_task_by_user[user_id] = bootstrap_task
            try:
                default_library_id = await asyncio.shield(bootstrap_task)
            # justify-ignore-error: the shared task logs the bootstrap defect once;
            # each affected request receives the same generic boundary response.
            except Exception:
                return self._error_json_response(
                    ApiErrorCode.E_INTERNAL,
                    "Internal server error",
                    500,
                )

        # Step 6: Attach viewer to request state
        request.state.viewer = Viewer(
            user_id=user_id,
            default_library_id=default_library_id,
            email=email,
        )
        auth_duration_ms = (time.monotonic() - auth_started_at) * 1000
        response = await call_next(request)
        response.headers.append("Server-Timing", f"nexus_auth;dur={auth_duration_ms:.2f}")
        return response

    @staticmethod
    def _consume_bootstrap_task_result(task: asyncio.Task[UUID]) -> None:
        if not task.cancelled():
            task.exception()

    async def _bootstrap_and_cache(self, user_id: UUID, email: str | None) -> UUID:
        current_task = asyncio.current_task()
        try:
            default_library_id = await run_in_threadpool(
                self.bootstrap_callback,
                user_id,
                email=email,
            )
            self._default_library_id_by_user[user_id] = default_library_id
            return default_library_id
        # justify-ignore-error: the request boundary returns a generic 500 while
        # this shared owner records the bootstrap defect exactly once.
        except Exception as exc:
            logger.exception("Bootstrap failed for user %s: %s", user_id, exc)
            raise
        finally:
            if self._bootstrap_task_by_user.get(user_id) is current_task:
                del self._bootstrap_task_by_user[user_id]

    def _verify_internal_header(self, request: Request) -> JSONResponse | None:
        """Verify the internal header using constant-time comparison.

        Returns:
            JSONResponse if verification fails, None if successful.
        """
        header_value = request.headers.get(INTERNAL_HEADER)

        if header_value is None:
            logger.warning(
                "auth_failure",
                extra={
                    "reason": "internal_header_missing",
                    "request_path": request.url.path,
                },
            )
            return self._error_json_response(
                ApiErrorCode.E_INTERNAL_ONLY,
                "Internal API access required",
                403,
            )

        if not self.internal_secret:
            # This shouldn't happen in staging/prod (validated at startup)
            logger.error("Internal secret not configured but header required")
            return self._error_json_response(
                ApiErrorCode.E_INTERNAL,
                "Internal server error",
                500,
            )

        # Constant-time comparison to prevent timing attacks
        if not hmac.compare_digest(header_value.encode(), self.internal_secret.encode()):
            logger.warning(
                "auth_failure",
                extra={
                    "reason": "internal_header_mismatch",
                    "request_path": request.url.path,
                },
            )
            return self._error_json_response(
                ApiErrorCode.E_INTERNAL_ONLY,
                "Internal API access required",
                403,
            )

        return None

    def _extract_bearer_token(self, request: Request) -> tuple[str, JSONResponse | None]:
        """Extract bearer token from Authorization header.

        Returns:
            Tuple of (token, error_response). Token is empty string if error.
        """
        auth_header = request.headers.get(AUTHORIZATION_HEADER)
        if not auth_header:
            logger.warning(
                "auth_failure",
                extra={"reason": "missing_header", "request_path": request.url.path},
            )
            return "", self._error_json_response(
                ApiErrorCode.E_UNAUTHENTICATED, "Authentication required", 401
            )

        token = parse_bearer_token(auth_header)
        if token is None:
            logger.warning(
                "auth_failure",
                extra={"reason": "invalid_header_format", "request_path": request.url.path},
            )
            return "", self._error_json_response(
                ApiErrorCode.E_UNAUTHENTICATED, "Invalid authorization header format", 401
            )

        return token, None

    def _error_json_response(
        self, code: ApiErrorCode, message: str, status_code: int
    ) -> JSONResponse:
        """Create a JSON error response."""
        return JSONResponse(
            status_code=status_code,
            content=error_response(code, message),
        )


async def get_viewer(request: Request) -> Viewer:
    """FastAPI dependency to get the authenticated viewer.

    Reading request state requires no worker-thread allocation. Authentication
    and bootstrap have already completed in middleware.

    Args:
        request: The FastAPI request object.

    Returns:
        The authenticated Viewer.

    Raises:
        ApiError: If viewer is not set (middleware didn't run or path is public).
    """
    viewer = getattr(request.state, "viewer", None)
    if viewer is None:
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Authentication required")
    return viewer
