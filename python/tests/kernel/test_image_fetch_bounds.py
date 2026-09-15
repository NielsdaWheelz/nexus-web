"""Image fetches reject headers before reading and bound streamed bodies."""

from __future__ import annotations

import io
import socket
from collections.abc import Iterator

import httpx
import pytest
from PIL import Image

from nexus.errors import ApiError, ApiErrorCode
from nexus.services import image_validation


class _Body(httpx.SyncByteStream):
    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        self.chunks = chunks
        self.bytes_read = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            self.bytes_read += len(chunk)
            yield chunk

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def resolved_hosts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    hosts: list[str] = []

    def resolve(hostname: str, *_args: object) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        hosts.append(hostname)
        address = "127.0.0.1" if hostname == "private.example" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))]

    monkeypatch.setattr(image_validation.socket, "getaddrinfo", resolve)
    return hosts


@pytest.mark.parametrize(
    ("status", "headers", "code"),
    [
        (404, {"content-type": "image/png"}, ApiErrorCode.E_IMAGE_FETCH_FAILED),
        (200, {"content-type": "image/svg+xml"}, ApiErrorCode.E_INVALID_REQUEST),
        (200, {"content-type": "text/html"}, ApiErrorCode.E_INVALID_REQUEST),
        (200, {"content-encoding": "gzip"}, ApiErrorCode.E_INVALID_REQUEST),
        (200, {"content-encoding": "br"}, ApiErrorCode.E_INVALID_REQUEST),
        (302, {}, ApiErrorCode.E_IMAGE_FETCH_FAILED),
    ],
)
def test_rejected_image_headers_close_without_reading_body(
    status: int, headers: dict[str, str], code: ApiErrorCode
) -> None:
    body = _Body((b"body must remain unread",))

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(status, headers=headers, stream=body)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ApiError) as failure:
            image_validation.fetch_with_redirect("https://image.example/a", "image.example", client)

    assert failure.value.code == code
    assert body.bytes_read == 0
    assert body.closed


def test_redirect_body_is_unread_and_valid_image_bytes_are_preserved(
    resolved_hosts: list[str],
) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 3), color="red").save(buffer, format="PNG")
    data = buffer.getvalue()
    redirect_body = _Body((b"unbounded redirect body",))
    image_body = _Body((data[:20], data[20:]))
    requests: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        assert request.headers["accept-encoding"] == "identity"
        if len(requests) == 1:
            return httpx.Response(
                302,
                headers={"location": "https://cdn.example/b", "content-encoding": "gzip"},
                stream=redirect_body,
            )
        assert redirect_body.closed
        return httpx.Response(
            200,
            headers={"content-type": "image/png", "content-encoding": "identity"},
            stream=image_body,
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result = image_validation.fetch_validated_image("https://image.example/a", client)

    assert result == image_validation.ValidatedImage(data, "image/png", 2, 3)
    assert resolved_hosts == ["image.example", "cdn.example"]
    assert requests == ["https://image.example/a", "https://cdn.example/b"]
    assert redirect_body.bytes_read == 0
    assert image_body.bytes_read == len(data)
    assert image_body.closed


def test_second_redirect_is_rejected_without_consuming_either_body(
    resolved_hosts: list[str],
) -> None:
    bodies = [_Body((b"first redirect",)), _Body((b"second redirect",))]
    requests: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "/next"}, stream=bodies[len(requests) - 1])

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ApiError, match="Too many redirects") as failure:
            image_validation.fetch_validated_image("https://image.example/a", client)

    assert failure.value.code == ApiErrorCode.E_IMAGE_FETCH_FAILED
    assert len(requests) == 2
    assert resolved_hosts == ["image.example", "image.example"]
    assert all(body.bytes_read == 0 and body.closed for body in bodies)


def test_redirect_to_private_address_is_rejected_before_second_request(
    resolved_hosts: list[str],
) -> None:
    body = _Body((b"redirect body",))
    requests: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://private.example/a"}, stream=body)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ApiError) as failure:
            image_validation.fetch_validated_image("https://image.example/a", client)

    assert failure.value.code == ApiErrorCode.E_SSRF_BLOCKED
    assert requests == ["https://image.example/a"]
    assert resolved_hosts == ["image.example", "private.example"]
    assert body.bytes_read == 0
    assert body.closed


def test_oversized_image_stops_reading_at_the_first_excess_chunk() -> None:
    chunk = b"x" * (64 * 1024)
    body = _Body((chunk,) * (image_validation.MAX_IMAGE_BYTES // len(chunk) + 2))

    with httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, stream=body))
    ) as client:
        with pytest.raises(ApiError) as failure:
            image_validation.fetch_with_redirect("https://image.example/a", "image.example", client)

    assert failure.value.code == ApiErrorCode.E_IMAGE_TOO_LARGE
    assert body.bytes_read == image_validation.MAX_IMAGE_BYTES + len(chunk)
    assert body.closed


def test_image_at_byte_limit_is_accepted_without_rewriting() -> None:
    chunk = b"x" * (64 * 1024)
    body = _Body((chunk,) * (image_validation.MAX_IMAGE_BYTES // len(chunk)))

    with httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, stream=body))
    ) as client:
        data, content_type = image_validation.fetch_with_redirect(
            "https://image.example/a", "image.example", client
        )

    assert data == chunk * (image_validation.MAX_IMAGE_BYTES // len(chunk))
    assert content_type is None
    assert body.bytes_read == image_validation.MAX_IMAGE_BYTES
    assert body.closed


def test_corrupt_png_checksum_is_an_invalid_image() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 3), color="red").save(buffer, format="PNG")
    data = bytearray(buffer.getvalue())
    idat = data.index(b"IDAT")
    chunk_length = int.from_bytes(data[idat - 4 : idat], "big")
    data[idat + 4 + chunk_length] ^= 1

    with pytest.raises(ApiError) as failure:
        image_validation.validate_and_decode_image(bytes(data), "image/png")

    assert failure.value.code == ApiErrorCode.E_INVALID_REQUEST


@pytest.mark.parametrize("width", [4096, 4097])
def test_verified_image_preserves_the_dimension_boundary(width: int) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (width, 1), color="red").save(buffer, format="PNG")
    if width == 4096:
        assert image_validation.validate_and_decode_image(buffer.getvalue(), None) == (
            "image/png",
            width,
            1,
        )
    else:
        with pytest.raises(ApiError) as failure:
            image_validation.validate_and_decode_image(buffer.getvalue(), None)
        assert failure.value.code == ApiErrorCode.E_IMAGE_TOO_LARGE
