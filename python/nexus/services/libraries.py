"""Library service layer.

All library-domain business logic lives here.
Routes may not contain domain logic or raw DB access - they must call these functions.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.library import (
    AcceptLibraryInviteResponse,
    DeclineLibraryInviteResponse,
    InviteAcceptMembershipOut,
    ItemLibraryMembershipOut,
    LibraryEntryOrderRequest,
    LibraryEntryOut,
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryMemberOut,
    LibraryOut,
    LibraryPodcastOut,
    LibraryPodcastSubscriptionOut,
    LibraryRole,
)
from nexus.schemas.media import MediaAuthorOut, MediaOut
from nexus.services.capabilities import derive_capabilities
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.search import visible_media_ids_cte_sql

logger = logging.getLogger(__name__)


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
                INSERT INTO libraries (name, color, owner_user_id, is_default)
                VALUES (:name, NULL, :viewer_id, false)
                RETURNING id, name, color, owner_user_id, is_default, created_at, updated_at
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
        color=library_row[2],
        owner_user_id=library_row[3],
        is_default=library_row[4],
        role="admin",  # Creator is always admin
        created_at=library_row[5],
        updated_at=library_row[6],
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
                SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
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

        is_default = row[4]
        role = row[7]

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
        color=row[2],
        owner_user_id=row[3],
        is_default=row[4],
        role=role,
        created_at=row[5],
        updated_at=now,
    )


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Delete a library.

    S4 rule: only the current owner can delete a non-default library.
    Non-owner admins get E_OWNER_REQUIRED. Non-members get masked 404.

    Args:
        db: Database session.
        viewer_id: The ID of the user deleting the library.
        library_id: The ID of the library to delete.

    Raises:
        NotFoundError: If library not found or viewer is not a member.
        ForbiddenError: If library is default or viewer is not owner.
    """
    with transaction(db):
        from nexus.services.default_library_closure import remove_media_from_non_default_closure

        result = db.execute(
            text("""
                SELECT l.id, l.is_default, l.owner_user_id, m.role
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
        owner_user_id = row[2]

        if is_default:
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN, "Cannot delete default library"
            )

        if owner_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED, "Only the library owner can delete it"
            )

        media_ids = [
            UUID(str(entry[0]))
            for entry in db.execute(
                text("""
                    SELECT media_id
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND media_id IS NOT NULL
                    ORDER BY position ASC, created_at DESC, id DESC
                """),
                {"library_id": library_id},
            ).fetchall()
        ]
        for media_id in media_ids:
            remove_media_from_non_default_closure(db, library_id, media_id)

        db.execute(
            text("DELETE FROM library_entries WHERE library_id = :library_id"),
            {"library_id": library_id},
        )
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
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
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
            color=row[2],
            owner_user_id=row[3],
            is_default=row[4],
            created_at=row[5],
            updated_at=row[6],
            role=row[7],
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
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default, l.created_at, l.updated_at, m.role
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
        color=row[2],
        owner_user_id=row[3],
        is_default=row[4],
        created_at=row[5],
        updated_at=row[6],
        role=row[7],
    )


def add_media_to_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    media_id: UUID,
) -> LibraryEntryOut:
    """Add media to a library.

    S4 closure rules:
    - Default target: ensure intrinsic + library entry, no closure edges.
    - Non-default target: insert source row, create closure edges + materialized
      default rows for all current members.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        media_id: The ID of the media to add.

    Raises:
        NotFoundError: If library not found, viewer not a member, or media not found.
        ForbiddenError: If viewer is not admin.
    """
    from nexus.services.default_library_closure import (
        add_media_to_non_default_closure,
        ensure_default_intrinsic,
    )

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

        is_default_library = membership[1]
        if is_default_library:
            ensure_default_intrinsic(db, library_id, media_id)
        else:
            row = db.execute(
                text("""
                    SELECT id, library_id, media_id, podcast_id, created_at, position
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            ).fetchone()
            if row is None:
                row = db.execute(
                    text("""
                        INSERT INTO library_entries (library_id, media_id, podcast_id, position)
                        VALUES (:library_id, :media_id, NULL, :position)
                        RETURNING id, library_id, media_id, podcast_id, created_at, position
                    """),
                    {
                        "library_id": library_id,
                        "media_id": media_id,
                        "position": _next_library_entry_position(db, library_id),
                    },
                ).fetchone()
            add_media_to_non_default_closure(db, library_id, media_id)
        if is_default_library:
            row = db.execute(
                text("""
                    SELECT id, library_id, media_id, podcast_id, created_at, position
                    FROM library_entries
                    WHERE library_id = :library_id
                      AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            ).fetchone()

    return _hydrate_library_entries(db, viewer_id, [row])[0]


def ensure_writable_non_default_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
) -> None:
    row = _fetch_library_with_membership(db, viewer_id, library_id)
    _require_admin(row[6])
    _require_non_default(row[1])


def list_media_item_libraries(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> list[ItemLibraryMembershipOut]:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    rows = db.execute(
        text("""
            SELECT
                l.id,
                l.name,
                l.color,
                EXISTS(
                    SELECT 1
                    FROM library_entries le
                    WHERE le.library_id = l.id
                      AND le.media_id = :media_id
                ) AS in_library,
                m.role
            FROM libraries l
            JOIN memberships m
              ON m.library_id = l.id
             AND m.user_id = :viewer_id
            WHERE l.is_default = false
            ORDER BY l.created_at ASC, l.id ASC
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).fetchall()

    return [
        ItemLibraryMembershipOut(
            id=row[0],
            name=row[1],
            color=row[2],
            is_in_library=bool(row[3]),
            can_add=row[4] == "admin" and not bool(row[3]),
            can_remove=row[4] == "admin" and bool(row[3]),
        )
        for row in rows
    ]


def remove_media_from_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    media_id: UUID,
) -> None:
    """Remove media from a library.

    S4 closure rules:
    - Default target: remove intrinsic; gc materialized row iff no intrinsic
      and no remaining closure edge. Does NOT cascade to non-default libraries.
    - Non-default target: remove source row, remove source closure edges, gc
      affected default rows.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        media_id: The ID of the media to remove.

    Raises:
        NotFoundError: If library not found, viewer not a member, or media not in library.
        ForbiddenError: If viewer is not admin.
    """
    from nexus.services.default_library_closure import (
        remove_default_intrinsic_and_gc,
        remove_media_from_non_default_closure,
    )

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
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        if membership[0] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        # Step 3: Verify media exists in this library
        row = db.execute(
            text("""
                SELECT id
                FROM library_entries
                WHERE library_id = :library_id
                  AND media_id = :media_id
            """),
            {"library_id": library_id, "media_id": media_id},
        ).fetchone()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found in library")

        if is_default:
            remove_default_intrinsic_and_gc(db, library_id, media_id)
        else:
            db.execute(
                text("""
                    DELETE FROM library_entries
                    WHERE library_id = :library_id
                      AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
            )
            remove_media_from_non_default_closure(db, library_id, media_id)
        _normalize_library_entry_positions(db, library_id)


def add_podcast_to_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> LibraryEntryOut:
    with transaction(db):
        membership = db.execute(
            text("""
                SELECT m.role, l.is_default
                FROM memberships m
                JOIN libraries l ON l.id = m.library_id
                WHERE m.library_id = :library_id
                  AND m.user_id = :viewer_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        ).fetchone()
        if membership is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
        if membership[0] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")
        if bool(membership[1]):
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
                "Podcasts cannot be added to the default library",
            )

        podcast_row = db.execute(
            text("""
                SELECT p.id
                FROM podcasts p
                JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id
                 AND ps.user_id = :viewer_id
                 AND ps.status = 'active'
                WHERE p.id = :podcast_id
            """),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        ).fetchone()
        if podcast_row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Active podcast subscription not found")

        row = db.execute(
            text("""
                SELECT id, library_id, media_id, podcast_id, created_at, position
                FROM library_entries
                WHERE library_id = :library_id
                  AND podcast_id = :podcast_id
            """),
            {"library_id": library_id, "podcast_id": podcast_id},
        ).fetchone()
        if row is None:
            next_position = _next_library_entry_position(db, library_id)
            row = db.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id, podcast_id, position)
                    VALUES (:library_id, NULL, :podcast_id, :position)
                    RETURNING id, library_id, media_id, podcast_id, created_at, position
                """),
                {
                    "library_id": library_id,
                    "podcast_id": podcast_id,
                    "position": next_position,
                },
            ).fetchone()

    return _hydrate_library_entries(db, viewer_id, [row])[0]


def list_podcast_item_libraries(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> list[ItemLibraryMembershipOut]:
    podcast_exists = db.execute(
        text("SELECT 1 FROM podcasts WHERE id = :podcast_id"),
        {"podcast_id": podcast_id},
    ).fetchone()
    if podcast_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

    rows = db.execute(
        text("""
            SELECT
                l.id,
                l.name,
                l.color,
                EXISTS(
                    SELECT 1
                    FROM library_entries le
                    WHERE le.library_id = l.id
                      AND le.podcast_id = :podcast_id
                ) AS in_library,
                m.role
            FROM libraries l
            JOIN memberships m
              ON m.library_id = l.id
             AND m.user_id = :viewer_id
            WHERE l.is_default = false
            ORDER BY l.created_at ASC, l.id ASC
        """),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchall()

    return [
        ItemLibraryMembershipOut(
            id=row[0],
            name=row[1],
            color=row[2],
            is_in_library=bool(row[3]),
            can_add=row[4] == "admin" and not bool(row[3]),
            can_remove=row[4] == "admin" and bool(row[3]),
        )
        for row in rows
    ]


def remove_podcast_from_library(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    podcast_id: UUID,
) -> None:
    with transaction(db):
        row = _fetch_library_with_membership(db, viewer_id, library_id, lock=True)
        _require_admin(row[6])
        _require_non_default(row[1])
        deleted = db.execute(
            text("""
                DELETE FROM library_entries
                WHERE library_id = :library_id
                  AND podcast_id = :podcast_id
                RETURNING id
            """),
            {"library_id": library_id, "podcast_id": podcast_id},
        ).fetchone()
        if deleted is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found in library")
        _normalize_library_entry_positions(db, library_id)


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    limit: int = 100,
    offset: int = 0,
) -> list[LibraryEntryOut]:
    """List ordered entries in a library.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        limit: Maximum number of media to return (default 100, max 200).

    Raises:
        NotFoundError: If library not found or viewer is not a member.
        InvalidRequestError: If limit <= 0.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    if offset < 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Offset must be non-negative")

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

    rows = db.execute(
        text("""
            SELECT id, library_id, media_id, podcast_id, created_at, position
            FROM library_entries
            WHERE library_id = :library_id
            ORDER BY position ASC, created_at DESC, id DESC
            LIMIT :limit
            OFFSET :offset
        """),
        {"library_id": library_id, "limit": limit, "offset": offset},
    ).fetchall()
    return _hydrate_library_entries(db, viewer_id, rows)


