"""Private EPUB asset access."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, MediaKind
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.capabilities import is_document_status_ready
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
    cache_control: str
    content_security_policy: str | None


@dataclass(frozen=True)
class _EpubAssetMetadata:
    storage_path: str
    content_type: str
    size_bytes: int


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
            expected_size=asset_metadata.size_bytes,
        )
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Stored EPUB asset object is missing or unreadable",
        ) from exc

    # SVG can carry script; lock served EPUB SVG assets down at the response level.
    content_security_policy = (
        "default-src 'none'; img-src 'self' data:; script-src 'none'; "
        "object-src 'none'; base-uri 'none'"
        if asset_metadata.content_type == "image/svg+xml"
        else None
    )
    return EpubAssetOut(
        data=data,
        content_type=asset_metadata.content_type,
        cache_control="private, max-age=86400",
        content_security_policy=content_security_policy,
    )


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

    if not is_document_status_ready(media.processing_status):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    if not asset_key or not _ASSET_KEY_RE.match(asset_key):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")

    row = (
        db.execute(
            text(
                """
                SELECT storage_path, content_type, size_bytes
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
    )
