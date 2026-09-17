"""X-Request-ID middleware for request correlation and tracing.

This middleware:
- Extracts or generates a unique request ID for each request
- Attaches the ID to request state for downstream use
- Echoes the ID in response headers
- Logs access information after response is produced

Middleware Ordering (Critical):
- Must be added LAST to run FIRST (FastAPI middleware runs in reverse order)
- This ensures all other middleware (auth, etc.) are wrapped and receive request_id
- Auth failures will still include X-Request-ID in their response
"""

import time
import uuid

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from nexus.logging import clear_request_context, get_logger, set_request_context
from nexus.services.redact import safe_kv

REQUEST_ID_HEADER = "X-Request-ID"
logger = get_logger(__name__)


def generate_request_id() -> str:
    """Generate a new UUID v4 request ID."""
    return str(uuid.uuid4())


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Middleware for X-Request-ID handling and access logging.

    This middleware:
    1. Reuses the inbound X-Request-ID header, or generates one when absent
    2. Sets request_id on request.state for downstream use
    3. Sets logging context for all log entries
    4. Echoes the ID in the response header
    5. Emits one access log entry per request (after response)
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Process request with request ID handling."""
        start_time = time.monotonic()

        request_id = request.headers.get(REQUEST_ID_HEADER) or generate_request_id()

        # Attach to request state for downstream middleware/routes
        request.state.request_id = request_id

        # Set logging context with path and method for subsequent log calls.
        set_request_context(
            request_id,
            path=request.url.path,
            method=request.method,
        )

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
            duration_ms = (time.monotonic() - start_time) * 1000
            downstream_timings = response.headers.getlist("Server-Timing")
            api_timing = f"nexus_api;dur={duration_ms:.2f}"
            response.headers["Server-Timing"] = (
                ", ".join((api_timing, *downstream_timings)) if downstream_timings else api_timing
            )

            logger.info(
                "http.request.completed",
                **safe_kv(
                    status_code=response.status_code,
                    duration_ms=round(duration_ms, 2),
                ),
            )

            return response

        # justify-ignore-error: middleware observability boundary logs context
        # and re-raises for the global unhandled-exception handler.
        except Exception:
            logger.exception("http.request.failed")
            raise

        finally:
            # Clear context at end of request
            clear_request_context()
