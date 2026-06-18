"""Tests for the Oracle plate service + public route.

The service tests (``@pytest.mark.unit``) are hermetic: the session factory and
storage client are local fakes, so the pure service logic is exercised without a
database or storage backend.

The route tests (``@pytest.mark.integration``) use a real test PostgreSQL
database (the plate row is read through ``get_session_factory()`` on its own
connection, so the data must be committed via ``direct_db``) and the sanctioned
external storage seam ``tests.support.storage.FakeStorageClient`` patched in at
``nexus.services.oracle_plates.get_storage_client``.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import OraclePlate
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.oracle_plates import (
    ensure_oracle_plate_asset,
    get_oracle_plate_bytes,
    oracle_plate_url,
    prune_oracle_plates_except_source_urls,
    validate_oracle_plate_storage_objects,
)
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
    byte_size: int
    content_type: str
    width: int = 800
    height: int = 1200


# ---------------------------------------------------------------------------
# Service tests (pure logic, local fakes only — no DB / no storage)
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_get_oracle_plate_bytes_returns_data_and_etag():
    data = b"\xff\xd8\xff" + b"plate"
    image_id = uuid4()
    image = _FakeImage(
        storage_key="oracle/plates/test-plate.jpg",
        byte_size=len(data),
        content_type="image/jpeg",
    )

    result = get_oracle_plate_bytes(
        session_factory=_session_factory_for(image),
        image_id=image_id,
        storage_client=_FakeStorage(data),
    )

    assert result.data == data
    assert result.content_type == "image/jpeg"
    assert result.byte_size == len(data)
    assert result.etag == f'"oracle-plate-{image_id}"'


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
    image = _FakeImage(
        storage_key="oracle/plates/test-plate.jpg",
        byte_size=len(data),
        content_type="image/jpeg",
    )

    # Storage yields different bytes than the persisted byte-size claim.
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
    image = SimpleNamespace(
        storage_key="oracle/plates/test-plate.jpg",
        byte_size=len(data),
        content_type="image/jpeg",
        width=800,
        height=1200,
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
def test_get_oracle_plate_bytes_rejects_invalid_storage_key_before_read():
    data = b"\xff\xd8\xff" + b"plate"
    image = SimpleNamespace(
        storage_key="media/plates/not-the-digest.jpg",
        byte_size=len(data),
        content_type="image/jpeg",
        width=800,
        height=1200,
    )
    events: list[str] = []

    with pytest.raises(ApiError) as exc_info:
        get_oracle_plate_bytes(
            session_factory=_session_factory_for(image, events=events),
            image_id=uuid4(),
            storage_client=_FakeStorage(data, events=events),
        )

    assert exc_info.value.code == ApiErrorCode.E_INTERNAL
    assert events == ["session_exit"]


@pytest.mark.unit
def test_oracle_plate_url_shape():
    some_uuid = uuid4()
    assert oracle_plate_url(some_uuid) == f"/api/oracle/plates/{some_uuid}"


# ---------------------------------------------------------------------------
# Route tests (real test DB + FakeStorageClient external storage seam)
# ---------------------------------------------------------------------------


def _seed_oracle_plate(
    db: Session,
    *,
    data: bytes,
    content_type: str = "image/jpeg",
) -> tuple[UUID, str]:
    """Commit one current OraclePlate row."""
    storage_key = f"oracle/plates/test-plate-{uuid4().hex[:12]}.jpg"
    image = OraclePlate(
        id=uuid4(),
        source_repository="test",
        source_url=f"https://example.com/oracle-plate-{uuid4()}.jpg",
        artist="Test Engraver",
        work_title="The Test Plate",
        year="1860",
        attribution_text="Test Engraver, The Test Plate, test collection.",
        width=800,
        height=1200,
        storage_key=storage_key,
        content_type=content_type,
        byte_size=len(data),
        tags=["forest", "lamp"],
    )
    db.add(image)
    db.flush()
    image_id = image.id
    db.commit()
    return image_id, storage_key


def _register_plate_cleanup(direct_db: DirectSessionManager, image_id: UUID) -> None:
    direct_db.register_cleanup("oracle_plates", "id", image_id)


@pytest.mark.integration
def test_validate_oracle_plate_storage_objects_checks_object_metadata(
    direct_db: DirectSessionManager,
):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    content_type = "image/jpeg"
    with direct_db.session() as session:
        image_id, storage_key = _seed_oracle_plate(session, data=data, content_type=content_type)
    _register_plate_cleanup(direct_db, image_id)

    fake = FakeStorageClient()
    with direct_db.session() as session:
        missing = validate_oracle_plate_storage_objects(session, storage_client=fake)

    assert missing.total >= 1
    assert not missing.ready
    assert any(str(image_id) in reason and "missing object" in reason for reason in missing.invalid)

    fake.put_object(storage_key, data, content_type)
    with direct_db.session() as session:
        after_put = validate_oracle_plate_storage_objects(session, storage_client=fake)

    assert after_put.valid == missing.valid + 1
    assert not any(str(image_id) in reason for reason in after_put.invalid)


@pytest.mark.integration
def test_ensure_oracle_plate_asset_overwrites_mismatched_object(
    direct_db: DirectSessionManager,
):
    old_data = b"\xff\xd8\xff" + b"old"
    new_data = b"\xff\xd8\xff" + b"new image bytes"
    with direct_db.session() as session:
        image_id, storage_key = _seed_oracle_plate(session, data=old_data)
        source_url = session.get(OraclePlate, image_id).source_url
    _register_plate_cleanup(direct_db, image_id)

    fake = FakeStorageClient()
    fake.put_object(storage_key, old_data, "image/jpeg")

    with direct_db.session() as session:
        result = ensure_oracle_plate_asset(
            session,
            storage_client=fake,
            source_repository="test",
            source_page_url="https://example.com/page",
            source_url=source_url,
            license_text="public domain",
            artist="Test Engraver",
            work_title="The Test Plate",
            year="1860",
            attribution_text="Test Engraver, The Test Plate, test collection.",
            width=800,
            height=1200,
            storage_key=storage_key,
            content_type="image/jpeg",
            data=new_data,
            tags=["forest"],
        )
        session.commit()

    assert result.object_written is True
    assert fake.get_object(storage_key) == new_data
    with direct_db.session() as session:
        row = session.get(OraclePlate, image_id)
        assert row is not None
        assert row.byte_size == len(new_data)


@pytest.mark.integration
def test_prune_oracle_plates_except_source_urls_deletes_only_stale_unreferenced_rows(
    direct_db: DirectSessionManager,
):
    with direct_db.session() as session:
        keep_id, _ = _seed_oracle_plate(session, data=b"\xff\xd8\xffkeep")
        stale_id, _ = _seed_oracle_plate(session, data=b"\xff\xd8\xffstale")
        keep_source_url = session.get(OraclePlate, keep_id).source_url
        stale_source_url = session.get(OraclePlate, stale_id).source_url
        existing_urls = set(session.execute(select(OraclePlate.source_url)).scalars())
    _register_plate_cleanup(direct_db, keep_id)
    _register_plate_cleanup(direct_db, stale_id)

    with direct_db.session() as session:
        deleted = prune_oracle_plates_except_source_urls(
            session,
            source_urls=(existing_urls - {stale_source_url}) | {keep_source_url},
        )
        session.commit()

    assert deleted == 1
    with direct_db.session() as session:
        assert session.get(OraclePlate, keep_id) is not None
        assert session.get(OraclePlate, stale_id) is None


@pytest.mark.integration
def test_prune_oracle_plates_except_source_urls_fails_for_referenced_stale_rows(
    direct_db: DirectSessionManager,
):
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        image_id, _ = _seed_oracle_plate(session, data=b"\xff\xd8\xffreferenced")
        source_url = session.get(OraclePlate, image_id).source_url
        existing_urls = set(session.execute(select(OraclePlate.source_url)).scalars())
        session.execute(
            text(
                """
                INSERT INTO oracle_readings (
                    user_id, folio_number, question_text, status, image_id, completed_at
                )
                VALUES (:user_id, 1, 'Will this prune?', 'complete', :image_id, now())
                """
            ),
            {"user_id": user_id, "image_id": image_id},
        )
        session.commit()
    direct_db.register_cleanup("users", "id", user_id)
    _register_plate_cleanup(direct_db, image_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)

    with direct_db.session() as session:
        with pytest.raises(ApiError, match="readings still reference"):
            prune_oracle_plates_except_source_urls(
                session,
                source_urls=existing_urls - {source_url},
            )


@pytest.mark.integration
def test_route_returns_image_with_immutable_cache_and_etag(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    content_type = "image/jpeg"

    with direct_db.session() as session:
        image_id, storage_key = _seed_oracle_plate(session, data=data, content_type=content_type)
    _register_plate_cleanup(direct_db, image_id)

    fake = FakeStorageClient()
    fake.put_object(storage_key, data, content_type)

    # STORAGE SEAM EXCEPTION: External storage boundary mock.
    # Object storage is an external dependency; FakeStorageClient isolates tests
    # from the real storage service per testing standards Section 6 (Allowed Mocks).
    # The service binds get_storage_client into its own namespace, so the seam is
    # patched at nexus.services.oracle_plates.get_storage_client.
    # Replacement: Real storage integration in E2E tests.
    with patch("nexus.services.oracle_plates.get_storage_client", return_value=fake):
        resp = client.get(f"/oracle/plates/{image_id}")

    assert resp.status_code == 200, resp.text
    assert resp.content == data
    assert resp.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert resp.headers["ETag"] == f'"oracle-plate-{image_id}"'
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers["content-type"].startswith(content_type)
    assert resp.headers.get("content-length") == str(len(data))


@pytest.mark.integration
def test_route_conditional_get_returns_304(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    content_type = "image/jpeg"

    with direct_db.session() as session:
        image_id, _storage_key = _seed_oracle_plate(session, data=data, content_type=content_type)
    _register_plate_cleanup(direct_db, image_id)

    with patch(
        "nexus.services.oracle_plates.get_storage_client",
        side_effect=AssertionError("conditional GET must not read storage"),
    ):
        resp = client.get(
            f"/oracle/plates/{image_id}",
            headers={"If-None-Match": f'"oracle-plate-{image_id}"'},
        )

    assert resp.status_code == 304, resp.text
    assert resp.content == b""
    assert resp.headers["ETag"] == f'"oracle-plate-{image_id}"'


@pytest.mark.integration
def test_route_integrity_mismatch_returns_5xx(client, direct_db: DirectSessionManager):
    data = b"\xff\xd8\xff" + b"\x00" * 64
    content_type = "image/jpeg"

    with direct_db.session() as session:
        image_id, storage_key = _seed_oracle_plate(session, data=data, content_type=content_type)
    _register_plate_cleanup(direct_db, image_id)

    # Current plate integrity is byte-size based; no content hash is persisted.
    tampered = b"\x00\x11\x22"
    assert len(tampered) != len(data)
    fake = FakeStorageClient()
    fake.put_object(storage_key, tampered, content_type)

    # STORAGE SEAM EXCEPTION: External storage boundary mock (see above).
    with patch("nexus.services.oracle_plates.get_storage_client", return_value=fake):
        resp = client.get(f"/oracle/plates/{image_id}")

    # ERROR_CODE_TO_STATUS maps ApiErrorCode.E_STORAGE_ERROR to 500.
    assert resp.status_code == 500, resp.text
    assert resp.json()["error"]["code"] == ApiErrorCode.E_STORAGE_ERROR.value
