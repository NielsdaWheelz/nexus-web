"""Supabase Storage client abstraction.

Provides a clean interface for storage operations with:
- Signed upload URLs (for direct browser uploads)
- Signed download URLs (for secure file access)
- Object existence checks
- Object streaming (for hashing)
- Object deletion

The client uses Supabase's signed URL mechanisms for secure access.
All methods receive the full storage_path directly - no prefix manipulation.
"""

import hashlib
import os
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from typing import BinaryIO
from uuid import uuid4

import httpx


@dataclass(frozen=True)
class SignedUpload:
    """Supabase signed upload response.

    Use with supabase.storage.uploadToSignedUrl(path, token, file) on client.
    """

    path: str
    token: str


@dataclass(frozen=True)
class ObjectMetadata:
    """Storage object metadata.

    Advisory only - do not trust for security validation.
    Only reliable signal is existence (None vs not-None from head_object).
    """

    content_type: str
    size_bytes: int


class StorageClientBase(ABC):
    """Abstract base class for storage client implementations."""

    @abstractmethod
    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        expires_in: int = 300,
    ) -> SignedUpload:
        """Create a signed upload URL for direct browser upload.

        Args:
            path: Full storage path (e.g., "media/{id}/original.pdf").
            content_type: Expected content type for the upload.
            expires_in: URL validity in seconds.

        Returns:
            SignedUpload with path and token for uploadToSignedUrl().

        Raises:
            StorageError: If signing fails.
        """
        ...

    @abstractmethod
    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
        """Create a signed download URL.

        Args:
            path: Full storage path.
            expires_in: URL validity in seconds.

        Returns:
            Signed URL string.

        Raises:
            StorageError: If signing fails.
        """
        ...

    @abstractmethod
    def head_object(self, path: str) -> ObjectMetadata | None:
        """Check if object exists and get metadata.

        Args:
            path: Full storage path.

        Returns:
            ObjectMetadata if object exists, None otherwise.
            Note: Metadata values are advisory only.
        """
        ...

    @abstractmethod
    def stream_object(self, path: str) -> Iterator[bytes]:
        """Stream object content in chunks.

        Used for hashing and validation from actual bytes.

        Args:
            path: Full storage path.

        Yields:
            Chunks of bytes.

        Raises:
            StorageError: If object doesn't exist or streaming fails.
        """
        ...

    @abstractmethod
    def delete_object(self, path: str) -> None:
        """Delete an object from storage.

        Best-effort operation - logs errors but doesn't raise.

        Args:
            path: Full storage path.
        """
        ...


class StorageError(Exception):
    """Storage operation error."""

    def __init__(self, message: str, code: str = "E_STORAGE_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


class StorageClient(StorageClientBase):
    """Production Supabase Storage client.

    Uses httpx for HTTP operations against Supabase Storage API.
    """

    def __init__(
        self,
        supabase_url: str,
        service_key: str,
        bucket: str = "media",
    ):
        """Initialize the storage client.

        Args:
            supabase_url: Supabase project URL (e.g., https://xxx.supabase.co).
            service_key: Supabase service role key.
            bucket: Storage bucket name.
        """
        self._base_url = supabase_url.rstrip("/")
        self._service_key = service_key
        self._bucket = bucket
        self._storage_url = f"{self._base_url}/storage/v1"
        self._headers = {
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
        }

    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        expires_in: int = 300,
    ) -> SignedUpload:
        """Create signed upload URL via Supabase Storage API."""
        # Supabase uses POST /object/upload/sign/{bucket}/{path}
        url = f"{self._storage_url}/object/upload/sign/{self._bucket}/{path}"

        with httpx.Client() as client:
            response = client.post(
                url,
                headers=self._headers,
                json={"expiresIn": expires_in},
                timeout=30.0,
            )

            if response.status_code != 200:
                raise StorageError(
                    f"Failed to sign upload: {response.status_code} {response.text}",
                    code="E_SIGN_UPLOAD_FAILED",
                )

            data = response.json()
            # Supabase returns { url: "...", token: "..." }
            # The token is what we need for uploadToSignedUrl
            token = data.get("token", "")
            if not token:
                # Fallback: extract from URL if token not in response
                signed_url = data.get("url", "")
                if "token=" in signed_url:
                    token = signed_url.split("token=")[1].split("&")[0]

            return SignedUpload(path=path, token=token)

    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
        """Create signed download URL via Supabase Storage API."""
        # Supabase uses POST /object/sign/{bucket}/{path}
        url = f"{self._storage_url}/object/sign/{self._bucket}/{path}"

        with httpx.Client() as client:
            response = client.post(
                url,
                headers=self._headers,
                json={"expiresIn": expires_in},
                timeout=30.0,
            )

            if response.status_code != 200:
                raise StorageError(
                    f"Failed to sign download: {response.status_code} {response.text}",
                    code="E_SIGN_DOWNLOAD_FAILED",
                )

            data = response.json()
            signed_path = data.get("signedURL") or data.get("signedUrl") or ""
            if not signed_path:
                raise StorageError(
                    "Failed to sign download: missing signed URL",
                    code="E_SIGN_DOWNLOAD_FAILED",
                )

            # Supabase may return relative paths (with or without /storage/v1).
            if signed_path.startswith("http://") or signed_path.startswith("https://"):
                return signed_path

            if signed_path.startswith("/storage/"):
                return f"{self._base_url}{signed_path}"

            if signed_path.startswith("/object/"):
                return f"{self._storage_url}{signed_path}"

            if signed_path.startswith("storage/"):
                return f"{self._base_url}/{signed_path.lstrip('/')}"

            if signed_path.startswith("object/"):
                return f"{self._storage_url}/{signed_path.lstrip('/')}"

            if signed_path.startswith("/"):
                return f"{self._base_url}{signed_path}"

            # Fallback to storage base if the API returns a bare path.
            return f"{self._storage_url}/{signed_path.lstrip('/')}"

    def head_object(self, path: str) -> ObjectMetadata | None:
        """Check object existence via HEAD request."""
        # Use the public/authenticated object endpoint
        url = f"{self._storage_url}/object/{self._bucket}/{path}"

        with httpx.Client() as client:
            response = client.head(url, headers=self._headers, timeout=30.0)

            if response.status_code == 404:
                return None

            if response.status_code != 200:
                # Treat other errors as "doesn't exist" for safety
                return None

            content_type = response.headers.get("content-type", "application/octet-stream")
            content_length = response.headers.get("content-length", "0")

            return ObjectMetadata(
                content_type=content_type,
                size_bytes=int(content_length),
            )

    def stream_object(self, path: str) -> Iterator[bytes]:
        """Stream object content via authenticated GET request."""
        url = f"{self._storage_url}/object/{self._bucket}/{path}"

        with httpx.Client() as client:
            with client.stream("GET", url, headers=self._headers, timeout=60.0) as response:
                if response.status_code == 404:
                    raise StorageError(
                        f"Object not found: {path}",
                        code="E_STORAGE_MISSING",
                    )

                if response.status_code != 200:
                    raise StorageError(
                        f"Failed to stream object: {response.status_code}",
                        code="E_STORAGE_ERROR",
                    )

                yield from response.iter_bytes(chunk_size=8 * 1024 * 1024)  # 8 MiB chunks

    def delete_object(self, path: str) -> None:
        """Delete object from storage (best-effort)."""
        url = f"{self._storage_url}/object/{self._bucket}/{path}"

        try:
            with httpx.Client() as client:
                response = client.delete(url, headers=self._headers, timeout=30.0)
                # Log but don't raise on failure
                if response.status_code not in (200, 204, 404):
                    # Use standard logging instead of print
                    import logging

                    logging.getLogger(__name__).warning(
                        "Storage delete failed: %s %s",
                        response.status_code,
                        response.text,
                    )
        except Exception as e:
            import logging

            logging.getLogger(__name__).warning("Storage delete error: %s", e)


