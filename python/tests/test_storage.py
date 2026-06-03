"""Tests for storage clients and path utilities."""

import hashlib
from collections.abc import Iterator
from io import BytesIO
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError

from nexus.storage.client import (
    ObjectMetadata,
    SignedUpload,
    StorageClient,
    StorageClientBase,
    StorageError,
    get_storage_client,
)
from nexus.storage.paths import (
    PLATE_CONTENT_TYPE_TO_EXT,
    build_epub_asset_storage_path,
    build_oracle_plate_storage_path,
    build_storage_path,
    build_upload_staging_storage_path,
    ext_for_content_type,
    get_file_extension,
)
from nexus.storage.read import read_object_checked
from tests.support.storage import FakeStorageClient

pytestmark = pytest.mark.unit


class RecordingS3Client:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.head_response = {"ContentType": "application/pdf", "ContentLength": 123}
        self.head_error: ClientError | None = None
        self.get_body = b"pdf-bytes"
        self.get_error: ClientError | None = None
        self.put_error: ClientError | None = None
        self.copy_error: ClientError | None = None
        self.delete_error: ClientError | None = None

    def generate_presigned_url(self, client_method, Params, ExpiresIn, HttpMethod):
        self.calls.append(
            (
                "generate_presigned_url",
                {
                    "client_method": client_method,
                    "Params": Params,
                    "ExpiresIn": ExpiresIn,
                    "HttpMethod": HttpMethod,
                },
            )
        )
        return f"https://signed.test/{client_method}/{Params['Key']}"

    def head_object(self, **kwargs):
        self.calls.append(("head_object", kwargs))
        if self.head_error:
            raise self.head_error
        return self.head_response

    def get_object(self, **kwargs):
        self.calls.append(("get_object", kwargs))
        if self.get_error:
            raise self.get_error
        return {"Body": BytesIO(self.get_body)}

    def put_object(self, **kwargs):
        self.calls.append(("put_object", kwargs))
        if self.put_error:
            raise self.put_error
        return {}

    def copy_object(self, **kwargs):
        self.calls.append(("copy_object", kwargs))
        if self.copy_error:
            raise self.copy_error
        return {}

    def delete_object(self, **kwargs):
        self.calls.append(("delete_object", kwargs))
        if self.delete_error:
            raise self.delete_error
        return {}


class FailingReadBody:
    def __init__(self):
        self.closed = False

    def read(self, _size: int) -> bytes:
        raise OSError("stream interrupted")

    def close(self) -> None:
        self.closed = True


def client_error(code: str, status_code: int = 500) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": code},
            "ResponseMetadata": {"HTTPStatusCode": status_code},
        },
        "storage-test",
    )


class TestPathBuilding:
    def test_get_file_extension_pdf(self):
        assert get_file_extension("pdf") == "pdf"

    def test_get_file_extension_epub(self):
        assert get_file_extension("epub") == "epub"

    def test_get_file_extension_invalid(self):
        with pytest.raises(ValueError, match="not a file-backed media type"):
            get_file_extension("web_article")

    def test_build_storage_path(self):
        media_id = uuid4()
        path = build_storage_path(media_id, "pdf")

        assert path == f"media/{media_id}/original.pdf"

    def test_build_upload_staging_storage_path(self):
        media_id = uuid4()

        assert (
            build_upload_staging_storage_path(media_id, "pdf")
            == f"uploads/media/{media_id}/original.pdf"
        )

    def test_build_epub_asset_storage_path(self):
        media_id = uuid4()

        assert (
            build_epub_asset_storage_path(media_id, "OEBPS/images/cover.png")
            == f"media/{media_id}/assets/OEBPS/images/cover.png"
        )

    @pytest.mark.parametrize(
        "asset_key",
        ["", "/", "/cover.png", "images//cover.png", "./cover.png", "../cover.png"],
    )
    def test_build_epub_asset_storage_path_rejects_unsafe_asset_key(self, asset_key: str):
        with pytest.raises(ValueError, match="EPUB asset key"):
            build_epub_asset_storage_path(uuid4(), asset_key)

    def test_build_oracle_plate_storage_path(self):
        sha = "a" * 64

        assert build_oracle_plate_storage_path(sha, "jpg") == f"oracle/plates/{sha}.jpg"

    def test_build_oracle_plate_storage_path_rejects_short_sha(self):
        with pytest.raises(ValueError, match="64 lowercase hex chars"):
            build_oracle_plate_storage_path("a" * 63, "jpg")

    def test_build_oracle_plate_storage_path_rejects_uppercase_sha(self):
        with pytest.raises(ValueError, match="64 lowercase hex chars"):
            build_oracle_plate_storage_path("A" * 64, "jpg")

    def test_build_oracle_plate_storage_path_rejects_unsupported_ext(self):
        with pytest.raises(ValueError, match="jpg|png|webp"):
            build_oracle_plate_storage_path("a" * 64, "gif")

    @pytest.mark.parametrize(
        ("content_type", "ext"),
        [("image/jpeg", "jpg"), ("image/png", "png"), ("image/webp", "webp")],
    )
    def test_ext_for_content_type(self, content_type: str, ext: str):
        assert ext_for_content_type(content_type) == ext
        assert PLATE_CONTENT_TYPE_TO_EXT[content_type] == ext

    @pytest.mark.parametrize("content_type", ["image/gif", "image/svg+xml"])
    def test_ext_for_content_type_rejects_unsupported(self, content_type: str):
        with pytest.raises(ValueError, match="unsupported oracle plate content-type"):
            ext_for_content_type(content_type)
        assert content_type not in PLATE_CONTENT_TYPE_TO_EXT


