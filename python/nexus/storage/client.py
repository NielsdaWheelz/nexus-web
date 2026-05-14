"""Cloudflare R2 storage client."""

import hashlib
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from uuid import uuid4

import boto3
from botocore.client import BaseClient, Config
from botocore.exceptions import BotoCoreError, ClientError

from nexus.config import get_settings


@dataclass(frozen=True)
class SignedUpload:
    """Signed direct-upload URL for a storage path."""

    path: str
    upload_url: str


@dataclass(frozen=True)
class ObjectMetadata:
    """Storage object metadata.

    Metadata is advisory. The reliable existence signal is None vs not-None
    from head_object().
    """

    content_type: str
    size_bytes: int


class StorageClientBase(ABC):
    """Storage operations used by services and tasks."""

    @abstractmethod
    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        size_bytes: int,
        expires_in: int = 300,
    ) -> SignedUpload:
        """Create a signed URL for browser direct upload."""
        ...

    @abstractmethod
    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
        """Create a signed URL for downloading an object."""
        ...

    @abstractmethod
    def head_object(self, path: str) -> ObjectMetadata | None:
        """Return object metadata, or None when the object is missing."""
        ...

    @abstractmethod
    def stream_object(self, path: str) -> Iterator[bytes]:
        """Stream object bytes in chunks."""
        ...

    @abstractmethod
    def put_object(
        self,
        path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
    ) -> None:
        """Upload bytes to an object path."""
        ...

    @abstractmethod
    def copy_object(self, source_path: str, destination_path: str) -> None:
        """Copy one object to another path inside the same bucket."""
        ...

    @abstractmethod
    def delete_object(self, path: str) -> None:
        """Delete an object path."""
        ...


class StorageError(Exception):
    """Storage operation error."""

    def __init__(self, message: str, code: str = "E_STORAGE_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


class StorageClient(StorageClientBase):
    """Cloudflare R2 client using the S3-compatible API."""

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
            ),
        )

    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        size_bytes: int,
        expires_in: int = 300,
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

    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
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
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=path)
        except ClientError as exc:
            if _client_error_is_missing(exc):
                raise StorageError(f"Object not found: {path}", code="E_STORAGE_MISSING") from exc
            raise StorageError(f"Failed to stream object {path}") from exc
        except BotoCoreError as exc:
            raise StorageError(f"Failed to stream object {path}") from exc

        body = response["Body"]
        try:
            try:
                while chunk := body.read(8 * 1024 * 1024):
                    yield chunk
            except (BotoCoreError, ClientError, OSError) as exc:
                raise StorageError(f"Failed to stream object {path}") from exc
        finally:
            close = getattr(body, "close", None)
            if close:
                close()

    def put_object(
        self,
        path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
    ) -> None:
        try:
            self._client.put_object(
                Bucket=self._bucket,
                Key=path,
                Body=content,
                ContentType=content_type,
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to upload object {path}") from exc

    def copy_object(self, source_path: str, destination_path: str) -> None:
        try:
            self._client.copy_object(
                Bucket=self._bucket,
                Key=destination_path,
                CopySource={"Bucket": self._bucket, "Key": source_path},
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(
                f"Failed to copy object {source_path} to {destination_path}"
            ) from exc

    def delete_object(self, path: str) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket, Key=path)
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(f"Failed to delete object {path}") from exc


class FakeStorageClient(StorageClientBase):
    """In-memory storage client for unit tests."""

    def __init__(self):
        self._objects: dict[str, tuple[bytes, str]] = {}

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

    def put_object(
        self,
        path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
    ) -> None:
        self._objects[path] = (content, content_type)

    def copy_object(self, source_path: str, destination_path: str) -> None:
        if source_path not in self._objects:
            raise StorageError(f"Object not found: {source_path}", code="E_STORAGE_MISSING")
        self._objects[destination_path] = self._objects[source_path]

    def delete_object(self, path: str) -> None:
        self._objects.pop(path, None)

    def get_object(self, path: str) -> bytes | None:
        if path not in self._objects:
            return None
        return self._objects[path][0]

    def clear(self) -> None:
        self._objects.clear()


def get_storage_client() -> StorageClientBase:
    settings = get_settings()
    endpoint_url = settings.r2_endpoint_url
    access_key_id = settings.r2_access_key_id
    secret_access_key = settings.r2_secret_access_key
    bucket = settings.r2_bucket
    region = settings.r2_region or "auto"

    missing = [
        key
        for key, value in (
            ("R2_ENDPOINT_URL", endpoint_url),
            ("R2_ACCESS_KEY_ID", access_key_id),
            ("R2_SECRET_ACCESS_KEY", secret_access_key),
            ("R2_BUCKET", bucket),
        )
        if not value
    ]
    if missing:
        raise StorageError(f"Missing R2 storage settings: {', '.join(missing)}")

    assert endpoint_url is not None
    assert access_key_id is not None
    assert secret_access_key is not None
    assert bucket is not None
    return StorageClient(
        endpoint_url=endpoint_url,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        bucket=bucket,
        region=region,
    )


def compute_sha256(data: bytes | Iterator[bytes]) -> str:
    hasher = hashlib.sha256()

    if isinstance(data, bytes):
        hasher.update(data)
    else:
        for chunk in data:
            hasher.update(chunk)

    return hasher.hexdigest()


def _client_error_is_missing(exc: ClientError) -> bool:
    response = getattr(exc, "response", {})
    error_code = str(response.get("Error", {}).get("Code") or "")
    return error_code in {"404", "NoSuchKey", "NotFound"}
