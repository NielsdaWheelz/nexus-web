"""Library service layer.

All library-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.schemas.library import LibraryMediaOut, LibraryOut, MediaOut


def create_library(db: Session, viewer_id: UUID, name: str) -> LibraryOut:
    """Create a new non-default library.

    Args:
        db: Database session.
        viewer_id: The ID of the user creating the library.
        name: The library name (will be trimmed).

    Returns:
        The created library.

    Raises:
        InvalidRequestError: If name is empty or > 100 chars.
    """
    # Trim and validate name
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")

    with transaction(db):
        # Create library
        result = db.execute(
            text("""
                INSERT INTO libraries (name, owner_user_id, is_default)
                VALUES (:name, :viewer_id, false)
                RETURNING id, name, owner_user_id, is_default, created_at, updated_at
            """),
            {"name": name, "viewer_id": viewer_id},
        )
        library_row = result.fetchone()

        library_id = library_row[0]

        # Create owner membership (always admin)
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": library_id, "user_id": viewer_id},
        )

    return LibraryOut(
        id=library_row[0],
        name=library_row[1],
        owner_user_id=library_row[2],
        is_default=library_row[3],
        role="admin",  # Creator is always admin
        created_at=library_row[4],
        updated_at=library_row[5],
    )


def rename_library(db: Session, viewer_id: UUID, library_id: UUID, name: str) -> LibraryOut:
    """Rename a library.

    Args:
        db: Database session.
        viewer_id: The ID of the user renaming the library.
        library_id: The ID of the library to rename.
        name: The new library name (will be trimmed).

    Returns:
        The updated library.

    Raises:
        NotFoundError: If library not found or viewer is not a member.
        ForbiddenError: If viewer is not admin or library is default.
        InvalidRequestError: If name is empty or > 100 chars.
    """
    # Trim and validate name
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")

    with transaction(db):
        # Fetch library with membership check (FOR UPDATE to lock)
        result = db.execute(
            text("""
                SELECT l.id, l.name, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = :library_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        row = result.fetchone()

        if row is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        is_default = row[3]
        role = row[6]

        if is_default:
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN, "Cannot rename default library"
            )

        if role != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        # Update name and updated_at
        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE libraries
                SET name = :name, updated_at = :updated_at
                WHERE id = :library_id
            """),
            {"name": name, "updated_at": now, "library_id": library_id},
        )

    return LibraryOut(
        id=row[0],
        name=name,
        owner_user_id=row[2],
        is_default=row[3],
        role=role,
        created_at=row[4],
        updated_at=now,
    )


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Delete a library.

    Args:
        db: Database session.
        viewer_id: The ID of the user deleting the library.
        library_id: The ID of the library to delete.

    Raises:
        NotFoundError: If library not found or viewer is not a member.
        ForbiddenError: If viewer is not admin, library is default, or library has multiple members.
    """
    with transaction(db):
        # Fetch library with membership check (FOR UPDATE to lock)
        result = db.execute(
            text("""
                SELECT l.id, l.is_default, m.role
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = :library_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        row = result.fetchone()

        if row is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        is_default = row[1]
        role = row[2]

        if is_default:
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN, "Cannot delete default library"
            )

        if role != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        # Check membership count - only allow deletion if single-member
        result = db.execute(
            text("""
                SELECT COUNT(*) FROM memberships WHERE library_id = :library_id
            """),
            {"library_id": library_id},
        )
        member_count = result.scalar()

        if member_count > 1:
            raise ForbiddenError(
                ApiErrorCode.E_FORBIDDEN, "Cannot delete library with multiple members"
            )

        # Delete library (CASCADE handles library_media and memberships)
        db.execute(
            text("DELETE FROM libraries WHERE id = :library_id"),
            {"library_id": library_id},
        )


def list_libraries(db: Session, viewer_id: UUID, limit: int = 100) -> list[LibraryOut]:
    """List all libraries the viewer is a member of.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        limit: Maximum number of libraries to return (default 100, max 200).

    Returns:
        List of libraries ordered by created_at ASC, id ASC.

    Raises:
        InvalidRequestError: If limit <= 0.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    # Clamp limit to max 200
    limit = min(limit, 200)

    result = db.execute(
        text("""
            SELECT l.id, l.name, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            ORDER BY l.created_at ASC, l.id ASC
            LIMIT :limit
        """),
        {"viewer_id": viewer_id, "limit": limit},
    )

    return [
        LibraryOut(
            id=row[0],
            name=row[1],
            owner_user_id=row[2],
            is_default=row[3],
            created_at=row[4],
            updated_at=row[5],
            role=row[6],
        )
        for row in result.fetchall()
    ]


def get_library(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOut:
    """Get a single library by ID.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library to fetch.

    Returns:
        The library if found and viewer is a member.

    Raises:
        NotFoundError: If library not found or viewer is not a member.
    """
    result = db.execute(
        text("""
            SELECT l.id, l.name, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
        """),
        {"library_id": library_id, "viewer_id": viewer_id},
    )
    row = result.fetchone()

    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

    return LibraryOut(
        id=row[0],
        name=row[1],
        owner_user_id=row[2],
        is_default=row[3],
        created_at=row[4],
        updated_at=row[5],
        role=row[6],
    )


def add_media_to_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    media_id: UUID,
) -> LibraryMediaOut:
    """Add media to a library.

    Enforces default library closure for all members.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        media_id: The ID of the media to add.

    Returns:
        The library-media association.

    Raises:
        NotFoundError: If library not found, viewer not a member, or media not found.
        ForbiddenError: If viewer is not admin.
    """
    with transaction(db):
        # Step 1: Verify library exists and viewer is admin
        result = db.execute(
            text("""
                SELECT m.role, l.is_default
                FROM memberships m
                JOIN libraries l ON l.id = m.library_id
                WHERE m.library_id = :library_id AND m.user_id = :viewer_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        membership = result.fetchone()

        if membership is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        role = membership[0]
        if role != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        # Step 2: Verify media exists
        result = db.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        )
        if result.fetchone() is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

        # Step 3: Insert into target library
        result = db.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                VALUES (:library_id, :media_id)
                ON CONFLICT (library_id, media_id) DO NOTHING
                RETURNING library_id, media_id, created_at
            """),
            {"library_id": library_id, "media_id": media_id},
        )
        row = result.fetchone()

        # Step 4: Enforce default library closure for all members of this library
        db.execute(
            text("""
                INSERT INTO library_media (library_id, media_id)
                SELECT default_lib.id, :media_id
                FROM memberships m
                JOIN libraries default_lib
                    ON default_lib.owner_user_id = m.user_id
                    AND default_lib.is_default = true
                WHERE m.library_id = :library_id
                ON CONFLICT (library_id, media_id) DO NOTHING
            """),
            {"library_id": library_id, "media_id": media_id},
        )

        # If row is None, the association already existed - fetch it
        if row is None:
            result = db.execute(
                text("""
                    SELECT library_id, media_id, created_at
                    FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            )
            row = result.fetchone()

    return LibraryMediaOut(
        library_id=row[0],
        media_id=row[1],
        created_at=row[2],
    )


def remove_media_from_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    media_id: UUID,
) -> None:
    """Remove media from a library.

    Enforces default library closure rules:
    - If removing from default library: cascades to single-member libraries owned by viewer
    - If removing from non-default library: does not affect default library

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        media_id: The ID of the media to remove.

    Raises:
        NotFoundError: If library not found, viewer not a member, or media not in library.
        ForbiddenError: If viewer is not admin.
    """
    with transaction(db):
        # Step 1: Fetch library with lock
        result = db.execute(
            text("""
                SELECT l.id, l.is_default, l.owner_user_id
                FROM libraries l
                WHERE l.id = :library_id
                FOR UPDATE
            """),
            {"library_id": library_id},
        )
        library = result.fetchone()

        if library is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        is_default = library[1]

        # Step 2: Verify viewer is admin member
        result = db.execute(
            text("""
                SELECT role FROM memberships
                WHERE library_id = :library_id AND user_id = :viewer_id
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        membership = result.fetchone()

        if membership is None:
            # Mask membership check as 404
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        if membership[0] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        # Step 3: Verify media exists in this library
        result = db.execute(
            text("""
                SELECT 1 FROM library_media
                WHERE library_id = :library_id AND media_id = :media_id
            """),
            {"library_id": library_id, "media_id": media_id},
        )
        if result.fetchone() is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found in library")

        if is_default:
            # Removing from default library: cascade to single-member libraries owned by viewer
            # Find all libraries where:
            #   - viewer is the ONLY member (membership count = 1)
            #   - viewer owns the library (owner_user_id = viewer_id)
            #   - library is NOT the default library (already handling separately)
            db.execute(
                text("""
                    DELETE FROM library_media
                    WHERE media_id = :media_id
                    AND library_id IN (
                        SELECT l.id
                        FROM libraries l
                        JOIN memberships m ON m.library_id = l.id
                        WHERE l.owner_user_id = :viewer_id
                        AND l.is_default = false
                        GROUP BY l.id
                        HAVING COUNT(*) = 1
                    )
                """),
                {"media_id": media_id, "viewer_id": viewer_id},
            )

            # Now remove from default library
            db.execute(
                text("""
                    DELETE FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            )
        else:
            # Removing from non-default library: does NOT affect default library
            db.execute(
                text("""
                    DELETE FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            )


def list_library_media(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    limit: int = 100,
) -> list[MediaOut]:
    """List media in a library.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        limit: Maximum number of media to return (default 100, max 200).

    Returns:
        List of media ordered by library_media.created_at DESC, media.id DESC.

    Raises:
        NotFoundError: If library not found or viewer is not a member.
        InvalidRequestError: If limit <= 0.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    # Clamp limit to max 200
    limit = min(limit, 200)

    # Verify viewer is member of library
    result = db.execute(
        text("""
            SELECT 1 FROM memberships
            WHERE library_id = :library_id AND user_id = :viewer_id
        """),
        {"library_id": library_id, "viewer_id": viewer_id},
    )
    if result.fetchone() is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

    # Fetch media
    result = db.execute(
        text("""
            SELECT m.id, m.kind, m.title, m.canonical_source_url,
                   m.processing_status, m.created_at, m.updated_at
            FROM media m
            JOIN library_media lm ON lm.media_id = m.id
            WHERE lm.library_id = :library_id
            ORDER BY lm.created_at DESC, m.id DESC
            LIMIT :limit
        """),
        {"library_id": library_id, "limit": limit},
    )

    return [
        MediaOut(
            id=row[0],
            kind=row[1],
            title=row[2],
            canonical_source_url=row[3],
            processing_status=row[4],
            created_at=row[5],
            updated_at=row[6],
        )
        for row in result.fetchall()
    ]
