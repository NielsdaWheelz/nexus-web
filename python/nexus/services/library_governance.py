"""Library governance: the `libraries` and `memberships` tables.

Owns library CRUD, membership/role management, ownership transfer, the
membership-fetch-and-lock guards reused across the library domain, and the
libraries/memberships access checks used by ingest paths. Entry rows, invitations,
and the default-library closure are owned by their own modules.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.library import LibraryMemberOut, LibraryOut, LibraryRole
from nexus.storage.client import StorageError, get_storage_client

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LibraryMembershipContext:
    """A library row joined with the viewer's membership role. The frozen result of
    `lock_library_for_member`; consumers read fields by name instead of unpacking a
    positional tuple."""

    library_id: UUID
    is_default: bool
    owner_user_id: UUID
    name: str
    color: str | None
    role: LibraryRole
    created_at: datetime
    updated_at: datetime


def _library_out_from_row(row) -> LibraryOut:
    return LibraryOut(
        id=row["id"],
        name=row["name"],
        color=row["color"],
        owner_user_id=row["owner_user_id"],
        is_default=row["is_default"],
        role=row["role"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def lock_library_for_member(
    db: Session, viewer_id: UUID, library_id: UUID, *, lock: bool = True
) -> LibraryMembershipContext:
    """Fetch a library joined with the viewer's membership; mask a non-member as 404.

    With `lock=True` (the default for mutations) the library row is `FOR UPDATE OF l`
    locked. Read-only auth checks pass `lock=False`.
    """
    lock_clause = "FOR UPDATE OF l" if lock else ""
    row = (
        db.execute(
            text(f"""
            SELECT l.id, l.is_default, l.owner_user_id, l.name, l.color,
                   m.role, l.created_at, l.updated_at
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
            {lock_clause}
        """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return LibraryMembershipContext(
        library_id=row["id"],
        is_default=row["is_default"],
        owner_user_id=row["owner_user_id"],
        name=row["name"],
        color=row["color"],
        role=row["role"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def require_admin(role: LibraryRole) -> None:
    """Raise E_FORBIDDEN if role is not admin."""
    if role != "admin":
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")


def require_non_default(is_default: bool) -> None:
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


def _lock_memberships_and_repair_owner(db: Session, library_id: UUID, owner_user_id: UUID) -> None:
    """Gap-lock the library's membership rows, then repair the owner-admin invariant — the
    shared preamble for every membership mutation (role change, removal, transfer)."""
    db.execute(
        text("SELECT 1 FROM memberships WHERE library_id = :lid FOR UPDATE"),
        {"lid": library_id},
    )
    _repair_owner_admin_invariant(db, library_id, owner_user_id)


def create_library(db: Session, viewer_id: UUID, name: str) -> LibraryOut:
    """Create a new non-default library with the creator as owner-admin."""
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")

    with transaction(db):
        row = (
            db.execute(
                text("""
                INSERT INTO libraries (name, color, owner_user_id, is_default)
                VALUES (:name, NULL, :viewer_id, false)
                RETURNING id, name, color, owner_user_id, is_default, created_at, updated_at
            """),
                {"name": name, "viewer_id": viewer_id},
            )
            .mappings()
            .fetchone()
        )
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": row["id"], "user_id": viewer_id},
        )

    return LibraryOut(
        id=row["id"],
        name=row["name"],
        color=row["color"],
        owner_user_id=row["owner_user_id"],
        is_default=row["is_default"],
        role="admin",
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def rename_library(db: Session, viewer_id: UUID, library_id: UUID, name: str) -> LibraryOut:
    """Rename a non-default library. Admin-only; default library forbidden."""
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")

    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        require_admin(ctx.role)

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
        id=ctx.library_id,
        name=name,
        color=ctx.color,
        owner_user_id=ctx.owner_user_id,
        is_default=ctx.is_default,
        role=ctx.role,
        created_at=ctx.created_at,
        updated_at=now,
    )


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Delete a non-default library. Owner-only; non-owner admins get E_OWNER_REQUIRED."""
    from nexus.services import library_entries, media_deletion
    from nexus.services.default_library_closure import remove_media_from_non_default_closure

    storage_paths: list[str] = []
    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        if ctx.owner_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED, "Only the library owner can delete it"
            )

        media_ids = library_entries.list_media_ids_in_library(db, library_id)
        for media_id in media_ids:
            remove_media_from_non_default_closure(db, library_id, media_id)

        _delete_library_intelligence_rows(db, library_id)

        library_entries.delete_library_entries(db, library_id)
        db.execute(
            text("DELETE FROM libraries WHERE id = :library_id"),
            {"library_id": library_id},
        )

        for media_id in media_ids:
            paths = media_deletion.delete_document_media_if_unreferenced(db, media_id)
            if paths:
                storage_paths.extend(paths)

    if storage_paths:
        storage_client = get_storage_client()
        for storage_path in storage_paths:
            try:
                storage_client.delete_object(storage_path)
            except StorageError as exc:
                # justify-ignore-error: library deletion has already committed
                # the DB state that makes this object unreachable.
                logger.warning(
                    "library_storage_delete_failed storage_path=%s error=%s",
                    storage_path,
                    exc.message,
                )


