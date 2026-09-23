"""Cloudflare R2 storage client (S3-compatible API)."""

import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import BinaryIO

import boto3
from botocore.client import BaseClient, Config
from botocore.exceptions import BotoCoreError, ClientError

from nexus.config import get_settings

_PUT_OBJECT_ATTEMPTS = 3
_READ_CHUNK_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class SignedUpload:
    path: str
    upload_url: str


@dataclass(frozen=True)
class ObjectMetadata:
    """Advisory object metadata. Existence is None vs not-None from head_object."""

    content_type: str
    size_bytes: int


@dataclass(frozen=True)
class StorageObjectEntry:
    path: str
    last_modified: datetime
    size_bytes: int


@dataclass(frozen=True)
class ObjectPage:
    objects: tuple[StorageObjectEntry, ...]
    next_continuation_token: str | None


class StorageError(Exception):
    def __init__(self, message: str, code: str = "E_STORAGE_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


def _client_error_is_missing(exc: ClientError) -> bool:
    response = getattr(exc, "response", {})
    error_code = str(response.get("Error", {}).get("Code") or "")
    return error_code in {"404", "NoSuchKey", "NotFound"}


class StorageClient:
    def __init__(
        self,
        endpoint_url: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        region: str = "auto",
        s3_client: BaseClient | None = None,
    ):
        self._bucket = bucket
        self._client = s3_client or boto3.client(
            "s3",
            endpoint_url=endpoint_url.rstrip("/"),
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                connect_timeout=get_settings().r2_connect_timeout_seconds,
                read_timeout=get_settings().r2_read_timeout_seconds,
            ),
        )

    def sign_upload(
        self, path: str, *, content_type: str, size_bytes: int, expires_in: int = 300
    ) -> SignedUpload:
        try:
            upload_url = self._client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": self._bucket,
                    "Key": path,
                    "ContentType": content_type,
                    "ContentLength": int(size_bytes),
                },
                ExpiresIn=expires_in,
                HttpMethod="PUT",
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to sign upload for {path}") from exc
        return SignedUpload(path=path, upload_url=upload_url)

    def sign_download(self, path: str, *, expires_in: int = 300) -> str:
        try:
            return self._client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": path},
                ExpiresIn=expires_in,
                HttpMethod="GET",
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to sign download for {path}") from exc

    def head_object(self, path: str) -> ObjectMetadata | None:
        try:
            response = self._client.head_object(Bucket=self._bucket, Key=path)
        except ClientError as exc:
            if _client_error_is_missing(exc):
                return None
            raise StorageError(f"Failed to read object metadata for {path}") from exc
        except BotoCoreError as exc:
            raise StorageError(f"Failed to read object metadata for {path}") from exc
        return ObjectMetadata(
            content_type=str(response.get("ContentType") or "application/octet-stream"),
            size_bytes=int(response.get("ContentLength") or 0),
        )

    def stream_object(self, path: str) -> Iterator[bytes]:
        return self._stream(path, remaining=None)

    def stream_object_range(self, path: str, *, start: int, end_inclusive: int) -> Iterator[bytes]:
        if start < 0 or end_inclusive < start:
            raise ValueError("invalid inclusive object range")
        return self._stream(
            path, remaining=end_inclusive - start + 1, range_header=f"bytes={start}-{end_inclusive}"
        )

    def _stream(
        self, path: str, *, remaining: int | None, range_header: str | None = None
    ) -> Iterator[bytes]:
        what = "object" if range_header is None else "object range"
        params = {"Bucket": self._bucket, "Key": path}
        if range_header is not None:
            params["Range"] = range_header
        try:
            response = self._client.get_object(**params)
        except ClientError as exc:
            if _client_error_is_missing(exc):
                raise StorageError(f"Object not found: {path}", code="E_STORAGE_MISSING") from exc
            raise StorageError(f"Failed to stream {what} {path}") from exc
        except BotoCoreError as exc:
            raise StorageError(f"Failed to stream {what} {path}") from exc

        body = response["Body"]
        try:
            try:
                while remaining is None or remaining > 0:
                    want = (
                        _READ_CHUNK_BYTES
                        if remaining is None
                        else min(_READ_CHUNK_BYTES, remaining)
                    )
                    chunk = body.read(want)
                    if not chunk:
                        if remaining is None:
                            return
                        raise StorageError("Stored object range ended before persisted metadata")
                    if remaining is not None:
                        remaining -= len(chunk)
                    yield chunk
            except (BotoCoreError, ClientError, OSError) as exc:
                raise StorageError(f"Failed to stream {what} {path}") from exc
        finally:
            close = getattr(body, "close", None)
            if close:
                close()

    def put_object(
        self, path: str, content: bytes, content_type: str = "application/octet-stream"
    ) -> None:
        # A whole-bytes put is idempotent, and single-request transient failures
        # have terminally failed captures. Bounded retry, ~0.8s worst case.
        delay_seconds = 0.2
        for attempt in range(1, _PUT_OBJECT_ATTEMPTS + 1):
            try:
                self._client.put_object(
                    Bucket=self._bucket, Key=path, Body=content, ContentType=content_type
                )
                return
            except (BotoCoreError, ClientError) as exc:
                if attempt == _PUT_OBJECT_ATTEMPTS:
                    raise StorageError(f"Failed to upload object {path}: {exc}") from exc
                time.sleep(delay_seconds)
                delay_seconds *= 3

    def put_object_stream(
        self, path: str, content: BinaryIO, content_type: str = "application/octet-stream"
    ) -> None:
        # No retry: the stream body is not replayable after a partial send.
        try:
            self._client.put_object(
                Bucket=self._bucket, Key=path, Body=content, ContentType=content_type
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to upload object {path}: {exc}") from exc

    def copy_object(self, source_path: str, destination_path: str) -> None:
        try:
            self._client.copy_object(
                Bucket=self._bucket,
                Key=destination_path,
                CopySource={"Bucket": self._bucket, "Key": source_path},
            )
        except ClientError as exc:
            if _client_error_is_missing(exc):
                raise StorageError(
                    f"Object not found: {source_path}", code="E_STORAGE_MISSING"
                ) from exc
            raise StorageError(
                f"Failed to copy object {source_path} to {destination_path}"
            ) from exc
        except BotoCoreError as exc:
            raise StorageError(
                f"Failed to copy object {source_path} to {destination_path}"
            ) from exc

    def delete_object(self, path: str) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket, Key=path)
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to delete object {path}") from exc

    def list_objects(self, prefix: str, *, continuation_token: str | None = None) -> ObjectPage:
        params: dict[str, str] = {"Bucket": self._bucket, "Prefix": prefix}
        if continuation_token is not None:
            params["ContinuationToken"] = continuation_token
        try:
            response = self._client.list_objects_v2(**params)
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to list objects under {prefix}") from exc

        objects = tuple(
            StorageObjectEntry(
                path=str(item["Key"]),
                last_modified=item["LastModified"],
                size_bytes=int(item.get("Size", 0)),
            )
            for item in response.get("Contents", [])
        )
        next_token = None
        if bool(response.get("IsTruncated", False)):
            candidate = response.get("NextContinuationToken")
            if not isinstance(candidate, str) or not candidate or candidate != candidate.strip():
                raise StorageError("Storage listing returned an invalid next continuation token")
            if candidate == continuation_token:
                raise StorageError(
                    "Storage listing returned a non-advancing next continuation token"
                )
            next_token = candidate
        return ObjectPage(objects=objects, next_continuation_token=next_token)


