"""Library governance: the `libraries` and `memberships` tables.

Owns library CRUD, membership/role management, ownership transfer, the
membership-fetch-and-lock guards reused across the library domain, and the
libraries/memberships access checks used by ingest paths. Entry rows, invitations,
and the default-library closure are owned by their own modules.
"""

import base64
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
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
from nexus.schemas.library import (
    LibraryDestinationOut,
    LibraryMemberOut,
    LibraryOut,
    LibraryPageInfo,
    LibraryRole,
)
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
    system_key: str | None
    created_at: datetime
    updated_at: datetime


def _library_capabilities(*, role: str, is_default: bool, system_key: str | None) -> dict:
    """Derive the user-facing mutability affordances for a LibraryOut. System and
    default libraries are immutable; otherwise rename/delete/entry-edit gate on admin."""
    mutable = system_key is None and not is_default
    return {
        "can_rename": mutable and role == "admin",
        "can_delete": mutable and role == "admin",
        "can_edit_entries": mutable and role == "admin",
    }


def _library_out_from_row(row) -> LibraryOut:
    return LibraryOut(
        id=row["id"],
        name=row["name"],
        color=row["color"],
        owner_user_id=row["owner_user_id"],
        is_default=row["is_default"],
        role=row["role"],
        system_key=row["system_key"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        **_library_capabilities(
            role=row["role"], is_default=row["is_default"], system_key=row["system_key"]
        ),
    )


def _library_destination_out_from_row(row) -> LibraryDestinationOut:
    return LibraryDestinationOut(
        id=row["id"],
        name=row["name"],
        color=row["color"],
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
                   m.role, l.system_key, l.created_at, l.updated_at
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
        system_key=row["system_key"],
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


def require_not_system(system_key: str | None) -> None:
    """Raise E_LIBRARY_FORBIDDEN for system-owned libraries (user mutations are blocked)."""
    if system_key is not None:
        raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "System library cannot be modified")


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
        system_key=None,
        can_rename=True,
        can_delete=True,
        can_edit_entries=True,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def ensure_system_library(db: Session, *, system_key: str, name: str, owner_user_id: UUID) -> UUID:
    """Create or return the system library identified by ``system_key`` (idempotent).

    System maintenance command. System libraries are protected from user
    rename/delete/share/entry edits (``system_key IS NOT NULL``); only explicit system
    commands like this one create or mutate them. The owner gets an admin membership.
    """
    with transaction(db):
        existing = db.execute(
            text("SELECT id FROM libraries WHERE system_key = :system_key"),
            {"system_key": system_key},
        ).scalar_one_or_none()
        if existing is not None:
            return existing
        library_id = db.execute(
            text(
                """
                INSERT INTO libraries (name, owner_user_id, is_default, system_key)
                VALUES (:name, :owner_user_id, false, :system_key)
                RETURNING id
                """
            ),
            {"name": name, "owner_user_id": owner_user_id, "system_key": system_key},
        ).scalar_one()
        db.execute(
            text(
                "INSERT INTO memberships (library_id, user_id, role) "
                "VALUES (:library_id, :user_id, 'admin')"
            ),
            {"library_id": library_id, "user_id": owner_user_id},
        )
        return library_id


def rename_library(db: Session, viewer_id: UUID, library_id: UUID, name: str) -> LibraryOut:
    """Rename a non-default library. Admin-only; default library forbidden."""
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")

    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        require_not_system(ctx.system_key)
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
        system_key=ctx.system_key,
        created_at=ctx.created_at,
        updated_at=now,
        **_library_capabilities(
            role=ctx.role, is_default=ctx.is_default, system_key=ctx.system_key
        ),
    )


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Delete a non-default library. Owner-only; non-owner admins get E_OWNER_REQUIRED."""
    from nexus.services import library_entries, media_deletion
    from nexus.services.default_library_closure import remove_media_from_non_default_closure
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
    from nexus.services.resource_graph.refs import ResourceRef

    storage_paths: list[str] = []
    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        require_not_system(ctx.system_key)
        if ctx.owner_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED, "Only the library owner can delete it"
            )

        media_ids = library_entries.list_media_ids_in_library(db, library_id)
        for media_id in media_ids:
            remove_media_from_non_default_closure(db, library_id, media_id)

        _delete_library_intelligence_rows(db, library_id)

        # The library itself is a graph resource: context refs and app_search
        # scopes point at ``library:<id>`` (§9.6 rule 2). Clean them with the
        # row, mirroring conversation/media delete, or they dangle as phantom
        # scopes. Cited edges sourced by the library (rule 1) — none today — die
        # the same way.
        delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="library", id=library_id))

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
    """Tear down the head + its revisions for a deleted library (non-cascading FKs).

    Order: null the circular head->revision pointer, then each artifact/revision
    graph ref (citations die with their domain parent, §9.6 rule 1) + events,
    then revisions, then the head.
    """
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
    from nexus.services.resource_graph.refs import ResourceRef

    revision_filter = (
        "revision_id IN (SELECT r.id FROM library_intelligence_artifact_revisions r "
        "JOIN library_intelligence_artifacts a ON a.id = r.artifact_id "
        "WHERE a.library_id = :library_id)"
    )
    artifact_ids = [
        row[0]
        for row in db.execute(
            text("SELECT id FROM library_intelligence_artifacts WHERE library_id = :library_id"),
            {"library_id": library_id},
        )
    ]
    revision_ids = [
        row[0]
        for row in db.execute(
            text(
                """
                SELECT r.id
                FROM library_intelligence_artifact_revisions r
                JOIN library_intelligence_artifacts a ON a.id = r.artifact_id
                WHERE a.library_id = :library_id
                """
            ),
            {"library_id": library_id},
        )
    ]
    db.execute(
        text(
            "UPDATE library_intelligence_artifacts "
            "SET current_revision_id = NULL WHERE library_id = :library_id"
        ),
        {"library_id": library_id},
    )
    for artifact_id in artifact_ids:
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="library_intelligence_artifact", id=artifact_id)
        )
    for revision_id in revision_ids:
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="library_intelligence_revision", id=revision_id)
        )
    db.execute(
        text(f"DELETE FROM library_intelligence_revision_events WHERE {revision_filter}"),
        {"library_id": library_id},
    )
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_artifact_revisions
            WHERE artifact_id IN (
                SELECT id FROM library_intelligence_artifacts WHERE library_id = :library_id
            )
            """
        ),
        {"library_id": library_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_artifacts WHERE library_id = :library_id"),
        {"library_id": library_id},
    )


