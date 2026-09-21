"""Library governance: the `libraries` table and the viewer's index over it."""

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    ParsedCollectionQuery,
    parse_collection_query,
)
from nexus.schemas.library import (
    CreateLibraryRequest,
    LibraryDeleteOut,
    LibraryDestinationOut,
    LibraryOut,
    LibraryRenameOut,
    LibraryRole,
)
from nexus.schemas.presence import absent, present
from nexus.services.collection_keyset import (
    Direction,
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.collection_revisions import (
    ENTRY_VISIBILITY_FAMILIES,
    CollectionFamily,
    bump_collection_families,
    bump_collection_revisions,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.keyset_cursor import (
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.sealed_handles import seal_user
from nexus.storage.client import StorageError, get_storage_client
from nexus.text import escape_like

logger = logging.getLogger(__name__)

_LIBRARY_COLUMNS = """
    l.id, l.name, l.owner_user_id, l.is_default,
    l.system_key, l.created_at, l.updated_at, m.role
"""


@dataclass(frozen=True)
class LibraryMembershipContext:
    """A library row joined with the viewer's membership role."""

    library_id: UUID
    is_default: bool
    owner_user_id: UUID
    name: str
    role: LibraryRole
    system_key: str | None
    created_at: datetime
    updated_at: datetime


def membership_context(row: Any) -> LibraryMembershipContext:
    """Adapt one `_LIBRARY_COLUMNS` row into the frozen membership context."""
    return LibraryMembershipContext(
        library_id=row["id"],
        is_default=row["is_default"],
        owner_user_id=row["owner_user_id"],
        name=row["name"],
        role=row["role"],
        system_key=row["system_key"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def library_out(
    ctx: LibraryMembershipContext,
    *,
    viewer_id: UUID,
    name: str | None = None,
    owner_user_id: UUID | None = None,
    role: LibraryRole | None = None,
    updated_at: datetime | None = None,
) -> LibraryOut:
    """The one LibraryOut builder. System and default libraries are immutable;
    common edits gate on admin, destructive ownership actions on ownership."""
    owner = ctx.owner_user_id if owner_user_id is None else owner_user_id
    effective_role = ctx.role if role is None else role
    mutable = ctx.system_key is None and not ctx.is_default
    is_owner = viewer_id == owner
    return LibraryOut(
        id=ctx.library_id,
        name=ctx.name if name is None else name,
        owner_user_handle=seal_user(owner),
        is_default=ctx.is_default,
        role=effective_role,
        system_key=ctx.system_key,
        created_at=ctx.created_at,
        updated_at=ctx.updated_at if updated_at is None else updated_at,
        can_rename=mutable and effective_role == "admin",
        can_delete=mutable and is_owner,
        can_edit_entries=mutable and effective_role == "admin",
        can_manage_members=mutable and effective_role == "admin",
        can_transfer_ownership=mutable and is_owner,
    )


def lock_library_for_member(
    db: Session, viewer_id: UUID, library_id: UUID, *, lock: bool = True
) -> LibraryMembershipContext:
    """Fetch a library joined with the viewer's membership; mask a non-member as 404.

    With `lock=True` the library row is `FOR UPDATE OF l` locked; read-only
    checks and SERIALIZABLE commands pass `lock=False`.
    """
    row = (
        db.execute(
            text(f"""
            SELECT {_LIBRARY_COLUMNS}
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.id = :library_id
            {"FOR UPDATE OF l" if lock else ""}
        """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return membership_context(row)


def lock_library_rows_in_order(db: Session, library_ids: Sequence[UUID]) -> list[UUID]:
    """Lock existing library rows in UUID order for reference mutations."""
    ordered_ids = sorted(set(library_ids))
    if not ordered_ids:
        return []
    rows = db.execute(
        text("SELECT id FROM libraries WHERE id = ANY(:library_ids) ORDER BY id FOR UPDATE"),
        {"library_ids": ordered_ids},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def require_admin(role: LibraryRole) -> None:
    """Raise E_FORBIDDEN unless the viewer is an admin of the library."""
    if role != "admin":
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")


def require_non_default(is_default: bool) -> None:
    """Raise E_DEFAULT_LIBRARY_FORBIDDEN for the viewer's virtual All library."""
    if is_default:
        raise ForbiddenError(
            ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
            "Operation not allowed on default library",
        )


def require_not_system(system_key: str | None) -> None:
    """Raise E_LIBRARY_FORBIDDEN for system-owned libraries."""
    if system_key is not None:
        raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "System library cannot be modified")


def library_member_ids(db: Session, library_id: UUID) -> list[UUID]:
    """Every current member of a library, in UUID order."""
    return [
        UUID(str(user_id))
        for user_id in db.execute(
            text("SELECT user_id FROM memberships WHERE library_id = :library_id ORDER BY user_id"),
            {"library_id": library_id},
        ).scalars()
    ]


def bump_library_index(
    db: Session, viewer_ids: Sequence[UUID], *, conversations: bool = False
) -> None:
    """Invalidate the index and entry inventories of every affected member."""
    bump_collection_families(
        db,
        viewer_ids=viewer_ids,
        families=(*ENTRY_VISIBILITY_FAMILIES, CollectionFamily.LibrariesIndex),
    )
    if conversations:
        bump_collection_revisions(
            db, viewer_ids=viewer_ids, family=CollectionFamily.ConversationIndex
        )


def keyset_page(
    db: Session,
    *,
    family: str,
    query: dict[str, object],
    plan: Sequence[SortKey],
    alias: str,
    cursor: str | None,
    limit: int,
    params: dict[str, object],
    sql: Callable[[str, str], str],
) -> tuple[list[Any], str | None]:
    """Run one keyset page for the library domain's four cursored listings.

    `sql(keyset_predicate, order_by)` returns a statement selecting `:limit`
    rows from `alias`; this binds `limit + 1` and reports the next cursor.
    """
    bound = dict(params, limit=limit + 1)
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias=alias)
        bound.update(
            keyset_params(
                plan,
                decode_keyset_cursor(
                    cursor, family=family, query=query, expected_kinds=expected_kinds(plan)
                ),
            )
        )
    rows = (
        db.execute(text(sql(keyset_sql, order_by_sql(plan, alias=alias))), bound).mappings().all()
    )
    page_rows = list(rows[:limit])
    next_cursor = (
        encode_keyset_cursor(family=family, query=query, after=after_values(plan, page_rows[-1]))
        if len(rows) > limit
        else None
    )
    return page_rows, next_cursor


def _validate_library_name(name: str) -> str:
    """Normalize a user-authored name; `All` is reserved for the All view."""
    name = name.strip()
    if not name or len(name) > 100:
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters")
    if name.casefold() == "all":
        raise InvalidRequestError(ApiErrorCode.E_NAME_INVALID, "All is reserved for the All view.")
    return name


def create_library(db: Session, viewer_id: UUID, request: CreateLibraryRequest) -> LibraryOut:
    """Create a non-default library with the creator as owner-admin, idempotent by id."""
    name = _validate_library_name(request.name)

    def attempt() -> LibraryMembershipContext:
        with transaction(db):
            existing = (
                db.execute(
                    text(f"""
                        SELECT {_LIBRARY_COLUMNS}
                        FROM libraries l
                        LEFT JOIN memberships m
                          ON m.library_id = l.id AND m.user_id = :viewer_id
                        WHERE l.id = :library_id
                    """),
                    {"library_id": request.library_id, "viewer_id": viewer_id},
                )
                .mappings()
                .fetchone()
            )
            if existing is not None:
                if (
                    existing["owner_user_id"] != viewer_id
                    or existing["name"] != name
                    or existing["is_default"]
                    or existing["system_key"] is not None
                    or existing["role"] != "admin"
                ):
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT,
                        "Library create id is already bound to a different resource",
                    )
                return membership_context(existing)

            created = (
                db.execute(
                    text("""
                        INSERT INTO libraries (id, name, owner_user_id, is_default)
                        VALUES (:library_id, :name, :viewer_id, false)
                        RETURNING id, name, owner_user_id, is_default,
                                  system_key, created_at, updated_at
                    """),
                    {"library_id": request.library_id, "name": name, "viewer_id": viewer_id},
                )
                .mappings()
                .one()
            )
            db.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                """),
                {"library_id": request.library_id, "user_id": viewer_id},
            )
            bump_collection_families(
                db,
                viewer_ids=(viewer_id,),
                families=(CollectionFamily.LibrariesIndex, CollectionFamily.LibraryEntries),
            )
            return membership_context({**created, "role": "admin"})

    return library_out(retry_serializable(db, "create_library", attempt), viewer_id=viewer_id)


def ensure_system_library(db: Session, *, system_key: str, name: str, owner_user_id: UUID) -> UUID:
    """Create or return the system library identified by `system_key` (idempotent)."""
    with transaction(db):
        existing = db.execute(
            text("SELECT id FROM libraries WHERE system_key = :system_key"),
            {"system_key": system_key},
        ).scalar_one_or_none()
        if existing is not None:
            return existing
        library_id = db.execute(
            text("""
                INSERT INTO libraries (name, owner_user_id, is_default, system_key)
                VALUES (:name, :owner_user_id, false, :system_key)
                RETURNING id
            """),
            {"name": name, "owner_user_id": owner_user_id, "system_key": system_key},
        ).scalar_one()
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
            """),
            {"library_id": library_id, "user_id": owner_user_id},
        )
        bump_collection_families(
            db,
            viewer_ids=(owner_user_id,),
            families=(CollectionFamily.LibrariesIndex, CollectionFamily.LibraryEntries),
        )
        return library_id


def rename_library(db: Session, viewer_id: UUID, library_id: UUID, name: str) -> LibraryRenameOut:
    """Rename a mutable library. Admin-only."""
    name = _validate_library_name(name)
    with transaction(db):
        ctx = lock_library_for_member(db, viewer_id, library_id)
        require_non_default(ctx.is_default)
        require_not_system(ctx.system_key)
        require_admin(ctx.role)

        now = datetime.now(UTC)
        db.execute(
            text("""
                UPDATE libraries SET name = :name, updated_at = :updated_at
                WHERE id = :library_id
            """),
            {"name": name, "updated_at": now, "library_id": library_id},
        )
        bump_library_index(db, library_member_ids(db, library_id))
        collection_revision = read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.LibrariesIndex
        )

    return LibraryRenameOut(
        library=library_out(ctx, viewer_id=viewer_id, name=name, updated_at=now),
        collection_revision=collection_revision,
    )


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryDeleteOut:
    """Delete a mutable library and everything sourced by it. Owner-only."""
    from nexus.services import library_entries, media_deletion, media_upload_sessions
    from nexus.services.artifacts import engine as artifact_engine
    from nexus.services.artifacts.dossier_types import AudienceUser
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
    from nexus.services.resource_graph.refs import ResourceRef

    def require_owner(lock: bool) -> LibraryMembershipContext:
        ctx = lock_library_for_member(db, viewer_id, library_id, lock=lock)
        require_non_default(ctx.is_default)
        require_not_system(ctx.system_key)
        if ctx.owner_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED, "Only the library owner can delete it"
            )
        return ctx

    def attempt() -> tuple[list[str], CollectionRevision]:
        with transaction(db):
            require_owner(lock=False)
            media_ids = sorted(set(library_entries.list_media_ids_in_library(db, library_id)))
            if library_entries.lock_media_rows_in_order(db, media_ids) != media_ids:
                raise TransactionRestart("library media lock set contained a missing media row")

            require_owner(lock=True)
            if sorted(set(library_entries.list_media_ids_in_library(db, library_id))) != media_ids:
                raise TransactionRestart("library media lock set changed before deletion")

            affected_user_ids = [
                UUID(str(user_id))
                for user_id in db.execute(
                    text(
                        "SELECT user_id FROM memberships "
                        "WHERE library_id = :library_id ORDER BY user_id FOR UPDATE"
                    ),
                    {"library_id": library_id},
                ).scalars()
            ]
            bump_library_index(db, affected_user_ids, conversations=True)
            # Prelock the whole possible Dossier head union once, in the owner's
            # canonical order, before any nested cleanup can take a head lock.
            artifact_engine.lock_cleanup_heads_in_order(
                db,
                subject_refs=[
                    ResourceRef(scheme="library", id=library_id),
                    *(ResourceRef(scheme="media", id=media_id) for media_id in media_ids),
                ],
                audiences=[AudienceUser(user_id=user_id) for user_id in affected_user_ids],
            )
            artifact_engine.on_subject_deleted(db, ResourceRef(scheme="library", id=library_id))
            delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="library", id=library_id))
            media_upload_sessions.delete_library_destination_support_in_current_transaction(
                db, library_id=library_id
            )
            library_entries.delete_library_entries(db, library_id)
            db.execute(
                text("DELETE FROM libraries WHERE id = :library_id"), {"library_id": library_id}
            )

            storage_paths: list[str] = []
            for media_id in media_ids:
                paths = media_deletion.delete_document_media_if_unreferenced(db, media_id)
                if paths:
                    storage_paths.extend(paths)
            for user_id in affected_user_ids:
                artifact_engine.on_audience_visibility_changed(
                    db, audience=AudienceUser(user_id=user_id)
                )
            return storage_paths, read_collection_revision(
                db, viewer_id=viewer_id, family=CollectionFamily.LibrariesIndex
            )

    storage_paths, collection_revision = retry_read_committed(db, "delete_library", attempt)

    if storage_paths:
        storage_client = get_storage_client()
        for storage_path in storage_paths:
            try:
                storage_client.delete_object(storage_path)
            except StorageError as exc:
                # justify-ignore-error: the commit already made this object unreachable.
                logger.warning(
                    "library_storage_delete_failed storage_path=%s error=%s",
                    storage_path,
                    exc.message,
                )
    return LibraryDeleteOut(library_id=library_id, collection_revision=collection_revision)