def reorder_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    body: LibraryEntryOrderRequest,
) -> list[LibraryEntryOut]:
    """Replace full library entry order for admin viewers."""
    with transaction(db):
        _, _, _, _, _, _, role, _ = _fetch_library_with_membership(
            db,
            viewer_id,
            library_id,
            lock=True,
        )
        _require_admin(role)
        existing_entry_ids = [
            row[0]
            for row in db.execute(
                text("""
                    SELECT id
                    FROM library_entries
                    WHERE library_id = :library_id
                    ORDER BY position ASC, created_at DESC, id DESC
                """),
                {"library_id": library_id},
            ).fetchall()
        ]
        requested_entry_ids = [UUID(str(entry_id)) for entry_id in body.entry_ids]
        if len(existing_entry_ids) != len(requested_entry_ids) or set(existing_entry_ids) != set(
            requested_entry_ids
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Library reorder requires an exact full set of entry IDs",
            )
        for position, entry_id in enumerate(requested_entry_ids):
            db.execute(
                text("""
                    UPDATE library_entries
                    SET position = :position
                    WHERE library_id = :library_id
                      AND id = :entry_id
                """),
                {
                    "position": position,
                    "library_id": library_id,
                    "entry_id": entry_id,
                },
            )
        _normalize_library_entry_positions(db, library_id)

    return list_library_entries(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        limit=min(max(len(requested_entry_ids), 1), 200),
        offset=0,
    )


