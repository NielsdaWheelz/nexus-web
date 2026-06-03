"""Read access to stored media files."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import MediaFile
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.storage.client import StorageError, get_storage_client

logger = get_logger(__name__)


def get_signed_download_url(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> dict:
    """Get a signed download URL for a media file visible to the viewer."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_file = db.execute(select(MediaFile).where(MediaFile.media_id == media_id)).scalar()
    if media_file is None:
        raise NotFoundError(
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            "No file available for this media",
        )

    settings = get_settings()
    try:
        url = get_storage_client().sign_download(
            media_file.storage_path,
            expires_in=settings.signed_url_expiry_s,
        )
    except StorageError as exc:
        logger.error("Failed to sign download: %s", exc.message)
        raise ApiError(
            ApiErrorCode.E_SIGN_DOWNLOAD_FAILED, "Failed to generate download URL"
        ) from exc

    return {
        "url": url,
        "expires_at": (
            datetime.now(UTC) + timedelta(seconds=settings.signed_url_expiry_s)
        ).isoformat(),
    }
