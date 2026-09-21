"""Library sharing: the `memberships` and `library_invitations` tables.

Members, roles, ownership transfer and the invitation lifecycle are one
capability with one authorisation rule — an admin of a mutable library — so
they live together. Accepting an invitation commits the membership and the
status in one transaction; that commit alone changes the invitee's All on the
very next read, with no backfill job or projection to catch up.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    NotFoundError,
)
from nexus.schemas.library import (
    AcceptLibraryInviteResponse,
    DeclineLibraryInviteResponse,
    InviteAcceptMembershipOut,
    LibraryGovernancePageInfo,
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryMemberOut,
    LibraryOut,
    LibraryRole,
    UserLibraryInvitee,
    ViewerLibraryInvitationOut,
)
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.services import library_governance as governance
from nexus.services.collection_keyset import SortKey, plan_json
from nexus.services.collection_revisions import CollectionFamily, bump_collection_families
from nexus.services.keyset_cursor import KeysetValueKind
from nexus.services.sealed_handles import (
    InvalidSealedHandle,
    LibraryInvitationHandle,
    seal_library_invitation,
    seal_user,
    unseal_library_invitation,
    unseal_user,
)

_MAX_PAGE = 200
_MEMBER_CURSOR_FAMILY = "LibraryMembers:v2"
_MEMBER_PLAN = (SortKey("user_id", "asc", KeysetValueKind.Uuid),)
_INVITATION_CURSOR_FAMILY = "LibraryInvitations:v2"
_INVITATION_PLAN = (
    SortKey("created_at", "desc", KeysetValueKind.DateTime),
    SortKey("id", "desc", KeysetValueKind.Uuid),
)
# Every invitation read carries the invitee's Presence fields and the library's
# mutability, so no lifecycle step has to re-read either.
_INVITATION_COLUMNS = """
    i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
    i.role, i.status, i.created_at, i.responded_at,
    u.email, u.display_name, l.is_default, l.system_key
"""
_INVITATION_SOURCE = """
    FROM library_invitations i
    JOIN users u ON u.id = i.invitee_user_id
    JOIN libraries l ON l.id = i.library_id
