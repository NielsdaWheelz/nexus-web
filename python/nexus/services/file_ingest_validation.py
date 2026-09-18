"""Shared validation for PDF/EPUB file-ingest paths."""

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError

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
