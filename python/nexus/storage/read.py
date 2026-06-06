"""Streaming object reads with persisted-size verification."""

from nexus.storage.client import StorageClientBase, StorageError


def read_object_checked(
    storage: StorageClientBase,
    storage_path: str,
    *,
    expected_size: int,
) -> bytes:
    """Stream an object fully, verifying its byte size before returning.

    Raises StorageError on a missing object (from stream_object) or an integrity
    mismatch. Callers map StorageError to their own ApiError.
    """
    chunks: list[bytes] = []
    total = 0
    for chunk in storage.stream_object(storage_path):
        total += len(chunk)
        if total > expected_size:
            raise StorageError("Stored object is larger than persisted metadata")
        chunks.append(chunk)
    if total != expected_size:
        raise StorageError("Stored object integrity mismatch")
    return b"".join(chunks)
