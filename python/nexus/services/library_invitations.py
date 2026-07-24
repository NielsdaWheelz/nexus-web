"""Library invitations: the `library_invitations` table and its lifecycle.

Owns create/list/accept/decline/revoke. Membership commit alone changes Default
list/count/search immediately (spec AC3); no follow-up projection/backfill work
is required or performed.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.library import (
    AcceptLibraryInviteResponse,
    DeclineLibraryInviteResponse,
    EmailLibraryInvitee,
    InviteAcceptMembershipOut,
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryInvitee,
    LibraryRole,
    ViewerLibraryInvitationOut,
)
from nexus.services import library_governance as governance
from nexus.services.sealed_handles import (
    InvalidSealedHandle,
    LibraryInvitationHandle,
    seal_library_invitation,
    seal_user,
    unseal_library_invitation,
    unseal_user,
)

_INVITATION_COLUMNS = (
    "id, library_id, inviter_user_id, invitee_user_id, role, status, created_at, responded_at"
)


def _invitation_row_to_out(row) -> LibraryInvitationOut:
    """Map a name-keyed invitation row to LibraryInvitationOut. Rows that also project
    `email`/`display_name` carry invitee user info; others leave it None."""
    return LibraryInvitationOut(
        invitation_handle=seal_library_invitation(row["id"]),
        library_id=row["library_id"],
        inviter_user_handle=seal_user(row["inviter_user_id"]),
        invitee_user_handle=seal_user(row["invitee_user_id"]),
        role=row["role"],
        status=row["status"],
        created_at=row["created_at"],
        responded_at=row["responded_at"],
        invitee_email=row.get("email"),
        invitee_display_name=row.get("display_name"),
    )


def _viewer_invitation_row_to_out(row) -> ViewerLibraryInvitationOut:
    return ViewerLibraryInvitationOut(
        **_invitation_row_to_out(row).model_dump(),
        library_name=row["library_name"],
    )


def create_library_invite(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    invitee: LibraryInvitee,
    role: LibraryRole,
) -> LibraryInvitationOut:
    """Create an invitation from one strict sealed-user or email audience."""
    with transaction(db):
        ctx = governance.lock_library_for_member(db, viewer_id, library_id)
        governance.require_admin(ctx.role)
        governance.require_non_default(ctx.is_default)
        governance.require_not_system(ctx.system_key)

        if isinstance(invitee, EmailLibraryInvitee):
            normalized_invitee_email = invitee.email.strip()
            if not normalized_invitee_email:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Invitee email is required",
                )
            row = db.execute(
                text("SELECT id FROM users WHERE email = :email"),
                {"email": normalized_invitee_email},
            ).fetchone()
            if row is None:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
            invitee_user_id = row[0]
        else:
            try:
                invitee_user_id = unseal_user(invitee.user_handle)
            except InvalidSealedHandle as exc:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
            invitee_exists = db.execute(
                text("SELECT 1 FROM users WHERE id = :uid"),
                {"uid": invitee_user_id},
            ).fetchone()
            if invitee_exists is None:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")

        member_exists = db.execute(
            text("SELECT 1 FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": library_id, "uid": invitee_user_id},
        ).fetchone()
        if member_exists is not None:
            raise ConflictError(ApiErrorCode.E_INVITE_MEMBER_EXISTS, "User is already a member")

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

        from nexus.services.billing_entitlements import get_effective_entitlements

        if not get_effective_entitlements(db, viewer_id).can_share:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED,
                "Sharing requires an eligible plan",
            )

        try:
            row = (
                db.execute(
                    text(f"""
                    INSERT INTO library_invitations
                        (library_id, inviter_user_id, invitee_user_id, role, status)
                    VALUES (:lid, :inviter, :invitee, :role, 'pending')
                    RETURNING {_INVITATION_COLUMNS}
                """),
                    {
                        "lid": library_id,
                        "inviter": viewer_id,
                        "invitee": invitee_user_id,
                        "role": role,
                    },
                )
                .mappings()
                .fetchone()
            )
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
    """List invitations for a library. Admin-only; ordered created_at DESC, id DESC."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    governance.require_admin(ctx.role)
    governance.require_not_system(ctx.system_key)

    rows = (
        db.execute(
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
        .mappings()
        .all()
    )
    return [_invitation_row_to_out(row) for row in rows]


def list_viewer_invites(
    db: Session,
    viewer_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    limit: int = 100,
) -> list[ViewerLibraryInvitationOut]:
    """List invitations addressed to the viewer. Ordered created_at DESC, id DESC."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    rows = (
        db.execute(
            text("""
            SELECT i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
                   i.role, i.status, i.created_at, i.responded_at,
                   u.email, u.display_name, l.name AS library_name
            FROM library_invitations i
            JOIN users u ON u.id = i.invitee_user_id
            JOIN libraries l ON l.id = i.library_id
            WHERE i.invitee_user_id = :uid AND i.status = :status
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
        """),
            {"uid": viewer_id, "status": status, "limit": limit},
        )
        .mappings()
        .all()
    )
    return [_viewer_invitation_row_to_out(row) for row in rows]


def accept_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> AcceptLibraryInviteResponse:
    """Accept a library invitation: membership upsert → invite update. The
    membership commit alone immediately changes Default list/count/search; no
    follow-up projection work is required."""
    try:
        invite_id = unseal_library_invitation(str(invitation_handle))
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc
    with transaction(db):
        inv = (
            db.execute(
                text(f"""
                SELECT {_INVITATION_COLUMNS}
                FROM library_invitations
                WHERE id = :invite_id AND invitee_user_id = :uid
                FOR UPDATE
            """),
                {"invite_id": invite_id, "uid": viewer_id},
            )
            .mappings()
            .fetchone()
        )

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        invite_library_id = inv["library_id"]
        invite_role = inv["role"]

        if inv["status"] == "accepted":
            mem = db.execute(
                text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
                {"lid": invite_library_id, "uid": viewer_id},
            ).fetchone()
            return AcceptLibraryInviteResponse(
                invite=_invitation_row_to_out(inv),
                membership=InviteAcceptMembershipOut(
                    library_id=invite_library_id,
                    user_handle=seal_user(viewer_id),
                    role=mem[0] if mem else invite_role,
                ),
                idempotent=True,
            )

        if inv["status"] != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

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
            text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
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

        updated = (
            db.execute(
                text(f"""
                UPDATE library_invitations
                SET status = 'accepted', responded_at = :now
                WHERE id = :invite_id
                RETURNING {_INVITATION_COLUMNS}
            """),
                {"invite_id": invite_id, "now": datetime.now(UTC)},
            )
            .mappings()
            .fetchone()
        )

    return AcceptLibraryInviteResponse(
        invite=_invitation_row_to_out(updated),
        membership=InviteAcceptMembershipOut(
            library_id=invite_library_id,
            user_handle=seal_user(viewer_id),
            role=invite_role,
        ),
        idempotent=False,
    )


def decline_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> DeclineLibraryInviteResponse:
    """Decline a pending invitation. declined → declined is idempotent; accepted/revoked
    → 409."""
    try:
        invite_id = unseal_library_invitation(str(invitation_handle))
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc
    with transaction(db):
        inv = (
            db.execute(
                text(f"""
                SELECT {_INVITATION_COLUMNS}
                FROM library_invitations
                WHERE id = :invite_id AND invitee_user_id = :uid
                FOR UPDATE
            """),
                {"invite_id": invite_id, "uid": viewer_id},
            )
            .mappings()
            .fetchone()
        )

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        if inv["status"] == "declined":
            return DeclineLibraryInviteResponse(invite=_invitation_row_to_out(inv), idempotent=True)
        if inv["status"] != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

        updated = (
            db.execute(
                text(f"""
                UPDATE library_invitations
                SET status = 'declined', responded_at = :now
                WHERE id = :invite_id
                RETURNING {_INVITATION_COLUMNS}
            """),
                {"invite_id": invite_id, "now": datetime.now(UTC)},
            )
            .mappings()
            .fetchone()
        )

    return DeclineLibraryInviteResponse(invite=_invitation_row_to_out(updated), idempotent=False)


def revoke_library_invite(
    db: Session,
    viewer_id: UUID,
    invitation_handle: LibraryInvitationHandle | str,
) -> None:
    """Revoke a pending invitation. Admin-only; revoked → revoked is idempotent;
    accepted/declined → 409."""
    try:
        invite_id = unseal_library_invitation(str(invitation_handle))
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc
    with transaction(db):
        inv = (
            db.execute(
                text(f"""
                SELECT {_INVITATION_COLUMNS}
                FROM library_invitations
                WHERE id = :invite_id
                FOR UPDATE
            """),
                {"invite_id": invite_id},
            )
            .mappings()
            .fetchone()
        )

        if inv is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

        membership = db.execute(
            text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
            {"lid": inv["library_id"], "uid": viewer_id},
        ).fetchone()
        if membership is None:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")
        governance.require_admin(membership[0])

        if inv["status"] == "revoked":
            return
        if inv["status"] != "pending":
            raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")

        db.execute(
            text("""
                UPDATE library_invitations
                SET status = 'revoked', responded_at = :now
                WHERE id = :invite_id
            """),
            {"invite_id": invite_id, "now": datetime.now(UTC)},
        )
