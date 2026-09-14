"""Bound foreground reads across execution, serialization, and body transfer.

Three pools draw on one qualified profile, and a route belongs to exactly one of
them:

- ``AdmittedReadRoute``: expensive reads that materialize a response.
- ``AdmittedImageRoute``: whole-image reads, a stricter sub-budget of the above.
- ``AdmittedPackageTransferRoute``: offline package transfers, whose bytes dwarf
  every other response and which therefore may not draw on the read budget the
  spec reserves for progress, auth, readiness and lightweight reads.

A permit covers the request body as well: every pool refuses a body larger than
the profile's ``request_bytes`` before the framework reads or parses it, so no
admitted route materializes an arbitrary request.

Progress, reader state, readiness, file redirects and mint/status routes stay
outside every pool: that reserved headroom is what keeps the process answering
while the pools are full.
"""

import asyncio

from fastapi.routing import APIRoute
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode

_REQUEST_TOO_LARGE = "Request body exceeds the qualified read profile"


class ReadAdmission:
    def __init__(
        self,
        *,
        max_concurrency: int,
        deadline_seconds: int,
        retry_after_seconds: int,
        request_bytes: int,
    ) -> None:
        if (
            max_concurrency < 1
            or deadline_seconds < 1
            or retry_after_seconds < 1
            or request_bytes < 1
        ):
            raise ValueError("read admission requires positive qualified limits")
        self._max_concurrency = max_concurrency
        self._deadline_seconds = deadline_seconds
        self._retry_after_seconds = retry_after_seconds
        self._request_bytes = request_bytes
        self._running: set[asyncio.Task[None]] = set()

    def _bounded(self, scope: Scope, receive: Receive) -> Receive:
        """Refuse a request body larger than the profile admits, before it exists.

        A declared length is refused before a slot is taken and before the server
        is asked for a single body byte. Chunked bodies and lying declarations are
        caught on the way in, because this wrapper stops consuming the stream at
        the bound rather than after the framework has materialized and parsed it.
        The HTTP server has already validated Content-Length as digits to build
        this scope.
        """
        for key, value in scope["headers"]:
            if key == b"content-length" and int(value) > self._request_bytes:
                raise ApiError(ApiErrorCode.E_REQUEST_TOO_LARGE, _REQUEST_TOO_LARGE)
        received = 0

        async def bounded_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self._request_bytes:
                    raise ApiError(ApiErrorCode.E_REQUEST_TOO_LARGE, _REQUEST_TOO_LARGE)
            return message

        return bounded_receive

    async def serve(self, handle: ASGIApp, scope: Scope, receive: Receive, send: Send) -> None:
        receive = self._bounded(scope, receive)
        # This owner runs on the ASGI event loop. No await separates admission
        # from publishing the task that owns the slot.
        if len(self._running) >= self._max_concurrency:
            raise ApiError(
                ApiErrorCode.E_READ_CAPACITY,
                "Reader capacity is occupied; retry this read.",
                retry_after_seconds=self._retry_after_seconds,
            )

        async def admitted_route() -> None:
            try:
                await handle(scope, receive, send)
            finally:
                self._running.remove(task)

        loop = asyncio.get_running_loop()
        task = asyncio.create_task(admitted_route())
        self._running.add(task)
        deadline = loop.time() + self._deadline_seconds
        cancelled = False
        expired = False
        while True:
            try:
                await asyncio.wait_for(
                    asyncio.shield(task), None if expired else max(deadline - loop.time(), 0.0)
                )
                break
            except TimeoutError:
                # The permit's qualified lifetime is a recorded foreground limit.
                # Past it the read cannot finish, so stop waiting for it — but keep
                # holding the slot until the work actually terminates.
                task.cancel()
                expired = True
            except asyncio.CancelledError:
                if task.cancelled():
                    if expired:
                        break
                    raise
                # Outer middleware owns this request's DB-session cleanup.
                # Even repeated caller cancellation cannot unwind it while the
                # synchronous worker or response still uses those resources.
                cancelled = True
        if expired and task.cancelled():
            # justify-defect: the deadline is a qualified limit this deployment is
            # provisioned to meet, so exceeding it is a capacity or wedged-transfer
            # failure of our own, not a condition the client can retry into.
            raise RuntimeError("admitted read exceeded its qualified permit deadline")
        if cancelled:
            raise asyncio.CancelledError


def configured_read_admission() -> tuple[ReadAdmission, ReadAdmission, ReadAdmission]:
    limits = get_settings().api_read_admission_limits
    if limits is None:
        raise RuntimeError("API_READ_ADMISSION_LIMITS requires a qualified foreground profile")
    return (
        ReadAdmission(
            max_concurrency=limits.max_concurrency,
            deadline_seconds=limits.work_deadline_seconds,
            retry_after_seconds=limits.retry_after_seconds,
            request_bytes=limits.request_bytes,
        ),
        ReadAdmission(
            max_concurrency=limits.max_image_concurrency,
            deadline_seconds=limits.work_deadline_seconds,
            retry_after_seconds=limits.retry_after_seconds,
            request_bytes=limits.request_bytes,
        ),
        ReadAdmission(
            max_concurrency=limits.max_package_transfer_concurrency,
            deadline_seconds=limits.package_transfer_deadline_seconds,
            retry_after_seconds=limits.retry_after_seconds,
            request_bytes=limits.request_bytes,
        ),
    )


class AdmittedReadRoute(APIRoute):
    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        admission: ReadAdmission = scope["app"].state.read_admission
        await admission.serve(super().handle, scope, receive, send)


class AdmittedImageRoute(AdmittedReadRoute):
    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        admission: ReadAdmission = scope["app"].state.image_admission
        await admission.serve(super().handle, scope, receive, send)


class AdmittedPackageTransferRoute(APIRoute):
    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        admission: ReadAdmission = scope["app"].state.package_transfer_admission
        await admission.serve(super().handle, scope, receive, send)
