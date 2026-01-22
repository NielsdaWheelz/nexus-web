"""Media service layer.

All media-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media as _can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.media import FragmentOut, MediaOut
from nexus.services.capabilities import derive_capabilities


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
