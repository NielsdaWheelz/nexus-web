"""Library members: the `memberships` and `library_invitations` tables.

A membership lets a user read what a library files (member) or also change it
(admin); the owner is always an admin. An invitation is the invitee's consent:
accepting inserts the membership and the status in one transaction, so the
invitee's All changes on their next read. Only mutable libraries (named, not
system) take invitations and member changes. Every rule authorizes through
`libraries.access`.

Retry rules: an invitation resends its client id (the same id answers that
invitation); a role change carries the role it expects to replace; removing,
leaving, revoking and repeating an answer are idempotent; a transfer to the
current owner succeeds.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.library_members import (
    CreateInvitationRequest,
    LibraryInvitationOut,
    LibraryMemberOut,
    SetMemberRoleRequest,
    ViewerInvitationOut,
)
from nexus.services import libraries, resource_grants
from nexus.services.collection_keyset import KeysetValueKind, SortKey, keyset_page
from nexus.services.suggestion_changes import delete_suggestion_feeds, record_input_change

_NEWEST = (
    SortKey("created_at", "desc", KeysetValueKind.DateTime),
    SortKey("id", "desc", KeysetValueKind.Uuid),
)
_MEMBERS = """
    SELECT m.user_id, m.role, m.created_at, u.email, u.display_name,
           m.user_id = l.owner_user_id AS is_owner
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN libraries l ON l.id = m.library_id
    WHERE m.library_id = :library_id
"""
# The invitee's email only as the inviter typed it, or once the invitee is a member.
_INVITATIONS = """
    SELECT i.id, i.library_id, i.role, i.status, i.created_at, i.invitee_user_id,
           coalesce(i.invitee_email, CASE WHEN m.user_id IS NOT NULL THEN u.email END)
               AS invitee_email,
           u.display_name AS invitee_display_name
    FROM library_invitations i
    JOIN users u ON u.id = i.invitee_user_id
    LEFT JOIN memberships m ON m.library_id = i.library_id AND m.user_id = i.invitee_user_id
"""
_ANSWER = """
    UPDATE library_invitations SET status = :status, responded_at = now() WHERE id = :id
"""


def _managed(db: Session, viewer_id: UUID, library_id: UUID) -> libraries.LibraryAccess:
    """An admin's access to a mutable library."""
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_mutable()
    library.require_admin()
    return library


def list_members(
    db: Session, viewer_id: UUID, library_id: UUID, *, cursor: str | None, limit: int
) -> CollectionPage[LibraryMemberOut]:
    """One page of a library's members in user id order. Admin-only."""
    libraries.access(db, viewer_id, library_id, lock=False).require_admin()
    rows, next_cursor = keyset_page(
        db,
        binding={"list": "LibraryMembers", "viewer": viewer_id, "library": library_id},
        plan=(SortKey("user_id", "asc", KeysetValueKind.Uuid),),
        alias="m",
        cursor=cursor,
        limit=limit,
        params={"library_id": library_id},
        sql=lambda keyset, order: f"{_MEMBERS} {keyset} ORDER BY {order} LIMIT :limit",
    )
    return CollectionPage[LibraryMemberOut](
        items=[LibraryMemberOut(**row) for row in rows], next_cursor=next_cursor
    )


def set_member_role(
    db: Session, viewer_id: UUID, library_id: UUID, user_id: UUID, body: SetMemberRoleRequest
) -> None:
    """An admin sets a member's role; the owner's is fixed. Already that role:
    success; a role other than expected: 409 with `current_role`."""

    def attempt() -> None:
        with transaction(db):
            library = _managed(db, viewer_id, library_id)
            if user_id == library.owner_user_id:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_EXIT_FORBIDDEN, "Transfer ownership first"
                )
            params = {"library_id": library_id, "user_id": user_id, "role": body.role}
            current = db.scalar(
                text(
                    "SELECT role FROM memberships WHERE library_id = :library_id AND user_id = :user_id"
                ),
                params,
            )
            if current is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Member not found")
            if current == body.role:
                return
            if current != body.expected_role:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "The role was changed meanwhile",
                    details={"current_role": current},
                )
            db.execute(
                text("""
                    UPDATE memberships SET role = :role
                    WHERE library_id = :library_id AND user_id = :user_id
                """),
                params,
            )
            if body.role == "member":
                delete_suggestion_feeds(db, library_id=library_id, user_id=user_id)
            record_input_change(db)

    retry_serializable(db, "set_member_role", attempt)


