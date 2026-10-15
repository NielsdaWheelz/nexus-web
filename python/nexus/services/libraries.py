"""Libraries: the `libraries` table and the viewer's authority over one library.

A library is a named collection and the access group for what it files. Every
account owns one default library, presented as All; system libraries (`system_key`)
are readable and never user-mutable. A non-member is answered as if the library did
not exist (404). Every module authorizes a library write through `access`.

Retry rules: create resends its client id (same id and owner answers that row);
rename carries the name it expects to replace; delete is idempotent.
"""

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.schemas.library import (
    CreateLibraryRequest,
    LibraryDestinationOut,
    LibraryOut,
    LibraryRole,
    RenameLibraryRequest,
)
from nexus.services.collection_keyset import KeysetValueKind, SortKey, keyset_page

_COLUMNS = """
    l.id, l.name, l.owner_user_id, l.is_default, l.system_key,
    l.created_at, l.updated_at, m.role
"""


@dataclass(frozen=True, slots=True)
class LibraryAccess:
    """One library joined with the viewer's role in it."""

    id: UUID
    name: str
    owner_user_id: UUID
    is_default: bool
    system_key: str | None
    created_at: datetime
    updated_at: datetime
    role: LibraryRole

    @property
    def mutable(self) -> bool:
        return not self.is_default and self.system_key is None

    def require_admin(self) -> None:
        if self.role != "admin":
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")

    def require_named(self) -> None:
        if self.is_default:
            raise ForbiddenError(
                ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN, "Not allowed on the default library"
            )

    def require_not_system(self) -> None:
        if self.system_key is not None:
            raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "System library")

    def require_mutable(self) -> None:
        self.require_named()
        self.require_not_system()

    def require_owner(self, viewer_id: UUID) -> None:
        if self.owner_user_id != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Only the owner can do this")

    def out(self, viewer_id: UUID) -> LibraryOut:
        """The one capability rule: admins manage a mutable library, its owner deletes
        or hands it on, and everyone else may leave it."""
        owner = self.owner_user_id == viewer_id
        return LibraryOut(
            id=self.id,
            name=self.name,
            is_default=self.is_default,
            system_key=self.system_key,
            role=self.role,
            can_manage=self.mutable and self.role == "admin",
            can_delete=self.mutable and owner,
            can_transfer_ownership=self.mutable and owner,
            can_leave=self.mutable and not owner,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


def access(db: Session, viewer_id: UUID, library_id: UUID, *, lock: bool) -> LibraryAccess:
    """The library and the viewer's role; E_LIBRARY_NOT_FOUND for a non-member.
    `lock` takes the library row lock (READ COMMITTED writers only)."""
    row = (
        db.execute(
            text(f"""
                SELECT {_COLUMNS} FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = :library_id {"FOR UPDATE OF l" if lock else ""}
            """),
            {"library_id": library_id, "viewer_id": viewer_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return LibraryAccess(**row)


def lock_library_rows_in_order(db: Session, library_ids: Sequence[UUID]) -> list[UUID]:
    """Lock the existing library rows in uuid order (the last step of the lock
    order: podcast, media, library); return those that exist."""
    ordered = sorted(set(library_ids))
    if not ordered:
        return []
    return list(
        db.scalars(
            text("SELECT id FROM libraries WHERE id = ANY(:ids) ORDER BY id FOR UPDATE"),
            {"ids": ordered},
        )
    )


def default_library_id(db: Session, user_id: UUID) -> UUID:
    library_id = db.scalar(
        text("SELECT id FROM libraries WHERE owner_user_id = :id AND is_default"),
        {"id": user_id},
    )
    if library_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Default library not found")
    return library_id


def _valid_name(name: str) -> str:
    """1-100 characters; All (in any case) names the All view."""
    name = name.strip()
    if not 1 <= len(name) <= 100 or name.casefold() == "all":
        raise InvalidRequestError(
            ApiErrorCode.E_NAME_INVALID, "Name must be 1-100 characters and not All"
        )
    return name


def create_library(db: Session, viewer_id: UUID, body: CreateLibraryRequest) -> LibraryOut:
    """A named library owned (and administered) by the viewer."""
    name = _valid_name(body.name)

    def attempt() -> LibraryOut:
        with transaction(db):
            inserted = db.scalar(
                text("""
                    INSERT INTO libraries (id, name, owner_user_id, is_default)
                    VALUES (:id, :name, :viewer_id, false)
                    ON CONFLICT (id) DO NOTHING RETURNING id
                """),
                {"id": body.id, "name": name, "viewer_id": viewer_id},
            )
            if inserted is not None:
                db.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:id, :viewer_id, 'admin')
                    """),
                    {"id": body.id, "viewer_id": viewer_id},
                )
            held = db.execute(
                text("SELECT owner_user_id, is_default, system_key FROM libraries WHERE id = :id"),
                {"id": body.id},
            ).one()
            if held.owner_user_id != viewer_id or held.is_default or held.system_key is not None:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Library id is taken")
            return access(db, viewer_id, body.id, lock=False).out(viewer_id)

    # READ COMMITTED: ON CONFLICT settles a same-id race by waiting for the other
    # insert, so concurrent creates never fail on a serialization guess.
    return retry_read_committed(db, "create_library", attempt)


def rename_library(
    db: Session, viewer_id: UUID, library_id: UUID, body: RenameLibraryRequest
) -> LibraryOut:
    """Admin rename. Already named so: success; named other than expected: 409 with
    `current_name`."""
    name = _valid_name(body.name)
    with transaction(db):
        library = access(db, viewer_id, library_id, lock=True)
        library.require_mutable()
        library.require_admin()
        if library.name == name:
            return library.out(viewer_id)
        if library.name != body.expected_name:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The library was renamed meanwhile",
                details={"current_name": library.name},
            )
        updated_at = db.scalar(
            text("""
                UPDATE libraries SET name = :name, updated_at = now()
                WHERE id = :id RETURNING updated_at
            """),
            {"name": name, "id": library_id},
        )
    return replace(library, name=name, updated_at=updated_at).out(viewer_id)


def delete_library(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    """Owner delete. A media filed nowhere else moves into the owner's All, so
    deleting a library never deletes media. Absent or invisible: success."""
    from nexus.services import library_entries, media_upload_sessions
    from nexus.services.dossier import engine as dossier
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.suggestion_changes import (
        delete_suggestion_feeds_for_library,
        record_input_change,
    )

    ref = ResourceRef(scheme="library", id=library_id)

    def attempt() -> None:
        with transaction(db):
            media_ids = library_entries.media_ids_in_library(db, library_id)
            if library_entries.lock_media_rows_in_order(db, media_ids) != media_ids:
                raise TransactionRestart("library media set changed")
            default_id = default_library_id(db, viewer_id)
            lock_library_rows_in_order(db, [library_id, default_id])
            try:
                library = access(db, viewer_id, library_id, lock=False)
            except NotFoundError:
                return
            library.require_mutable()
            library.require_owner(viewer_id)
            # The library lock stops new filings; one that landed before it holds a
            # media this attempt did not lock, so the attempt restarts.
            held = library_entries.media_ids_in_library(db, library_id)
            if not set(held) <= set(media_ids):
                raise TransactionRestart("library media set grew")
            members = list(
                db.scalars(
                    text("""
                        SELECT user_id FROM memberships WHERE library_id = :id
                        ORDER BY user_id FOR UPDATE
                    """),
                    {"id": library_id},
                )
            )
            # The whole dossier head union, once, before any cleanup takes a head lock.
            dossier.lock_heads(
                db,
                subjects=[ref, *(ResourceRef(scheme="media", id=m) for m in held)],
                user_ids=members,
            )
            dossier.on_subject_deleted(db, ref)
            delete_edges_for_deleted_resource(db, ref=ref)
            media_upload_sessions.delete_library_destination_support_in_current_transaction(
                db, library_id=library_id
            )
            for media_id in held:
                if library_entries.count_entries_for_media(db, media_id) == 1:
                    library_entries.ensure_entry(
                        db, default_id, library_entries.media_target(media_id)
                    )
            library_entries.delete_library_entries(db, library_id)
            delete_suggestion_feeds_for_library(db, library_id=library_id)
            db.execute(text("DELETE FROM libraries WHERE id = :id"), {"id": library_id})
            for user_id in members:
                dossier.on_visibility_lost(db, user_id=user_id)
            record_input_change(db)

    retry_read_committed(db, "delete_library", attempt, retries=5)


def ensure_system_library(db: Session, *, system_key: str, name: str, owner_user_id: UUID) -> UUID:
    """The system library for `system_key`, created once."""
    with transaction(db):
        existing = db.scalar(
            text("SELECT id FROM libraries WHERE system_key = :key"), {"key": system_key}
        )
        if existing is not None:
            return existing
        library_id = db.scalar(
            text("""
                INSERT INTO libraries (name, owner_user_id, is_default, system_key)
                VALUES (:name, :owner, false, :key) RETURNING id
            """),
            {"name": name, "owner": owner_user_id, "key": system_key},
        )
        db.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:id, :owner, 'admin')
            """),
            {"id": library_id, "owner": owner_user_id},
        )
        return library_id


def join_system_library(db: Session, *, system_key: str, user_id: UUID) -> bool:
    """Join an existing system library; return whether membership changed. Flush only."""
    return (
        db.scalar(
            text("""
            INSERT INTO memberships (library_id, user_id, role)
            SELECT id, :user_id, 'member' FROM libraries WHERE system_key = :key
            ON CONFLICT DO NOTHING RETURNING library_id
        """),
            {"key": system_key, "user_id": user_id},
        )
        is not None
    )


# The index orders names as shown (the default library is All); absent sort is
# oldest created, so All comes first. Every plan ends in the unique id.
_PRESENTED = "CASE WHEN l.is_default THEN 'All' ELSE l.name END"
_ID = SortKey("id", "asc", KeysetValueKind.Uuid)
_INDEX_PLANS: dict[str | None, tuple[SortKey, ...]] = {
    None: (SortKey("created_at", "asc", KeysetValueKind.DateTime), _ID),
    "created_desc": (
        SortKey("created_at", "desc", KeysetValueKind.DateTime),
        SortKey("id", "desc", KeysetValueKind.Uuid),
    ),
    "name_asc": (
        SortKey("name_key", "asc", KeysetValueKind.Text),
        SortKey("presented_name", "asc", KeysetValueKind.Text),
        _ID,
    ),
    "name_desc": (
        SortKey("name_key", "desc", KeysetValueKind.Text),
        SortKey("presented_name", "desc", KeysetValueKind.Text),
        _ID,
    ),
}


def list_libraries(
    db: Session, viewer_id: UUID, items: Sequence[tuple[str, str]]
) -> CollectionPage[LibraryOut]:
    """One keyset page of the viewer's libraries in the `sort` view."""
    query = parse_collection_query(items, domain_keys={"sort"})
    sort = query.parameters.get("sort")
    if sort not in _INDEX_PLANS:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported libraries view")
    rows, next_cursor = keyset_page(
        db,
        binding={"list": "Libraries", "viewer": viewer_id, "sort": sort},
        plan=_INDEX_PLANS[sort],
        cursor=query.cursor,
        limit=query.limit,
        params={"viewer_id": viewer_id},
        sql=lambda keyset, order: f"""
            WITH facts AS (
                SELECT {_COLUMNS}, {_PRESENTED} AS presented_name,
                       lower(btrim({_PRESENTED})) AS name_key
                FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            )
            SELECT * FROM facts WHERE true {keyset} ORDER BY {order} LIMIT :limit
        """,
    )
    return CollectionPage[LibraryOut](
        items=[
            LibraryAccess(**{key: row[key] for key in LibraryAccess.__slots__}).out(viewer_id)
            for row in rows
        ],
        next_cursor=next_cursor,
    )


def list_writable_library_destinations(db: Session, viewer_id: UUID) -> list[LibraryDestinationOut]:
    """The complete named-library catalog the viewer may file into."""
    rows = db.execute(
        text("""
            SELECT l.id, l.name FROM libraries l
            JOIN memberships m
              ON m.library_id = l.id AND m.user_id = :viewer_id AND m.role = 'admin'
            WHERE NOT l.is_default AND l.system_key IS NULL
            ORDER BY lower(l.name), l.name, l.id
        """),
        {"viewer_id": viewer_id},
    )
    return [LibraryDestinationOut(id=row.id, name=row.name) for row in rows]


def resolve_writable_destinations(
    db: Session, viewer_id: UUID, library_ids: Sequence[UUID]
) -> list[UUID]:
    """The chosen named destinations, in their order, when the viewer admins each."""
    if len(set(library_ids)) != len(library_ids):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Duplicate library ids")
    writable = set(
        db.scalars(
            text("""
                SELECT l.id FROM libraries l
                JOIN memberships m
                  ON m.library_id = l.id AND m.user_id = :viewer_id AND m.role = 'admin'
                WHERE l.id = ANY(:ids) AND NOT l.is_default AND l.system_key IS NULL
            """),
            {"viewer_id": viewer_id, "ids": list(library_ids)},
        )
    )
    if writable != set(library_ids):
        raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "Library not writable")
    return list(library_ids)


@dataclass(frozen=True, slots=True)
class LibraryManagementFacts:
    """The viewer's manage/delete authority over one library (action snapshots)."""

    mutable: bool
    can_manage_settings: bool
    can_delete: bool


def library_management_facts(
    db: Session, *, viewer_id: UUID, library_ids: list[UUID]
) -> dict[UUID, LibraryManagementFacts]:
    rows = (
        db.execute(
            text(f"""
                SELECT {_COLUMNS} FROM libraries l
                JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
                WHERE l.id = ANY(:ids)
            """),
            {"viewer_id": viewer_id, "ids": list(dict.fromkeys(library_ids))},
        )
        .mappings()
        .all()
    )
    facts: dict[UUID, LibraryManagementFacts] = {}
    for row in rows:
        library = LibraryAccess(**row)
        out = library.out(viewer_id)
        facts[library.id] = LibraryManagementFacts(
            mutable=library.mutable, can_manage_settings=out.can_manage, can_delete=out.can_delete
        )
    return facts
