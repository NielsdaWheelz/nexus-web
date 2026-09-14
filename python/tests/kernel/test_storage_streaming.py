"""Exact storage EOF and bounded SDK reads through the actual response owner."""

import asyncio
from collections import deque
from typing import Any, cast

import pytest
from botocore.client import BaseClient
from botocore.response import StreamingBody
from starlette.types import Message

from nexus.api.storage_response import StorageResponse
from nexus.storage.client import StorageClient, StorageError
from nexus.storage.read import stream_object_checked


class _ObjectPeer:
    def __init__(self, chunks: tuple[bytes | OSError, ...]) -> None:
        self.chunks = deque(chunks)
        self.byte_size = sum(len(chunk) for chunk in chunks if isinstance(chunk, bytes))
        self.reads: list[int] = []
        self.requests: list[dict[str, Any]] = []
        self.closes = 0

    def get_object(self, **params: Any) -> dict[str, Any]:
        self.requests.append(params)
        return {"Body": StreamingBody(self, self.byte_size)}

    def read(self, amount: int) -> bytes:
        self.reads.append(amount)
        chunk = self.chunks.popleft() if self.chunks else b""
        if isinstance(chunk, OSError):
            raise chunk
        if len(chunk) > amount:
            self.chunks.appendleft(chunk[amount:])
        return chunk[:amount]

    def close(self) -> None:
        self.closes += 1


def _storage(peer: _ObjectPeer) -> StorageClient:
    return StorageClient(
        endpoint_url="https://storage.invalid",
        access_key_id="access-key",
        secret_access_key="secret-key",
        bucket="bucket",
        s3_client=cast(BaseClient, peer),
    )


@pytest.mark.parametrize(
    ("chunks", "size", "expected_body", "expected_status", "fails"),
    (
        ((b"ab", b"c", b"def"), 6, b"abcdef", 200, False),
        ((b"ab",), 6, b"", None, True),
        ((b"abcdefg",), 6, b"", None, True),
        ((b"ab", b"cd", b"ef", b"extra"), 6, b"abcd", 200, True),
        ((b"ab", b"cd"), 6, b"ab", 200, True),
        ((b"ab", b"cd", OSError("late SDK read failed")), 6, b"ab", 200, True),
        ((), 0, b"", 200, False),
    ),
)
def test_storage_response_requires_exact_eof_before_completing_declared_body(
    chunks: tuple[bytes | OSError, ...],
    size: int,
    expected_body: bytes,
    expected_status: int | None,
    fails: bool,
) -> None:
    peer = _ObjectPeer(chunks)
    response = StorageResponse(
        stream_object_checked(
            _storage(peer), "exact-object", expected_size=size, chunk_bytes=65536
        ),
        media_type="application/octet-stream",
        headers={"Content-Length": str(size)},
    )
    assert peer.requests == [], "constructing a storage response opened an SDK body"
    messages: list[Message] = []

    async def scenario() -> None:
        async def receive() -> Message:
            await asyncio.Event().wait()
            raise AssertionError("unexpected receive completion")

        async def send(message: Message) -> None:
            messages.append(message)

        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)

    if fails:
        with pytest.raises(StorageError):
            asyncio.run(scenario())
    else:
        asyncio.run(scenario())
    starts = [message["status"] for message in messages if message["type"] == "http.response.start"]
    bodies = [message for message in messages if message["type"] == "http.response.body"]
    assert starts == ([] if expected_status is None else [expected_status])
    assert b"".join(message["body"] for message in bodies) == expected_body, (
        "stored object released the declared tail before exact EOF"
    )
    assert any(not message["more_body"] for message in bodies) is not fails, (
        "storage response completed before exact declared-size EOF"
    )
    assert peer.requests == [{"Bucket": "bucket", "Key": "exact-object"}]
    assert peer.reads and set(peer.reads) == {65536}
    assert peer.closes == 1


def test_storage_chunk_contract_keeps_parser_default_and_exact_http_range() -> None:
    whole = _ObjectPeer((b"arbitrary", b"short", b"reads"))
    assert b"".join(_storage(whole).stream_object("source")) == b"arbitraryshortreads"
    assert set(whole.reads) == {8 * 1024 * 1024}
    assert whole.closes == 1
    ranged = _ObjectPeer((b"ab", b"cde"))
    assert (
        b"".join(
            _storage(ranged).stream_object_range(
                "source", start=10, end_inclusive=14, chunk_bytes=3
            )
        )
        == b"abcde"
    )
    assert ranged.requests == [{"Bucket": "bucket", "Key": "source", "Range": "bytes=10-14"}]
    assert ranged.reads == [3, 3]
    assert ranged.closes == 1
    invalid = _ObjectPeer((b"untouched",))
    with pytest.raises(ValueError, match="chunk size"):
        next(_storage(invalid).stream_object("source", chunk_bytes=0))
    assert invalid.requests == []


def test_storage_response_closes_the_same_sdk_body_when_send_fails() -> None:
    peer = _ObjectPeer((b"first", b"second", b"third"))
    response = StorageResponse(
        stream_object_checked(_storage(peer), "exact-object", expected_size=16, chunk_bytes=65536),
        media_type="application/octet-stream",
        headers={"Content-Length": "16"},
    )

    class SendFailed(Exception):
        pass

    async def scenario() -> None:
        async def receive() -> Message:
            raise AssertionError("ASGI 2.4 transfer should not poll receive")

        async def send(message: Message) -> None:
            if message["type"] == "http.response.body":
                raise SendFailed("downstream refused the first body")

        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)

    with pytest.raises(SendFailed):
        asyncio.run(scenario())
    assert len(peer.reads) == 2
    assert peer.closes == 1, "send failure abandoned the opened storage body"
