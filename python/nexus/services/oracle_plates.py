"""Oracle plate owned-asset service."""

from __future__ import annotations

from collections.abc import Callable, Collection
from dataclasses import dataclass
from typing import NoReturn
from uuid import UUID

from sqlalchemy.orm import Session

from nexus import web_paths
from nexus.db.models import OraclePlate
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import ext_for_content_type

logger = get_logger(__name__)


@dataclass(frozen=True)
class OraclePlateBytes:
    data: bytes
    content_type: str
    byte_size: int
    etag: str


@dataclass(frozen=True)
class OraclePlateMetadata:
    image_id: UUID
    storage_key: str
    content_type: str
    byte_size: int
    width: int
    height: int
    etag: str


@dataclass(frozen=True)
class OraclePlateStorageReadiness:
    total: int
    valid: int
    invalid: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return self.total > 0 and self.valid == self.total


def ensure_oracle_plate_storage_object(
    *,
    storage_client: StorageClientBase,
    storage_key: str,
    content_type: str,
    data: bytes,
    width: int,
    height: int,
) -> bool:
    """Make one owned R2 object exact without opening a database transaction."""
    normalized_content_type = _normalize_content_type(content_type)
    _validate_plate_metadata(
        image_id=UUID(int=0),
        storage_key=storage_key,
        byte_size=len(data),
        content_type=normalized_content_type,
        width=width,
        height=height,
    )
    return _ensure_plate_object(
        storage_client,
        storage_key=storage_key,
        data=data,
        content_type=normalized_content_type,
    )


def upsert_oracle_plate(
    db: Session,
    *,
    source_repository: str,
    source_page_url: str | None,
    source_url: str,
    license_text: str,
    artist: str,
    work_title: str,
    year: str | None,
    attribution_text: str,
    width: int,
    height: int,
    storage_key: str,
    content_type: str,
    byte_size: int,
    tags: list[str],
) -> OraclePlate:
    """Create or update one owned Oracle plate row by stable source URL."""
    existing = db.query(OraclePlate).filter(OraclePlate.source_url == source_url).one_or_none()
    plate = existing or OraclePlate(source_url=source_url)
    _validate_plate_metadata(
        image_id=plate.id,
        storage_key=storage_key,
        byte_size=byte_size,
        content_type=content_type,
        width=width,
        height=height,
    )
    plate.source_repository = source_repository
    plate.source_page_url = source_page_url
    plate.license_text = license_text
    plate.artist = artist
    plate.work_title = work_title
    plate.year = year
    plate.attribution_text = attribution_text
    plate.width = width
    plate.height = height
    plate.storage_key = storage_key
    plate.content_type = content_type
    plate.byte_size = byte_size
    plate.tags = tags
    if existing is None:
        db.add(plate)
    db.flush()
    return plate


def oracle_plate_url(image_id: UUID) -> str:
    return web_paths.oracle_plate_url(image_id)


def get_oracle_plate_metadata(
    *,
    session_factory: Callable[[], Session],
    image_id: UUID,
) -> OraclePlateMetadata:
    with session_factory() as db:
        img = db.get(OraclePlate, image_id)
        if img is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Oracle plate not found")
        storage_key = img.storage_key
        byte_size = img.byte_size
        content_type = img.content_type
        width = img.width
        height = img.height

    _validate_plate_metadata(
        image_id=image_id,
        storage_key=storage_key,
        byte_size=byte_size,
        content_type=content_type,
        width=width,
        height=height,
    )
    return OraclePlateMetadata(
        image_id=image_id,
        storage_key=storage_key,
        content_type=content_type,
        byte_size=byte_size,
        width=width,
        height=height,
        etag=f'"oracle-plate-{image_id}"',
    )


def get_oracle_plate_bytes(
    *,
    session_factory: Callable[[], Session],
    image_id: UUID,
    storage_client: StorageClientBase | None = None,
) -> OraclePlateBytes:
    metadata = get_oracle_plate_metadata(
        session_factory=session_factory,
        image_id=image_id,
    )
    return read_oracle_plate_bytes(metadata, storage_client=storage_client)


def read_oracle_plate_bytes(
    metadata: OraclePlateMetadata,
    *,
    storage_client: StorageClientBase | None = None,
) -> OraclePlateBytes:
    sc = storage_client or get_storage_client()
    try:
        data = b"".join(sc.stream_object(metadata.storage_key))
    except StorageError as exc:
        logger.error(
            "oracle_plate_storage_read_failed",
            image_id=str(metadata.image_id),
            storage_key=metadata.storage_key,
            error=str(exc),
        )
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Oracle plate object is missing or unreadable"
        ) from exc
    if len(data) != metadata.byte_size:
        logger.error(
            "oracle_plate_storage_size_mismatch",
            image_id=str(metadata.image_id),
            storage_key=metadata.storage_key,
            expected_size=metadata.byte_size,
            actual_size=len(data),
        )
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Oracle plate object is invalid")
    return OraclePlateBytes(
        data=data,
        content_type=metadata.content_type,
        byte_size=metadata.byte_size,
        etag=metadata.etag,
    )


