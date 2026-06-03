"""Streaming object reads with integrity verification."""

import hashlib

from nexus.storage.client import StorageClientBase, StorageError


def read_object_checked(
    storage: StorageClientBase,
    storage_path: str,
    *,
    expected_sha256: str,
    expected_size: int,
) -> bytes:
    """Stream an object fully, verifying its sha256 and byte size before returning.

    Raises StorageError on a missing object (from stream_object) or an integrity
    mismatch. Callers map StorageError to their own ApiError.
    """
    hasher = hashlib.sha256()
    chunks: list[bytes] = []
    total = 0
    for chunk in storage.stream_object(storage_path):
        total += len(chunk)
        if total > expected_size:
            raise StorageError("Stored object is larger than persisted metadata")
        hasher.update(chunk)
        chunks.append(chunk)
    if total != expected_size or hasher.hexdigest() != expected_sha256:
        raise StorageError("Stored object integrity mismatch")
    return b"".join(chunks)
