"""Remote PDF/EPUB URLs: which URLs name a file, and the bounded download into storage."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from tempfile import TemporaryFile
from typing import Literal
from urllib.parse import unquote, urlparse

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.file_ingest_validation import CONTENT_TYPES, has_valid_file_signature
from nexus.services.net.safe_fetch import SafeFetchFailed, safe_stream, source_fetch_error
from nexus.storage.client import StorageClient, StorageError

type RemoteFileKind = Literal["pdf", "epub"]

_ARXIV_HOSTS = frozenset({"arxiv.org", "www.arxiv.org", "export.arxiv.org"})
_ARXIV_PDF_PATH = re.compile(
    r"^/pdf/(?P<id>(?:[a-z.-]+/)?(?:\d{4}\.\d{4,5}|\d{7})(?:v\d+)?)(?:\.pdf)?$", re.IGNORECASE
)
_EPUB_SUFFIXES = (
    ".epub",
    ".epub.images",
    ".epub.noimages",
    ".epub3",
    ".epub3.images",
    ".epub3.noimages",
)


@dataclass(frozen=True, slots=True)
class RemoteFile:
    content_type: str
    size_bytes: int
    sha256_hex: str
    final_url: str


def remote_file_kind_from_url(url: str) -> RemoteFileKind | None:
    """A URL whose path names a PDF or EPUB (or an arXiv ``/pdf/<id>``), else ``None``."""
    path = unquote(urlparse(url).path).lower()
    if path.endswith(".pdf") or arxiv_pdf_id(url) is not None:
        return "pdf"
    return "epub" if path.endswith(_EPUB_SUFFIXES) else None


def arxiv_pdf_id(url: str) -> str | None:
    """The arXiv id of an ``arxiv.org/pdf/<id>`` URL."""
    parsed = urlparse(url)
    match = _ARXIV_PDF_PATH.match(parsed.path)
    return match["id"] if match and (parsed.hostname or "").lower() in _ARXIV_HOSTS else None


def fetch_remote_file(
    url: str, *, kind: str, storage_path: str, storage: StorageClient, max_bytes: int
) -> RemoteFile:
    """Download one bounded file, checking its magic bytes on arrival, then store it."""
    content_type = CONTENT_TYPES[kind]
    digest = hashlib.sha256()
    size = 0
    with TemporaryFile() as spool:

        def write(chunk: bytes) -> None:
            nonlocal size
            if size == 0 and chunk and not has_valid_file_signature(chunk, kind):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_FILE_TYPE,
                    f"Remote URL did not return a valid {kind.upper()} file.",
                )
            size += len(chunk)
            digest.update(chunk)
            spool.write(chunk)

        try:
            fetched = safe_stream(
                url,
                max_bytes=max_bytes,
                timeout_s=300.0,
                sink=write,
                headers={"Accept": f"{content_type},application/octet-stream,*/*;q=0.8"},
                allowed_ports=frozenset({80, 443}),
            )
        except SafeFetchFailed as exc:
            raise source_fetch_error(exc) from exc
        if size == 0:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Remote URL did not return a non-empty file."
            )
        spool.seek(0)
        try:
            storage.put_object_stream(storage_path, spool, content_type)
        except StorageError as exc:
            raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Failed to store remote file.") from exc
    return RemoteFile(
        content_type=content_type,
        size_bytes=size,
        sha256_hex=digest.hexdigest(),
        final_url=fetched.final_url,
    )
