"""Test-origin transport only; run the selected image's unchanged ASGI app."""

import asyncio
import socket
import sys
from pathlib import Path

import httpx
import uvicorn

FIXTURE_HOST = "capacity-images.example"
getaddrinfo = socket.getaddrinfo
handle_request = httpx.HTTPTransport.handle_request


def fixture_dns(host, *args, **kwargs):
    if host == FIXTURE_HOST:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]
    return getaddrinfo(host, *args, **kwargs)


class FixtureBytes(httpx.SyncByteStream):
    def __init__(self, path):
        self.file = path.open("rb")

    def __iter__(self):
        while data := self.file.read(64 * 1024):
            yield data

    def close(self):
        self.file.close()


def fixture_request(self, request):
    if request.url.host != FIXTURE_HOST:
        return handle_request(self, request)
    if request.url.path.startswith("/wire/"):
        path = Path("/capacity/wire.png")
    elif request.url.path.startswith("/metadata/"):
        path = Path("/capacity/metadata.png")
    elif request.url.path.startswith("/exif/"):
        path = Path("/capacity/exif.jpg")
    else:
        return httpx.Response(404, stream=httpx.ByteStream(b""))
    return httpx.Response(
        200,
        headers={
            "Content-Type": "image/jpeg" if path.suffix == ".jpg" else "image/png",
            "Content-Length": str(path.stat().st_size),
        },
        stream=FixtureBytes(path),
    )


socket.getaddrinfo = fixture_dns
httpx.HTTPTransport.handle_request = fixture_request
if sys.argv[1:] == ["--provider-warmed"]:
    import apps.api.main  # Construct the actual app before the selected first use.
    from capacity_provider_first_request import first_request

    asyncio.run(first_request())
    print("capacity_provider_first_request=passed", flush=True)
elif sys.argv[1:]:
    raise ValueError("Unsupported capacity startup input")
uvicorn.run("apps.api.main:app", host="0.0.0.0", port=8000)
