"""Image transfer keeps admission until bounded response writes finish."""

import asyncio
from collections.abc import Callable
from typing import Any
from uuid import UUID

import pytest
from anyio import CapacityLimiter
from starlette.requests import Request
from starlette.types import Message

from nexus.api.routes import media_assets
from nexus.auth.middleware import Viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.image_proxy import ImageResponse


@pytest.fixture
def image_fetch(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    fetched: list[str] = []

    def fetch(url: str, _etag: str | None) -> ImageResponse:
        fetched.append(url)
        return ImageResponse(b"image", "image/png", '"etag"')

    async def run_sync(function: Callable[..., Any], *args: Any, **_kwargs: Any) -> Any:
        return function(*args)

    monkeypatch.setattr(media_assets, "_image_fetch_slots", CapacityLimiter(2))
    monkeypatch.setattr(media_assets.image_proxy, "fetch_image", fetch)
    monkeypatch.setattr(media_assets.to_thread, "run_sync", run_sync)
    return fetched


async def _receive() -> Message:
    return {"type": "http.request", "body": b"", "more_body": False}


async def _response(url: str):
    return await media_assets.get_proxied_image(
        url,
        Request({"type": "http", "headers": []}),
        Viewer(UUID(int=1), UUID(int=2)),
    )


def test_third_fetch_waits_until_a_response_body_finishes(image_fetch: list[str]) -> None:
    async def run() -> None:
        blocked = [asyncio.Event(), asyncio.Event()]
        release = [asyncio.Event(), asyncio.Event()]

        async def serve(index: int) -> None:
            async def send(message: Message) -> None:
                if index < 2 and message["type"] == "http.response.body":
                    blocked[index].set()
                    await release[index].wait()

            response = await _response(str(index))
            await response({}, _receive, send)

        tasks = [asyncio.create_task(serve(i)) for i in range(2)]
        try:
            await asyncio.gather(*(event.wait() for event in blocked))
            tasks.append(asyncio.create_task(serve(2)))
            await asyncio.sleep(0)
            assert image_fetch == ["0", "1"]
            release[0].set()
            await tasks[0]
            await tasks[2]
            assert image_fetch == ["0", "1", "2"]
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(run())


@pytest.mark.parametrize("not_modified", [False, True])
def test_image_bytes_and_headers_survive_bounded_transfer(
    image_fetch: list[str], monkeypatch: pytest.MonkeyPatch, not_modified: bool
) -> None:
    data = b"image" * 40000
    monkeypatch.setattr(
        media_assets.image_proxy,
        "fetch_image",
        lambda *_args: ImageResponse(data, "image/png", '"etag"', not_modified),
    )
    messages: list[Message] = []

    async def send(message: Message) -> None:
        messages.append(message)

    async def run() -> None:
        response = await _response("image")
        await response({}, _receive, send)

    asyncio.run(run())
    headers = dict(messages[0]["headers"])
    assert headers[b"etag"] == b'"etag"'
    chunks = [message["body"] for message in messages[1:]]
    assert all(len(chunk) <= 64 * 1024 for chunk in chunks)
    assert messages[-1]["more_body"] is False
    if not_modified:
        assert messages[0]["status"] == 304
        assert b"content-length" not in headers
        assert b"".join(chunks) == b""
    else:
        assert messages[0]["status"] == 200
        assert headers[b"content-type"] == b"image/png"
        assert headers[b"content-length"] == str(len(data)).encode()
        assert headers[b"cache-control"] == b"private, max-age=86400"
        assert b"".join(chunks) == data


@pytest.mark.parametrize("failure_at", ["http.response.start", "http.response.body"])
@pytest.mark.parametrize("error", [OSError, asyncio.CancelledError])
def test_failed_or_cancelled_transfer_releases_its_slot(
    image_fetch: list[str], failure_at: str, error: type[BaseException]
) -> None:
    async def run() -> None:
        async def send(message: Message) -> None:
            if message["type"] == failure_at:
                raise error()

        for _ in range(3):
            with pytest.raises(error):
                response = await _response("image")
                await response({}, _receive, send)
            assert media_assets._image_fetch_slots.borrowed_tokens == 0

    asyncio.run(run())


def test_invalid_image_fails_before_response_headers(
    image_fetch: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def invalid(*_args: object) -> ImageResponse:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "invalid image")

    monkeypatch.setattr(media_assets.image_proxy, "fetch_image", invalid)
    messages: list[Message] = []

    async def send(message: Message) -> None:
        messages.append(message)

    async def run() -> None:
        with pytest.raises(ApiError):
            response = await _response("invalid")
            await response({}, _receive, send)
        assert messages == []
        assert media_assets._image_fetch_slots.borrowed_tokens == 0

    asyncio.run(run())
