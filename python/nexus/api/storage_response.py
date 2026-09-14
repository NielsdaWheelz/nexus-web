"""Storage response lifetime inside the existing admitted route owner."""

from collections.abc import Generator, Mapping

import anyio
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send


class StorageResponse(StreamingResponse):
    """Acquire lazily, prefetch before headers, and physically close before return.

    Callers must use an admitted route: its outer task shield and inner AnyIO
    deadline scope keep synchronous next()/close() owned through cancellation.
    """

    def __init__(
        self,
        content: Generator[bytes, None, None],
        *,
        media_type: str,
        headers: Mapping[str, str],
        status_code: int = 200,
    ) -> None:
        self._stream = content
        super().__init__(content, status_code=status_code, media_type=media_type, headers=headers)

    async def stream_response(self, send: Send) -> None:
        iterator = aiter(self.body_iterator)
        chunk = await anext(iterator, None)
        await send(
            {"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers}
        )
        while chunk is not None:
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
            del chunk
            chunk = await anext(iterator, None)
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Enter the shield before run_sync's initial cancellation checkpoint.
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(self._stream.close)