def oracle_plate_storage_metadata(db: Session) -> tuple[OraclePlateMetadata, ...]:
    """Read the plate object contract without touching external storage."""
    rows = db.query(OraclePlate).order_by(OraclePlate.created_at.asc(), OraclePlate.id.asc()).all()
    return tuple(
        OraclePlateMetadata(
            image_id=row.id,
            storage_key=row.storage_key,
            content_type=row.content_type,
            byte_size=row.byte_size,
            width=row.width,
            height=row.height,
            etag=f'"oracle-plate-{row.id}"',
        )
        for row in rows
    )


def validate_oracle_plate_storage_metadata(
    rows: Collection[OraclePlateMetadata],
    *,
    storage_client: StorageClientBase | None = None,
) -> OraclePlateStorageReadiness:
    """Validate a closed DB metadata snapshot after its transaction has ended."""
    sc = storage_client or get_storage_client()
    invalid: list[str] = []
    valid = 0
    for row in rows:
        invalid_reason = _oracle_plate_storage_invalid_reason(row, sc)
        if invalid_reason is not None:
            invalid.append(f"{row.image_id}: {invalid_reason}")
            continue
        valid += 1
    return OraclePlateStorageReadiness(total=len(rows), valid=valid, invalid=tuple(invalid))


def _oracle_plate_storage_invalid_reason(
    row: OraclePlate | OraclePlateMetadata,
    storage_client: StorageClientBase,
) -> str | None:
    try:
        _validate_plate_metadata(
            image_id=_plate_image_id(row),
            storage_key=row.storage_key,
            byte_size=row.byte_size,
            content_type=row.content_type,
            width=row.width,
            height=row.height,
        )
        object_metadata = storage_client.head_object(row.storage_key)
    except (ApiError, StorageError) as exc:
        return str(exc)
    if object_metadata is None:
        return f"missing object {row.storage_key}"
    if object_metadata.size_bytes != row.byte_size:
        return (
            f"size mismatch for {row.storage_key} ({object_metadata.size_bytes} != {row.byte_size})"
        )
    object_content_type = _normalize_content_type(object_metadata.content_type)
    if object_content_type != row.content_type:
        return (
            f"content-type mismatch for {row.storage_key} "
            f"({object_content_type} != {row.content_type})"
        )
    return None


def _plate_image_id(row: OraclePlate | OraclePlateMetadata) -> UUID:
    if isinstance(row, OraclePlateMetadata):
        return row.image_id
    return row.id


def _ensure_plate_object(
    storage_client: StorageClientBase,
    *,
    storage_key: str,
    data: bytes,
    content_type: str,
) -> bool:
    object_metadata = storage_client.head_object(storage_key)
    if object_metadata is not None:
        object_content_type = _normalize_content_type(object_metadata.content_type)
        if object_metadata.size_bytes == len(data) and object_content_type == content_type:
            return False
    storage_client.put_object(storage_key, data, content_type)
    return True


def _normalize_content_type(content_type: str) -> str:
    return content_type.lower().split(";", 1)[0].strip()


def _validate_plate_metadata(
    *,
    image_id: UUID,
    storage_key: str,
    byte_size: int,
    content_type: str,
    width: int,
    height: int,
) -> None:
    from nexus.services.image_validation import MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION

    try:
        expected_ext = ext_for_content_type(content_type)
    except ValueError as exc:
        _raise_invalid_plate_metadata(image_id, storage_key, str(exc))
    if not storage_key.startswith("oracle/plates/"):
        _raise_invalid_plate_metadata(
            image_id,
            storage_key,
            "storage key must live under oracle/plates/",
        )
    if any(part in {"", ".", ".."} for part in storage_key.split("/")):
        _raise_invalid_plate_metadata(
            image_id,
            storage_key,
            "storage key must not contain empty, dot, or dot-dot path parts",
        )
    if not storage_key.endswith(f".{expected_ext}"):
        _raise_invalid_plate_metadata(
            image_id,
            storage_key,
            f"storage key extension must match content type: .{expected_ext}",
        )
    if byte_size <= 0:
        _raise_invalid_plate_metadata(image_id, storage_key, "byte_size must be positive")
    if byte_size > MAX_IMAGE_BYTES:
        _raise_invalid_plate_metadata(image_id, storage_key, "byte_size exceeds image limit")
    if width <= 0 or height <= 0:
        _raise_invalid_plate_metadata(image_id, storage_key, "dimensions must be positive")
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        _raise_invalid_plate_metadata(image_id, storage_key, "dimensions exceed image limit")


def _raise_invalid_plate_metadata(image_id: UUID, storage_key: str, reason: str) -> NoReturn:
    logger.error(
        "oracle_plate_metadata_invalid",
        image_id=str(image_id),
        storage_key=storage_key,
        reason=reason,
    )
    raise ApiError(ApiErrorCode.E_INTERNAL, "Oracle plate metadata is invalid")
