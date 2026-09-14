"""External image bytes are bounded before retention and HTTP decoding."""

import gzip
import io
from collections.abc import Iterator

import httpx
import pytest
from PIL import Image, PngImagePlugin

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.image_validation import (
    MAX_IMAGE_BYTES,
    fetch_with_redirect,
    validate_and_decode_image,
)


def test_image_dimensions_follow_exif_display_orientation() -> None:
    encoded = io.BytesIO()
    with Image.new("RGB", (6, 2), "red") as image:
        exif = Image.Exif()
        exif[274] = 6  # Rotate 90 degrees clockwise for display.
        image.save(encoded, format="JPEG", exif=exif)
    content_type, width, height = validate_and_decode_image(encoded.getvalue())
    assert (content_type, width, height) == ("image/jpeg", 2, 6), (
        "artwork resize received encoded axes instead of display-oriented dimensions"
    )


def test_image_validation_classifies_excess_compressed_metadata_as_invalid() -> None:
    encoded = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("caption", "x" * (PngImagePlugin.MAX_TEXT_CHUNK + 1), zip=True)
    with Image.new("RGB", (1, 1)) as image:
        image.save(encoded, format="PNG", pnginfo=metadata)
    assert len(encoded.getvalue()) < MAX_IMAGE_BYTES
    with pytest.raises(ApiError) as rejected:
        validate_and_decode_image(encoded.getvalue())
    assert rejected.value.code == ApiErrorCode.E_INVALID_REQUEST


class ImageStream(httpx.SyncByteStream):
    def __init__(self, chunks: Iterator[bytes]) -> None:
        self.chunks = chunks
        self.read_chunks = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            self.read_chunks += 1
            yield chunk

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize("advertise", [False, True])
def test_image_fetch_rejects_oversize_before_retaining_the_response(advertise: bool) -> None:
    chunk_bytes = 64 * 1024
    stream = ImageStream(
        iter(b"x" * chunk_bytes for _ in range(MAX_IMAGE_BYTES // chunk_bytes + 20))
    )
    headers = {"Content-Type": "image/png"}
    if advertise:
        headers["Content-Length"] = str(MAX_IMAGE_BYTES + 1)
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, headers=headers, stream=stream))
    ) as client:
        with pytest.raises(ApiError) as rejected:
            fetch_with_redirect("https://images.example/picture", client)
    assert rejected.value.code == ApiErrorCode.E_IMAGE_TOO_LARGE
    assert stream.read_chunks <= (0 if advertise else MAX_IMAGE_BYTES // chunk_bytes + 1), (
        "image response was retained before enforcing its byte bound"
    )
    assert stream.closed, "oversized origin retained its transport"


def test_image_fetch_refuses_compressed_body_before_decompression() -> None:
    stream = ImageStream(iter((gzip.compress(b"x" * (MAX_IMAGE_BYTES + 1)),)))

    def origin(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=stream)

    with httpx.Client(transport=httpx.MockTransport(origin)) as client:
        with pytest.raises(ApiError) as rejected:
            fetch_with_redirect("https://images.example/picture", client)
    assert rejected.value.code == ApiErrorCode.E_IMAGE_FETCH_FAILED
    assert stream.read_chunks == 0, "HTTP decompression preceded the image allocation bound"
    assert stream.closed


def test_image_fetch_discards_redirect_bodies_before_fetching_the_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # DNS is the external boundary; the real per-hop public-address policy runs.
    monkeypatch.setattr(
        "socket.getaddrinfo",
        lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.215.14", 443))],
    )
    redirect = ImageStream(iter((b"x" * (MAX_IMAGE_BYTES + 1),)))
    image = ImageStream(iter((b"validated-later",)))

    def origin(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/picture":
            return httpx.Response(302, headers={"Location": "/final"}, stream=redirect)
        assert request.url.path == "/final"
        return httpx.Response(200, headers={"Content-Type": "image/png"}, stream=image)

    with httpx.Client(transport=httpx.MockTransport(origin)) as client:
        result = fetch_with_redirect("https://images.example/picture", client)
    assert result == (b"validated-later", "image/png")
    assert redirect.read_chunks == 0, "redirect body was allocated before it was discarded"
    assert redirect.closed and image.closed
