"""X-Request-ID middleware for request correlation and tracing.

This middleware:
- Extracts or generates a unique request ID for each request
- Validates and normalizes incoming request IDs
- Attaches the ID to request state for downstream use
- Echoes the ID in response headers
- Logs access information after response is produced

Middleware Ordering (Critical):
- Must be added LAST to run FIRST (FastAPI middleware runs in reverse order)
- This ensures all other middleware (auth, etc.) are wrapped and receive request_id
- Auth failures will still include X-Request-ID in their response
"""

import re
import time
import uuid

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from nexus.logging import clear_request_context, get_logger, set_request_context

REQUEST_ID_HEADER = "X-Request-ID"
MAX_REQUEST_ID_LENGTH = 128

# Regex for valid non-UUID request IDs
# Allows alphanumeric, dots, hyphens, underscores
VALID_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# Regex for UUID strings (any version)
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

logger = get_logger(__name__)


def is_valid_uuid(value: str) -> bool:
    """Check if value is a valid UUID string."""
    return bool(UUID_PATTERN.match(value))


def is_valid_request_id(value: str) -> bool:
    """Check if value is a valid request ID.

    A request ID is valid if:
    - Length is <= 128 bytes
    - It's a valid UUID string, OR
    - It matches the alphanumeric pattern

    Args:
        value: The request ID value to validate.

    Returns:
        True if valid, False otherwise.
    """
    if len(value.encode("utf-8")) > MAX_REQUEST_ID_LENGTH:
        return False

    return is_valid_uuid(value) or bool(VALID_REQUEST_ID_PATTERN.match(value))


def normalize_request_id(value: str) -> str:
    """Normalize a valid request ID.

    UUIDs are converted to lowercase hyphenated canonical form.
    Non-UUID strings are preserved as-is.

    Args:
        value: A valid request ID value.

    Returns:
        Normalized request ID.
    """
    if is_valid_uuid(value):
        return value.lower()
    return value


def generate_request_id() -> str:
    """Generate a new UUID v4 request ID."""
    return str(uuid.uuid4())


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Middleware for X-Request-ID handling and access logging.

    This middleware:
    1. Validates and normalizes incoming X-Request-ID headers
    2. Generates a new ID if missing or invalid
    3. Sets request_id on request.state for downstream use
    4. Sets logging context for all log entries
    5. Echoes the ID in the response header
    6. Emits one access log entry per request (after response)

    Args:
        app: The ASGI application.
        log_requests: If True, log access entries for each request.
    """

    def __init__(self, app, log_requests: bool = True):
        super().__init__(app)
        self.log_requests = log_requests

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Process request with request ID handling."""
        start_time = time.monotonic()

        # Extract and validate request ID from header
        incoming_id = request.headers.get(REQUEST_ID_HEADER)
        if incoming_id and is_valid_request_id(incoming_id):
            request_id = normalize_request_id(incoming_id)
        else:
            request_id = generate_request_id()

        # Attach to request state for downstream middleware/routes
        request.state.request_id = request_id

        # Set logging context (available to all subsequent log calls)
        set_request_context(request_id)

        try:
            # Process request through the rest of the middleware stack
            response = await call_next(request)

            # Get user_id if auth middleware ran (set on request.state.viewer)
            viewer = getattr(request.state, "viewer", None)
            user_id = str(viewer.user_id) if viewer else None
            if user_id:
                set_request_context(request_id, user_id)

            # Always echo request ID in response
            response.headers[REQUEST_ID_HEADER] = request_id

            # Log access entry
            if self.log_requests:
                duration_ms = (time.monotonic() - start_time) * 1000
                logger.info(
                    "request_completed",
                    method=request.method,
                    path=request.url.path,
                    status_code=response.status_code,
                    duration_ms=round(duration_ms, 2),
                )

            return response

        except Exception:
            # Log and re-raise - unhandled_exception_handler will catch this
            logger.exception("request_failed", method=request.method, path=request.url.path)
            raise

        finally:
            # Clear context at end of request
            clear_request_context()


def get_request_id_from_request(request: Request) -> str | None:
    """Get the request ID from request state.

    Args:
        request: The FastAPI request object.

    Returns:
        The request ID if set, None otherwise.
    """
    return getattr(request.state, "request_id", None)
