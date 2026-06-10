"""SSE stream-path predicate, shared by the auth and CORS middlewares.

Dependency-free on purpose: both `auth.middleware` and `middleware.stream_cors`
import it, and it cannot live under `api/routes` (importing that package would
cycle back through the route modules those middlewares help serve).
"""


def is_stream_path(path: str) -> bool:
    """True for the browser-callable SSE endpoints (auth via stream-token bearer).

    One prefix check: every browser-callable SSE stream lives under `/stream/`.
    An unrouted `/stream/*` path now skips Supabase auth and falls through to the
    router, which 404s it — no data exposure (no such route exists to leak).
    """
    return path.startswith("/stream/")