class TestFakeStorageClient:
    @pytest.fixture
    def client(self):
        return FakeStorageClient()

    def test_sign_upload_returns_path_and_upload_url(self, client):
        result = client.sign_upload(
            "media/test/original.pdf",
            content_type="application/pdf",
            size_bytes=123,
        )

        assert isinstance(result, SignedUpload)
        assert result.path == "media/test/original.pdf"
        assert result.upload_url.startswith(
            "https://fake-storage.test/upload/media/test/original.pdf"
        )

    def test_sign_download_returns_url(self, client):
        url = client.sign_download("media/test/original.pdf")

        assert "fake-storage.test" in url
        assert "download" in url

    def test_head_object_missing(self, client):
        assert client.head_object("missing/path.pdf") is None

    def test_head_object_exists(self, client):
        client.put_object("test/file.pdf", b"test content", "application/pdf")

        result = client.head_object("test/file.pdf")

        assert result == ObjectMetadata(content_type="application/pdf", size_bytes=12)

    def test_stream_object_missing(self, client):
        with pytest.raises(StorageError) as exc_info:
            list(client.stream_object("missing/path.pdf"))

        assert exc_info.value.code == "E_STORAGE_MISSING"

    def test_stream_object_returns_chunks(self, client):
        content = b"hello world" * 1000
        client.put_object("test/file.pdf", content, "application/pdf")

        chunks = list(client.stream_object("test/file.pdf"))

        assert b"".join(chunks) == content

    def test_delete_object(self, client):
        client.put_object("test/file.pdf", b"content", "application/pdf")

        client.delete_object("test/file.pdf")

        assert client.head_object("test/file.pdf") is None

    def test_delete_object_missing_no_error(self, client):
        client.delete_object("missing/path.pdf")

    def test_clear(self, client):
        client.put_object("test/a.pdf", b"a", "application/pdf")
        client.put_object("test/b.pdf", b"b", "application/pdf")

        client.clear()

        assert client.head_object("test/a.pdf") is None
        assert client.head_object("test/b.pdf") is None