def _next_library_entry_position(db: Session, library_id: UUID) -> int:
    next_position = db.execute(
        text("""
            SELECT COALESCE(MAX(position), -1) + 1
            FROM library_entries
            WHERE library_id = :library_id
        """),
        {"library_id": library_id},
    ).scalar()
    if next_position is None:
        return 0
    return int(next_position)


def _normalize_library_entry_positions(db: Session, library_id: UUID) -> None:
    db.execute(
        text("""
            WITH ordered AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        ORDER BY position ASC, created_at DESC, id DESC
                    ) - 1 AS new_position
                FROM library_entries
                WHERE library_id = :library_id
            )
            UPDATE library_entries le
            SET position = ordered.new_position
            FROM ordered
            WHERE le.id = ordered.id
              AND le.position <> ordered.new_position
        """),
        {"library_id": library_id},
    )


def _hydrate_library_entries(
    db: Session,
    viewer_id: UUID,
    rows: list[tuple],
) -> list[LibraryEntryOut]:
    if not rows:
        return []

    media_ids: list[UUID] = []
    podcast_ids: list[UUID] = []
    for row in rows:
        if row[2] is not None:
            media_ids.append(UUID(str(row[2])))
        if row[3] is not None:
            podcast_ids.append(UUID(str(row[3])))

    media_by_id: dict[UUID, MediaOut] = {}
    if media_ids:
        media_rows = db.execute(
            text("""
                SELECT m.id, m.kind, m.title, m.canonical_source_url,
                       m.processing_status, m.failure_stage, m.last_error_code,
                       m.external_playback_url, m.provider, m.provider_id,
                       m.created_at, m.updated_at,
                       EXISTS(SELECT 1 FROM media_file mf WHERE mf.media_id = m.id) AS has_file,
                       EXISTS(SELECT 1 FROM fragments f WHERE f.media_id = m.id) AS has_fragments,
                       m.published_date, m.publisher, m.language, m.description
                FROM media m
                WHERE m.id = ANY(:media_ids)
            """),
            {"media_ids": media_ids},
        ).fetchall()
        pdf_media_ids = [UUID(str(row[0])) for row in media_rows if row[1] == "pdf"]
        pdf_readiness = batch_pdf_quote_text_ready(db, pdf_media_ids) if pdf_media_ids else {}
        author_rows = db.execute(
            text("""
                SELECT id, media_id, name, role
                FROM media_authors
                WHERE media_id = ANY(:media_ids)
                ORDER BY sort_order
            """),
            {"media_ids": media_ids},
        ).fetchall()
        authors_by_media: dict[UUID, list[MediaAuthorOut]] = {
            media_id: [] for media_id in media_ids
        }
        for author_row in author_rows:
            author_media_id = UUID(str(author_row[1]))
            authors_by_media.setdefault(author_media_id, []).append(
                MediaAuthorOut(id=author_row[0], name=author_row[2], role=author_row[3])
            )
        for media_row in media_rows:
            media_id = UUID(str(media_row[0]))
            pdf_ready = pdf_readiness.get(media_id, False) if media_row[1] == "pdf" else False
            media_by_id[media_id] = MediaOut(
                id=media_id,
                kind=media_row[1],
                title=media_row[2],
                canonical_source_url=media_row[3],
                processing_status=media_row[4],
                failure_stage=media_row[5],
                last_error_code=media_row[6],
                playback_source=derive_playback_source(
                    kind=media_row[1],
                    external_playback_url=media_row[7],
                    canonical_source_url=media_row[3],
                    provider=media_row[8],
                    provider_id=media_row[9],
                ),
                capabilities=derive_capabilities(
                    kind=media_row[1],
                    processing_status=media_row[4],
                    last_error_code=media_row[6],
                    media_file_exists=bool(media_row[12]),
                    external_playback_url_exists=media_row[7] is not None,
                    has_fragments=bool(media_row[13]),
                    pdf_quote_text_ready=pdf_ready,
                ),
                authors=authors_by_media.get(media_id, []),
                published_date=media_row[14],
                publisher=media_row[15],
                language=media_row[16],
                description=media_row[17],
                created_at=media_row[10],
                updated_at=media_row[11],
            )

    podcast_rows_by_id: dict[UUID, tuple] = {}
    if podcast_ids:
        podcast_rows = db.execute(
            text(
                f"""
                WITH visible_media AS (
                    {visible_media_ids_cte_sql()}
                ),
                podcast_unplayed AS (
                    SELECT
                        pe.podcast_id,
                        COUNT(*) FILTER (
                            WHERE pls.is_completed IS NOT TRUE
                              AND COALESCE(pls.position_ms, 0) = 0
                        ) AS unplayed_count
                    FROM podcast_episodes pe
                    JOIN visible_media vm
                      ON vm.media_id = pe.media_id
                    LEFT JOIN podcast_listening_states pls
                      ON pls.user_id = :viewer_id
                     AND pls.media_id = pe.media_id
                    WHERE pe.podcast_id = ANY(:podcast_ids)
                    GROUP BY pe.podcast_id
                )
                SELECT
                    p.id,
                    p.provider,
                    p.provider_podcast_id,
                    p.title,
                    p.author,
                    p.feed_url,
                    p.website_url,
                    p.image_url,
                    p.description,
                    p.created_at,
                    p.updated_at,
                    COALESCE(pu.unplayed_count, 0) AS unplayed_count,
                    ps.status,
                    ps.default_playback_speed,
                    ps.auto_queue,
                    ps.sync_status,
                    ps.sync_error_code,
                    ps.sync_error_message,
                    ps.sync_attempts,
                    ps.sync_started_at,
                    ps.sync_completed_at,
                    ps.last_synced_at,
                    ps.updated_at
                FROM podcasts p
                LEFT JOIN podcast_unplayed pu
                  ON pu.podcast_id = p.id
                LEFT JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id
                 AND ps.user_id = :viewer_id
                WHERE p.id = ANY(:podcast_ids)
                """
            ),
            {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
        ).fetchall()
        podcast_rows_by_id = {UUID(str(row[0])): row for row in podcast_rows}

    hydrated: list[LibraryEntryOut] = []
    for row in rows:
        entry_id = UUID(str(row[0]))
        entry_library_id = UUID(str(row[1]))
        media_id = UUID(str(row[2])) if row[2] is not None else None
        podcast_id = UUID(str(row[3])) if row[3] is not None else None
        if media_id is not None:
            media = media_by_id.get(media_id)
            if media is None:
                continue
            hydrated.append(
                LibraryEntryOut(
                    id=entry_id,
                    library_id=entry_library_id,
                    kind="media",
                    position=int(row[5]),
                    created_at=row[4],
                    media=media,
                    podcast=None,
                    subscription=None,
                )
            )
            continue

        if podcast_id is None:
            continue

        podcast_row = podcast_rows_by_id.get(podcast_id)
        if podcast_row is None:
            continue

        subscription = None
        if podcast_row[12] is not None:
            subscription = LibraryPodcastSubscriptionOut(
                status=podcast_row[12],
                default_playback_speed=float(podcast_row[13])
                if podcast_row[13] is not None
                else None,
                auto_queue=bool(podcast_row[14]),
                sync_status=podcast_row[15],
                sync_error_code=podcast_row[16],
                sync_error_message=podcast_row[17],
                sync_attempts=int(podcast_row[18] or 0),
                sync_started_at=podcast_row[19],
                sync_completed_at=podcast_row[20],
                last_synced_at=podcast_row[21],
                updated_at=podcast_row[22],
            )

        hydrated.append(
            LibraryEntryOut(
                id=entry_id,
                library_id=entry_library_id,
                kind="podcast",
                position=int(row[5]),
                created_at=row[4],
                media=None,
                podcast=LibraryPodcastOut(
                    id=podcast_id,
                    provider=podcast_row[1],
                    provider_podcast_id=podcast_row[2],
                    title=podcast_row[3],
                    author=podcast_row[4],
                    feed_url=podcast_row[5],
                    website_url=podcast_row[6],
                    image_url=podcast_row[7],
                    description=podcast_row[8],
                    created_at=podcast_row[9],
                    updated_at=podcast_row[10],
                    unplayed_count=int(podcast_row[11] or 0),
                ),
                subscription=subscription,
            )
        )

    return hydrated


# =============================================================================
# S4 PR-03: Library governance
# =============================================================================


def _fetch_library_with_membership(
    db: Session, viewer_id: UUID, library_id: UUID, *, lock: bool = False
) -> tuple:
    """Fetch library row joined with viewer membership.

    Returns (library_id, is_default, owner_user_id, created_at, updated_at, name, role, color)
    or raises masked 404 if not found or viewer is not a member.
    """
    lock_clause = "FOR UPDATE OF l" if lock else ""
    result = db.execute(
        text(f"""
            SELECT l.id, l.is_default, l.owner_user_id, l.created_at, l.updated_at,
                   l.name, m.role, l.color
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
            {lock_clause}
        """),
        {"library_id": library_id, "viewer_id": viewer_id},
    )
    row = result.fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return row


def _require_admin(role: str) -> None:
    """Raise E_FORBIDDEN if role is not admin."""
    if role != "admin":
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")


def _require_non_default(is_default: bool) -> None:
    """Raise E_DEFAULT_LIBRARY_FORBIDDEN if library is default."""
    if is_default:
        raise ForbiddenError(
            ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
            "Operation not allowed on default library",
        )


def _repair_owner_admin_invariant(db: Session, library_id: UUID, owner_user_id: UUID) -> None:
    """Ensure the owner has an admin membership row. Create or promote if needed."""
    row = db.execute(
        text("""
            SELECT role
            FROM memberships
            WHERE library_id = :library_id
              AND user_id = :owner_user_id
        """),
        {"library_id": library_id, "owner_user_id": owner_user_id},
    ).fetchone()
    if row is None:
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :owner_user_id, 'admin')
            """),
            {"library_id": library_id, "owner_user_id": owner_user_id},
        )
        return
    if row[0] != "admin":
        db.execute(
            text("""
                UPDATE memberships
                SET role = 'admin'
                WHERE library_id = :library_id
                  AND user_id = :owner_user_id
            """),
            {"library_id": library_id, "owner_user_id": owner_user_id},
        )


def list_library_members(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    limit: int = 100,
) -> list[LibraryMemberOut]:
    """List members of a library.

    Auth: viewer must be admin member. Non-member -> masked 404. Non-admin -> 403.
    Ordering: owner first, then admin, then member, then created_at ASC, user_id ASC.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        library_id: The ID of the library.
        limit: Maximum results (default 100, clamped to 200).

    Returns:
        List of LibraryMemberOut.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    row = _fetch_library_with_membership(db, viewer_id, library_id)
    _require_admin(row[6])

    owner_user_id = row[2]

    result = db.execute(
        text("""
            SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.library_id = :library_id
            ORDER BY
                (m.user_id = :owner_user_id) DESC,
                (CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END) ASC,
                m.created_at ASC,
                m.user_id ASC
            LIMIT :limit
        """),
        {"library_id": library_id, "owner_user_id": owner_user_id, "limit": limit},
    )

    return [
        LibraryMemberOut(
            user_id=r[0],
            role=r[1],
            is_owner=(r[0] == owner_user_id),
            created_at=r[2],
            email=r[3],
            display_name=r[4],
        )
        for r in result.fetchall()
    ]


