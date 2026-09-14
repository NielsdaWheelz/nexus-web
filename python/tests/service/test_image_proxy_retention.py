"""Artwork keeps browser freshness without retaining API-resident byte copies."""

import io
import socket

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image


def test_image_proxy_fetches_current_bytes_without_a_process_cache_or_time_validator(
    authenticated_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    payloads = []
    for color in ("red", "blue"):
        with io.BytesIO() as output:
            Image.new("RGB", (2, 2), color).save(output, format="PNG")
            payloads.append(output.getvalue())
    original_dns = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host == "images.example":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 443))]
        return original_dns(host, port, *args, **kwargs)

    calls = 0

    def origin(_transport: httpx.HTTPTransport, request: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert str(request.url) == "https://images.example/cover.png"
        payload = payloads[calls]
        calls += 1
        return httpx.Response(
            200,
            headers={"Content-Type": "image/png", "Content-Length": str(len(payload))},
            stream=httpx.ByteStream(payload),
        )

    # Only DNS and the HTTP transport are controlled. Route, auth, byte bounds,
    # redirect policy, Pillow validation and response construction remain real.
    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", origin)
    for expected in payloads:
        response = authenticated_client.get(
            "/media/image",
            params={"url": "https://images.example/cover.png"},
            headers={"If-None-Match": "*"},
        )
        assert response.status_code == 200
        assert response.content == expected, "API retained stale resident image bytes"
        assert response.headers["cache-control"] == "private, max-age=86400, no-transform"
        assert response.headers["x-nexus-image-width"] == "2"
        assert response.headers["x-nexus-image-height"] == "2"
        assert "etag" not in response.headers, "proxy fabricated a source validator"
    assert calls == 2, "repeat artwork fetch bypassed the origin through a process cache"
