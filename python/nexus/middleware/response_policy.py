"""Apply private-state and anonymous-share headers without buffering bodies."""

import re

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from nexus.public_resource_security import (
    PUBLIC_RESOURCE_SHARE_PATH_RE,
    apply_public_resource_share_headers,
)
from nexus.responses import unhandled_exception_handler

PRIVATE_NO_STORE_PATH_RE = re.compile(
    r"/llm-catalog|/imports(/.*)?|/media/[^/]+/(offline-reader-state|offline-download-spec)"
    r"|/internal/offline-reading/account-binding"
    r"|/internal/media/[^/]+/offline-reading-token"
    r"|/me/reader-profile|/consumption/(activity|activity-exclusions|stats|sessions)"
)


class APIResponsePolicyMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        private = PRIVATE_NO_STORE_PATH_RE.fullmatch(scope["path"]) is not None
        public_share = PUBLIC_RESOURCE_SHARE_PATH_RE.fullmatch(scope["path"]) is not None
        if not private and not public_share:
            await self.app(scope, receive, send)
            return
        started = False

        async def policy_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if private:
                    headers["Cache-Control"] = "private, no-store"
                if public_share:
                    apply_public_resource_share_headers(headers)
                started = True
            await send(message)

        try:
            await self.app(scope, receive, policy_send)
        except Exception as exc:
            if started:
                raise
            response = await unhandled_exception_handler(Request(scope, receive), exc)
            await response(scope, receive, policy_send)
