"""Tests for the Oracle plate service + public route.

The service tests (``@pytest.mark.unit``) are hermetic: the session factory and
storage client are local fakes, so the pure service logic is exercised without a
database or storage backend.

The route tests (``@pytest.mark.integration``) use a real test PostgreSQL
database (the plate row is read through ``get_session_factory()`` on its own
connection, so the data must be committed via ``direct_db``) and the sanctioned
external storage seam ``tests.support.storage.FakeStorageClient`` patched in at
``nexus.services.oracle.get_storage_client``.
"""

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import OracleCorpusImage, OracleCorpusSetVersion
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.oracle import (
    get_oracle_plate_bytes,
    oracle_plate_path,
)
from nexus.services.semantic_chunks import current_transcript_embedding_model
from tests.support.storage import FakeStorageClient
from tests.utils.db import DirectSessionManager

# ---------------------------------------------------------------------------
# Local fakes (no real DB / no real storage) — for the unit service tests
# ---------------------------------------------------------------------------


class _FakeSession:
    """Context-manager session whose ``get`` returns a preset image stub."""

    def __init__(self, image, *, events: list[str] | None = None):
        self._image = image
        self._events = events

    def __enter__(self) -> "_FakeSession":
        return self

    def __exit__(self, *_exc) -> bool:
        if self._events is not None:
            self._events.append("session_exit")
        return False

    def get(self, _model, _image_id):
        return self._image


def _session_factory_for(image, *, events: list[str] | None = None):
    return lambda: _FakeSession(image, events=events)


class _FakeStorage:
    """Storage stub that yields fixed bytes from ``stream_object``."""

    def __init__(self, payload: bytes, *, events: list[str] | None = None):
        self._payload = payload
        self._events = events

    def stream_object(self, _path: str) -> Iterator[bytes]:
        if self._events is not None:
            self._events.append("stream_object")
        yield self._payload


@dataclass
class _FakeImage:
    storage_key: str
    sha256: str
    byte_size: int
    content_type: str


# ---------------------------------------------------------------------------
# Service tests (pure logic, local fakes only — no DB / no storage)
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_get_oracle_plate_bytes_returns_data_and_etag():
    data = b"\xff\xd8\xff" + b"plate"
    sha = hashlib.sha256(data).hexdigest()
    image = _FakeImage(
        storage_key="oracle/plates/" + sha + ".jpg",
        sha256=sha,
        byte_size=len(data),
        content_type="image/jpeg",
    )

    result = get_oracle_plate_bytes(
        session_factory=_session_factory_for(image),
        image_id=uuid4(),
        storage_client=_FakeStorage(data),
    )

    assert result.data == data
    assert result.content_type == "image/jpeg"
    assert result.etag == f'"{sha}"'


@pytest.mark.unit
def test_get_oracle_plate_bytes_unknown_id_raises_not_found():
    with pytest.raises(NotFoundError) as exc_info:
        get_oracle_plate_bytes(
            session_factory=_session_factory_for(None),
            image_id=uuid4(),
            storage_client=_FakeStorage(b"unused"),
        )

    assert exc_info.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND


@pytest.mark.unit
def test_get_oracle_plate_bytes_integrity_mismatch_raises_storage_error():
    data = b"\xff\xd8\xff" + b"plate"
    sha = hashlib.sha256(data).hexdigest()
    image = _FakeImage(
        storage_key="oracle/plates/" + sha + ".jpg",
        sha256=sha,
        byte_size=len(data),
        content_type="image/jpeg",
    )

    # Storage yields different bytes than the persisted sha256/byte_size claims.
    with pytest.raises(ApiError) as exc_info:
        get_oracle_plate_bytes(
            session_factory=_session_factory_for(image),
            image_id=uuid4(),
            storage_client=_FakeStorage(b"tampered-bytes"),
        )

    assert exc_info.value.code == ApiErrorCode.E_STORAGE_ERROR


@pytest.mark.unit
def test_get_oracle_plate_bytes_releases_session_before_read():
    data = b"\xff\xd8\xff" + b"plate"
    sha = hashlib.sha256(data).hexdigest()
    image = SimpleNamespace(
        storage_key="oracle/plates/" + sha + ".jpg",
        sha256=sha,
        byte_size=len(data),
        content_type="image/jpeg",
    )
    events: list[str] = []

    get_oracle_plate_bytes(
        session_factory=_session_factory_for(image, events=events),
        image_id=uuid4(),
        storage_client=_FakeStorage(data, events=events),
    )

    # The DB session must be released before the storage read begins so the
    # connection pool is not held during streaming (mirrors the EPUB asset
    # regression in test_media.py).
    assert events == ["session_exit", "stream_object"]


@pytest.mark.unit
def test_oracle_plate_path_shape():
    some_uuid = uuid4()
    assert oracle_plate_path(some_uuid) == f"/api/oracle/plates/{some_uuid}"


# ---------------------------------------------------------------------------
# Route tests (real test DB + FakeStorageClient external storage seam)
# ---------------------------------------------------------------------------


