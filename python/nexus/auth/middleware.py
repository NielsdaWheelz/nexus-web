"""Authentication middleware for FastAPI.

Provides:
- AuthMiddleware: Global middleware for bearer token + internal header verification
- get_viewer: Dependency for accessing authenticated viewer identity
"""

import hmac
import logging
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from nexus.auth.verifier import TokenVerifier
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import error_response

logger = logging.getLogger(__name__)

# Header names
AUTHORIZATION_HEADER = "authorization"
INTERNAL_HEADER = "x-nexus-internal"

# Paths that don't require authentication
PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json"}


@dataclass
class Viewer:
    """Authenticated viewer identity.

    Attributes:
        user_id: The viewer's user ID (from JWT sub claim).
        default_library_id: The viewer's default library ID.
    """

    user_id: UUID
    default_library_id: UUID


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
        requires_internal_header: bool = False,
        internal_secret: str | None = None,
        bootstrap_callback: Callable[[UUID], UUID] | None = None,
    ):
        """Initialize the auth middleware.

        Args:
            app: The ASGI application.
            verifier: TokenVerifier implementation for JWT verification.
            requires_internal_header: Whether to enforce X-Nexus-Internal header.
            internal_secret: The expected internal secret value.
            bootstrap_callback: Function(user_id) -> default_library_id.
                              Called after successful auth to ensure user exists.
        """
        super().__init__(app)
        self.verifier = verifier
        self.requires_internal_header = requires_internal_header
        self.internal_secret = internal_secret
        self.bootstrap_callback = bootstrap_callback

    async def dispatch(self, request: Request, call_next) -> JSONResponse:
        """Process the request through auth checks."""
        # Skip auth for public paths
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        # Step 1: Check internal header if required
        if self.requires_internal_header:
            error_response_obj = self._verify_internal_header(request)
            if error_response_obj:
                return error_response_obj

        # Step 2: Extract bearer token
        token, error_response_obj = self._extract_bearer_token(request)
        if error_response_obj:
            return error_response_obj

        # Step 3: Verify token
        try:
            payload = self.verifier.verify(token)
        except ApiError as e:
            return self._error_json_response(e.code, e.message, e.status_code)

        # Step 4: Parse user_id from sub
        user_id = UUID(payload["sub"])

        # Step 5: Bootstrap user/library if callback provided
        if self.bootstrap_callback:
            try:
                default_library_id = self.bootstrap_callback(user_id)
            except Exception as e:
                logger.exception("Bootstrap failed for user %s: %s", user_id, e)
                return self._error_json_response(
                    ApiErrorCode.E_INTERNAL,
                    "Internal server error",
                    500,
                )
        else:
            # No bootstrap callback - use a placeholder (tests may not need it)
            default_library_id = user_id  # Placeholder

        # Step 6: Attach viewer to request state
        request.state.viewer = Viewer(
            user_id=user_id,
            default_library_id=default_library_id,
        )

        return await call_next(request)

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
                extra={
                    "reason": "missing_header",
                    "request_path": request.url.path,
                },
            )
            return "", self._error_json_response(
                ApiErrorCode.E_UNAUTHENTICATED,
                "Authentication required",
                401,
            )

        # Check for Bearer prefix (case-insensitive)
        if not auth_header.lower().startswith("bearer "):
            logger.warning(
                "auth_failure",
                extra={
                    "reason": "invalid_header_format",
                    "request_path": request.url.path,
                },
            )
            return "", self._error_json_response(
                ApiErrorCode.E_UNAUTHENTICATED,
                "Invalid authorization header format",
                401,
            )

        # Extract token (everything after "Bearer ")
        token = auth_header[7:].strip()

        if not token:
            logger.warning(
                "auth_failure",
                extra={
                    "reason": "invalid_header_format",
                    "request_path": request.url.path,
                },
            )
            return "", self._error_json_response(
                ApiErrorCode.E_UNAUTHENTICATED,
                "Invalid authorization header format",
                401,
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


def get_viewer(request: Request) -> Viewer:
    """FastAPI dependency to get the authenticated viewer.

    This dependency should be used in route handlers that require authentication.

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


# Type alias for dependency injection
ViewerDep = Depends(get_viewer)
