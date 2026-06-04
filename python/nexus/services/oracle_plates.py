"""Oracle plate owned-asset service."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import NoReturn
from uuid import UUID

from sqlalchemy.orm import Session

from nexus import web_paths
from nexus.db.models import OracleCorpusImage
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import build_oracle_plate_storage_path, ext_for_content_type
from nexus.storage.read import read_object_checked

logger = get_logger(__name__)


@dataclass(frozen=True)
class OraclePlateBytes:
    data: bytes
    content_type: str
    byte_size: int
    sha256: str
    etag: str


@dataclass(frozen=True)
class OraclePlateMetadata:
    image_id: UUID
    storage_key: str
    content_type: str
    byte_size: int
    sha256: str
    etag: str


def oracle_plate_url(image_id: UUID) -> str:
    return web_paths.oracle_plate_url(image_id)


def get_oracle_plate_metadata(
    *,
    session_factory: Callable[[], Session],
    image_id: UUID,
) -> OraclePlateMetadata:
    with session_factory() as db:
        img = db.get(OracleCorpusImage, image_id)
        if img is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Oracle plate not found")
        storage_key = img.storage_key
        sha256 = img.sha256
        byte_size = img.byte_size
        content_type = img.content_type

    _validate_plate_metadata(
        image_id=image_id,
        storage_key=storage_key,
        sha256=sha256,
        byte_size=byte_size,
        content_type=content_type,
    )
    return OraclePlateMetadata(
        image_id=image_id,
        storage_key=storage_key,
        content_type=content_type,
        byte_size=byte_size,
        sha256=sha256,
        etag=f'"{sha256}"',
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
        data = read_object_checked(
            sc,
            metadata.storage_key,
            expected_sha256=metadata.sha256,
            expected_size=metadata.byte_size,
        )
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
    return OraclePlateBytes(
        data=data,
        content_type=metadata.content_type,
        byte_size=metadata.byte_size,
        sha256=metadata.sha256,
        etag=metadata.etag,
    )


def _validate_plate_metadata(
    *,
    image_id: UUID,
    storage_key: str,
    sha256: str,
    byte_size: int,
    content_type: str,
) -> None:
    try:
        expected_key = build_oracle_plate_storage_path(
            sha256,
            ext_for_content_type(content_type),
        )
    except ValueError as exc:
        _raise_invalid_plate_metadata(image_id, storage_key, str(exc))
    if storage_key != expected_key:
        _raise_invalid_plate_metadata(
            image_id,
            storage_key,
            f"storage key does not match sha256/content type: expected {expected_key}",
        )
    if byte_size <= 0:
        _raise_invalid_plate_metadata(image_id, storage_key, "byte_size must be positive")


def _raise_invalid_plate_metadata(image_id: UUID, storage_key: str, reason: str) -> NoReturn:
    logger.error(
        "oracle_plate_metadata_invalid",
        image_id=str(image_id),
        storage_key=storage_key,
        reason=reason,
    )
    raise ApiError(ApiErrorCode.E_INTERNAL, "Oracle plate metadata is invalid")