def remove_member(db: Session, viewer_id: UUID, library_id: UUID, user_id: UUID) -> None:
    """An admin removes a member, or a member leaves (`user_id` is the viewer); the
    owner transfers first. Already gone, or a library the viewer cannot see: success."""

    def attempt() -> None:
        with transaction(db):
            try:
                library = libraries.access(db, viewer_id, library_id, lock=False)
            except NotFoundError:
                return
            library.require_mutable()
            if user_id != viewer_id:
                library.require_admin()
            if user_id == library.owner_user_id:
                raise ForbiddenError(
                    ApiErrorCode.E_OWNER_EXIT_FORBIDDEN, "Transfer ownership first"
                )
            projections = resource_grants.library_annotation_visibility(db, library_id)
            removed = db.scalar(
                text("""
                    DELETE FROM memberships WHERE library_id = :library_id AND user_id = :user_id
                    RETURNING user_id
                """),
                {"library_id": library_id, "user_id": user_id},
            )
            if removed is not None:
                delete_suggestion_feeds(db, library_id=library_id, user_id=user_id)
                resource_grants.invalidate_annotation_visibility(db, projections)
                record_input_change(db)

    retry_serializable(db, "remove_member", attempt)


def transfer_ownership(db: Session, viewer_id: UUID, library_id: UUID, user_id: UUID) -> None:
    """The owner hands the library to a member, who becomes an admin; the old owner
    stays an admin. Already that member's: success."""

    def attempt() -> None:
        with transaction(db):
            library = libraries.access(db, viewer_id, library_id, lock=False)
            library.require_mutable()
            if library.owner_user_id == user_id:
                return
            library.require_owner(viewer_id)
            params = {"library_id": library_id, "user_id": user_id}
            promoted = db.scalar(
                text("""
                    UPDATE memberships SET role = 'admin'
                    WHERE library_id = :library_id AND user_id = :user_id RETURNING user_id
                """),
                params,
            )
            if promoted is None:
                raise ConflictError(
                    ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID, "The new owner must be a member"
                )
            db.execute(
                text("""
                    UPDATE libraries SET owner_user_id = :user_id, updated_at = now()
                    WHERE id = :library_id
                """),
                params,
            )
            record_input_change(db)

    retry_serializable(db, "transfer_ownership", attempt)


def create_invitation(
    db: Session, viewer_id: UUID, library_id: UUID, body: CreateInvitationRequest
) -> LibraryInvitationOut:
    """An admin invites an existing user, found by name or by the email the admin typed
    (stored as typed; 400 when it is not the user's). The same id answers that invitation
    (409 when it is another one); a member, or a pending invitation under another id, is
    409."""
    by_id = text(f"{_INVITATIONS} WHERE i.id = :id")

    def attempt() -> LibraryInvitationOut:
        with transaction(db):
            _managed(db, viewer_id, library_id)
            existing = db.execute(by_id, {"id": body.id}).mappings().first()
            if existing is not None:
                if (existing["library_id"], existing["invitee_user_id"]) != (
                    library_id,
                    body.invitee_user_id,
                ):
                    raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Invitation id is taken")
                return LibraryInvitationOut(**existing)
            params = {
                "library_id": library_id,
                "user_id": body.invitee_user_id,
                "email": body.invitee_email,
            }
            state = db.execute(
                text("""
                    SELECT
                        lower(u.email) = lower(:email) AS typed,
                        EXISTS (
                            SELECT 1 FROM memberships
                            WHERE library_id = :library_id AND user_id = :user_id
                        ) AS member,
                        EXISTS (
                            SELECT 1 FROM library_invitations
                            WHERE library_id = :library_id AND invitee_user_id = :user_id
                              AND status = 'pending'
                        ) AS pending
                    FROM users u WHERE u.id = :user_id
                """),
                params,
            ).first()
            if state is None:
                raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
            if body.invitee_email is not None and not state.typed:
                raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Not this user's email")
            if state.member:
                raise ConflictError(ApiErrorCode.E_INVITE_MEMBER_EXISTS, "Already a member")
            if state.pending:
                raise ConflictError(ApiErrorCode.E_INVITE_ALREADY_EXISTS, "Already invited")
            db.execute(
                text("""
                    INSERT INTO library_invitations
                        (id, library_id, inviter_user_id, invitee_user_id, invitee_email, role,
                         status)
                    VALUES (:id, :library_id, :viewer_id, :user_id, :email, :role, 'pending')
                """),
                {**params, "id": body.id, "viewer_id": viewer_id, "role": body.role},
            )
            return LibraryInvitationOut(**db.execute(by_id, {"id": body.id}).mappings().one())

    return retry_serializable(db, "create_invitation", attempt)