"""


def _page_info(next_cursor: str | None) -> LibraryGovernancePageInfo:
    return LibraryGovernancePageInfo(
        next_cursor=present(next_cursor) if next_cursor is not None else absent()
    )


def _member_out(
    row: Any, *, owner_user_id: UUID, role: LibraryRole | None = None
) -> LibraryMemberOut:
    return LibraryMemberOut(
        user_handle=seal_user(row["user_id"]),
        role=row["role"] if role is None else role,
        is_owner=row["user_id"] == owner_user_id,
        email=presence_from_nullable(row["email"]),
        display_name=presence_from_nullable(row["display_name"]),
        created_at=row["created_at"],
    )


def _invitation_out(
    row: Any,
    *,
    status: LibraryInvitationStatusValue | None = None,
    responded_at: datetime | None = None,
) -> LibraryInvitationOut:
    """The wire DTO for one invitation row, carrying a status this transaction
    just committed instead of re-reading the row."""
    return LibraryInvitationOut(
        invitation_handle=seal_library_invitation(row["id"]),
        library_id=row["library_id"],
        inviter_user_handle=seal_user(row["inviter_user_id"]),
        invitee_user_handle=seal_user(row["invitee_user_id"]),
        role=row["role"],
        status=row["status"] if status is None else status,
        created_at=row["created_at"],
        responded_at=presence_from_nullable(
            row["responded_at"] if status is None else responded_at
        ),
        invitee_email=presence_from_nullable(row["email"]),
        invitee_display_name=presence_from_nullable(row["display_name"]),
    )


def _require_mutable(row: Any) -> None:
    governance.require_non_default(row["is_default"])
    governance.require_not_system(row["system_key"])


def _locked_invitation(
    db: Session, *, invitation_handle: LibraryInvitationHandle | str, invitee_user_id: UUID | None
) -> Any:
    """Lock one invitation the responder is entitled to see, or raise 404."""
    try:
        invitation_id = unseal_library_invitation(str(invitation_handle))
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc
    row = (
        db.execute(
            text(f"""
                SELECT {_INVITATION_COLUMNS}
                {_INVITATION_SOURCE}
                WHERE i.id = :invitation_id
                  AND (
                    CAST(:invitee_id AS uuid) IS NULL
                    OR i.invitee_user_id = CAST(:invitee_id AS uuid)
                  )
                FOR UPDATE OF i
            """),
            {"invitation_id": invitation_id, "invitee_id": invitee_user_id},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")
    return row


def _set_invitation_status(
    db: Session, *, invitation_id: UUID, status: LibraryInvitationStatusValue
) -> datetime:
    responded_at = datetime.now(UTC)
    db.execute(
        text("""
            UPDATE library_invitations
            SET status = :status, responded_at = :responded_at
            WHERE id = :invitation_id
        """),
        {"invitation_id": invitation_id, "status": status, "responded_at": responded_at},
    )
    return responded_at


def list_library_members(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    cursor: str | None = None,
    limit: int = 100,
) -> tuple[list[LibraryMemberOut], LibraryGovernancePageInfo]:
    """One keyset page of a library's members over `user_id ASC`. Admin-only."""
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    governance.require_admin(ctx.role)
    page_rows, next_cursor = governance.keyset_page(
        db,
        family=_MEMBER_CURSOR_FAMILY,
        query={
            "family": _MEMBER_CURSOR_FAMILY,
            "libraryId": str(library_id),
            "plan": plan_json(_MEMBER_PLAN),
            "viewerId": str(viewer_id),
        },
        plan=_MEMBER_PLAN,
        alias="m",
        cursor=cursor,
        limit=min(limit, _MAX_PAGE),
        params={"library_id": library_id},
        sql=lambda keyset, order: f"""
            SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.library_id = :library_id {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    return (
        [_member_out(row, owner_user_id=ctx.owner_user_id) for row in page_rows],
        _page_info(next_cursor),
    )


def update_library_member_role(
    db: Session, viewer_id: UUID, library_id: UUID, target_user_id: UUID, role: LibraryRole
) -> LibraryMemberOut:
    """Set a member's role. Admin-only; the owner's role is fixed until transfer."""

    def attempt() -> LibraryMemberOut:
        with transaction(db):
            ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
            governance.require_admin(ctx.role)
            governance.require_non_default(ctx.is_default)
            governance.require_not_system(ctx.system_key)
            if target_user_id == ctx.owner_user_id:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                    "Cannot change owner role; transfer ownership first",
                )

            target = (
                db.execute(
                    text("""
                        SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
                        FROM memberships m
                        JOIN users u ON u.id = m.user_id
                        WHERE m.library_id = :lid AND m.user_id = :uid
                    """),
                    {"lid": library_id, "uid": target_user_id},
                )
                .mappings()
                .fetchone()
            )
            if target is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Member not found")
            if target["role"] == role:
                return _member_out(target, owner_user_id=ctx.owner_user_id)

            db.execute(
                text(
                    "UPDATE memberships SET role = :role WHERE library_id = :lid AND user_id = :uid"
                ),
                {"role": role, "lid": library_id, "uid": target_user_id},
            )
            governance.bump_library_index(db, governance.library_member_ids(db, library_id))
            return _member_out(target, owner_user_id=ctx.owner_user_id, role=role)

    return retry_serializable(db, "update_library_member_role", attempt)


def remove_library_member(
    db: Session, viewer_id: UUID, library_id: UUID, target_user_id: UUID
) -> None:
    """Remove a member and sweep their Dossier visibility. Admin-only; idempotent."""
    from nexus.services.artifacts.dossier_types import AudienceUser
    from nexus.services.artifacts.engine import on_audience_visibility_changed

    def attempt() -> None:
        with transaction(db):
            ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
            governance.require_admin(ctx.role)
            governance.require_non_default(ctx.is_default)
            governance.require_not_system(ctx.system_key)
            if target_user_id == ctx.owner_user_id:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_EXIT_FORBIDDEN,
                    "Cannot remove owner; transfer ownership first",
                )

            removed = db.execute(
                text(
                    "DELETE FROM memberships WHERE library_id = :lid AND user_id = :uid "
                    "RETURNING user_id"
                ),
                {"lid": library_id, "uid": target_user_id},
            ).fetchone()
            if removed is None:
                return
            governance.bump_library_index(
                db,
                [*governance.library_member_ids(db, library_id), target_user_id],
                conversations=True,
            )
            on_audience_visibility_changed(db, audience=AudienceUser(user_id=target_user_id))

    retry_serializable(db, "remove_library_member", attempt)


def transfer_library_ownership(
    db: Session, viewer_id: UUID, library_id: UUID, new_owner_user_id: UUID
) -> LibraryOut:
    """Hand ownership to an existing member. Owner-only; the previous owner stays admin."""

    def attempt() -> LibraryOut:
        with transaction(db):
            ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
            governance.require_non_default(ctx.is_default)
            governance.require_not_system(ctx.system_key)
            if ctx.owner_user_id != viewer_id:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_REQUIRED, "Only the library owner can transfer ownership"
                )
            if new_owner_user_id == ctx.owner_user_id:
                return governance.library_out(ctx, viewer_id=viewer_id)

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
                    text(
                        "UPDATE memberships SET role = 'admin' "
                        "WHERE library_id = :lid AND user_id = :uid"
                    ),
                    {"lid": library_id, "uid": new_owner_user_id},
                )

            now = datetime.now(UTC)
            db.execute(
                text(
                    "UPDATE libraries SET owner_user_id = :new_owner, updated_at = :now "
                    "WHERE id = :lid"
                ),
                {"new_owner": new_owner_user_id, "now": now, "lid": library_id},
            )
            governance.bump_library_index(db, governance.library_member_ids(db, library_id))
            return governance.library_out(
                ctx,
                viewer_id=viewer_id,
                owner_user_id=new_owner_user_id,
                role="admin",
                updated_at=now,
            )

    return retry_serializable(db, "transfer_library_ownership", attempt)


def create_library_invite(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    invitee: UserLibraryInvitee,
    role: LibraryRole,
) -> LibraryInvitationOut:
    """Invite one existing user to a mutable library. Admin-only; entitlement-gated."""
    from nexus.services.billing_entitlements import get_effective_entitlements

    def attempt() -> LibraryInvitationOut:
        with transaction(db):
            ctx = governance.lock_library_for_member(db, viewer_id, library_id)
            governance.require_admin(ctx.role)
            governance.require_non_default(ctx.is_default)
            governance.require_not_system(ctx.system_key)

            try:
                invitee_user_id = unseal_user(invitee.user_handle)
            except InvalidSealedHandle as exc:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
            state = (
                db.execute(
                    text("""
                        SELECT
                            EXISTS(SELECT 1 FROM users WHERE id = :uid) AS user_exists,
                            EXISTS(
                                SELECT 1 FROM memberships
                                WHERE library_id = :lid AND user_id = :uid
                            ) AS is_member,
                            EXISTS(
                                SELECT 1 FROM library_invitations
                                WHERE library_id = :lid
                                  AND invitee_user_id = :uid
                                  AND status = 'pending'
                            ) AS has_pending
                    """),
                    {"lid": library_id, "uid": invitee_user_id},
                )
                .mappings()
                .one()
            )
            if not state["user_exists"]:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
            if state["is_member"]:
                raise ConflictError(ApiErrorCode.E_INVITE_MEMBER_EXISTS, "User is already a member")
            if state["has_pending"]:
                raise ConflictError(
                    ApiErrorCode.E_INVITE_ALREADY_EXISTS, "Pending invitation already exists"
                )
            if not get_effective_entitlements(db, viewer_id).can_share:
                raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Sharing requires an eligible plan")

            try:
                created = (
                    db.execute(
                        text("""
                            WITH inserted AS (
                                INSERT INTO library_invitations
                                    (library_id, inviter_user_id, invitee_user_id, role, status)
                                VALUES (:lid, :inviter, :invitee, :role, 'pending')
                                RETURNING id, library_id, inviter_user_id, invitee_user_id,
                                          role, status, created_at, responded_at
                            )
                            SELECT inserted.*, u.email, u.display_name
                            FROM inserted
                            JOIN users u ON u.id = inserted.invitee_user_id
                        """),
                        {
                            "lid": library_id,
                            "inviter": viewer_id,
                            "invitee": invitee_user_id,
                            "role": role,
                        },
                    )
                    .mappings()
                    .one()
                )
            except IntegrityError as exc:
                # uix_library_invitations_pending_once is the real gate; the
                # pre-check above is only advisory.
                db.rollback()
                if "uix_library_invitations_pending_once" in str(exc) or (
                    "uix_library_invitations_pending_once"
                    in (getattr(exc.orig, "constraint_name", "") or "")
                ):
                    raise ConflictError(
                        ApiErrorCode.E_INVITE_ALREADY_EXISTS, "Pending invitation already exists"
                    ) from exc
                raise
            return _invitation_out(created)

    return retry_serializable(db, "create_library_invite", attempt)


def list_library_invites(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    cursor: str | None = None,
    limit: int = 100,
) -> tuple[list[LibraryInvitationOut], LibraryGovernancePageInfo]:
    """One keyset page of a library's invitations, newest first. Admin-only."""
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    governance.require_admin(ctx.role)
    governance.require_not_system(ctx.system_key)
    page_rows, next_cursor = governance.keyset_page(
        db,
        family=_INVITATION_CURSOR_FAMILY,
        query={
            "family": _INVITATION_CURSOR_FAMILY,
            "libraryId": str(library_id),
            "plan": plan_json(_INVITATION_PLAN),
            "status": status,
            "viewerId": str(viewer_id),
        },
        plan=_INVITATION_PLAN,
        alias="i",
        cursor=cursor,
        limit=min(limit, _MAX_PAGE),
        params={"lid": library_id, "status": status},
        sql=lambda keyset, order: f"""
            SELECT {_INVITATION_COLUMNS}
            {_INVITATION_SOURCE}
            WHERE i.library_id = :lid AND i.status = :status {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    return [_invitation_out(row) for row in page_rows], _page_info(next_cursor)


def list_viewer_invites(
    db: Session,
    viewer_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    limit: int = 100,
) -> list[ViewerLibraryInvitationOut]:
    """The invitations addressed to the viewer, newest first, with the library name."""
    rows = (
        db.execute(
            text(f"""
                SELECT {_INVITATION_COLUMNS}, l.name AS library_name
                {_INVITATION_SOURCE}
                WHERE i.invitee_user_id = :uid AND i.status = :status
                ORDER BY i.created_at DESC, i.id DESC
                LIMIT :limit
            """),
            {"uid": viewer_id, "status": status, "limit": min(limit, _MAX_PAGE)},
        )
        .mappings()
        .all()
    )
    return [
        ViewerLibraryInvitationOut(
            **_invitation_out(row).model_dump(), library_name=row["library_name"]
        )
        for row in rows
    ]


def accept_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> AcceptLibraryInviteResponse:
    """Accept an invitation: membership upsert then status, in one transaction."""

    def membership_role(library_id: UUID, fallback: LibraryRole) -> LibraryRole:
        row = db.execute(
            text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": library_id, "uid": viewer_id},
        ).fetchone()
        return fallback if row is None else row[0]

    def attempt() -> AcceptLibraryInviteResponse:
        with transaction(db):
            invite = _locked_invitation(
                db, invitation_handle=invitation_handle, invitee_user_id=viewer_id
            )
            library_id = invite["library_id"]
            if invite["status"] == "accepted":
                return AcceptLibraryInviteResponse(
                    invite=_invitation_out(invite),
                    membership=InviteAcceptMembershipOut(
                        library_id=library_id,
                        user_handle=seal_user(viewer_id),
                        role=membership_role(library_id, invite["role"]),
                    ),
                    idempotent=True,
                )
            if invite["status"] != "pending":
                raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")
            _require_mutable(invite)

            role = membership_role(library_id, invite["role"])
            db.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:lid, :uid, :role)
                    ON CONFLICT (library_id, user_id) DO NOTHING
                """),
                {"lid": library_id, "uid": viewer_id, "role": invite["role"]},
            )
            responded_at = _set_invitation_status(db, invitation_id=invite["id"], status="accepted")
            bump_collection_families(
                db,
                viewer_ids=(viewer_id,),
                families=(
                    CollectionFamily.AuthorWorks,
                    CollectionFamily.LibrariesIndex,
                    CollectionFamily.LibraryEntries,
                    CollectionFamily.PodcastEpisodes,
                    CollectionFamily.PodcastSubscriptions,
                ),
            )
            return AcceptLibraryInviteResponse(
                invite=_invitation_out(invite, status="accepted", responded_at=responded_at),
                membership=InviteAcceptMembershipOut(
                    library_id=library_id, user_handle=seal_user(viewer_id), role=role
                ),
                idempotent=False,
            )

    return retry_serializable(db, "accept_library_invite", attempt)