def update_library_member_role(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    target_user_id: UUID,
    role: str,
) -> LibraryMemberOut:
    """Update a library member's role.

    Auth: viewer must be admin member. Cannot change owner's role. Cannot demote last admin.
    Default library forbidden. Idempotent when role unchanged.
    """
    with transaction(db):
        lib_row = _fetch_library_with_membership(db, viewer_id, library_id, lock=True)
        _require_admin(lib_row[6])
        _require_non_default(lib_row[1])

        owner_user_id = lib_row[2]

        # Lock all memberships for this library to prevent races
        db.execute(
            text("SELECT 1 FROM memberships WHERE library_id = :lid FOR UPDATE"),
            {"lid": library_id},
        )

        # Repair owner-admin invariant if dirty
        _repair_owner_admin_invariant(db, library_id, owner_user_id)

        # Cannot change owner's role via this endpoint
        if target_user_id == owner_user_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                "Cannot change owner role; transfer ownership first",
            )

        # Find target membership
        result = db.execute(
            text("""
                SELECT user_id, role, created_at FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": library_id, "uid": target_user_id},
        )
        target = result.fetchone()
        if target is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Member not found")

        current_role = target[1]

        # Idempotent
        if current_role == role:
            return LibraryMemberOut(
                user_id=target[0],
                role=current_role,
                is_owner=False,
                created_at=target[2],
            )

        # Demoting an admin: check last-admin constraint
        if current_role == "admin" and role == "member":
            admin_count = db.execute(
                text("""
                    SELECT COUNT(*) FROM memberships
                    WHERE library_id = :lid AND role = 'admin'
                """),
                {"lid": library_id},
            ).scalar()
            if admin_count <= 1:
                raise ForbiddenError(
                    ApiErrorCode.E_LAST_ADMIN_FORBIDDEN,
                    "Cannot demote last admin",
                )

        db.execute(
            text("""
                UPDATE memberships SET role = :role
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"role": role, "lid": library_id, "uid": target_user_id},
        )

    return LibraryMemberOut(
        user_id=target[0],
        role=role,
        is_owner=False,
        created_at=target[2],
    )


