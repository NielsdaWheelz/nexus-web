"""The api's one door: request correlation, the wire revision and the last-resort error.

A pure ASGI middleware, outermost, so streams pass through unbuffered. For every HTTP
request it

- adopts a well-formed inbound ``X-Request-ID`` (the bff's) or mints one, binds it to the
  log context and stamps it on the response (I3);
- refuses, before routing, a client built for another wire: ``X-Nexus-Wire`` missing or
  other than ``WIRE_REVISION`` answers 426 ``E_WIRE_MISMATCH`` (I10). ``PUBLIC_PATHS``
  (operational, schema, the email webhook) carry no client build and are exempt;
- renders an exception nothing claimed before the response started as the 500
  ``E_INTERNAL`` envelope with its request id (a client disconnect as 499), and logs one
  access line when the request ends: a stream when it closes or its client leaves.
"""

import re
import time
import uuid

from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.pool import QueuePool
from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from nexus.auth.middleware import PUBLIC_PATHS
from nexus.db.engine import get_engine
from nexus.errors import ApiErrorCode
from nexus.logging import bind_request, get_logger
from nexus.responses import error_response

WIRE_REVISION = 4
"""The client contract. Bump it in the change that breaks a client built before it;
``gen:wire`` carries it to the web build, the extension and the apk."""

_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")
logger = get_logger(__name__)


def _envelope(code: ApiErrorCode, message: str) -> JSONResponse:
    return JSONResponse(error_response(code, message), status_code=code.status)


class EdgeMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        inbound = headers.get("x-request-id", "")
        request_id = inbound if _REQUEST_ID.fullmatch(inbound) else str(uuid.uuid4())
        bind_request(request_id, path=scope["path"], method=scope["method"])
        started = time.monotonic()
        status = 0

        async def stamped(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [
                    *message.get("headers", []),
                    (b"x-request-id", request_id.encode()),
                ]
            await send(message)

        wire = headers.get("x-nexus-wire")
        try:
            if scope["path"] not in PUBLIC_PATHS and wire != str(WIRE_REVISION):
                logger.info("http.wire_mismatch", client_wire=(wire or "")[:16])
                refusal = _envelope(
                    ApiErrorCode.E_WIRE_MISMATCH, "This client was built for another API"
                )
                return await refusal(scope, receive, stamped)
            await self.app(scope, receive, stamped)
        except ClientDisconnect:
            if status == 0:
                await _envelope(ApiErrorCode.E_CLIENT_DISCONNECT, "Client disconnected")(
                    scope, receive, stamped
                )
        except Exception as exc:
            pool = get_engine().pool if isinstance(exc, PoolTimeout) else None
            if isinstance(pool, QueuePool):
                logger.error(
                    "db_pool_exhausted",
                    pool_checked_out=pool.checkedout(),
                    pool_overflow=pool.overflow(),
                    pool_size=pool.size(),
                )
            else:
                logger.exception("http.request.failed")
            if status != 0:
                raise
            await _envelope(ApiErrorCode.E_INTERNAL, "Internal server error")(
                scope, receive, stamped
            )
        finally:
            # not on the final body message: a stream whose client left never sends one.
            viewer = scope.get("state", {}).get("viewer")
            logger.info(
                "http.request.completed",
                status_code=status,
                duration_ms=round((time.monotonic() - started) * 1000, 2),
                viewer_id=str(viewer.user_id) if viewer else None,
            )
