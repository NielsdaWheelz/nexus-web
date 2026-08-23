"""Shared plumbing for real PostgreSQL + MinIO upload-session proof."""

from __future__ import annotations

import json
from collections.abc import Iterator
from threading import Event
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.media import CreateUploadSessionRequest
from nexus.storage.client import ObjectMetadata, StorageClientBase


def delete_storage_prefix(storage: StorageClientBase, prefix: str) -> None:
    """Drain every object under one prefix through the real listing pagination."""
    paths: list[str] = []
    continuation_token: str | None = None
    while True:
        page = storage.list_objects(prefix, continuation_token=continuation_token)
        paths.extend(item.path for item in page.objects)
        continuation_token = page.next_continuation_token
        if continuation_token is None:
            break
    for path in paths:
        storage.delete_object(path)


class BlockingCopyStorage:
    """Real-storage proxy that holds one candidate copy at a controlled boundary."""

    def __init__(self, delegate: StorageClientBase, copy_started: Event, release_copy: Event):
        self._delegate = delegate
        self._copy_started = copy_started
        self._release_copy = release_copy
        self.destination_path: str | None = None

    def head_object(self, path: str) -> ObjectMetadata | None:
        return self._delegate.head_object(path)

    def stream_object(self, path: str) -> Iterator[bytes]:
        return self._delegate.stream_object(path)

    def copy_object(self, source_path: str, destination_path: str) -> None:
        self.destination_path = destination_path
        self._copy_started.set()
        if not self._release_copy.wait(timeout=20):
            raise AssertionError("stale verification copy was never released")
        self._delegate.copy_object(source_path, destination_path)

    def delete_object(self, path: str) -> None:
        self._delegate.delete_object(path)


def upload_request(
    *,
    filename: str,
    size_bytes: int,
    library_ids: list[UUID] | None = None,
) -> CreateUploadSessionRequest:
    """Build the one PDF upload intent every upload-session proof starts from."""
    return CreateUploadSessionRequest(
        kind="Pdf",
        filename=filename,
        content_type="application/pdf",
        size_bytes=size_bytes,
        library_ids=library_ids or [],
    )


def ingest_job_count(db: Session, *, media_id: UUID, attempt_id: UUID | None = None) -> int:
    """Count durable ingest jobs keyed by media, optionally narrowed to one attempt."""
    match = {"media_id": str(media_id)}
    if attempt_id is not None:
        match["attempt_id"] = str(attempt_id)
    return int(
        db.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = 'ingest_media_source'
                  AND payload @> CAST(:match AS jsonb)
                """
            ),
            {"match": json.dumps(match)},
        ).scalar_one()
    )
