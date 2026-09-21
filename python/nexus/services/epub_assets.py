"""Private EPUB asset access, and the public subset of the stored image types."""

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
from nexus.services.epub_ingest import SUPPORTED_IMAGE_TYPES
from nexus.storage.client import (
    StorageClient,
    StorageError,
    get_storage_client,
    read_object_checked,
)

_ASSET_KEY_RE = re.compile(r"^[a-zA-Z0-9_./-]+$")
_SVG_CONTENT_TYPE = "image/svg+xml"
# Anonymous shares expose every stored image type but SVG, which can carry script.
_PUBLIC_CONTENT_TYPES = SUPPORTED_IMAGE_TYPES - {_SVG_CONTENT_TYPE}


@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str
    cache_control: str
    content_security_policy: str | None


@dataclass(frozen=True, slots=True)
class EpubAssetSource:
    """Private source facts for one public-allowlisted EPUB image."""

    ordinal: int
    asset_key: str
    storage_path: str
    content_type: str
    size_bytes: int


def list_public_epub_asset_sources(db: Session, *, media_id: UUID) -> list[EpubAssetSource]:
    """Load deterministically ordered image facts without authorizing access."""
    rows = (
        db.execute(
            text("""
                SELECT asset_key, storage_path, content_type, size_bytes
                FROM epub_resources
                WHERE media_id = :media_id AND content_type = ANY(:content_types)
                ORDER BY package_href ASC, asset_key ASC
            """),
            {"media_id": media_id, "content_types": sorted(_PUBLIC_CONTENT_TYPES)},
        )
        .mappings()
        .all()
    )
    return [
        EpubAssetSource(
            ordinal=ordinal,
            asset_key=str(row["asset_key"]),
            storage_path=str(row["storage_path"]),
            content_type=str(row["content_type"]),
            size_bytes=int(row["size_bytes"]),
        )
        for ordinal, row in enumerate(rows)
    ]


def get_epub_asset_for_viewer(
    *,
    session_factory: Callable[[], Session],
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage_client: StorageClient | None = None,
) -> EpubAssetOut:
    """Authorize, resolve metadata, release the session, then read the exact bytes."""
    with session_factory() as db:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.kind != MediaKind.epub.value:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media"
            )
        if not is_document_status_ready(media.processing_status):
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
        if not asset_key or not _ASSET_KEY_RE.match(asset_key):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")
        if any(part in {"", ".", ".."} for part in asset_key.split("/")):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")
        row = (
            db.execute(
                text("""
                    SELECT storage_path, content_type, size_bytes
                    FROM epub_resources
                    WHERE media_id = :media_id AND asset_key = :asset_key
                """),
                {"media_id": media_id, "asset_key": asset_key},
            )
            .mappings()
            .fetchone()
        )
        if row is None or str(row["content_type"]) not in SUPPORTED_IMAGE_TYPES:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "EPUB asset not found")
        storage_path = str(row["storage_path"])
        content_type = str(row["content_type"])
        size_bytes = int(row["size_bytes"])

    try:
        data = read_object_checked(
            storage_client or get_storage_client(), storage_path, expected_size=size_bytes
        )
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Stored EPUB asset object is missing or unreadable"
        ) from exc

    return EpubAssetOut(
        data=data,
        content_type=content_type,
        cache_control="private, max-age=86400",
        # SVG can carry script; lock served EPUB SVG assets down at the response level.
        content_security_policy=(
            "default-src 'none'; img-src 'self' data:; script-src 'none'; "
            "object-src 'none'; base-uri 'none'"
            if content_type == _SVG_CONTENT_TYPE
            else None
        ),
    )
