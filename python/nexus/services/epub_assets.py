"""Private EPUB asset access."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.read import read_object_checked

_ASSET_KEY_RE = re.compile(r"^[a-zA-Z0-9_./-]+$")
_EPUB_ASSET_CONTENT_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/svg+xml",
        "image/webp",
    }
)


@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str


@dataclass(frozen=True)
class _EpubAssetMetadata:
    storage_path: str
    content_type: str
    size_bytes: int
    sha256: str


def get_epub_asset_for_viewer(
    *,
    session_factory: Callable[[], Session],
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage_client: StorageClientBase | None = None,
) -> EpubAssetOut:
    """Fetch an EPUB internal asset for an authorized viewer."""
    with session_factory() as db:
        asset_metadata = _get_epub_asset_metadata_for_viewer(
            db=db,
            viewer_id=viewer_id,
            media_id=media_id,
            asset_key=asset_key,
        )

    try:
        data = read_object_checked(
            storage_client or get_storage_client(),
            asset_metadata.storage_path,
            expected_sha256=asset_metadata.sha256,
            expected_size=asset_metadata.size_bytes,
        )
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Stored EPUB asset object is missing or unreadable",
        ) from exc

    return EpubAssetOut(data=data, content_type=asset_metadata.content_type)


def _get_epub_asset_metadata_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
) -> _EpubAssetMetadata:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != MediaKind.epub.value:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media")

    if media.processing_status not in {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
    }:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    if not asset_key or not _ASSET_KEY_RE.match(asset_key):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")

    row = (
        db.execute(
            text(
                """
                SELECT storage_path, content_type, size_bytes, sha256
                FROM epub_resources
                WHERE media_id = :media_id
                  AND asset_key = :asset_key
                """
            ),
            {"media_id": media_id, "asset_key": asset_key},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "EPUB asset not found")

    content_type = str(row["content_type"])
    if content_type not in _EPUB_ASSET_CONTENT_TYPES:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "EPUB asset not found")

    return _EpubAssetMetadata(
        storage_path=str(row["storage_path"]),
        content_type=content_type,
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
    )
