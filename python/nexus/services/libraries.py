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
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryMediaOut,
    LibraryMemberOut,
    LibraryOut,
    LibraryRole,
)
from nexus.schemas.media import MediaOut
from nexus.services.capabilities import derive_capabilities

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

        role = membership[0]  # membership[1] = is_default, used below
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

        # S4: If adding to default library, also create intrinsic provenance row
        if is_default_library:
            db.execute(
                text("""
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:library_id, :media_id)
                    ON CONFLICT (default_library_id, media_id) DO NOTHING
                """),
                {"library_id": library_id, "media_id": media_id},
            )

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

            # S4: Remove intrinsic provenance row
            db.execute(
                text("""
                    DELETE FROM default_library_intrinsics
                    WHERE default_library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": library_id, "media_id": media_id},
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

    # Fetch media with fields needed for capabilities
    result = db.execute(
        text("""
            SELECT m.id, m.kind, m.title, m.canonical_source_url,
                   m.processing_status, m.failure_stage, m.last_error_code,
                   m.external_playback_url, m.created_at, m.updated_at,
                   EXISTS(SELECT 1 FROM media_file mf WHERE mf.media_id = m.id) as has_file,
                   EXISTS(SELECT 1 FROM fragments f WHERE f.media_id = m.id) as has_fragments
            FROM media m
            JOIN library_media lm ON lm.media_id = m.id
            WHERE lm.library_id = :library_id
            ORDER BY lm.created_at DESC, m.id DESC
            LIMIT :limit
        """),
        {"library_id": library_id, "limit": limit},
    )

    media_list = []
    for row in result.fetchall():
        capabilities = derive_capabilities(
            kind=row[1],
            processing_status=row[4],
            last_error_code=row[6],
            media_file_exists=row[10],
            external_playback_url_exists=row[7] is not None,
            has_fragments=row[11],
            has_plain_text=False,  # TODO: Check media.plain_text when added
        )
        media_list.append(
            MediaOut(
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
        )
    return media_list


# =============================================================================
# S4 PR-03: Library governance
# =============================================================================


def _fetch_library_with_membership(
    db: Session, viewer_id: UUID, library_id: UUID, *, lock: bool = False
) -> tuple:
    """Fetch library row joined with viewer membership.

    Returns (library_id, is_default, owner_user_id, created_at, updated_at, name, role)
    or raises masked 404 if not found or viewer is not a member.
    """
    lock_clause = "FOR UPDATE OF l" if lock else ""
    result = db.execute(
        text(f"""
            SELECT l.id, l.is_default, l.owner_user_id, l.created_at, l.updated_at,
                   l.name, m.role
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
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :owner_user_id, 'admin')
            ON CONFLICT (library_id, user_id)
            DO UPDATE SET role = 'admin'
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
            SELECT m.user_id, m.role, m.created_at
            FROM memberships m
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
    """
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
                SELECT l.id, l.name, l.owner_user_id, l.is_default, l.created_at,
                       l.updated_at, m.role
                FROM libraries l
                LEFT JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = :library_id
                FOR UPDATE OF l
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        row = result.fetchone()

        if row is None or row[6] is None:
            raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")

        is_default = row[3]
        current_owner = row[2]
        viewer_role = row[6]

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
                owner_user_id=row[2],
                is_default=row[3],
                created_at=row[4],
                updated_at=row[5],
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
        owner_user_id=new_owner_user_id,
        is_default=row[3],
        created_at=row[4],
        updated_at=now,
        role="admin",
    )


# =============================================================================
# S4 PR-04: Invitation Lifecycle
# =============================================================================


def _invitation_row_to_out(row: tuple) -> LibraryInvitationOut:
    """Convert a raw invite query row to LibraryInvitationOut."""
    return LibraryInvitationOut(
        id=row[0],
        library_id=row[1],
        inviter_user_id=row[2],
        invitee_user_id=row[3],
        role=row[4],
        status=row[5],
        created_at=row[6],
        responded_at=row[7],
    )


def create_library_invite(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    invitee_user_id: UUID,
    role: LibraryRole,
) -> LibraryInvitationOut:
    """Create an invitation to a library.

    Auth: viewer must be admin/owner of target library.
    Default library targets are forbidden.
    Invitee must exist. Existing members and pending invites are conflicts.

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
            SELECT id, library_id, inviter_user_id, invitee_user_id,
                   role, status, created_at, responded_at
            FROM library_invitations
            WHERE library_id = :lid AND status = :status
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
        """),
        {"lid": library_id, "status": status, "limit": limit},
    )

    return [_invitation_row_to_out(r) for r in result.fetchall()]


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
            SELECT id, library_id, inviter_user_id, invitee_user_id,
                   role, status, created_at, responded_at
            FROM library_invitations
            WHERE invitee_user_id = :uid AND status = :status
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
        """),
        {"uid": viewer_id, "status": status, "limit": limit},
    )

    return [_invitation_row_to_out(r) for r in result.fetchall()]


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

        # Step 5: Membership upsert (ON CONFLICT DO NOTHING)
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:lid, :uid, :role)
                ON CONFLICT (library_id, user_id) DO NOTHING
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
            db.execute(
                text("""
                    INSERT INTO default_library_backfill_jobs
                        (default_library_id, source_library_id, user_id,
                         status, attempts, last_error_code, updated_at, finished_at)
                    VALUES (:dlid, :slid, :uid, 'pending', 0, NULL, now(), NULL)
                    ON CONFLICT (default_library_id, source_library_id, user_id)
                    DO UPDATE SET
                        status = 'pending',
                        attempts = 0,
                        last_error_code = NULL,
                        updated_at = now(),
                        finished_at = NULL
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

    Logging-only on failure. Returns True if dispatch succeeded.
    The durable backfill job row is authoritative; this is advisory.
    Worker task implementation is in PR-05.
    """
    try:
        # PR-05 will register the actual celery task here.
        # For now, log intent and return False (no worker available).
        logger.info(
            "backfill_enqueue: default_library=%s source_library=%s user=%s request_id=%s "
            "(worker not yet available, durable job row is authoritative)",
            default_library_id,
            source_library_id,
            user_id,
            request_id,
        )
        return False
    except Exception:
        logger.exception(
            "backfill_enqueue_failed: default_library=%s source_library=%s user=%s",
            default_library_id,
            source_library_id,
            user_id,
        )
        return False
