"""SSE stream-path predicate, shared by the auth and CORS middlewares.

Dependency-free on purpose: both `auth.middleware` and `middleware.stream_cors`
import it, and it cannot live under `api/routes` (importing that package would
cycle back through the route modules those middlewares help serve).
"""


def is_stream_path(path: str) -> bool:
    """True for the browser-callable SSE endpoints (auth via stream-token bearer)."""
    return (
        (path.startswith("/chat-runs/") and path.endswith("/events"))
        or (path.startswith("/stream/oracle-readings/") and path.endswith("/events"))
        or (path.startswith("/media/") and path.endswith("/events"))
    )
