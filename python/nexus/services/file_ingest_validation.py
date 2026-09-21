"""The one kind/content-type/size table and magic-byte check for file ingest."""

from __future__ import annotations

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

_CONTENT_TYPES = {"pdf": "application/pdf", "epub": "application/epub+zip"}
_MAGIC_BYTES = {"pdf": b"%PDF-", "epub": b"PK\x03\x04"}


def validate_file_ingest_request(kind: str, content_type: str, size_bytes: int) -> None:
    """Raise unless the declared kind, content type, and size are all acceptable."""
    expected_content_type = _CONTENT_TYPES.get(kind)
    if expected_content_type is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"Invalid kind '{kind}'. File ingest is only supported for pdf, epub.",
        )
    if content_type != expected_content_type:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            f"Invalid content type '{content_type}' for {kind}. "
            f"Expected one of: {expected_content_type}",
        )
    settings = get_settings()
    max_size = settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes
    if size_bytes > max_size:
        raise InvalidRequestError(
            ApiErrorCode.E_FILE_TOO_LARGE,
            f"File size {size_bytes} bytes exceeds maximum {max_size} bytes for {kind}.",
        )


def has_valid_file_signature(content: bytes, kind: str) -> bool:
    """True when the payload starts with the kind's magic bytes."""
    expected = _MAGIC_BYTES.get(kind)
    return expected is None or content.startswith(expected)