def decline_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> DeclineLibraryInviteResponse:
    """Decline a pending invitation; declining twice is idempotent."""

    def attempt() -> DeclineLibraryInviteResponse:
        with transaction(db):
            invite = _locked_invitation(
                db, invitation_handle=invitation_handle, invitee_user_id=viewer_id
            )
            if invite["status"] == "declined":
                return DeclineLibraryInviteResponse(invite=_invitation_out(invite), idempotent=True)
            if invite["status"] != "pending":
                raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")
            _require_mutable(invite)
            responded_at = _set_invitation_status(db, invitation_id=invite["id"], status="declined")
            return DeclineLibraryInviteResponse(
                invite=_invitation_out(invite, status="declined", responded_at=responded_at),
                idempotent=False,
            )

    return retry_serializable(db, "decline_library_invite", attempt)


def revoke_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> None:
    """Revoke a pending invitation. Admin-only; revoking twice is idempotent."""

    def attempt() -> None:
        with transaction(db):
            invite = _locked_invitation(
                db, invitation_handle=invitation_handle, invitee_user_id=None
            )
            membership = db.execute(
                text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
                {"lid": invite["library_id"], "uid": viewer_id},
            ).fetchone()
            if membership is None:
                raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")
            governance.require_admin(membership[0])

            if invite["status"] == "revoked":
                return
            if invite["status"] != "pending":
                raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")
            _require_mutable(invite)
            _set_invitation_status(db, invitation_id=invite["id"], status="revoked")

    retry_serializable(db, "revoke_library_invite", attempt)
