"""Media service layer.

All media-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from nexus.storage.client import StorageClientBase

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.config import Environment, get_settings
from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.media import FragmentOut, FromUrlResponse, MediaOut
from nexus.services.capabilities import derive_capabilities
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

logger = get_logger(__name__)


def get_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaOut:
    """Get media by ID if readable by viewer.

    Returns media row if readable by viewer, including derived capabilities.
    Uses a single query that combines existence + visibility check.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media to fetch.

    Returns:
        The media if found and viewer can read it.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    # First check if viewer can read the media using the canonical predicate
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Fetch the media data with additional fields needed for capabilities
    result = db.execute(
        text("""
            SELECT m.id, m.kind, m.title, m.canonical_source_url,
                   m.processing_status, m.failure_stage, m.last_error_code,
                   m.external_playback_url, m.created_at, m.updated_at,
                   (SELECT EXISTS(SELECT 1 FROM media_file mf WHERE mf.media_id = m.id)) as has_file,
                   (SELECT EXISTS(SELECT 1 FROM fragments f WHERE f.media_id = m.id)) as has_fragments
            FROM media m
            WHERE m.id = :media_id
        """),
        {"media_id": media_id},
    )
    row = result.fetchone()

    if row is None:
        # This should not happen if can_read_media returned True,
        # but handle defensively
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Derive capabilities
    capabilities = derive_capabilities(
        kind=row[1],
        processing_status=row[4],
        last_error_code=row[6],
        media_file_exists=row[10],
        external_playback_url_exists=row[7] is not None,
        has_fragments=row[11],
        has_plain_text=False,  # TODO: Check media.plain_text when added
    )

    return MediaOut(
        id=row[0],
        kind=row[1],
        title=row[2],
        canonical_source_url=row[3],
        processing_status=row[4],
        failure_stage=row[5],
        last_error_code=row[6],
        capabilities=capabilities,
        created_at=row[8],
        updated_at=row[9],
    )