def _seed_oracle_plate(
    db: Session,
    *,
    data: bytes,
    sha256: str,
    content_type: str = "image/jpeg",
) -> tuple[UUID, UUID, str]:
    """Commit one corpus version + one OracleCorpusImage row.

    Returns ``(corpus_set_version_id, image_id, storage_key)``. The image's
    storage metadata (storage_key/content_type/byte_size/sha256) is consistent
    with the bytes the caller will place in the fake storage client.
    """
    version = OracleCorpusSetVersion(
        id=uuid4(),
        version=f"oracle-plate-route-{uuid4()}",
        label="Oracle plate route test corpus",
        embedding_model=current_transcript_embedding_model(),
    )
    db.add(version)
    db.flush()

    storage_key = f"oracle/plates/{sha256}.jpg"
    image = OracleCorpusImage(
        id=uuid4(),
        corpus_set_version_id=version.id,
        source_repository="test",
        source_url=f"https://example.com/oracle-plate-{uuid4()}.jpg",
        artist="Test Engraver",
        work_title="The Test Plate",
        year="1860",
        attribution_text="Test Engraver, The Test Plate, test collection.",
        width=800,
        height=1200,
        sha256=sha256,
        storage_key=storage_key,
        content_type=content_type,
        byte_size=len(data),
        tags=["forest", "lamp"],
    )
    db.add(image)
    db.flush()
    image_id = image.id
    version_id = version.id
    db.commit()
    return version_id, image_id, storage_key


def _register_plate_cleanup(direct_db: DirectSessionManager, version_id: UUID) -> None:
    # LIFO cleanup: register the parent version first so it is deleted LAST,
    # after its child image rows (FK: oracle_corpus_images -> versions).
    direct_db.register_cleanup("oracle_corpus_set_versions", "id", version_id)
    direct_db.register_cleanup("oracle_corpus_images", "corpus_set_version_id", version_id)


@pytest.mark.integration
def test_route_returns_image_with_immutable_cache_and_etag(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    sha256 = hashlib.sha256(data).hexdigest()
    content_type = "image/jpeg"

    with direct_db.session() as session:
        version_id, image_id, storage_key = _seed_oracle_plate(
            session, data=data, sha256=sha256, content_type=content_type
        )
    _register_plate_cleanup(direct_db, version_id)

    fake = FakeStorageClient()
    fake.put_object(storage_key, data, content_type)

    # STORAGE SEAM EXCEPTION: External storage boundary mock.
    # Object storage is an external dependency; FakeStorageClient isolates tests
    # from the real storage service per testing standards Section 6 (Allowed Mocks).
    # The service binds get_storage_client into its own namespace, so the seam is
    # patched at nexus.services.oracle.get_storage_client.
    # Replacement: Real storage integration in E2E tests.
    with patch("nexus.services.oracle.get_storage_client", return_value=fake):
        resp = client.get(f"/oracle/plates/{image_id}")

    assert resp.status_code == 200, resp.text
    assert resp.content == data
    assert resp.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert resp.headers["ETag"] == f'"{sha256}"'
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers["content-type"].startswith(content_type)
    assert resp.headers.get("content-length") == str(len(data))


@pytest.mark.integration
def test_route_conditional_get_returns_304(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    sha256 = hashlib.sha256(data).hexdigest()
    content_type = "image/jpeg"

    with direct_db.session() as session:
        version_id, image_id, storage_key = _seed_oracle_plate(
            session, data=data, sha256=sha256, content_type=content_type
        )
    _register_plate_cleanup(direct_db, version_id)

    fake = FakeStorageClient()
    fake.put_object(storage_key, data, content_type)

    # STORAGE SEAM EXCEPTION: External storage boundary mock (see above).
    with patch("nexus.services.oracle.get_storage_client", return_value=fake):
        resp = client.get(
            f"/oracle/plates/{image_id}",
            headers={"If-None-Match": f'"{sha256}"'},
        )

    assert resp.status_code == 304, resp.text
    assert resp.content == b""
    assert resp.headers["ETag"] == f'"{sha256}"'


@pytest.mark.integration
def test_route_integrity_mismatch_returns_5xx(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    sha256 = hashlib.sha256(data).hexdigest()
    content_type = "image/jpeg"

    with direct_db.session() as session:
        version_id, image_id, storage_key = _seed_oracle_plate(
            session, data=data, sha256=sha256, content_type=content_type
        )
    _register_plate_cleanup(direct_db, version_id)

    # Different bytes of the SAME length under the same storage_key, so
    # read_object_checked's sha256-mismatch branch fires (not the size ceiling).
    tampered = b"\x00\x11\x22" + b"\xff" * 64
    assert len(tampered) == len(data)
    fake = FakeStorageClient()
    fake.put_object(storage_key, tampered, content_type)

    # STORAGE SEAM EXCEPTION: External storage boundary mock (see above).
    with patch("nexus.services.oracle.get_storage_client", return_value=fake):
        resp = client.get(f"/oracle/plates/{image_id}")

    # ERROR_CODE_TO_STATUS maps ApiErrorCode.E_STORAGE_ERROR to 500.
    assert resp.status_code == 500, resp.text
    assert resp.json()["error"]["code"] == ApiErrorCode.E_STORAGE_ERROR.value
