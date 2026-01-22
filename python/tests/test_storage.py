"""Tests for storage client and path utilities.

Tests cover:
- Path building with test prefix isolation
- Storage client abstraction
- SHA-256 computation
- FakeStorageClient behavior
"""

from uuid import uuid4

import pytest

from nexus.storage.client import FakeStorageClient, ObjectMetadata, SignedUpload, compute_sha256
from nexus.storage.paths import build_storage_path, get_file_extension, parse_storage_path


class TestPathBuilding:
    """Tests for storage path building utilities."""

    def test_get_file_extension_pdf(self):
        """PDF kind returns 'pdf' extension."""
        assert get_file_extension("pdf") == "pdf"

    def test_get_file_extension_epub(self):
        """EPUB kind returns 'epub' extension."""
        assert get_file_extension("epub") == "epub"

    def test_get_file_extension_invalid(self):
        """Invalid kind raises ValueError."""
        with pytest.raises(ValueError, match="not a file-backed media type"):
            get_file_extension("web_article")

    def test_build_storage_path_production(self, monkeypatch):
        """Production path has no test prefix."""
        # Ensure no test prefix is set
        monkeypatch.delenv("STORAGE_TEST_PREFIX", raising=False)

        media_id = uuid4()
        path = build_storage_path(media_id, "pdf")

        assert path == f"media/{media_id}/original.pdf"
        assert not path.startswith("test_runs/")

    def test_build_storage_path_test_prefix(self, monkeypatch):
        """Test prefix is applied when STORAGE_TEST_PREFIX is set."""
        run_id = "test-run-123"
        monkeypatch.setenv("STORAGE_TEST_PREFIX", f"test_runs/{run_id}/")

        media_id = uuid4()
        path = build_storage_path(media_id, "epub")

        assert path == f"test_runs/{run_id}/media/{media_id}/original.epub"

    def test_build_storage_path_test_prefix_no_trailing_slash(self, monkeypatch):
        """Test prefix without trailing slash gets one added."""
        run_id = "test-run-456"
        monkeypatch.setenv("STORAGE_TEST_PREFIX", f"test_runs/{run_id}")  # No trailing slash

        media_id = uuid4()
        path = build_storage_path(media_id, "pdf")

        assert path == f"test_runs/{run_id}/media/{media_id}/original.pdf"

    def test_parse_storage_path_production(self):
        """Parse production path correctly."""
        media_id = str(uuid4())
        path = f"media/{media_id}/original.pdf"

        parsed_id, ext = parse_storage_path(path)

        assert parsed_id == media_id
        assert ext == "pdf"

    def test_parse_storage_path_test_prefix(self):
        """Parse test prefixed path correctly."""
        media_id = str(uuid4())
        path = f"test_runs/run-123/media/{media_id}/original.epub"

        parsed_id, ext = parse_storage_path(path)

        assert parsed_id == media_id
        assert ext == "epub"


class TestFakeStorageClient:
    """Tests for FakeStorageClient implementation."""

    @pytest.fixture
    def client(self):
        """Provide a fresh FakeStorageClient."""
        return FakeStorageClient()

    def test_sign_upload_returns_path_and_token(self, client):
        """sign_upload returns SignedUpload with path and token."""
        result = client.sign_upload(
            "media/test/original.pdf",
            content_type="application/pdf",
        )

        assert isinstance(result, SignedUpload)
        assert result.path == "media/test/original.pdf"
        assert result.token.startswith("fake-token-")

    def test_sign_download_returns_url(self, client):
        """sign_download returns fake URL."""
        url = client.sign_download("media/test/original.pdf")

        assert "fake-storage.test" in url
        assert "download" in url

    def test_head_object_missing(self, client):
        """head_object returns None for missing object."""
        result = client.head_object("missing/path.pdf")
        assert result is None

    def test_head_object_exists(self, client):
        """head_object returns metadata for existing object."""
        client.put_object("test/file.pdf", b"test content", "application/pdf")

        result = client.head_object("test/file.pdf")

        assert isinstance(result, ObjectMetadata)
        assert result.content_type == "application/pdf"
        assert result.size_bytes == len(b"test content")

    def test_stream_object_missing(self, client):
        """stream_object raises StorageError for missing object."""
        from nexus.storage.client import StorageError

        with pytest.raises(StorageError) as exc_info:
            list(client.stream_object("missing/path.pdf"))

        assert exc_info.value.code == "E_STORAGE_MISSING"

    def test_stream_object_returns_chunks(self, client):
        """stream_object yields content in chunks."""
        content = b"hello world" * 1000
        client.put_object("test/file.pdf", content, "application/pdf")

        chunks = list(client.stream_object("test/file.pdf"))

        assert b"".join(chunks) == content

    def test_delete_object(self, client):
        """delete_object removes the object."""
        client.put_object("test/file.pdf", b"content", "application/pdf")

        client.delete_object("test/file.pdf")

        assert client.head_object("test/file.pdf") is None

    def test_delete_object_missing_no_error(self, client):
        """delete_object doesn't error for missing object."""
        # Should not raise
        client.delete_object("missing/path.pdf")

    def test_clear(self, client):
        """clear removes all objects."""
        client.put_object("test/a.pdf", b"a", "application/pdf")
        client.put_object("test/b.pdf", b"b", "application/pdf")

        client.clear()

        assert client.head_object("test/a.pdf") is None
        assert client.head_object("test/b.pdf") is None


class TestComputeSha256:
    """Tests for SHA-256 computation utility."""

    def test_compute_sha256_bytes(self):
        """Compute SHA-256 from bytes."""
        # Known SHA-256 for "hello"
        expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        result = compute_sha256(b"hello")
        assert result == expected

    def test_compute_sha256_iterator(self):
        """Compute SHA-256 from iterator of bytes."""
        expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

        def chunks():
            yield b"hel"
            yield b"lo"

        result = compute_sha256(chunks())
        assert result == expected

    def test_compute_sha256_empty(self):
        """Compute SHA-256 for empty input."""
        # Known SHA-256 for empty string
        expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        result = compute_sha256(b"")
        assert result == expected