class TestStorageClient:
    def test_sign_upload_returns_presigned_put_url(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        result = client.sign_upload(
            "media/test/original.pdf",
            content_type="application/pdf",
            size_bytes=123,
            expires_in=120,
        )

        assert result == SignedUpload(
            path="media/test/original.pdf",
            upload_url="https://signed.test/put_object/media/test/original.pdf",
        )
        assert s3.calls == [
            (
                "generate_presigned_url",
                {
                    "client_method": "put_object",
                    "Params": {
                        "Bucket": "media",
                        "Key": "media/test/original.pdf",
                        "ContentType": "application/pdf",
                        "ContentLength": 123,
                    },
                    "ExpiresIn": 120,
                    "HttpMethod": "PUT",
                },
            )
        ]

    def test_sign_download_returns_presigned_get_url(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        signed_url = client.sign_download("media/test/original.pdf", expires_in=60)

        assert signed_url == "https://signed.test/get_object/media/test/original.pdf"
        assert s3.calls == [
            (
                "generate_presigned_url",
                {
                    "client_method": "get_object",
                    "Params": {"Bucket": "media", "Key": "media/test/original.pdf"},
                    "ExpiresIn": 60,
                    "HttpMethod": "GET",
                },
            )
        ]

    def test_head_object_reads_metadata(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        metadata = client.head_object("media/test/file.pdf")

        assert metadata == ObjectMetadata(content_type="application/pdf", size_bytes=123)
        assert s3.calls == [("head_object", {"Bucket": "media", "Key": "media/test/file.pdf"})]

    def test_head_object_returns_none_when_missing(self):
        s3 = RecordingS3Client()
        s3.head_error = client_error("NoSuchKey", 404)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        assert client.head_object("media/test/file.pdf") is None

    def test_head_object_raises_on_missing_bucket(self):
        s3 = RecordingS3Client()
        s3.head_error = client_error("NoSuchBucket", 404)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            client.head_object("media/test/file.pdf")

        assert exc_info.value.code == "E_STORAGE_ERROR"

    def test_head_object_raises_on_infrastructure_error(self):
        s3 = RecordingS3Client()
        s3.head_error = client_error("InternalError", 500)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            client.head_object("media/test/file.pdf")

        assert exc_info.value.code == "E_STORAGE_ERROR"

    def test_stream_object_reads_body(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        assert list(client.stream_object("media/test/file.pdf")) == [b"pdf-bytes"]
        assert s3.calls == [("get_object", {"Bucket": "media", "Key": "media/test/file.pdf"})]

    def test_stream_object_wraps_mid_stream_failure(self):
        s3 = RecordingS3Client()
        body = FailingReadBody()

        def get_object(**kwargs):
            s3.calls.append(("get_object", kwargs))
            return {"Body": body}

        s3.get_object = get_object
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            list(client.stream_object("media/test/file.pdf"))

        assert exc_info.value.code == "E_STORAGE_ERROR"
        assert body.closed is True

    def test_stream_object_raises_missing_code_for_missing_object(self):
        s3 = RecordingS3Client()
        s3.get_error = client_error("NoSuchKey", 404)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            list(client.stream_object("media/test/file.pdf"))

        assert exc_info.value.code == "E_STORAGE_MISSING"

    def test_put_object_uploads_bytes_with_content_type(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        client.put_object("media/test/assets/cover.jpg", b"jpeg-bytes", "image/jpeg")

        assert s3.calls == [
            (
                "put_object",
                {
                    "Bucket": "media",
                    "Key": "media/test/assets/cover.jpg",
                    "Body": b"jpeg-bytes",
                    "ContentType": "image/jpeg",
                },
            )
        ]

    def test_put_object_raises_storage_error(self):
        s3 = RecordingS3Client()
        s3.put_error = client_error("InternalError", 500)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            client.put_object("media/test/assets/bad.bin", b"data")

        assert exc_info.value.code == "E_STORAGE_ERROR"

    def test_copy_object_copies_within_bucket(self):
        s3 = RecordingS3Client()
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        client.copy_object("media/test/uploads/original.pdf", "media/test/original.pdf")

        assert s3.calls == [
            (
                "copy_object",
                {
                    "Bucket": "media",
                    "Key": "media/test/original.pdf",
                    "CopySource": {
                        "Bucket": "media",
                        "Key": "media/test/uploads/original.pdf",
                    },
                },
            )
        ]

    def test_copy_object_raises_storage_error(self):
        s3 = RecordingS3Client()
        s3.copy_error = client_error("InternalError", 500)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            client.copy_object("media/test/uploads/original.pdf", "media/test/original.pdf")

        assert exc_info.value.code == "E_STORAGE_ERROR"

    def test_delete_object_raises_storage_error(self):
        s3 = RecordingS3Client()
        s3.delete_error = client_error("InternalError", 500)
        client = StorageClient("https://r2.test", "access", "secret", "media", s3_client=s3)

        with pytest.raises(StorageError) as exc_info:
            client.delete_object("media/test/file.pdf")

        assert exc_info.value.code == "E_STORAGE_ERROR"
        assert s3.calls == [("delete_object", {"Bucket": "media", "Key": "media/test/file.pdf"})]


class TestGetStorageClient:
    @pytest.fixture(autouse=True)
    def clear_rejected_supabase_service_role_env(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://localhost/test")
        monkeypatch.setenv("SUPABASE_SERVICE_KEY", "")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "")

    def test_test_env_without_r2_fails_closed(self, monkeypatch):
        for key in ("R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
            monkeypatch.setenv(key, "")
        monkeypatch.setenv("NEXUS_ENV", "test")

        with pytest.raises(StorageError, match="R2_S3_API_ORIGIN"):
            get_storage_client()

    def test_local_without_r2_fails_closed(self, monkeypatch):
        for key in ("R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
            monkeypatch.setenv(key, "")
        monkeypatch.setenv("NEXUS_ENV", "local")

        with pytest.raises(StorageError, match="R2_S3_API_ORIGIN"):
            get_storage_client()

    def test_partial_r2_env_fails_closed(self, monkeypatch):
        monkeypatch.setenv("NEXUS_ENV", "local")
        monkeypatch.setenv("R2_S3_API_ORIGIN", "https://r2.test")
        monkeypatch.setenv("R2_ACCESS_KEY_ID", "access")
        monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "")
        monkeypatch.setenv("R2_BUCKET", "")

        with pytest.raises(StorageError, match="R2_SECRET_ACCESS_KEY"):
            get_storage_client()

    def test_complete_r2_settings_create_real_storage_client(self, monkeypatch):
        calls = []

        def fake_boto3_client(service_name, **kwargs):
            calls.append((service_name, kwargs))
            return RecordingS3Client()

        monkeypatch.setenv("NEXUS_ENV", "test")
        monkeypatch.setenv("R2_S3_API_ORIGIN", "https://abc123.r2.cloudflarestorage.com")
        monkeypatch.setenv("R2_ACCESS_KEY_ID", "access")
        monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
        monkeypatch.setenv("R2_BUCKET", "media")
        monkeypatch.setenv("R2_REGION", "auto")
        monkeypatch.setattr("nexus.storage.client.boto3.client", fake_boto3_client)

        client = get_storage_client()

        assert isinstance(client, StorageClient)
        assert calls[0][0] == "s3"
        assert calls[0][1]["endpoint_url"] == "https://abc123.r2.cloudflarestorage.com"
        assert calls[0][1]["aws_access_key_id"] == "access"
        assert calls[0][1]["aws_secret_access_key"] == "secret"
        assert calls[0][1]["region_name"] == "auto"


class ChunkedStorageClient(StorageClientBase):
    """Minimal storage client that streams a caller-supplied list of chunks.

    Unlike FakeStorageClient (which only yields 8MB chunks), this lets a test
    pin exact chunk boundaries so the streaming loop in read_object_checked is
    exercised across more than one chunk.
    """

    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    def stream_object(self, path: str) -> Iterator[bytes]:
        yield from self._chunks

    def sign_upload(self, *args, **kwargs) -> SignedUpload:  # pragma: no cover - unused
        raise NotImplementedError

    def sign_download(self, *args, **kwargs) -> str:  # pragma: no cover - unused
        raise NotImplementedError

    def head_object(self, path: str) -> ObjectMetadata | None:  # pragma: no cover - unused
        raise NotImplementedError

    def put_object(self, *args, **kwargs) -> None:  # pragma: no cover - unused
        raise NotImplementedError

    def copy_object(self, *args, **kwargs) -> None:  # pragma: no cover - unused
        raise NotImplementedError

    def delete_object(self, path: str) -> None:  # pragma: no cover - unused
        raise NotImplementedError


class TestReadObjectChecked:
    def test_happy_multi_chunk_joins_and_verifies(self):
        chunks = [b"hello ", b"checked ", b"world"]
        payload = b"".join(chunks)
        client = ChunkedStorageClient(chunks)

        result = read_object_checked(
            client,
            "oracle/plates/x.jpg",
            expected_sha256=hashlib.sha256(payload).hexdigest(),
            expected_size=len(payload),
        )

        assert result == payload

    def test_silent_corruption_same_size_wrong_sha_raises(self):
        # Tampered content with the SAME byte length: only the hash check can
        # catch this. This is the integrity branch that was previously untested.
        original = b"the real plate bytes!!"
        tampered = b"the FAKE plate bytes!!"
        assert len(tampered) == len(original)
        client = ChunkedStorageClient([tampered])

        with pytest.raises(StorageError, match="integrity mismatch"):
            read_object_checked(
                client,
                "oracle/plates/x.jpg",
                expected_sha256=hashlib.sha256(original).hexdigest(),
                expected_size=len(original),
            )

    def test_oversize_payload_raises(self):
        original = b"abc"
        client = ChunkedStorageClient([b"abc", b"extra"])

        with pytest.raises(StorageError, match="larger than persisted metadata"):
            read_object_checked(
                client,
                "oracle/plates/x.jpg",
                expected_sha256=hashlib.sha256(original).hexdigest(),
                expected_size=len(original),
            )

    def test_undersize_payload_raises(self):
        original = b"abcdef"
        client = ChunkedStorageClient([b"abc"])

        with pytest.raises(StorageError, match="integrity mismatch"):
            read_object_checked(
                client,
                "oracle/plates/x.jpg",
                expected_sha256=hashlib.sha256(original).hexdigest(),
                expected_size=len(original),
            )
