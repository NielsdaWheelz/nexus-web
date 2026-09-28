"""The Share overlay's snapshot and create command. One ordered availability check serves both
audiences, first failing reason first; create re-runs it under the subject's row locks."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import Highlight, MediaTeardownIntent, ResourceGrant, User
from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.schemas.resource_sharing import (
    AudienceAvailableOut,
    AudienceUnavailableOut,
    AudienceUnavailableReason,
    CreateResourceShareOut,
    CreationAvailabilityOut,
    LinkAudienceIn,
    LinkShareOut,
    ReceivedUserShareOut,
    ResourceShareSnapshotOut,
    ShareMembersOut,
    ShareUserOut,
    UserAudienceIn,
    UserShareOut,
)
from nexus.services import public_resource_sharing, resource_grants
from nexus.services.library_governance import library_out, lock_library_for_member
from nexus.services.locator_resolver import resolve_highlight_reader_target
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_items.capabilities import capability_for_ref
from nexus.services.resource_items.routing import route_for_ref
from nexus.services.sealed_handles import (
    InvalidSealedHandle,
    seal_resource_grant,
    seal_user,
    unseal_user,
)


def _href(path: str) -> str:
    return get_settings().app_public_url.rstrip("/") + path


def _user(user: User) -> ShareUserOut:
    return ShareUserOut(
        user_handle=seal_user(user.id),
        email=presence_from_nullable(user.email),
        display_name=presence_from_nullable(user.display_name),
    )


def _owned(grant: ResourceGrant, grantee: User | None) -> UserShareOut | LinkShareOut:
    handle = seal_resource_grant(grant.id)
    if grantee is None:
        return LinkShareOut(handle=handle, public_href=_href(f"/s#share={grant.share_token}"))
    return UserShareOut(handle=handle, user=_user(grantee))


def _unavailable(
    db: Session, viewer_id: UUID, subject: ResourceRef, *, lock: bool
) -> AudienceUnavailableReason | None:
    """Why the viewer may not grant the subject to anyone now, or None."""
    if capability_for_ref(subject).sharing not in {"ResourceGrants", "HighlightGrants"}:
        return "UnsupportedSubject"
    if lock:
        resource_grants.lock_subject(db, subject)
    media_id, owner_id = subject.id, viewer_id
    if subject.scheme == "highlight":
        owned_by = select(Highlight.anchor_media_id, Highlight.user_id)
        row = db.execute(owned_by.where(Highlight.id == subject.id)).one_or_none()
        if row is None:
            return "InsufficientAuthority"
        media_id, owner_id = row
    if db.scalar(select(exists().where(MediaTeardownIntent.media_id == media_id))):
        return "Deleting"
    if owner_id != viewer_id or not can_read_media(
        db, viewer_id, media_id, include_tearing_down=True
    ):
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
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    mode = capability_for_ref(subject).sharing
    user = _unavailable(db, viewer_user_id, subject, lock=False)
    link = user or public_resource_sharing.link_readiness(db, subject)
    members = absent()
    if mode == "LibraryMembership":
        library = library_out(
            lock_library_for_member(db, viewer_user_id, subject.id, lock=False),
            viewer_id=viewer_user_id,
        )
        if not library.is_default and library.system_key is None:
            members = present(ShareMembersOut(can_manage=library.can_manage_members))
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
                handle=seal_resource_grant(grant.id),
                shared_by=_user(creator),
                subject=f"{grant.subject_scheme}:{grant.subject_id}",
            )
            for grant, creator in received
        ],
        members=members,
    )


def _grantee(db: Session, viewer_id: UUID, handle: str) -> User:
    """The user a person grant names: someone other than the viewer who still exists."""
    try:
        grantee = db.get(User, unseal_user(handle))
    except InvalidSealedHandle as exc:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
    if grantee is None:
        raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")
    if grantee.id == viewer_id:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Cannot share a resource with yourself"
        )
    return grantee


def create_share(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
    audience: UserAudienceIn | LinkAudienceIn,
) -> CreateResourceShareOut:
    """Grant the subject, or return the viewer's existing grant for that audience."""

    def attempt() -> CreateResourceShareOut:
        with transaction(db):
            reason = _unavailable(db, viewer_user_id, subject, lock=True)
            if reason is not None:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Share unavailable: {reason}"
                )
            grantee = None
            if isinstance(audience, UserAudienceIn):
                grantee = _grantee(db, viewer_user_id, audience.user_handle)
            grantee_id = grantee.id if grantee else None
            grant = resource_grants.find_grant(
                db, creator_id=viewer_user_id, subject=subject, grantee_id=grantee_id
            )
            if grant is not None:
                return CreateResourceShareOut(share=_owned(grant, grantee), created=False)
            if grantee is None and (reason := public_resource_sharing.link_readiness(db, subject)):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Share unavailable: {reason}"
                )
            grant = resource_grants.insert_grant(
                db, creator_id=viewer_user_id, subject=subject, grantee_id=grantee_id
            )
            return CreateResourceShareOut(share=_owned(grant, grantee), created=True)

    return retry_serializable(db, "create_resource_grant", attempt)
