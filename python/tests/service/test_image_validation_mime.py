"""Image type comes from the validated source, not its upstream label."""

import io
import socket

import httpx
import pytest
from PIL import Image

from nexus.services.image_validation import fetch_validated_image


@pytest.mark.parametrize("isolated", [False, True])
@pytest.mark.parametrize(
    ("format_name", "expected_type"),
    (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp")),
)
def test_validated_image_mime_preserves_source_format(
    monkeypatch: pytest.MonkeyPatch, format_name: str, expected_type: str, isolated: bool
) -> None:
    with io.BytesIO() as encoded, Image.new("RGB", (2, 3), "red") as first:
        if format_name in {"GIF", "WEBP"}:
            with Image.new("RGB", (2, 3), "blue") as second:
                first.save(
                    encoded,
                    format=format_name,
                    save_all=True,
                    append_images=[second],
                    duration=[100, 200],
                    loop=0,
                )
        else:
            first.save(encoded, format=format_name)
        source = encoded.getvalue()
    # DNS and the image origin are external; validation and the optional decoder
    # process remain real. The direct path also reaches the original source.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))
        ],
    )
    for upstream in (None, expected_type, "image/x-incorrect"):
        headers = {} if upstream is None else {"Content-Type": upstream}
        with httpx.Client(
            transport=httpx.MockTransport(
                lambda _request, headers=headers: httpx.Response(
                    200, headers=headers, stream=httpx.ByteStream(source)
                )
            )
        ) as client:
            if isolated:
                from nexus.config import ImageDecoderLimits

                actual = fetch_validated_image(
                    "https://images.example/figure",
                    client,
                    decoder_limits=ImageDecoderLimits(
                        address_space_bytes=256 * 1024 * 1024, cpu_seconds=5, wall_seconds=10
                    ),
                )
            else:
                actual = fetch_validated_image("https://images.example/figure", client)
        assert (actual.content_type, actual.width, actual.height) == (expected_type, 2, 3), (
            "validated image retained an unverified upstream MIME"
        )
        assert actual.data == source, "image validation changed the retained source bytes"
