"""Shared validation for PDF/EPUB file-ingest paths."""

import hashlib

from nexus.config import get_settings
from nexus.db.models import MediaFile
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.storage.client import StorageError

_VALID_CONTENT_TYPES = {
    "pdf": {"application/pdf"},
    "epub": {"application/epub+zip"},
}

_MAGIC_BYTES = {
    "pdf": b"%PDF-",
    "epub": b"PK\x03\x04",
}


def validate_file_ingest_request(kind: str, content_type: str, size_bytes: int) -> None:
    settings = get_settings()
    if kind not in _VALID_CONTENT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"Invalid kind '{kind}'. File ingest is only supported for pdf, epub.",
        )

    valid_types = _VALID_CONTENT_TYPES[kind]
    if content_type not in valid_types:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            f"Invalid content type '{content_type}' for {kind}. "
            f"Expected one of: {', '.join(valid_types)}",
        )

    max_size = settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes
    if size_bytes > max_size:
        raise InvalidRequestError(
            ApiErrorCode.E_FILE_TOO_LARGE,
            f"File size {size_bytes} bytes exceeds maximum {max_size} bytes for {kind}.",
        )


def has_valid_file_signature(content: bytes, kind: str) -> bool:
    expected = _MAGIC_BYTES.get(kind)
    return expected is None or content.startswith(expected)


def validate_file_source_integrity(
    storage_client,
    media_file: MediaFile,
    kind: str,
    *,
    expected_sha256: str | None = None,
) -> None:
    """Validate stored file bytes before retrying extraction."""
    settings = get_settings()

    try:
        metadata = storage_client.head_object(media_file.storage_path)
        if metadata is None:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING,
                "Source file not found in storage.",
            )
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            f"Failed to read source file: {exc.message}",
        ) from exc

    max_size = settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes
    try:
        hasher = hashlib.sha256()
        total_bytes = 0
        first_chunk = True

        for chunk in storage_client.stream_object(media_file.storage_path):
            if first_chunk:
                if not has_valid_file_signature(chunk, kind):
                    raise InvalidRequestError(
                        ApiErrorCode.E_INVALID_FILE_TYPE,
                        f"Invalid file type. Expected {kind}.",
                    )
                first_chunk = False

            total_bytes += len(chunk)
            if total_bytes > max_size:
                raise InvalidRequestError(
                    ApiErrorCode.E_FILE_TOO_LARGE,
                    f"File size exceeds maximum {max_size} bytes for {kind}.",
                )
            hasher.update(chunk)

        if expected_sha256 is not None and hasher.hexdigest() != expected_sha256:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING,
                "Source integrity mismatch: stored hash does not match source bytes.",
            )
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            f"Failed to read source file: {exc.message}",
        ) from exc