def read_object_checked(storage: StorageClient, storage_path: str, *, expected_size: int) -> bytes:
    """Stream an object fully, verifying its byte size before returning."""
    chunks: list[bytes] = []
    total = 0
    for chunk in storage.stream_object(storage_path):
        total += len(chunk)
        if total > expected_size:
            raise StorageError("Stored object is larger than persisted metadata")
        chunks.append(chunk)
    if total != expected_size:
        raise StorageError("Stored object integrity mismatch")
    return b"".join(chunks)


def get_storage_client() -> StorageClient:
    settings = get_settings()
    resolved: dict[str, str] = {}
    missing: list[str] = []
    for key, value in (
        ("R2_S3_API_ORIGIN", settings.r2_s3_api_origin),
        ("R2_ACCESS_KEY_ID", settings.r2_access_key_id),
        ("R2_SECRET_ACCESS_KEY", settings.r2_secret_access_key),
        ("R2_BUCKET", settings.r2_bucket),
    ):
        if value:
            resolved[key] = value
        else:
            missing.append(key)
    if missing:
        raise StorageError(f"Missing R2 storage settings: {', '.join(missing)}")

    return StorageClient(
        endpoint_url=resolved["R2_S3_API_ORIGIN"],
        access_key_id=resolved["R2_ACCESS_KEY_ID"],
        secret_access_key=resolved["R2_SECRET_ACCESS_KEY"],
        bucket=resolved["R2_BUCKET"],
        region=settings.r2_region or "auto",
    )