def remove_library_member(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    target_user_id: UUID,
) -> None:
    """Remove a member from a library.

    Auth: viewer must be admin member. Cannot remove owner. Cannot remove last admin.
    Default library forbidden. Idempotent: absent target -> silent 204.

    S4: on successful delete, run closure cleanup + gc for removed user and
    delete matching backfill job row.
    """
    from nexus.services.default_library_closure import remove_member_closure_and_gc

    with transaction(db):
        lib_row = _fetch_library_with_membership(db, viewer_id, library_id, lock=True)
        _require_admin(lib_row[6])
        _require_non_default(lib_row[1])

        owner_user_id = lib_row[2]

        # Lock memberships
        db.execute(
            text("SELECT 1 FROM memberships WHERE library_id = :lid FOR UPDATE"),
            {"lid": library_id},
        )

        _repair_owner_admin_invariant(db, library_id, owner_user_id)

        # Cannot remove owner
        if target_user_id == owner_user_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                "Cannot remove owner; transfer ownership first",
            )

        # Check target exists
        result = db.execute(
            text("""
                SELECT role FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": library_id, "uid": target_user_id},
        )
        target = result.fetchone()

        # Idempotent: absent target is no-op
        if target is None:
            return

        target_role = target[0]

        # Last-admin check
        if target_role == "admin":
            admin_count = db.execute(
                text("""
                    SELECT COUNT(*) FROM memberships
                    WHERE library_id = :lid AND role = 'admin'
                """),
                {"lid": library_id},
            ).scalar()
            if admin_count <= 1:
                raise ForbiddenError(
                    ApiErrorCode.E_LAST_ADMIN_FORBIDDEN,
                    "Cannot remove last admin",
                )

        db.execute(
            text("""
                DELETE FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": library_id, "uid": target_user_id},
        )

        # S4: closure cleanup + gc + backfill job deletion
        remove_member_closure_and_gc(db, library_id, target_user_id)


def transfer_library_ownership(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    new_owner_user_id: UUID,
) -> LibraryOut:
    """Transfer library ownership to another member.

    Owner-only. Target must be existing member. Previous owner stays admin.
    Default library forbidden. Idempotent when target is current owner.
    """
    with transaction(db):
        # Lock library and fetch with viewer membership
        result = db.execute(
            text("""
                SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default, l.created_at,
                       l.updated_at, m.role
                FROM libraries l
                LEFT JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = :library_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        row = result.fetchone()

        if row is None or row[7] is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        is_default = row[4]
        current_owner = row[3]
        viewer_role = row[7]

        _require_non_default(is_default)

        # Must be current owner
        if current_owner != viewer_id:
            if viewer_role:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_REQUIRED,
                    "Only the library owner can transfer ownership",
                )
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        # Lock memberships
        db.execute(
            text("SELECT 1 FROM memberships WHERE library_id = :lid FOR UPDATE"),
            {"lid": library_id},
        )

        _repair_owner_admin_invariant(db, library_id, current_owner)

        # Idempotent: transfer to self
        if new_owner_user_id == current_owner:
            return LibraryOut(
                id=row[0],
                name=row[1],
                color=row[2],
                owner_user_id=row[3],
                is_default=row[4],
                created_at=row[5],
                updated_at=row[6],
                role=viewer_role,
            )

        # Target must be existing member
        target_result = db.execute(
            text("""
                SELECT role FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": library_id, "uid": new_owner_user_id},
        )
        target_membership = target_result.fetchone()
        if target_membership is None:
            raise ConflictError(
                ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID,
                "Transfer target must be an existing member",
            )

        # Ensure target is admin
        if target_membership[0] != "admin":
            db.execute(
                text("""
                    UPDATE memberships SET role = 'admin'
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": new_owner_user_id},
            )

        # Transfer ownership
        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE libraries SET owner_user_id = :new_owner, updated_at = :now
                WHERE id = :lid
            """),
            {"new_owner": new_owner_user_id, "now": now, "lid": library_id},
        )

        # Previous owner stays admin
        _repair_owner_admin_invariant(db, library_id, viewer_id)

    return LibraryOut(
        id=row[0],
        name=row[1],
        color=row[2],
        owner_user_id=new_owner_user_id,
        is_default=row[4],
        created_at=row[5],
        updated_at=now,
        role="admin",
    )


# =============================================================================
# S4 PR-04: Invitation Lifecycle
# =============================================================================


def _invitation_row_to_out(row: tuple, *, with_user_info: bool = False) -> LibraryInvitationOut:
    """Convert a raw invite query row to LibraryInvitationOut.

    If with_user_info=True, expects columns [0..7] + [8]=email, [9]=display_name.
    """
    kwargs: dict = {
        "id": row[0],
        "library_id": row[1],
        "inviter_user_id": row[2],
        "invitee_user_id": row[3],
        "role": row[4],
        "status": row[5],
        "created_at": row[6],
        "responded_at": row[7],
    }
    if with_user_info and len(row) > 8:
        kwargs["invitee_email"] = row[8]
        kwargs["invitee_display_name"] = row[9]
    return LibraryInvitationOut(**kwargs)


def create_library_invite(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    invitee_user_id: UUID | None,
    role: LibraryRole,
    invitee_email: str | None = None,
) -> LibraryInvitationOut:
    """Create an invitation to a library.

    Auth: viewer must be admin/owner of target library.
    Default library targets are forbidden.
    Invitee must exist. Existing members and pending invites are conflicts.

    Either invitee_user_id or invitee_email must be provided. If both are
    provided, invitee_user_id takes precedence.

    Raises:
        NotFoundError: Library not found or viewer not member (masked 404).
        ForbiddenError: Viewer not admin, or default library target.
        ConflictError: Invitee already member or pending invite exists.
        NotFoundError: Invitee user not found.
    """
    with transaction(db):
        lib_row = _fetch_library_with_membership(db, viewer_id, library_id)
        _require_admin(lib_row[6])
        _require_non_default(lib_row[1])

        # Resolve invitee: by user_id or by email
        # Schema validation ensures at least one is provided; assert defensively.
        assert invitee_user_id is not None or invitee_email is not None

        if invitee_user_id is None:
            # Resolve email to user_id
            row = db.execute(
                text("SELECT id FROM users WHERE email = :email"),
                {"email": invitee_email},
            ).fetchone()
            if row is None:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
            invitee_user_id = row[0]
        else:
            # Invitee must exist
            invitee_exists = db.execute(
                text("SELECT 1 FROM users WHERE id = :uid"),
                {"uid": invitee_user_id},
            ).fetchone()
            if invitee_exists is None:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")

        # Check existing membership (catches self-invite via same path)
        member_exists = db.execute(
            text("""
                SELECT 1 FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": library_id, "uid": invitee_user_id},
        ).fetchone()
        if member_exists is not None:
            raise ConflictError(ApiErrorCode.E_INVITE_MEMBER_EXISTS, "User is already a member")

        # Check existing pending invite
        pending_exists = db.execute(
            text("""
                SELECT 1 FROM library_invitations
                WHERE library_id = :lid AND invitee_user_id = :uid AND status = 'pending'
            """),
            {"lid": library_id, "uid": invitee_user_id},
        ).fetchone()
        if pending_exists is not None:
            raise ConflictError(
                ApiErrorCode.E_INVITE_ALREADY_EXISTS,
                "Pending invitation already exists",
            )

        # Insert invite row; handle unique-index race
        try:
            result = db.execute(
                text("""
                    INSERT INTO library_invitations
                        (library_id, inviter_user_id, invitee_user_id, role, status)
                    VALUES (:lid, :inviter, :invitee, :role, 'pending')
                    RETURNING id, library_id, inviter_user_id, invitee_user_id,
                              role, status, created_at, responded_at
                """),
                {
                    "lid": library_id,
                    "inviter": viewer_id,
                    "invitee": invitee_user_id,
                    "role": role,
                },
            )
            row = result.fetchone()
        except IntegrityError as exc:
            db.rollback()
            constraint_name = getattr(exc.orig, "constraint_name", "") or ""
            if "uix_library_invitations_pending_once" in str(exc) or (
                "uix_library_invitations_pending_once" in constraint_name
            ):
                raise ConflictError(
                    ApiErrorCode.E_INVITE_ALREADY_EXISTS,
                    "Pending invitation already exists",
                ) from exc
            raise

    return _invitation_row_to_out(row)


def list_library_invites(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    limit: int = 100,
) -> list[LibraryInvitationOut]:
    """List invitations for a library.

    Auth: viewer must be admin/owner of the library.
    Order: created_at DESC, id DESC.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    lib_row = _fetch_library_with_membership(db, viewer_id, library_id)
    _require_admin(lib_row[6])

    result = db.execute(
        text("""
            SELECT i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
                   i.role, i.status, i.created_at, i.responded_at,
                   u.email, u.display_name
            FROM library_invitations i
            JOIN users u ON u.id = i.invitee_user_id
            WHERE i.library_id = :lid AND i.status = :status
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
        """),
        {"lid": library_id, "status": status, "limit": limit},
    )

    return [_invitation_row_to_out(r, with_user_info=True) for r in result.fetchall()]


def list_viewer_invites(
    db: Session,
    viewer_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    limit: int = 100,
) -> list[LibraryInvitationOut]:
    """List invitations addressed to the viewer.

    Auth: authenticated viewer only (sees own invites).
    Order: created_at DESC, id DESC.
    """
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    result = db.execute(
        text("""
            SELECT i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
                   i.role, i.status, i.created_at, i.responded_at,
                   u.email, u.display_name
            FROM library_invitations i
            JOIN users u ON u.id = i.invitee_user_id
            WHERE i.invitee_user_id = :uid AND i.status = :status
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
        """),
        {"uid": viewer_id, "status": status, "limit": limit},
    )

    return [_invitation_row_to_out(r, with_user_info=True) for r in result.fetchall()]


def accept_library_invite(
    db: Session,
    viewer_id: UUID,
    invite_id: UUID,
) -> AcceptLibraryInviteResponse:
    """Accept a library invitation.

    Transactional: lock invite -> state check -> membership upsert ->
    invite update -> backfill-job upsert -> commit.

    Raises:
        NotFoundError: Invite not found or not for viewer (masked).
        ConflictError: Invite not in pending state (unless idempotent accepted).
        ForbiddenError: Target library is default (defensive guard).
    """
    with transaction(db):
        # Step 1: Lock invite row by id + invitee
        result = db.execute(
            text("""
                SELECT id, library_id, inviter_user_id, invitee_user_id,
                       role, status, created_at, responded_at
                FROM library_invitations
                WHERE id = :invite_id AND invitee_user_id = :uid
                FOR UPDATE
            """),
            {"invite_id": invite_id, "uid": viewer_id},
        )
        inv = result.fetchone()

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        current_status = inv[5]
        invite_library_id = inv[1]
        invite_role = inv[4]

        # Step 2: Idempotent on already accepted
        if current_status == "accepted":
            invite_out = _invitation_row_to_out(inv)
            # Fetch current membership to return
            mem = db.execute(
                text("""
                    SELECT library_id, user_id, role FROM memberships
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": invite_library_id, "uid": viewer_id},
            ).fetchone()
            membership_out = InviteAcceptMembershipOut(
                library_id=mem[0] if mem else invite_library_id,
                user_id=viewer_id,
                role=mem[2] if mem else invite_role,
            )
            return AcceptLibraryInviteResponse(
                invite=invite_out,
                membership=membership_out,
                idempotent=True,
                backfill_job_status="completed",
            )

        # Step 3: Non-pending is conflict
        if current_status != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

        # Step 4: Defensive guard — target library must be non-default
        lib_check = db.execute(
            text("SELECT is_default FROM libraries WHERE id = :lid"),
            {"lid": invite_library_id},
        ).fetchone()
        if lib_check is None or lib_check[0]:
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
                "Cannot accept invite to default library",
            )

        membership = db.execute(
            text("""
                SELECT role
                FROM memberships
                WHERE library_id = :lid
                  AND user_id = :uid
            """),
            {"lid": invite_library_id, "uid": viewer_id},
        ).fetchone()
        if membership is None:
            db.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, :role)
                """),
                {"lid": invite_library_id, "uid": viewer_id, "role": invite_role},
            )

        # Step 6: Update invite to accepted
        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE library_invitations
                SET status = 'accepted', responded_at = :now
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id, "now": now},
        )

        # Step 7: Upsert durable backfill job
        # Find the invitee's default library
        default_lib = db.execute(
            text("""
                SELECT id FROM libraries
                WHERE owner_user_id = :uid AND is_default = true
            """),
            {"uid": viewer_id},
        ).fetchone()

        backfill_job_status = "pending"
        if default_lib is not None:
            job = db.execute(
                text("""
                    SELECT status
                    FROM default_library_backfill_jobs
                    WHERE default_library_id = :dlid
                      AND source_library_id = :slid
                      AND user_id = :uid
                """),
                {
                    "dlid": default_lib[0],
                    "slid": invite_library_id,
                    "uid": viewer_id,
                },
            ).fetchone()
            if job is None:
                db.execute(
                    text("""
                        INSERT INTO default_library_backfill_jobs
                            (default_library_id, source_library_id, user_id,
                             status, attempts, last_error_code, updated_at, finished_at)
                        VALUES (:dlid, :slid, :uid, 'pending', 0, NULL, now(), NULL)
                    """),
                    {
                        "dlid": default_lib[0],
                        "slid": invite_library_id,
                        "uid": viewer_id,
                    },
                )
            else:
                db.execute(
                    text("""
                        UPDATE default_library_backfill_jobs
                        SET status = 'pending',
                            attempts = 0,
                            last_error_code = NULL,
                            updated_at = now(),
                            finished_at = NULL
                        WHERE default_library_id = :dlid
                          AND source_library_id = :slid
                          AND user_id = :uid
                    """),
                    {
                        "dlid": default_lib[0],
                        "slid": invite_library_id,
                        "uid": viewer_id,
                    },
                )

        # Refetch updated invite row
        updated = db.execute(
            text("""
                SELECT id, library_id, inviter_user_id, invitee_user_id,
                       role, status, created_at, responded_at
                FROM library_invitations
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id},
        ).fetchone()

    invite_out = _invitation_row_to_out(updated)
    membership_out = InviteAcceptMembershipOut(
        library_id=invite_library_id,
        user_id=viewer_id,
        role=invite_role,
    )

    # Step 9: Post-commit best-effort enqueue (non-fatal)
    if default_lib is not None:
        _enqueue_default_library_backfill_job(default_lib[0], invite_library_id, viewer_id)

    return AcceptLibraryInviteResponse(
        invite=invite_out,
        membership=membership_out,
        idempotent=False,
        backfill_job_status=backfill_job_status,
    )


def decline_library_invite(
    db: Session,
    viewer_id: UUID,
    invite_id: UUID,
) -> DeclineLibraryInviteResponse:
    """Decline a library invitation.

    pending -> declined. declined -> declined is idempotent.
    accepted|revoked -> 409.

    Raises:
        NotFoundError: Invite not found or not for viewer (masked).
        ConflictError: Invite not in pending state (unless idempotent declined).
    """
    with transaction(db):
        result = db.execute(
            text("""
                SELECT id, library_id, inviter_user_id, invitee_user_id,
                       role, status, created_at, responded_at
                FROM library_invitations
                WHERE id = :invite_id AND invitee_user_id = :uid
                FOR UPDATE
            """),
            {"invite_id": invite_id, "uid": viewer_id},
        )
        inv = result.fetchone()

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        current_status = inv[5]

        # Idempotent on already declined
        if current_status == "declined":
            return DeclineLibraryInviteResponse(
                invite=_invitation_row_to_out(inv),
                idempotent=True,
            )

        if current_status != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE library_invitations
                SET status = 'declined', responded_at = :now
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id, "now": now},
        )

        updated = db.execute(
            text("""
                SELECT id, library_id, inviter_user_id, invitee_user_id,
                       role, status, created_at, responded_at
                FROM library_invitations
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id},
        ).fetchone()

    return DeclineLibraryInviteResponse(
        invite=_invitation_row_to_out(updated),
        idempotent=False,
    )


def revoke_library_invite(
    db: Session,
    viewer_id: UUID,
    invite_id: UUID,
) -> None:
    """Revoke a library invitation.

    Auth: viewer must be admin/owner of the invite's library.
    pending -> revoked. revoked -> revoked is idempotent (204).
    accepted|declined -> 409.

    Raises:
        NotFoundError: Invite not found or not visible to caller (masked).
        ForbiddenError: Caller is member but not admin.
        ConflictError: Invite in terminal non-revoked state.
    """
    with transaction(db):
        # Fetch the invite
        inv_result = db.execute(
            text("""
                SELECT i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
                       i.role, i.status, i.created_at, i.responded_at
                FROM library_invitations i
                WHERE i.id = :invite_id
                FOR UPDATE
            """),
            {"invite_id": invite_id},
        )
        inv = inv_result.fetchone()

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        invite_library_id = inv[1]

        # Check caller is member of the invite's library
        membership = db.execute(
            text("""
                SELECT role FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"lid": invite_library_id, "uid": viewer_id},
        ).fetchone()

        if membership is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        if membership[0] != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

        current_status = inv[5]

        # Idempotent on already revoked
        if current_status == "revoked":
            return

        if current_status != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE library_invitations
                SET status = 'revoked', responded_at = :now
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id, "now": now},
        )


def _enqueue_default_library_backfill_job(
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
    request_id: str | None = None,
) -> bool:
    """Best-effort enqueue of backfill worker task.

    Delegates to shared enqueue helper. Never raises.
    The durable backfill job row is authoritative; this is advisory.
    """
    from nexus.services.default_library_closure import enqueue_backfill_task

    return enqueue_backfill_task(
        default_library_id, source_library_id, user_id, request_id=request_id
    )
