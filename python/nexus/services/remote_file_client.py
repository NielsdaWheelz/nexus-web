"""Remote PDF/EPUB fetch policy."""

import hashlib
from dataclasses import dataclass
from tempfile import TemporaryFile
from urllib.parse import urljoin

import httpx

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.file_ingest_validation import has_valid_file_signature
from nexus.services.image_validation import (
    check_hostname_denylist,
    validate_dns_resolution,
    validate_url,
)
from nexus.storage.client import StorageClientBase, StorageError

REMOTE_FILE_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "epub": "application/epub+zip",
}

_CHUNK_BYTES = 1024 * 1024
_REDIRECT_LIMIT = 3
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_USER_AGENT = "Nexus Media Ingestion/1.0"


@dataclass(frozen=True)
class RemoteFileFetchResult:
    content_type: str
    size_bytes: int
    sha256_hex: str
    final_url: str


def fetch_to_storage(
    *,
    url: str,
    kind: str,
    storage_path: str,
    storage_client: StorageClientBase,
) -> RemoteFileFetchResult:
    if kind not in REMOTE_FILE_CONTENT_TYPES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Remote URL must be a PDF or EPUB.")

    max_bytes = get_settings().max_pdf_bytes if kind == "pdf" else get_settings().max_epub_bytes
    content_type = REMOTE_FILE_CONTENT_TYPES[kind]
    return fetch_binary_to_storage(
        url=url,
        storage_path=storage_path,
        storage_client=storage_client,
        content_type=content_type,
        max_bytes=max_bytes,
        accept=f"{content_type},application/octet-stream,*/*;q=0.8",
        signature_kind=kind,
    )


def fetch_binary_to_storage(
    *,
    url: str,
    storage_path: str,
    storage_client: StorageClientBase,
    content_type: str,
    max_bytes: int,
    accept: str,
    signature_kind: str | None = None,
) -> RemoteFileFetchResult:
    current_url = url

    with httpx.Client(timeout=_TIMEOUT, follow_redirects=False, trust_env=False) as client:
        for _ in range(_REDIRECT_LIMIT + 1):
            normalized_url, hostname, _ = validate_url(current_url)
            check_hostname_denylist(hostname)
            validate_dns_resolution(hostname)

            try:
                with client.stream(
                    "GET",
                    normalized_url,
                    headers={
                        "User-Agent": _USER_AGENT,
                        "Accept": accept,
                    },
                ) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise ApiError(
                                ApiErrorCode.E_INGEST_FAILED,
                                "Remote file redirect did not include a Location header.",
                            )
                        current_url = urljoin(normalized_url, location)
                        continue

                    if response.status_code < 200 or response.status_code >= 300:
                        raise ApiError(
                            ApiErrorCode.E_INGEST_FAILED,
                            f"Remote file returned status {response.status_code}.",
                        )

                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > max_bytes:
                        raise InvalidRequestError(
                            ApiErrorCode.E_FILE_TOO_LARGE,
                            f"Remote {_fetch_error_label(signature_kind)} exceeds maximum size.",
                        )

                    return _write_response_to_storage(
                        response=response,
                        content_type=content_type,
                        max_bytes=max_bytes,
                        storage_path=storage_path,
                        storage_client=storage_client,
                        final_url=normalized_url,
                        signature_kind=signature_kind,
                    )
            except ValueError as exc:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Invalid remote file response.",
                ) from exc
            except httpx.TimeoutException as exc:
                raise ApiError(
                    ApiErrorCode.E_INGEST_TIMEOUT, "Remote file fetch timed out."
                ) from exc
            except httpx.RequestError as exc:
                raise ApiError(
                    ApiErrorCode.E_INGEST_FAILED, "Failed to fetch remote file."
                ) from exc

    raise ApiError(ApiErrorCode.E_INGEST_FAILED, "Remote file had too many redirects.")


def _write_response_to_storage(
    *,
    response: httpx.Response,
    content_type: str,
    max_bytes: int,
    storage_path: str,
    storage_client: StorageClientBase,
    final_url: str,
    signature_kind: str | None,
) -> RemoteFileFetchResult:
    size_bytes = 0
    saw_chunk = False
    hasher = hashlib.sha256()

    with TemporaryFile() as payload:
        for chunk in response.iter_bytes(chunk_size=_CHUNK_BYTES):
            if not chunk:
                continue
            if not saw_chunk:
                if signature_kind is not None and not has_valid_file_signature(
                    chunk,
                    signature_kind,
                ):
                    raise InvalidRequestError(
                        ApiErrorCode.E_INVALID_FILE_TYPE,
                        f"Remote URL did not return a valid {signature_kind.upper()} file.",
                    )
                saw_chunk = True

            size_bytes += len(chunk)
            if size_bytes > max_bytes:
                raise InvalidRequestError(
                    ApiErrorCode.E_FILE_TOO_LARGE,
                    f"Remote {_fetch_error_label(signature_kind)} exceeds maximum size.",
                )
            hasher.update(chunk)
            payload.write(chunk)

        if not saw_chunk:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE,
                "Remote URL did not return a non-empty file.",
            )

        payload.seek(0)
        try:
            storage_client.put_object_stream(storage_path, payload, content_type)
        except StorageError as exc:
            raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Failed to store remote file.") from exc

    return RemoteFileFetchResult(
        content_type=content_type,
        size_bytes=size_bytes,
        sha256_hex=hasher.hexdigest(),
        final_url=final_url,
    )


def _fetch_error_label(signature_kind: str | None) -> str:
    return signature_kind.upper() if signature_kind is not None else "file"
