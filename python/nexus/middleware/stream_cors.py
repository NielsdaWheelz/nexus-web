"""Pure ASGI CORS middleware for /stream/* endpoints only.

Per PR-08 spec §3:
- Do NOT use starlette's CORSMiddleware (not path-scoped).
- Do NOT use BaseHTTPMiddleware (buffers StreamingResponse, defeats incremental delivery).
- This is a pure ASGI middleware that injects CORS headers only on /stream/* paths.
- Non-/stream/* requests pass through untouched.
- Handles OPTIONS preflight before any auth dependency runs.
"""

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send


class StreamCORSMiddleware:
    """Pure ASGI middleware for path-scoped CORS on /stream/* routes.

    Does not buffer streaming responses. Only injects CORS headers on the
    initial http.response.start message for /stream/* paths.
    """

    def __init__(self, app: ASGIApp, allowed_origins: list[str]):
        self.app = app
        self.allowed_origins = set(allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/stream/"):
            await self.app(scope, receive, send)
            return

        headers = dict(Headers(scope=scope))
        origin = headers.get("origin")

        if origin is None:
            # No Origin header = non-browser request (curl, tests). Pass through.
            await self.app(scope, receive, send)
            return

        if origin not in self.allowed_origins:
            response = Response(status_code=403, content="origin not allowed")
            await response(scope, receive, send)
            return

        if scope["method"] == "OPTIONS":
            # Preflight — respond immediately, no auth needed
            response = Response(
                status_code=204,
                headers={
                    "access-control-allow-origin": origin,
                    "access-control-allow-methods": "POST, OPTIONS",
                    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
                    "access-control-max-age": "600",
                },
            )
            await response(scope, receive, send)
            return

        # Wrap send to inject CORS headers on the response
        async def send_with_cors(message: dict) -> None:
            if message["type"] == "http.response.start":
                resp_headers = MutableHeaders(scope=message)
                resp_headers.append("access-control-allow-origin", origin)
                resp_headers.append("access-control-expose-headers", "X-Request-Id")
            await send(message)

        await self.app(scope, receive, send_with_cors)
