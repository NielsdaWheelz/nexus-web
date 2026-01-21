"""Media service layer.

All media-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.media import FragmentOut, MediaOut


def get_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaOut:
    """Get media by ID if readable by viewer.

    Returns media row if readable by viewer.
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
    # Single query pattern: returns a row only if readable
    # This ensures no timing side-channel on existence
    result = db.execute(
        text("""
            SELECT m.id, m.kind, m.title, m.canonical_source_url,
                   m.processing_status, m.created_at, m.updated_at
            FROM media m
            WHERE m.id = :media_id
            AND EXISTS (
                SELECT 1 FROM library_media lm
                JOIN memberships mem ON mem.library_id = lm.library_id
                WHERE lm.media_id = m.id AND mem.user_id = :viewer_id
            )
        """),
        {"media_id": media_id, "viewer_id": viewer_id},
    )
    row = result.fetchone()

    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    return MediaOut(
        id=row[0],
        kind=row[1],
        title=row[2],
        canonical_source_url=row[3],
        processing_status=row[4],
        created_at=row[5],
        updated_at=row[6],
    )


def can_read_media(db: Session, viewer_id: UUID, media_id: UUID) -> bool:
    """Check if viewer can read a media item.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        True if viewer can read the media, False otherwise.
    """
    result = db.execute(
        text("""
            SELECT 1 FROM library_media lm
            JOIN memberships mem ON mem.library_id = lm.library_id
            WHERE lm.media_id = :media_id AND mem.user_id = :viewer_id
            LIMIT 1
        """),
        {"media_id": media_id, "viewer_id": viewer_id},
    )
    return result.fetchone() is not None


def list_fragments_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> list[FragmentOut]:
    """List fragments for a media item if readable by viewer.

    Returns ordered fragments if media is readable.
    Uses 2 queries: check readability, then fetch fragments.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        List of fragments ordered by idx ASC.

    Raises:
        NotFoundError: If media does not exist or viewer cannot read it.
    """
    # Query 1: Check readability (same as can_read_media, but we also check media exists)
    # We do this in a single query to distinguish "not found" from "not readable"
    # But per spec, both return 404 E_MEDIA_NOT_FOUND (masking existence)
    result = db.execute(
        text("""
            SELECT EXISTS (SELECT 1 FROM media WHERE id = :media_id) as media_exists,
                   EXISTS (
                       SELECT 1 FROM library_media lm
                       JOIN memberships mem ON mem.library_id = lm.library_id
                       WHERE lm.media_id = :media_id AND mem.user_id = :viewer_id
                   ) as can_read
        """),
        {"media_id": media_id, "viewer_id": viewer_id},
    )
    row = result.fetchone()

    # If media doesn't exist OR viewer can't read it, return 404 (mask existence)
    if not row[0] or not row[1]:
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