def _delete_library_intelligence_rows(db: Session, library_id: UUID) -> None:
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_evidence e
            USING library_intelligence_claims c, library_intelligence_versions v
            WHERE e.claim_id = c.id
              AND c.version_id = v.id
              AND v.library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_claims c
            USING library_intelligence_versions v
            WHERE c.version_id = v.id
              AND v.library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_nodes n
            USING library_intelligence_versions v
            WHERE n.version_id = v.id
              AND v.library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_sections s
            USING library_intelligence_versions v
            WHERE s.version_id = v.id
              AND v.library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET active_version_id = NULL,
                updated_at = now()
            WHERE library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_versions WHERE library_id = :library_id"),
        {"library_id": library_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_builds WHERE library_id = :library_id"),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            DELETE FROM library_source_set_items i
            USING library_source_set_versions s
            WHERE i.source_set_version_id = s.id
              AND s.library_id = :library_id
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_artifacts WHERE library_id = :library_id"),
        {"library_id": library_id},
    )
    db.execute(
        text("DELETE FROM library_source_set_versions WHERE library_id = :library_id"),
        {"library_id": library_id},
    )


def list_libraries(db: Session, viewer_id: UUID, limit: int = 100) -> list[LibraryOut]:
    """List all libraries the viewer is a member of, ordered created_at ASC, id ASC."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    rows = (
        db.execute(
            text("""
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default,
                   l.created_at, l.updated_at, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            ORDER BY l.created_at ASC, l.id ASC
            LIMIT :limit
        """),
            {"viewer_id": viewer_id, "limit": limit},
        )
        .mappings()
        .all()
    )
    return [_library_out_from_row(row) for row in rows]


def get_library(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOut:
    """Get a single library the viewer is a member of; mask a non-member as 404."""
    row = (
        db.execute(
            text("""
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default,
                   l.created_at, l.updated_at, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
        """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return _library_out_from_row(row)


def list_library_members(
    db: Session, viewer_id: UUID, library_id: UUID, limit: int = 100
) -> list[LibraryMemberOut]:
    """List members of a library. Admin-only; owner first, then admin, then member."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    ctx = lock_library_for_member(db, viewer_id, library_id, lock=False)
    require_admin(ctx.role)

    rows = (
        db.execute(
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
            {"library_id": library_id, "owner_user_id": ctx.owner_user_id, "limit": limit},
        )
        .mappings()
        .all()
    )

    return [
        LibraryMemberOut(
            user_id=row["user_id"],
            role=row["role"],
            is_owner=(row["user_id"] == ctx.owner_user_id),
            created_at=row["created_at"],
            email=row["email"],
            display_name=row["display_name"],
        )
        for row in rows
    ]


def update_library_member_role(
    db: Session, viewer_id: UUID, library_id: UUID, target_user_id: UUID, role: str
) -> LibraryMemberOut:
    """Update a member's role. Admin-only; cannot change owner's role; default forbidden."""
    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_admin(ctx.role)
        require_non_default(ctx.is_default)

        _lock_memberships_and_repair_owner(db, library_id, ctx.owner_user_id)

        if target_user_id == ctx.owner_user_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                "Cannot change owner role; transfer ownership first",
            )

        target = (
            db.execute(
                text("""
                SELECT user_id, role, created_at FROM memberships
                WHERE library_id = :lid AND user_id = :uid
            """),
                {"lid": library_id, "uid": target_user_id},
            )
            .mappings()
            .fetchone()
        )
        if target is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Member not found")

        if target["role"] == role:
            return LibraryMemberOut(
                user_id=target["user_id"],
                role=target["role"],
                is_owner=False,
                created_at=target["created_at"],
            )

        db.execute(
            text("""
                UPDATE memberships SET role = :role
                WHERE library_id = :lid AND user_id = :uid
            """),
            {"role": role, "lid": library_id, "uid": target_user_id},
        )

    return LibraryMemberOut(
        user_id=target["user_id"],
        role=role,
        is_owner=False,
        created_at=target["created_at"],
    )


