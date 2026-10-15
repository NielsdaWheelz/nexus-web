"""The process's one R2 client (S3 API). A key authorizes nothing: callers reach bytes
only after their owner row's check.

Every SDK call that can open or use a connection, and every body read, holds one process
lock and never yields to a caller while holding it: botocore reloads CA certificates into
the client's shared TLS context whenever it opens a connection (#576). Presigning signs in
memory and sends nothing, so it stays outside the lock. Botocore retries a transient failure
itself (standard mode, three attempts in all) inside the lock, rewinding a file body to byte 0.
"""

import atexit
from collections.abc import Generator
from dataclasses import dataclass
from datetime import datetime
from threading import Lock
from typing import Any, BinaryIO, Literal

from boto3.session import Session
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

from nexus.config import get_settings

_CHUNK_BYTES = 8 * 1024 * 1024
type StorageErrorCode = Literal["E_STORAGE_ERROR", "E_STORAGE_MISSING"]


@dataclass(frozen=True)
class ObjectMetadata:
    content_type: str
    size_bytes: int


class StorageError(Exception):
    """Not an ApiError: each caller maps it. ``E_STORAGE_MISSING`` is a 404 on read/copy."""

    def __init__(self, message: str, code: StorageErrorCode = "E_STORAGE_ERROR"):
        super().__init__(message)
        self.message = message
        self.code: StorageErrorCode = code


def _missing(exc: Exception) -> bool:
    code = isinstance(exc, ClientError) and exc.response.get("Error", {}).get("Code")
    return code in ("404", "NoSuchKey", "NotFound")


class StorageClient:
    def __init__(self) -> None:
        s = get_settings()
        if not (
            s.r2_s3_api_origin and s.r2_access_key_id and s.r2_secret_access_key and s.r2_bucket
        ):
            raise StorageError("R2 storage is not configured (R2_* settings)")
        self._bucket = s.r2_bucket
        self._lock = Lock()
        self._s3 = Session().client(
            "s3",
            endpoint_url=s.r2_s3_api_origin.rstrip("/"),
            aws_access_key_id=s.r2_access_key_id,
            aws_secret_access_key=s.r2_secret_access_key.get_secret_value(),
            region_name=s.r2_region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                connect_timeout=5,
                read_timeout=30,
                retries={"mode": "standard", "total_max_attempts": 3},
            ),
        )

    def _call(self, operation: str, what: str, **params: object) -> Any:
        try:
            with self._lock:
                return getattr(self._s3, operation)(Bucket=self._bucket, **params)
        except (BotoCoreError, ClientError) as exc:
            code = "E_STORAGE_MISSING" if _missing(exc) else "E_STORAGE_ERROR"
            raise StorageError(f"Failed to {what}", code) from exc

    def close(self) -> None:
        with self._lock:
            self._s3.close()

    def sign_upload(self, path: str, *, content_type: str, size_bytes: int, expires_in: int) -> str:
        """A PUT url that admits exactly these bytes' type and length (I8)."""
        params = {"ContentType": content_type, "ContentLength": size_bytes}
        return self._sign("put_object", path, expires_in, params)

    def sign_download(self, path: str, *, expires_in: int) -> str:
        return self._sign("get_object", path, expires_in, {})

    def _sign(self, operation: str, path: str, expires_in: int, params: dict[str, object]) -> str:
        try:
            return self._s3.generate_presigned_url(
                operation,
                Params={"Bucket": self._bucket, "Key": path, **params},
                ExpiresIn=expires_in,
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to sign {path}") from exc

    def head_object(self, path: str) -> ObjectMetadata | None:
        try:
            head = self._call("head_object", f"read metadata of {path}", Key=path)
        except StorageError as exc:
            if exc.code == "E_STORAGE_MISSING":
                return None
            raise
        return ObjectMetadata(
            str(head.get("ContentType") or "application/octet-stream"),
            int(head.get("ContentLength") or 0),
        )

    def stream_object(
        self,
        path: str,
        *,
        expected_size: int | None = None,
        byte_range: tuple[int, int] | None = None,
    ) -> Generator[bytes, None, None]:
        """Chunks of at most 8 MiB, lazily. The object's stored size is proven before the
        first chunk (a mismatch with ``expected_size`` raises then, not mid-body), and a
        body that ends short raises. ``byte_range`` is inclusive."""
        params = {"Key": path}
        if byte_range is not None:
            start, end = byte_range
            if start < 0 or end < start:
                raise ValueError("invalid inclusive byte range")
            params["Range"] = f"bytes={start}-{end}"
        response = self._call("get_object", f"read {path}", **params)
        body = response["Body"]
        try:
            remaining = int(response["ContentLength"])
            total = int(response["ContentRange"].rsplit("/", 1)[1]) if byte_range else remaining
            if expected_size is not None and total != expected_size:
                raise StorageError(f"{path} holds {total} bytes, its row says {expected_size}")
            while remaining > 0:
                try:
                    with self._lock:
                        chunk = body.read(min(_CHUNK_BYTES, remaining))
                except (BotoCoreError, ClientError, OSError) as exc:
                    raise StorageError(f"Failed to read {path}") from exc
                if not chunk:
                    raise StorageError(f"{path} ended {remaining} bytes short")
                remaining -= len(chunk)
                yield chunk
        finally:
            with self._lock:
                body.close()

    def read_object(self, path: str, *, expected_size: int | None = None) -> bytes:
        return b"".join(self.stream_object(path, expected_size=expected_size))

    def put_object(
        self, path: str, body: bytes | BinaryIO, content_type: str = "application/octet-stream"
    ) -> None:
        """Whole bytes, or a file at byte 0: botocore takes the length from the file's
        position and rewinds it to 0 before a retry."""
        self._call("put_object", f"write {path}", Key=path, Body=body, ContentType=content_type)

    def copy_object(self, source: str, destination: str) -> None:
        self._call(
            "copy_object",
            f"copy {source} to {destination}",
            Key=destination,
            CopySource={"Bucket": self._bucket, "Key": source},
        )

    def delete_object(self, path: str) -> None:
        self._call("delete_object", f"delete {path}", Key=path)

    def list_objects(
        self, prefix: str, *, continuation_token: str | None = None
    ) -> tuple[list[tuple[str, datetime]], str | None]:
        """One page: (key, last modified) pairs and the token of the next page, if any."""
        params = {"Prefix": prefix}
        if continuation_token is not None:
            params["ContinuationToken"] = continuation_token
        page = self._call("list_objects_v2", f"list {prefix}", **params)
        objects = [(str(item["Key"]), item["LastModified"]) for item in page.get("Contents", [])]
        return objects, page.get("NextContinuationToken") if page.get("IsTruncated") else None


_client: StorageClient | None = None
_client_lock = Lock()


def get_storage_client() -> StorageClient:
    """The process singleton, created on first use and closed at exit."""
    global _client
    with _client_lock:
        if _client is None:
            _client = StorageClient()
            atexit.register(_client.close)
        return _client