def get_library(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOut:
    """Read one library the viewer is a member of; mask a non-member as 404."""
    return library_out(
        lock_library_for_member(db, viewer_id, library_id, lock=False), viewer_id=viewer_id
    )


@dataclass(frozen=True, slots=True)
class LibrariesIndexView:
    """One advertised total order over the viewer's libraries index."""

    sort: Literal["created", "name"]
    direction: Direction


_INDEX_QUERY_KEYS = frozenset({"sort", "direction"})
# Versioned family: a cursor minted under the single unordered index carried no
# plan and no revision, so none is decodable against a chosen order.
_INDEX_CURSOR_FAMILY = f"{CollectionFamily.LibrariesIndex.value}:v2"
# The presented Library name, matching `libraries/presentation.ts`. Ordering on
# the authored column would file the Default Library under a name no one sees.
_PRESENTED_NAME_SQL = "CASE WHEN l.is_default THEN 'All' ELSE l.name END"
# `created+asc` is absent deliberately: the canonical view keeps exactly one URL.
_INDEX_VIEWS: dict[tuple[str | None, str | None], LibrariesIndexView] = {
    (None, None): LibrariesIndexView("created", "asc"),
    ("created", "desc"): LibrariesIndexView("created", "desc"),
    ("name", "asc"): LibrariesIndexView("name", "asc"),
    ("name", "desc"): LibrariesIndexView("name", "desc"),
}
# Every plan ends in `id`, which is unique, so every order is total; the name
# orders keep `id ASC` in both directions.
_DIRECTIONS: tuple[Direction, ...] = ("asc", "desc")
_INDEX_PLANS: dict[LibrariesIndexView, tuple[SortKey, ...]] = {
    LibrariesIndexView("created", direction): (
        SortKey("created_at", direction, KeysetValueKind.DateTime),
        SortKey("id", direction, KeysetValueKind.Uuid),
    )
    for direction in _DIRECTIONS
} | {
    LibrariesIndexView("name", direction): (
        SortKey("name_key", direction, KeysetValueKind.Text),
        SortKey("presented_name", direction, KeysetValueKind.Text),
        SortKey("id", "asc", KeysetValueKind.Uuid),
    )
    for direction in _DIRECTIONS
}


def parse_libraries_index_query(
    items: Sequence[tuple[str, str]],
) -> tuple[LibrariesIndexView, ParsedCollectionQuery]:
    """Strict libraries-index view parse over the request's `multi_items()`."""
    query = parse_collection_query(items, domain_keys=_INDEX_QUERY_KEYS)
    view = _INDEX_VIEWS.get((query.parameters.get("sort"), query.parameters.get("direction")))
    if view is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unsupported Libraries index view"
        )
    return view, query


