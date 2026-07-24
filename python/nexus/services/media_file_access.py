"""Read access to stored media files."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import MediaFile
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.storage.client import StorageError, get_storage_client

logger = get_logger(__name__)

_SINGLE_RANGE_RE = re.compile(r"^bytes=((?:0|[1-9][0-9]*)?)-((?:0|[1-9][0-9]*)?)$")


@dataclass(frozen=True, slots=True)
class MediaFileSource:
    """Private storage facts. Callers must authorize before requesting them."""

    storage_path: str
    content_type: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class InclusiveByteRange:
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1


def get_media_file_source(db: Session, *, media_id: UUID) -> MediaFileSource | None:
    """Load private persisted file facts without making an authorization decision."""
    row = (
        db.execute(
            text(
                """
                SELECT storage_path, content_type, size_bytes
                FROM media_file
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return MediaFileSource(
        storage_path=str(row["storage_path"]),
        content_type=str(row["content_type"]),
        size_bytes=int(row["size_bytes"]),
    )


def parse_single_byte_range(raw: str, *, size_bytes: int) -> InclusiveByteRange:
    """Parse one canonical HTTP byte range against an authorized object size."""
    match = _SINGLE_RANGE_RE.fullmatch(raw)
    if match is None or "," in raw or size_bytes <= 0:
        raise ValueError("invalid byte range")
    start_raw, end_raw = match.groups()
    if not start_raw and not end_raw:
        raise ValueError("invalid byte range")
    if start_raw:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size_bytes - 1
        if start >= size_bytes or end < start:
            raise ValueError("unsatisfiable byte range")
        return InclusiveByteRange(start=start, end=min(end, size_bytes - 1))

    suffix_length = int(end_raw)
    if suffix_length <= 0:
        raise ValueError("unsatisfiable byte range")
    bounded_length = min(suffix_length, size_bytes)
    return InclusiveByteRange(
        start=size_bytes - bounded_length,
        end=size_bytes - 1,
    )


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