class FakeStorageClient(StorageClientBase):
    """Fake storage client for testing without real Supabase.

    Stores files in memory and provides deterministic behavior for unit tests.
    """

    def __init__(self):
        self._objects: dict[str, tuple[bytes, str]] = {}  # path -> (content, content_type)
        self._signed_uploads: dict[str, str] = {}  # path -> token

    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        expires_in: int = 300,
    ) -> SignedUpload:
        """Create a fake signed upload token."""
        token = f"fake-token-{uuid4()}"
        self._signed_uploads[path] = token
        # Pre-create empty entry so head_object returns None until actual upload
        return SignedUpload(path=path, token=token)

    def sign_download(
        self,
        path: str,
        *,
        expires_in: int = 300,
    ) -> str:
        """Create a fake signed download URL."""
        return f"https://fake-storage.test/download/{path}?token=fake-{uuid4()}"

    def head_object(self, path: str) -> ObjectMetadata | None:
        """Check if fake object exists."""
        if path not in self._objects:
            return None
        content, content_type = self._objects[path]
        return ObjectMetadata(
            content_type=content_type,
            size_bytes=len(content),
        )

    def stream_object(self, path: str) -> Iterator[bytes]:
        """Stream fake object content."""
        if path not in self._objects:
            raise StorageError(
                f"Object not found: {path}",
                code="E_STORAGE_MISSING",
            )
        content, _ = self._objects[path]
        # Yield in chunks like real client
        chunk_size = 8 * 1024 * 1024
        for i in range(0, len(content), chunk_size):
            yield content[i : i + chunk_size]

    def delete_object(self, path: str) -> None:
        """Delete fake object."""
        self._objects.pop(path, None)

    # Test helper methods

    def put_object(self, path: str, content: bytes, content_type: str = "application/pdf") -> None:
        """Store an object directly (test helper)."""
        self._objects[path] = (content, content_type)

    def get_object(self, path: str) -> bytes | None:
        """Get object content directly (test helper)."""
        if path not in self._objects:
            return None
        return self._objects[path][0]

    def clear(self) -> None:
        """Clear all stored objects (test helper)."""
        self._objects.clear()
        self._signed_uploads.clear()


def get_storage_client() -> StorageClientBase:
    """Get the configured storage client.

    Returns:
        StorageClient if SUPABASE_URL and SUPABASE_SERVICE_KEY are set,
        FakeStorageClient otherwise.
    """
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY")

    if supabase_url and service_key:
        return StorageClient(
            supabase_url=supabase_url,
            service_key=service_key,
        )

    # Return fake client for local dev / tests without Supabase
    return FakeStorageClient()


def compute_sha256(data: bytes | BinaryIO | Iterator[bytes]) -> str:
    """Compute SHA-256 hash of data.

    Args:
        data: Bytes, file-like object, or iterator of bytes.

    Returns:
        Hex-encoded SHA-256 hash.
    """
    hasher = hashlib.sha256()

    if isinstance(data, bytes):
        hasher.update(data)
    elif hasattr(data, "read"):
        # File-like object
        while chunk := data.read(8 * 1024 * 1024):
            hasher.update(chunk)
    else:
        # Iterator
        for chunk in data:
            hasher.update(chunk)

    return hasher.hexdigest()
