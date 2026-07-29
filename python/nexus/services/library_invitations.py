"""Library invitations: the `library_invitations` table and its lifecycle.

Owns create/list/accept/decline/revoke. Membership commit alone changes Default
list/count/search immediately (spec AC3); no follow-up projection/backfill work
is required or performed.
"""

import base64
import json
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
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.library import (
    AcceptLibraryInviteResponse,
    DeclineLibraryInviteResponse,
    EmailLibraryInvitee,
    InviteAcceptMembershipOut,
    LibraryGovernancePageInfo,
    LibraryInvitationOut,
    LibraryInvitationStatusValue,
    LibraryInvitee,
    LibraryRole,
    ViewerLibraryInvitationOut,
)
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.services import library_governance as governance
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_families,
    bump_collection_revision,
)
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
_JOINED_INVITATION_COLUMNS = """
    i.id, i.library_id, i.inviter_user_id, i.invitee_user_id,
    i.role, i.status, i.created_at, i.responded_at,
    u.email, u.display_name
"""


def _invitation_row_to_out(row) -> LibraryInvitationOut:
    """Map one complete invitation-plus-invitee projection to the wire DTO."""
    return LibraryInvitationOut(
        invitation_handle=seal_library_invitation(row["id"]),
        library_id=row["library_id"],
        inviter_user_handle=seal_user(row["inviter_user_id"]),
        invitee_user_handle=seal_user(row["invitee_user_id"]),
        role=row["role"],
        status=row["status"],
        created_at=row["created_at"],
        responded_at=presence_from_nullable(row["responded_at"]),
        invitee_email=presence_from_nullable(row["email"]),
        invitee_display_name=presence_from_nullable(row["display_name"]),
    )


def _viewer_invitation_row_to_out(row) -> ViewerLibraryInvitationOut:
    return ViewerLibraryInvitationOut(
        **_invitation_row_to_out(row).model_dump(),
        library_name=row["library_name"],
    )


def _load_invitation_projection(db: Session, invitation_id: UUID) -> LibraryInvitationOut:
    row = (
        db.execute(
            text(f"""
                SELECT {_JOINED_INVITATION_COLUMNS}
                FROM library_invitations i
                JOIN users u ON u.id = i.invitee_user_id
                WHERE i.id = :invitation_id
            """),
            {"invitation_id": invitation_id},
        )
        .mappings()
        .one()
    )
    return _invitation_row_to_out(row)


def _require_mutable_invitation_library(db: Session, library_id: UUID) -> None:
    library = (
        db.execute(
            text("""
                SELECT is_default, system_key
                FROM libraries
                WHERE id = :library_id
            """),
            {"library_id": library_id},
        )
        .mappings()
        .one()
    )
    governance.require_non_default(library["is_default"])
    governance.require_not_system(library["system_key"])


def _encode_library_invitation_cursor(
    row,
    *,
    viewer_id: UUID,
    library_id: UUID,
    status: LibraryInvitationStatusValue,
) -> str:
    payload = {
        "k": "library_invitations:v1",
        "viewer": str(seal_user(viewer_id)),
        "library_id": str(library_id),
        "status": status,
        "created_at": row["created_at"].isoformat(),
        "after_invitation": str(seal_library_invitation(row["id"])),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def _decode_library_invitation_cursor(
    cursor: str,
    *,
    viewer_id: UUID,
    library_id: UUID,
    status: LibraryInvitationStatusValue,
) -> tuple[datetime, UUID]:
    try:
        if not cursor or "=" in cursor:
            raise ValueError
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != cursor:
            raise ValueError
        raw_payload: Any = json.loads(decoded.decode("utf-8"))
        if not isinstance(raw_payload, dict):
            raise ValueError
        payload: dict[str, Any] = raw_payload
        if (
            set(payload)
            != {
                "k",
                "viewer",
                "library_id",
                "status",
                "created_at",
                "after_invitation",
            }
            or not all(isinstance(value, str) for value in payload.values())
            or payload["k"] != "library_invitations:v1"
            or payload["viewer"] != str(seal_user(viewer_id))
            or UUID(str(payload["library_id"])) != library_id
            or payload["status"] != status
        ):
            raise ValueError
        cursor_created_at = datetime.fromisoformat(payload["created_at"])
        if (
            cursor_created_at.tzinfo is None
            or cursor_created_at.utcoffset() is None
            or cursor_created_at.isoformat() != payload["created_at"]
        ):
            raise ValueError
        return (
            cursor_created_at,
            unseal_library_invitation(str(payload["after_invitation"])),
        )
    except Exception:
        # justify-ignore-error: malformed cursor input is an expected API error path.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def create_library_invite(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    invitee: LibraryInvitee,
    role: LibraryRole,
) -> LibraryInvitationOut:
    """Create an invitation from one strict sealed-user or email audience."""

    def attempt() -> LibraryInvitationOut:
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
                raise ConflictError(
                    ApiErrorCode.E_INVITE_MEMBER_EXISTS,
                    "User is already a member",
                )

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
                invitation_id = db.execute(
                    text("""
                        INSERT INTO library_invitations
                            (library_id, inviter_user_id, invitee_user_id, role, status)
                        VALUES (:lid, :inviter, :invitee, :role, 'pending')
                        RETURNING id
                    """),
                    {
                        "lid": library_id,
                        "inviter": viewer_id,
                        "invitee": invitee_user_id,
                        "role": role,
                    },
                ).scalar_one()
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

            return _load_invitation_projection(db, invitation_id)

    return retry_serializable(db, "create_library_invite", attempt)