def list_invitations(
    db: Session, viewer_id: UUID, library_id: UUID, *, cursor: str | None, limit: int
) -> CollectionPage[LibraryInvitationOut]:
    """A library's pending invitations, newest first. Admin-only."""
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_not_system()
    library.require_admin()
    rows, next_cursor = keyset_page(
        db,
        binding={"list": "LibraryInvitations", "viewer": viewer_id, "library": library_id},
        plan=_NEWEST,
        alias="i",
        cursor=cursor,
        limit=limit,
        params={"library_id": library_id},
        sql=lambda keyset, order: f"""
            {_INVITATIONS}
            WHERE i.library_id = :library_id AND i.status = 'pending' {keyset}
            ORDER BY {order} LIMIT :limit
        """,
    )
    return CollectionPage[LibraryInvitationOut](
        items=[LibraryInvitationOut(**row) for row in rows], next_cursor=next_cursor
    )


def list_viewer_invitations(
    db: Session, viewer_id: UUID, *, cursor: str | None, limit: int
) -> CollectionPage[ViewerInvitationOut]:
    """The invitations waiting for the viewer, newest first, with who sent them."""
    rows, next_cursor = keyset_page(
        db,
        binding={"list": "ViewerInvitations", "viewer": viewer_id},
        plan=_NEWEST,
        alias="i",
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id},
        sql=lambda keyset, order: f"""
            SELECT i.id, i.library_id, l.name AS library_name, i.role, i.created_at,
                   u.email AS inviter_email, u.display_name AS inviter_display_name
            FROM library_invitations i
            JOIN libraries l ON l.id = i.library_id
            JOIN users u ON u.id = i.inviter_user_id
            WHERE i.invitee_user_id = :viewer_id AND i.status = 'pending' {keyset}
            ORDER BY {order} LIMIT :limit
        """,
    )
    return CollectionPage[ViewerInvitationOut](
        items=[ViewerInvitationOut(**row) for row in rows], next_cursor=next_cursor
    )


def respond_to_invitation(
    db: Session, viewer_id: UUID, invitation_id: UUID, *, accept: bool
) -> None:
    """The invitee accepts (the membership and the status in one transaction) or
    declines. Repeating the same answer succeeds; any other state is 409."""
    status = "accepted" if accept else "declined"

    def attempt() -> None:
        with transaction(db):
            row = db.execute(
                text("""
                    SELECT library_id, role, status FROM library_invitations
                    WHERE id = :id AND invitee_user_id = :viewer_id
                """),
                {"id": invitation_id, "viewer_id": viewer_id},
            ).first()
            if row is None:
                raise NotFoundError(ApiErrorCode.E_INVITE_NOT_FOUND, "Invitation not found")
            if row.status == status:
                return
            if row.status != "pending":
                raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")
            db.execute(text(_ANSWER), {"id": invitation_id, "status": status})
            if accept:
                db.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :viewer_id, :role) ON CONFLICT DO NOTHING
                    """),
                    {"library_id": row.library_id, "viewer_id": viewer_id, "role": row.role},
                )
                resource_grants.invalidate_annotation_visibility(
                    db, resource_grants.library_annotation_visibility(db, row.library_id)
                )
                record_input_change(db)

    retry_serializable(db, "respond_to_invitation", attempt)


def revoke_invitation(db: Session, viewer_id: UUID, invitation_id: UUID) -> None:
    """An admin of the invitation's library withdraws it. Already revoked, absent, or
    in a library the viewer cannot see: success."""

    def attempt() -> None:
        with transaction(db):
            row = db.execute(
                text("SELECT library_id, status FROM library_invitations WHERE id = :id"),
                {"id": invitation_id},
            ).first()
            if row is None or row.status == "revoked":
                return
            try:
                library = libraries.access(db, viewer_id, row.library_id, lock=False)
            except NotFoundError:
                return
            library.require_admin()
            if row.status != "pending":
                raise ConflictError(ApiErrorCode.E_INVITE_NOT_PENDING, "Invitation is not pending")
            db.execute(text(_ANSWER), {"id": invitation_id, "status": "revoked"})

    retry_serializable(db, "revoke_invitation", attempt)