def _encode_library_cursor(row, *, viewer_id: UUID) -> str:
    payload = {
        "k": "libraries",
        "viewer_id": str(viewer_id),
        "created_at": row["created_at"].isoformat(),
        "id": str(row["id"]),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def _decode_library_cursor(cursor: str, *, viewer_id: UUID) -> tuple[datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if payload.get("k") != "libraries" or UUID(str(payload["viewer_id"])) != viewer_id:
            raise ValueError
        return datetime.fromisoformat(str(payload["created_at"])), UUID(str(payload["id"]))
    except Exception:
        # justify-ignore-error: malformed cursor input is an expected API error path.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def list_libraries(
    db: Session, viewer_id: UUID, *, cursor: str | None = None, limit: int = 100
) -> tuple[list[LibraryOut], LibraryPageInfo]:
    """List all libraries the viewer is a member of, ordered created_at ASC, id ASC."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)
    cursor_clause = ""
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit + 1}
    if cursor is not None:
        cursor_created_at, cursor_id = _decode_library_cursor(cursor, viewer_id=viewer_id)
        cursor_clause = """
          AND (
            l.created_at > :cursor_created_at
            OR (l.created_at = :cursor_created_at AND l.id > :cursor_id)
          )
        """
        params.update({"cursor_created_at": cursor_created_at, "cursor_id": cursor_id})

    rows = (
        db.execute(
            text(f"""
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default,
                   l.system_key, l.created_at, l.updated_at, m.role
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE 1 = 1
              {cursor_clause}
            ORDER BY l.created_at ASC, l.id ASC
            LIMIT :limit
        """),
            params,
        )
        .mappings()
        .all()
    )
    page_rows = rows[:limit]
    next_cursor = (
        _encode_library_cursor(page_rows[-1], viewer_id=viewer_id) if len(rows) > limit else None
    )
    return (
        [_library_out_from_row(row) for row in page_rows],
        LibraryPageInfo(has_more=next_cursor is not None, next_cursor=next_cursor),
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _encode_destination_cursor(row, *, viewer_id: UUID) -> str:
    payload = {
        "k": "library_destinations",
        "viewer_id": str(viewer_id),
        "rank": int(row["match_rank"]),
        "updated_at": row["updated_at"].isoformat(),
        "created_at": row["created_at"].isoformat(),
        "id": str(row["id"]),
        "q": str(row["cursor_q"]),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def _decode_destination_cursor(
    cursor: str, q: str, *, viewer_id: UUID
) -> tuple[int, datetime, datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if (
            payload.get("k") != "library_destinations"
            or UUID(str(payload["viewer_id"])) != viewer_id
            or payload["q"] != q
        ):
            raise ValueError
        return (
            int(payload["rank"]),
            datetime.fromisoformat(str(payload["updated_at"])),
            datetime.fromisoformat(str(payload["created_at"])),
            UUID(str(payload["id"])),
        )
    except Exception:
        # justify-ignore-error: malformed cursor input is an expected API error path.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def list_writable_library_destinations(
    db: Session,
    viewer_id: UUID,
    *,
    q: str | None = None,
    cursor: str | None = None,
    limit: int = 25,
) -> tuple[list[LibraryDestinationOut], str | None]:
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 50)
    query = q or ""
    cursor_clause = ""
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "q": query,
        "prefix_q": f"{_escape_like(query)}%",
        "contains_q": f"%{_escape_like(query)}%",
        "limit": limit + 1,
    }
    if cursor is not None:
        rank, updated_at, created_at, library_id = _decode_destination_cursor(
            cursor, query, viewer_id=viewer_id
        )
        cursor_clause = """
          AND (
            ranked.match_rank > :cursor_rank
            OR (ranked.match_rank = :cursor_rank AND ranked.updated_at < :cursor_updated_at)
            OR (
              ranked.match_rank = :cursor_rank
              AND ranked.updated_at = :cursor_updated_at
              AND ranked.created_at < :cursor_created_at
            )
            OR (
              ranked.match_rank = :cursor_rank
              AND ranked.updated_at = :cursor_updated_at
              AND ranked.created_at = :cursor_created_at
              AND ranked.id > :cursor_id
            )
          )
        """
        params.update(
            {
                "cursor_rank": rank,
                "cursor_updated_at": updated_at,
                "cursor_created_at": created_at,
                "cursor_id": library_id,
            }
        )

    rows = (
        db.execute(
            text(f"""
            WITH ranked AS (
                SELECT
                    l.id,
                    l.name,
                    l.color,
                    l.created_at,
                    l.updated_at,
                    :q AS cursor_q,
                    CASE
                        WHEN :q = '' THEN 3
                        WHEN lower(l.name) = :q THEN 0
                        WHEN lower(l.name) LIKE :prefix_q ESCAPE '\\' THEN 1
                        ELSE 2
                    END AS match_rank
                FROM libraries l
                LEFT JOIN memberships m
                  ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.is_default = false
                  AND l.system_key IS NULL
                  AND (l.owner_user_id = :viewer_id OR m.role = 'admin')
                  AND (:q = '' OR lower(l.name) LIKE :contains_q ESCAPE '\\')
            )
            SELECT *
            FROM ranked
            WHERE 1 = 1
              {cursor_clause}
            ORDER BY match_rank ASC, updated_at DESC, created_at DESC, id ASC
            LIMIT :limit
        """),
            params,
        )
        .mappings()
        .all()
    )
    page_rows = rows[:limit]
    next_cursor = (
        _encode_destination_cursor(page_rows[-1], viewer_id=viewer_id)
        if len(rows) > limit
        else None
    )
    return [_library_destination_out_from_row(row) for row in page_rows], next_cursor


def get_library(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOut:
    """Get a single library the viewer is a member of; mask a non-member as 404."""
    row = (
        db.execute(
            text("""
            SELECT l.id, l.name, l.color, l.owner_user_id, l.is_default,
                   l.system_key, l.created_at, l.updated_at, m.role
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
        require_not_system(ctx.system_key)

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
        require_not_system(ctx.system_key)

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
        require_not_system(ctx.system_key)
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
                system_key=ctx.system_key,
                created_at=ctx.created_at,
                updated_at=ctx.updated_at,
                **_library_capabilities(
                    role=ctx.role, is_default=ctx.is_default, system_key=ctx.system_key
                ),
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
        system_key=ctx.system_key,
        **_library_capabilities(role="admin", is_default=ctx.is_default, system_key=ctx.system_key),
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


def resolve_writable_non_default_library_ids(
    db: Session, viewer_id: UUID, library_ids: list[UUID]
) -> list[UUID]:
    """Validate user-selected write destinations and preserve input order."""
    if not library_ids:
        return []
    if len(set(library_ids)) != len(library_ids):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "library_ids must not contain duplicates",
        )
    rows = (
        db.execute(
            text("""
                SELECT l.id, l.is_default, l.owner_user_id, l.system_key, m.role
                FROM libraries l
                LEFT JOIN memberships m
                  ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = ANY(:library_ids)
            """),
            {"viewer_id": viewer_id, "library_ids": library_ids},
        )
        .mappings()
        .all()
    )
    rows_by_id = {UUID(str(row["id"])): row for row in rows}
    targets: list[UUID] = []
    for library_id in library_ids:
        row = rows_by_id.get(library_id)
        if row is None:
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not writable")
        if row["owner_user_id"] != viewer_id and row["role"] != "admin":
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not writable")
        if row["is_default"]:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Default library cannot be selected",
            )
        if row["system_key"] is not None:
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not writable")
        targets.append(library_id)
    return targets


def validate_writable_library_destinations(
    db: Session, viewer_id: UUID, library_ids: list[UUID]
) -> None:
    resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
