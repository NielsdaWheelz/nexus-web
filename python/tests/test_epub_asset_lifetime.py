"""Focused tests for EPUB asset DB/storage lifetime ordering."""

from uuid import uuid4

import pytest

from nexus.services import epub_assets
from tests.support.storage import FakeStorageClient

pytestmark = pytest.mark.unit


class FakeDbSession:
    def __init__(self):
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True
        return False


def test_epub_asset_storage_read_happens_after_short_db_phase(monkeypatch):
    fake_db = FakeDbSession()
    asset_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    storage_path = "media/test-media/assets/images/fig1.png"
    metadata_calls: list[str] = []
    storage_saw_db_closed: list[bool] = []

    def load_metadata(*, db, viewer_id, media_id, asset_key):
        assert db is fake_db
        assert fake_db.closed is False
        metadata_calls.append(asset_key)
        return epub_assets._EpubAssetMetadata(
            storage_path=storage_path,
            content_type="image/png",
            size_bytes=len(asset_content),
        )

    class AssertingStorageClient(FakeStorageClient):
        def stream_object(self, path):
            storage_saw_db_closed.append(fake_db.closed)
            yield from super().stream_object(path)

    storage = AssertingStorageClient()
    storage.put_object(storage_path, asset_content, "image/png")
    monkeypatch.setattr(epub_assets, "_get_epub_asset_metadata_for_viewer", load_metadata)

    result = epub_assets.get_epub_asset_for_viewer(
        session_factory=lambda: fake_db,
        viewer_id=uuid4(),
        media_id=uuid4(),
        asset_key="images/fig1.png",
        storage_client=storage,
    )

    assert result.data == asset_content
    assert result.content_type == "image/png"
    assert metadata_calls == ["images/fig1.png"]
    assert storage_saw_db_closed == [True]
