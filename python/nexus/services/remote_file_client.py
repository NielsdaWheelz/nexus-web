"""Remote PDF/EPUB download behind the SSRF boundary, spooled into storage."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from tempfile import TemporaryFile

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.file_ingest_validation import has_valid_file_signature
from nexus.services.net.safe_fetch import SafeFetchFailed, safe_stream
from nexus.storage.client import StorageClient, StorageError

REMOTE_FILE_CONTENT_TYPES = {"pdf": "application/pdf", "epub": "application/epub+zip"}

_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True, slots=True)
class RemoteFileFetchResult:
    content_type: str
    size_bytes: int
    sha256_hex: str
    final_url: str


def fetch_binary_to_storage(
    *,
    url: str,
    storage_path: str,
    storage_client: StorageClient,
    content_type: str,
    max_bytes: int,
    accept: str,
    signature_kind: str | None = None,
) -> RemoteFileFetchResult:
    """Download one bounded remote file, checking its magic bytes on arrival."""
    label = signature_kind.upper() if signature_kind is not None else "file"
    digest = hashlib.sha256()
    size_bytes = 0
    with TemporaryFile() as spool:

        def write(chunk: bytes) -> None:
            nonlocal size_bytes
            if not chunk:
                return
            if (
                size_bytes == 0
                and signature_kind is not None
                and not has_valid_file_signature(chunk, signature_kind)
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_FILE_TYPE,
                    f"Remote URL did not return a valid {label} file.",
                )
            size_bytes += len(chunk)
            digest.update(chunk)
            spool.write(chunk)

        try:
            headers = safe_stream(
                url,
                max_bytes=max_bytes,
                timeout_s=_TIMEOUT_SECONDS,
                sink=write,
                accept=accept,
                allowed_ports=frozenset({80, 443}),
            )
        except SafeFetchFailed as exc:
            raise _remote_file_error(exc, label) from exc
        if size_bytes == 0:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Remote URL did not return a non-empty file."
            )
        spool.seek(0)
        try:
            storage_client.put_object_stream(storage_path, spool, content_type)
        except StorageError as exc:
            raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Failed to store remote file.") from exc
    return RemoteFileFetchResult(
        content_type=content_type,
        size_bytes=size_bytes,
        sha256_hex=digest.hexdigest(),
        final_url=headers.final_url,
    )


def _remote_file_error(exc: SafeFetchFailed, label: str) -> ApiError:
    if exc.reason == "Blocked":
        return ApiError(ApiErrorCode.E_SSRF_BLOCKED, exc.message)
    if exc.reason == "TooLarge":
        return InvalidRequestError(
            ApiErrorCode.E_FILE_TOO_LARGE, f"Remote {label} exceeds maximum size."
        )
    if exc.reason == "Timeout":
        return ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Remote file fetch timed out.")
    return ApiError(ApiErrorCode.E_INGEST_FAILED, f"Remote file fetch failed: {exc.message}")
