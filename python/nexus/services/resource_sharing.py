"""The Share overlay's snapshot and create command. One ordered availability check serves both
audiences, first failing reason first; create re-runs it under the subject's row locks. A
subject the viewer cannot read is 404 to both, so neither reveals that it exists.

Retry rule: a create resends its client id. The same id answers that grant (409 when it names
another one), and the creator's existing grant for the same audience answers as it is.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.config import get_settings
from nexus.db.models import Highlight, MediaTeardownIntent, ResourceGrant, User
from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.resource_sharing import (
    AudienceAvailableOut,
    AudienceUnavailableOut,
    AudienceUnavailableReason,
    CreateResourceShareOut,
    CreateResourceShareRequest,
    CreationAvailabilityOut,
    LinkShareOut,
    ReceivedUserShareOut,
    ResourceShareSnapshotOut,
    ShareMembersOut,
    ShareUserOut,
    UserAudienceIn,
    UserShareOut,
)
from nexus.services import libraries, public_resource_sharing, resource_grants
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.routing import route_for_ref
from nexus.services.suggestion_changes import record_input_change


def _href(path: str) -> str:
    return get_settings().app_public_url.rstrip("/") + path


def _user(user: User, email: str | None) -> ShareUserOut:
    return ShareUserOut(user_id=user.id, email=email, display_name=user.display_name)


def _owned(grant: ResourceGrant, grantee: User | None) -> UserShareOut | LinkShareOut:
    """The creator's grant; the grantee's email only as the creator typed it."""
    if grantee is None:
        return LinkShareOut(id=grant.id, public_href=_href(f"/s#share={grant.share_token}"))
    return UserShareOut(id=grant.id, user=_user(grantee, grant.grantee_email))


def _not_found() -> NotFoundError:
    return NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")


def _unavailable(
    db: Session, viewer_id: UUID, subject: ResourceRef, *, lock: bool
) -> AudienceUnavailableReason | None:
    """Why the viewer may not grant the subject to anyone now, or None; 404 when the
    viewer cannot read it."""
    if capability(subject.scheme).sharing not in {"ResourceGrants", "HighlightGrants"}:
        return "UnsupportedSubject"
    if lock:
        resource_grants.lock_subject(db, subject)
    media_id, owner_id = subject.id, viewer_id
    if subject.scheme == "highlight":
        owned_by = select(Highlight.anchor_media_id, Highlight.user_id)
        row = db.execute(
            owned_by.where(Highlight.id == subject.id, Highlight.authored_visible)
        ).one_or_none()
        if row is None:
            raise _not_found()
        media_id, owner_id = row
    if not can_read_media(db, viewer_id, media_id, include_tearing_down=True) or (
        owner_id != viewer_id and not can_read_highlight(db, viewer_id, subject.id)
    ):
        raise _not_found()
    if db.scalar(select(exists().where(MediaTeardownIntent.media_id == media_id))):
        return "Deleting"
    if owner_id != viewer_id:
        return "InsufficientAuthority"
    if subject.scheme == "highlight" and not resolve_highlight_reader_target(
        db, highlight_id=subject.id
    ):
        return "HighlightUnresolved"
    return None


def get_share_snapshot(
    db: Session, *, viewer_user_id: UUID, subject: ResourceRef
) -> ResourceShareSnapshotOut:
    route = None
    if not resolve_refs(db, viewer_id=viewer_user_id, refs=[subject])[0].missing:
        route = route_for_ref(db, viewer_id=viewer_user_id, ref=subject, missing=False)
    if route is None:
        raise _not_found()
    mode = capability(subject.scheme).sharing
    user = _unavailable(db, viewer_user_id, subject, lock=False)
    link = user or public_resource_sharing.link_readiness(db, subject)
    members = None
    if mode == "LibraryMembership":
        library = libraries.access(db, viewer_user_id, subject.id, lock=False)
        if library.mutable:
            members = ShareMembersOut(can_manage=library.out(viewer_user_id).can_manage)
    # Only media and highlights have grant rows, so other subjects list none.
    owned = resource_grants.creator_grants(db, creator_id=viewer_user_id, subject=subject)
    received = resource_grants.received_grants(db, recipient_id=viewer_user_id, subject=subject)
    return ResourceShareSnapshotOut(
        sharing=mode,
        authenticated_href=_href(route),
        creation_availability=CreationAvailabilityOut(
            user=AudienceUnavailableOut(reason=user) if user else AudienceAvailableOut(),
            link=AudienceUnavailableOut(reason=link) if link else AudienceAvailableOut(),
        ),
        shares=[_owned(grant, grantee) for grant, grantee in owned],
        received_access=[
            ReceivedUserShareOut(
                id=grant.id,
                shared_by=_user(creator, creator.email),
                subject=f"{grant.subject_scheme}:{grant.subject_id}",
            )
            for grant, creator in received
        ],
        members=members,
    )


def _grantee(db: Session, viewer_id: UUID, audience: UserAudienceIn) -> User:
    """The user a person grant names: someone other than the viewer who exists, and
    whose email the typed one is (in any case) when the viewer typed one."""
    typed = func.lower(User.email) == func.lower(audience.email)
    row = db.execute(select(User, typed).where(User.id == audience.user_id)).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
    grantee, is_theirs = row
    if grantee.id == viewer_id:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Cannot share a resource with yourself"
        )
    if audience.email is not None and not is_theirs:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Not this user's email")
    return grantee


def create_share(
    db: Session, *, viewer_user_id: UUID, subject: ResourceRef, body: CreateResourceShareRequest
) -> CreateResourceShareOut:
    """Grant the subject to one audience, or answer the grant that already does."""

    def attempt() -> CreateResourceShareOut:
        with transaction(db):
            reason = _unavailable(db, viewer_user_id, subject, lock=True)
            if reason is not None:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Share unavailable: {reason}"
                )
            grantee, email = None, None
            if isinstance(body.audience, UserAudienceIn):
                grantee, email = _grantee(db, viewer_user_id, body.audience), body.audience.email
            grantee_id = grantee.id if grantee else None
            same = (viewer_user_id, subject.scheme, subject.id, grantee_id)
            grant = db.get(ResourceGrant, body.id)
            if grant is not None and same != (
                grant.created_by_user_id,
                grant.subject_scheme,
                grant.subject_id,
                grant.grantee_user_id,
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Share id is taken")
            grant = grant or resource_grants.find_grant(
                db, creator_id=viewer_user_id, subject=subject, grantee_id=grantee_id
            )
            if grant is not None:
                return CreateResourceShareOut(share=_owned(grant, grantee), created=False)
            if grantee is None and (reason := public_resource_sharing.link_readiness(db, subject)):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Share unavailable: {reason}"
                )
            grant = resource_grants.insert_grant(
                db,
                id=body.id,
                creator_id=viewer_user_id,
                subject=subject,
                grantee_id=grantee_id,
                grantee_email=email,
            )
            result = CreateResourceShareOut(share=_owned(grant, grantee), created=True)
            record_input_change(db)
            return result

    return retry_serializable(db, "create_resource_grant", attempt)
