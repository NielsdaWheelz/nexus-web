"""ASGI middleware for request-scoped database session release."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from nexus.db.session import release_tracked_request_db_sessions


class RequestDbSessionMiddleware:
    """Release request DB connections before response bodies are streamed."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        released = False

        def release_once() -> None:
            nonlocal released
            if released:
                return
            released = True
            release_tracked_request_db_sessions(scope.get("state"))

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                release_once()
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            release_once()