def remove_library_member(
    db: Session, viewer_id: UUID, library_id: UUID, target_user_id: UUID
) -> None:
    """Remove a member. Admin-only; cannot remove owner; default forbidden; idempotent."""
    from nexus.services.default_library_closure import remove_member_closure_and_gc

    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_admin(ctx.role)
        require_non_default(ctx.is_default)

        _lock_memberships_and_repair_owner(db, library_id, ctx.owner_user_id)

        if target_user_id == ctx.owner_user_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                "Cannot remove owner; transfer ownership first",
            )

        target = db.execute(
            text("SELECT 1 FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": library_id, "uid": target_user_id},
        ).fetchone()
        if target is None:
            return

        db.execute(
            text("DELETE FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": library_id, "uid": target_user_id},
        )
        remove_member_closure_and_gc(db, library_id, target_user_id)


def transfer_library_ownership(
    db: Session, viewer_id: UUID, library_id: UUID, new_owner_user_id: UUID
) -> LibraryOut:
    """Transfer ownership to another member. Owner-only; previous owner stays admin."""
    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        if ctx.owner_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED,
                "Only the library owner can transfer ownership",
            )

        _lock_memberships_and_repair_owner(db, library_id, ctx.owner_user_id)

        if new_owner_user_id == ctx.owner_user_id:
            return LibraryOut(
                id=ctx.library_id,
                name=ctx.name,
                color=ctx.color,
                owner_user_id=ctx.owner_user_id,
                is_default=ctx.is_default,
                role=ctx.role,
                created_at=ctx.created_at,
                updated_at=ctx.updated_at,
            )

        target = db.execute(
            text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": library_id, "uid": new_owner_user_id},
        ).fetchone()
        if target is None:
            raise ConflictError(
                ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID,
                "Transfer target must be an existing member",
            )

        if target[0] != "admin":
            db.execute(
                text("""
                    UPDATE memberships SET role = 'admin'
                    WHERE library_id = :lid AND user_id = :uid
                """),
                {"lid": library_id, "uid": new_owner_user_id},
            )

        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE libraries SET owner_user_id = :new_owner, updated_at = :now
                WHERE id = :lid
            """),
            {"new_owner": new_owner_user_id, "now": now, "lid": library_id},
        )

    return LibraryOut(
        id=ctx.library_id,
        name=ctx.name,
        color=ctx.color,
        owner_user_id=new_owner_user_id,
        is_default=ctx.is_default,
        created_at=ctx.created_at,
        updated_at=now,
        role="admin",
    )


def find_default_library_id(db: Session, user_id: UUID) -> UUID | None:
    """The user's default library id, or None if they have none (tolerant lookup)."""
    row = db.execute(
        text("SELECT id FROM libraries WHERE owner_user_id = :uid AND is_default = true"),
        {"uid": user_id},
    ).fetchone()
    return UUID(str(row[0])) if row is not None else None


def default_library_id_for_user(db: Session, user_id: UUID) -> UUID:
    """The user's default library id; raises E_NOT_FOUND if absent."""
    library_id = find_default_library_id(db, user_id)
    if library_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Default library not found")
    return library_id


def resolve_accessible_non_default_library_ids(
    db: Session, viewer_id: UUID, library_ids: list[UUID]
) -> list[UUID]:
    """Dedupe the viewer's default id, then assert every remaining id is one the viewer
    owns or is a member of. Raises E_LIBRARY_FORBIDDEN if any is inaccessible; returns
    the accessible non-default target set."""
    if not library_ids:
        return []
    default_library_id = default_library_id_for_user(db, viewer_id)
    targets = list({lid for lid in library_ids if lid != default_library_id})
    if not targets:
        return []
    accessible_rows = db.execute(
        text("""
            SELECT l.id
            FROM libraries l
            LEFT JOIN memberships m
              ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = ANY(:library_ids)
              AND (l.owner_user_id = :viewer_id OR m.user_id IS NOT NULL)
        """),
        {"viewer_id": viewer_id, "library_ids": targets},
    ).fetchall()
    accessible_ids = {UUID(str(row[0])) for row in accessible_rows}
    if accessible_ids != set(targets):
        raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not accessible")
    return targets


def validate_libraries_accessible(db: Session, viewer_id: UUID, library_ids: list[UUID]) -> None:
    """Raise ForbiddenError(E_LIBRARY_FORBIDDEN) if any id is inaccessible.

    Use at the top of any ingest path before creating media, so a forbidden
    library_id rejects the request atomically (no orphan rows). The viewer's default
    library id and duplicates are silently deduped. An empty list is a no-op.
    """
    resolve_accessible_non_default_library_ids(db, viewer_id, library_ids)
