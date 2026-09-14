"""Streaming object reads with persisted-size verification."""

from collections.abc import Generator

from nexus.storage.client import StorageClientBase, StorageError

# HTTP response source chunks only; SDK/framework allocations need qualification.
HTTP_STORAGE_CHUNK_BYTES = 64 * 1024


def stream_object_checked(
    storage: StorageClientBase,
    storage_path: str,
    *,
    expected_size: int,
    chunk_bytes: int = 8 * 1024 * 1024,
) -> Generator[bytes, None, None]:
    """Withhold one chunk until the next read; release the last only at exact EOF.

    Short reads are data, not EOF. Later size or storage failures interrupt a
    partially sent body; they cannot recall already emitted bytes or headers.
    """
    chunks = storage.stream_object(storage_path, chunk_bytes=chunk_bytes)
    total = 0
    pending: bytes | None = None
    try:
        for chunk in chunks:
            total += len(chunk)
            if total > expected_size:
                raise StorageError("Stored object is larger than persisted metadata")
            if pending is not None:
                yield pending
            pending = chunk
        if total != expected_size:
            raise StorageError("Stored object integrity mismatch")
        if pending is not None:
            yield pending
    finally:
        chunks.close()


def read_object_checked(
    storage: StorageClientBase,
    storage_path: str,
    *,
    expected_size: int,
) -> bytes:
    """Read complete bytes for callers that require a materialized object."""
    chunks = stream_object_checked(storage, storage_path, expected_size=expected_size)
    try:
        return b"".join(chunks)
    finally:
        chunks.close()