def list_library_invites(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    status: LibraryInvitationStatusValue = "pending",
    cursor: str | None = None,
    limit: int = 100,
) -> tuple[list[LibraryInvitationOut], LibraryGovernancePageInfo]:
    """List invitations for a library. Admin-only; ordered created_at DESC, id DESC."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)

    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    governance.require_admin(ctx.role)
    governance.require_not_system(ctx.system_key)

    cursor_clause = ""
    params: dict[str, object] = {
        "lid": library_id,
        "status": status,
        "limit": limit + 1,
    }
    if cursor is not None:
        cursor_created_at, cursor_invitation_id = _decode_library_invitation_cursor(
            cursor,
            viewer_id=viewer_id,
            library_id=library_id,
            status=status,
        )
        cursor_clause = """
            AND (
                i.created_at < :cursor_created_at
                OR (
                    i.created_at = :cursor_created_at
                    AND i.id < :cursor_invitation_id
                )
            )
        """
        params.update(
            {
                "cursor_created_at": cursor_created_at,
                "cursor_invitation_id": cursor_invitation_id,
            }
        )

    rows = (
        db.execute(
            text(f"""
            SELECT {_JOINED_INVITATION_COLUMNS}
            FROM library_invitations i
            JOIN users u ON u.id = i.invitee_user_id
            WHERE i.library_id = :lid AND i.status = :status
              {cursor_clause}
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
        """),
            params,
        )
        .mappings()
        .all()
    )
    page_rows = rows[:limit]
    next_cursor = (
        _encode_library_invitation_cursor(
            page_rows[-1],
            viewer_id=viewer_id,
            library_id=library_id,
            status=status,
        )
        if len(rows) > limit
        else None
    )
    return (
        [_invitation_row_to_out(row) for row in page_rows],
        LibraryGovernancePageInfo(
            next_cursor=present(next_cursor) if next_cursor is not None else absent()
        ),
    )


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
            text(f"""
            SELECT {_JOINED_INVITATION_COLUMNS}, l.name AS library_name
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

    def attempt() -> AcceptLibraryInviteResponse:
        try:
            invite_id = unseal_library_invitation(str(invitation_handle))
        except InvalidSealedHandle as exc:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc

        with transaction(db):
            inv = (
                db.execute(
                    text(f"""
                    SELECT {_JOINED_INVITATION_COLUMNS}
                    FROM library_invitations i
                    JOIN users u ON u.id = i.invitee_user_id
                    WHERE i.id = :invite_id AND i.invitee_user_id = :uid
                    FOR UPDATE OF i
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
                membership = db.execute(
                    text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
                    {"lid": invite_library_id, "uid": viewer_id},
                ).fetchone()
                return AcceptLibraryInviteResponse(
                    invite=_invitation_row_to_out(inv),
                    membership=InviteAcceptMembershipOut(
                        library_id=invite_library_id,
                        user_handle=seal_user(viewer_id),
                        role=membership[0] if membership else invite_role,
                    ),
                    idempotent=True,
                )

            if inv["status"] != "pending":
                raise ConflictError(
                    ApiErrorCode.E_INVITE_NOT_PENDING,
                    "Invitation is not pending",
                )

            _require_mutable_invitation_library(db, invite_library_id)

            membership = db.execute(
                text("SELECT role FROM memberships WHERE library_id = :lid AND user_id = :uid"),
                {"lid": invite_library_id, "uid": viewer_id},
            ).fetchone()
            membership_role = membership[0] if membership is not None else invite_role
            if membership is None:
                result = db.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:lid, :uid, :role)
                    """),
                    {"lid": invite_library_id, "uid": viewer_id, "role": invite_role},
                )
                assert getattr(result, "rowcount", None) == 1

            result = db.execute(
                text("""
                    UPDATE library_invitations
                    SET status = 'accepted', responded_at = :now
                    WHERE id = :invite_id
                """),
                {"invite_id": invite_id, "now": datetime.now(UTC)},
            )
            assert getattr(result, "rowcount", None) == 1
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
            bump_collection_revision(
                db,
                viewer_id=viewer_id,
                family=CollectionFamily.ConversationIndex,
            )
            updated = _load_invitation_projection(db, invite_id)

            return AcceptLibraryInviteResponse(
                invite=updated,
                membership=InviteAcceptMembershipOut(
                    library_id=invite_library_id,
                    user_handle=seal_user(viewer_id),
                    role=membership_role,
                ),
                idempotent=False,
            )

    return retry_serializable(db, "accept_library_invite", attempt)


def decline_library_invite(
    db: Session, viewer_id: UUID, invitation_handle: LibraryInvitationHandle | str
) -> DeclineLibraryInviteResponse:
    """Decline a pending invitation. declined → declined is idempotent; accepted/revoked
    → 409."""

    def attempt() -> DeclineLibraryInviteResponse:
        try:
            invite_id = unseal_library_invitation(str(invitation_handle))
        except InvalidSealedHandle as exc:
            raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found") from exc

        with transaction(db):
            inv = (
                db.execute(
                    text(f"""
                    SELECT {_JOINED_INVITATION_COLUMNS}
                    FROM library_invitations i
                    JOIN users u ON u.id = i.invitee_user_id
                    WHERE i.id = :invite_id AND i.invitee_user_id = :uid
                    FOR UPDATE OF i
                """),
                    {"invite_id": invite_id, "uid": viewer_id},
                )
                .mappings()
                .fetchone()
            )

            if inv is None:
                raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")

            if inv["status"] == "declined":
                return DeclineLibraryInviteResponse(
                    invite=_invitation_row_to_out(inv),
                    idempotent=True,
                )
            if inv["status"] != "pending":
                raise ConflictError(
                    ApiErrorCode.E_INVITE_NOT_PENDING,
                    "Invitation is not pending",
                )

            _require_mutable_invitation_library(db, inv["library_id"])

            result = db.execute(
                text("""
                    UPDATE library_invitations
                    SET status = 'declined', responded_at = :now
                    WHERE id = :invite_id
                """),
                {"invite_id": invite_id, "now": datetime.now(UTC)},
            )
            assert getattr(result, "rowcount", None) == 1
            updated = _load_invitation_projection(db, invite_id)
            return DeclineLibraryInviteResponse(invite=updated, idempotent=False)

    return retry_serializable(db, "decline_library_invite", attempt)


def revoke_library_invite(
    db: Session,
    viewer_id: UUID,
    invitation_handle: LibraryInvitationHandle | str,
) -> None:
    """Revoke a pending invitation. Admin-only; revoked → revoked is idempotent;
    accepted/declined → 409."""

    def attempt() -> None:
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
                raise ConflictError(
                    ApiErrorCode.E_INVITE_NOT_PENDING,
                    "Invitation is not pending",
                )

            _require_mutable_invitation_library(db, inv["library_id"])

            result = db.execute(
                text("""
                    UPDATE library_invitations
                    SET status = 'revoked', responded_at = :now
                    WHERE id = :invite_id
                """),
                {"invite_id": invite_id, "now": datetime.now(UTC)},
            )
            assert getattr(result, "rowcount", None) == 1

    retry_serializable(db, "revoke_library_invite", attempt)