def can_read_media(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    """Check if viewer can read a media item.

    Delegates to the canonical predicate in nexus.auth.permissions.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        True if viewer can read the media, False otherwise.
    """
    return _can_read_media(db, viewer_id, media_id)


def get_media_for_viewer_or_404(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> Media:
    """Get media by ID if readable by viewer, return the ORM model.

    Internal helper for service functions that need the ORM model.
    Returns Media row if readable by viewer.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media to fetch.

    Returns:
        The Media ORM model if found and viewer can read it.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    result = db.execute(
        text("SELECT * FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    )
    row = result.fetchone()

    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Query returns all columns, map to Media model
    return db.get(Media, media_id)


def create_provisional_web_article(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    enqueue_task: bool = False,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create a provisional web_article media row from a URL.

    This creates a media row with:
    - kind = 'web_article'
    - processing_status = 'pending'
    - requested_url = exactly as provided
    - canonical_url = NULL (set after redirect resolution during ingestion)
    - canonical_source_url = normalize_url_for_display(url)
    - title = truncated URL or 'Untitled'

    The media is immediately attached to the viewer's default library.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer creating the media.
        url: The URL to create a provisional media row for.
        enqueue_task: If True, enqueue ingestion task after creating media.
        request_id: Optional request ID for task correlation.

    Returns:
        FromUrlResponse with media_id, duplicate=False, processing_status='pending',
        and ingest_enqueued reflecting whether task was enqueued.

    Raises:
        InvalidRequestError: If URL validation fails.
        NotFoundError: If user's default library doesn't exist.
    """
    # Import here to avoid circular dependency
    from nexus.services.upload import _ensure_in_default_library

    # Validate URL (raises InvalidRequestError on failure)
    validate_requested_url(url)

    # Normalize for display/storage
    canonical_source = normalize_url_for_display(url)

    # Generate placeholder title from URL (truncate to 255 chars)
    title = url[:255] if url else "Untitled"

    now = datetime.now(UTC)

    # Create media row
    media = Media(
        kind=MediaKind.web_article.value,
        title=title,
        requested_url=url,
        canonical_url=None,  # Not set until ingestion resolves redirects
        canonical_source_url=canonical_source,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    db.flush()  # Get the generated ID

    # Attach to viewer's default library
    _ensure_in_default_library(db, viewer_id, media.id)

    db.commit()

    # Enqueue task if requested
    ingest_enqueued = False
    if enqueue_task:
        ingest_enqueued = _enqueue_ingest_task(media.id, viewer_id, request_id)

    return FromUrlResponse(
        media_id=media.id,
        duplicate=False,  # Always false at creation; dedup happens during ingestion
        processing_status=ProcessingStatus.pending.value,
        ingest_enqueued=ingest_enqueued,
    )


def enqueue_web_article_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create a provisional web_article and enqueue ingestion.

    Per PR-04 spec, this is the main entry point for /media/from_url:
    - Creates provisional media row
    - Attaches to viewer's default library
    - Enqueues Celery task for ingestion

    Args:
        db: Database session.
        viewer_id: The ID of the viewer creating the media.
        url: The URL to ingest.
        request_id: Optional request ID for task correlation.

    Returns:
        FromUrlResponse with ingest_enqueued=True.
    """
    return create_provisional_web_article(
        db,
        viewer_id,
        url,
        enqueue_task=True,
        request_id=request_id,
    )


def _enqueue_ingest_task(
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> bool:
    """Enqueue the ingest_web_article Celery task.

    In test/dev mode, runs synchronously if Celery is not available.

    Returns:
        True if task was enqueued/executed, False otherwise.
    """
    settings = get_settings()

    # In test environment, don't enqueue - let tests call task directly
    if settings.nexus_env == Environment.TEST:
        logger.debug("skipping_task_enqueue", reason="test_environment")
        return False

    try:
        from nexus.tasks import ingest_web_article

        ingest_web_article.apply_async(
            args=[str(media_id), str(actor_user_id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
        logger.info(
            "ingest_task_enqueued",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
        )
        return True
    except Exception as e:
        # Log but don't fail - task can be retried manually
        logger.warning(
            "ingest_task_enqueue_failed",
            media_id=str(media_id),
            error=str(e),
        )
        return False


def list_fragments_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> list[FragmentOut]:
    """List fragments for a media item if readable by viewer.

    Returns ordered fragments if media is readable.
    Uses the canonical visibility predicate.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        List of fragments ordered by idx ASC.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    # Check readability using the canonical predicate
    # This masks existence - both "not found" and "not readable" return 404
    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Query 2: Fetch fragments ordered by idx ASC
    result = db.execute(
        text("""
            SELECT f.id, f.media_id, f.idx, f.html_sanitized, f.canonical_text, f.created_at
            FROM fragments f
            WHERE f.media_id = :media_id
            ORDER BY f.idx ASC
        """),
        {"media_id": media_id},
    )

    return [
        FragmentOut(
            id=row[0],
            media_id=row[1],
            idx=row[2],
            html_sanitized=row[3],
            canonical_text=row[4],
            created_at=row[5],
        )
        for row in result.fetchall()
    ]


# ---------------------------------------------------------------------------
# EPUB asset fetch (S5 PR-02)
# ---------------------------------------------------------------------------

_ASSET_KEY_RE = re.compile(r"^[a-zA-Z0-9_./ -]+$")

# Allowlist of content types served for EPUB-internal assets.
# Intentionally restrictive — only known-safe static asset types.
_EPUB_ASSET_CONTENT_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".css": "text/css",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


@dataclass(frozen=True)
class EpubAssetOut:
    data: bytes
    content_type: str


def get_epub_asset_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    asset_key: str,
    storage_client: StorageClientBase | None = None,
) -> EpubAssetOut:
    """Fetch an EPUB internal asset for an authorized viewer.

    Enforces visibility, kind, readiness, and key-format guards.
    Returns binary payload without exposing raw private storage URLs.
    """
    from nexus.errors import ApiError
    from nexus.storage import get_storage_client

    if not _can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != MediaKind.epub.value:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media")

    ready_states = {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
    }
    if media.processing_status not in ready_states:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    if not asset_key or not _ASSET_KEY_RE.match(asset_key):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid asset key format")

    sc = storage_client or get_storage_client()
    storage_path = f"media/{media_id}/assets/{asset_key}"

    try:
        data = b"".join(sc.stream_object(storage_path))
    except Exception as exc:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found") from exc

    ext = posixpath.splitext(asset_key)[1].lower()
    content_type = _EPUB_ASSET_CONTENT_TYPES.get(ext, "application/octet-stream")

    return EpubAssetOut(data=data, content_type=content_type)