def list_libraries(
    db: Session,
    viewer_id: UUID,
    *,
    view: LibrariesIndexView,
    cursor: CollectionCursor | None = None,
    collection_revision: CollectionRevision | None = None,
    limit: int = 100,
) -> CollectionPage[LibraryOut]:
    """One immutable-keyset page of the viewer's libraries index.

    The `facts` wrapper projects the derived sort columns once so ORDER BY, the
    keyset and the cursor read identical expressions.
    """
    revision = (
        read_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.LibrariesIndex)
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibrariesIndex,
            expected=collection_revision,
        )
    )
    plan = _INDEX_PLANS[view]
    cursor_query: dict[str, object] = {
        "family": _INDEX_CURSOR_FAMILY,
        "plan": plan_json(plan),
        "revision": revision,
        "viewerId": str(viewer_id),
    }
    page_rows, next_cursor = keyset_page(
        db,
        family=_INDEX_CURSOR_FAMILY,
        query=cursor_query,
        plan=plan,
        alias="facts",
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id},
        sql=lambda keyset, order: f"""
            WITH facts AS (
                SELECT {_LIBRARY_COLUMNS},
                       {_PRESENTED_NAME_SQL} AS presented_name,
                       lower(btrim({_PRESENTED_NAME_SQL})) AS name_key
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            )
            SELECT * FROM facts WHERE 1 = 1 {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    return CollectionPage[LibraryOut](
        items=[library_out(membership_context(row), viewer_id=viewer_id) for row in page_rows],
        collectionRevision=revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )


_DESTINATIONS_CURSOR_FAMILY = "LibraryDestinations:v3"
_DESTINATIONS_PLAN = (
    SortKey("match_rank", "asc", KeysetValueKind.Int),
    SortKey("normalized_name", "asc", KeysetValueKind.Text),
    SortKey("name", "asc", KeysetValueKind.Text),
    SortKey("id", "asc", KeysetValueKind.Uuid),
)


def list_writable_library_destinations(
    db: Session,
    viewer_id: UUID,
    *,
    q: str | None = None,
    cursor: str | None = None,
    limit: int = 25,
) -> tuple[list[LibraryDestinationOut], str | None]:
    """Rank the viewer's writable named libraries exact → prefix → contains → name."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 50)
    query = q or ""
    cursor_query: dict[str, object] = {
        "family": _DESTINATIONS_CURSOR_FAMILY,
        "plan": plan_json(_DESTINATIONS_PLAN),
        "q": query,
        "viewerId": str(viewer_id),
    }
    page_rows, next_cursor = keyset_page(
        db,
        family=_DESTINATIONS_CURSOR_FAMILY,
        query=cursor_query,
        plan=_DESTINATIONS_PLAN,
        alias="ranked",
        cursor=cursor,
        limit=limit,
        params={
            "viewer_id": viewer_id,
            "q": query,
            "prefix_q": f"{escape_like(query)}%",
            "contains_q": f"%{escape_like(query)}%",
        },
        sql=lambda keyset, order: f"""
            WITH ranked AS (
                SELECT
                    l.id, l.name, l.created_at, l.updated_at,
                    lower(l.name) AS normalized_name,
                    CASE
                        WHEN :q = '' THEN 3
                        WHEN lower(l.name) = :q THEN 0
                        WHEN lower(l.name) LIKE :prefix_q ESCAPE '\\' THEN 1
                        ELSE 2
                    END AS match_rank
                FROM libraries l
                LEFT JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.is_default = false
                  AND l.system_key IS NULL
                  AND (l.owner_user_id = :viewer_id OR m.role = 'admin')
                  AND (:q = '' OR lower(l.name) LIKE :contains_q ESCAPE '\\')
            )
            SELECT * FROM ranked WHERE 1 = 1 {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    return [
        LibraryDestinationOut(
            id=row["id"],
            name=row["name"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        for row in page_rows
    ], next_cursor


@dataclass(frozen=True, slots=True)
class LibraryManagementFacts:
    """The viewer's manage/delete authority over one library."""

    mutable: bool
    can_manage_settings: bool
    can_delete: bool


def library_management_facts(
    db: Session, *, viewer_id: UUID, library_ids: list[UUID]
) -> dict[UUID, LibraryManagementFacts]:
    """Batch the viewer's authority per library through the enforced capability rule."""
    ordered = list(dict.fromkeys(library_ids))
    if not ordered:
        return {}
    rows = (
        db.execute(
            text(f"""
                SELECT {_LIBRARY_COLUMNS}
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = ANY(:library_ids)
            """),
            {"viewer_id": viewer_id, "library_ids": ordered},
        )
        .mappings()
        .all()
    )
    facts: dict[UUID, LibraryManagementFacts] = {}
    for row in rows:
        out = library_out(membership_context(row), viewer_id=viewer_id)
        facts[out.id] = LibraryManagementFacts(
            mutable=not out.is_default and out.system_key is None,
            can_manage_settings=out.can_rename,
            can_delete=out.can_delete,
        )
    return facts


def find_default_library_id(db: Session, user_id: UUID) -> UUID | None:
    """The user's default library id, or None if bootstrap has not made one."""
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
            ApiErrorCode.E_INVALID_REQUEST, "library_ids must not contain duplicates"
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
    for library_id in library_ids:
        row = rows_by_id.get(library_id)
        if row is None or (row["owner_user_id"] != viewer_id and row["role"] != "admin"):
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not writable")
        if row["is_default"]:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Default library cannot be selected"
            )
        if row["system_key"] is not None:
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not writable")
    return list(library_ids)


def validate_writable_library_destinations(
    db: Session, viewer_id: UUID, library_ids: list[UUID]
) -> None:
    """Reject any selection the viewer cannot file into."""
    resolve_writable_non_default_library_ids(db, viewer_id, library_ids)
