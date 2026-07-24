"""Test-only storage fakes."""

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import BinaryIO
from uuid import uuid4

from nexus.storage.client import (
    ObjectMetadata,
    ObjectPage,
    SignedUpload,
    StorageClientBase,
    StorageError,
    StorageObjectEntry,
)


class FakeStorageClient(StorageClientBase):
    """In-memory storage client for tests."""

    def __init__(self):
        self._objects: dict[str, tuple[bytes, str]] = {}
        self._last_modified: dict[str, datetime] = {}

    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        size_bytes: int,
        expires_in: int = 300,
    ) -> SignedUpload:
        return SignedUpload(
            path=path,
            upload_url=f"https://fake-storage.test/upload/{path}?signature=fake-{uuid4()}",
        )

    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
        return f"https://fake-storage.test/download/{path}?signature=fake-{uuid4()}"

    def head_object(self, path: str) -> ObjectMetadata | None:
        if path not in self._objects:
            return None
        content, content_type = self._objects[path]
        return ObjectMetadata(content_type=content_type, size_bytes=len(content))

    def stream_object(self, path: str) -> Iterator[bytes]:
        if path not in self._objects:
            raise StorageError(f"Object not found: {path}", code="E_STORAGE_MISSING")
        content, _ = self._objects[path]
        for i in range(0, len(content), 8 * 1024 * 1024):
            yield content[i : i + 8 * 1024 * 1024]

    def stream_object_range(
        self,
        path: str,
        *,
        start: int,
        end_inclusive: int,
    ) -> Iterator[bytes]:
        if path not in self._objects:
            raise StorageError(f"Object not found: {path}", code="E_STORAGE_MISSING")
        content, _ = self._objects[path]
        yield content[start : end_inclusive + 1]

    def put_object(
        self,
        path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
    ) -> None:
        self._objects[path] = (content, content_type)
        self._last_modified[path] = datetime.now(UTC)

    def put_object_stream(
        self,
        path: str,
        content: BinaryIO,
        content_type: str = "application/octet-stream",
    ) -> None:
        self._objects[path] = (content.read(), content_type)
        self._last_modified[path] = datetime.now(UTC)

    def copy_object(self, source_path: str, destination_path: str) -> None:
        if source_path not in self._objects:
            raise StorageError(f"Object not found: {source_path}", code="E_STORAGE_MISSING")
        self._objects[destination_path] = self._objects[source_path]
        self._last_modified[destination_path] = datetime.now(UTC)

    def delete_object(self, path: str) -> None:
        self._objects.pop(path, None)
        self._last_modified.pop(path, None)

    def list_objects(
        self,
        prefix: str,
        *,
        continuation_token: str | None = None,
    ) -> ObjectPage:
        """Return every matching object in one page; the fake never truncates."""
        objects = tuple(
            StorageObjectEntry(
                path=path,
                last_modified=self._last_modified[path],
                size_bytes=len(content),
            )
            for path, (content, _content_type) in sorted(self._objects.items())
            if path.startswith(prefix)
        )
        return ObjectPage(objects=objects, next_continuation_token=None)

    def get_object(self, path: str) -> bytes | None:
        if path not in self._objects:
            return None
        return self._objects[path][0]

    def clear(self) -> None:
        self._objects.clear()
        self._last_modified.clear()
