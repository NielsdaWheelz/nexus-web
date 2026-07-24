"""Authenticated Share snapshot and mutation projection owner."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import Highlight, MediaTeardownIntent, User
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.resource_sharing import (
    AudienceAvailabilityOut,
    AudienceAvailableOut,
    AudienceUnavailableOut,
    CreateResourceShareOut,
    GrantCreationAvailabilityOut,
    LinkAudienceIn,
    LinkShareOut,
    OwnedShareOut,
    ReceivedUserShareOut,
    ResourceShareSnapshotOut,
    ShareUserOut,
    UserAudienceIn,
    UserShareOut,
)
from nexus.services import resource_grants
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.public_resource_sharing import (
    Available as ProjectionAvailable,
)
from nexus.services.public_resource_sharing import (
    ProjectionNotReady,
    ProjectionUnsupported,
    highlight_target_available,
    link_projection_availability,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.capabilities import capability_for_ref
from nexus.services.resource_items.routing import route_for_ref
from nexus.services.sealed_handles import InvalidSealedHandle, seal_user, unseal_user


def _absolute_href(path: str) -> str:
    return f"{get_settings().app_public_url.rstrip('/')}{path}"


def _user_out(user: User) -> ShareUserOut:
    return ShareUserOut(
        user_handle=seal_user(user.id),
        email=user.email,
        display_name=user.display_name,
    )


def _availability(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
    link: bool,
    check_entitlement: bool = True,
    check_link_projection: bool = True,
) -> AudienceAvailabilityOut:
    mode = capability_for_ref(subject).sharing
    if mode not in {"ResourceGrants", "HighlightGrants"}:
        return AudienceUnavailableOut(reason="UnsupportedSubject")

    parent_media_id = subject.id
    highlight_owner_id: UUID | None = None
    if subject.scheme == "highlight":
        row = db.execute(
            select(Highlight.anchor_media_id, Highlight.user_id).where(Highlight.id == subject.id)
        ).one_or_none()
        if row is None:
            return AudienceUnavailableOut(reason="InsufficientAuthority")
        parent_media_id = row.anchor_media_id
        highlight_owner_id = row.user_id

    if db.scalar(
        select(MediaTeardownIntent.media_id).where(MediaTeardownIntent.media_id == parent_media_id)
    ):
        return AudienceUnavailableOut(reason="Deleting")
    if highlight_owner_id is not None and highlight_owner_id != viewer_user_id:
        return AudienceUnavailableOut(reason="InsufficientAuthority")
    if not can_read_media(
        db,
        viewer_user_id,
        parent_media_id,
        include_tearing_down=True,
    ):
        return AudienceUnavailableOut(reason="InsufficientAuthority")
    if subject.scheme == "highlight" and not highlight_target_available(
        db,
        highlight_id=subject.id,
    ):
        return AudienceUnavailableOut(reason="HighlightUnresolved")
    if check_entitlement and not get_effective_entitlements(db, viewer_user_id).can_share:
        return AudienceUnavailableOut(reason="EntitlementRequired")
    if link and check_link_projection:
        projection = link_projection_availability(db, subject=subject)
        if isinstance(projection, ProjectionNotReady):
            return AudienceUnavailableOut(reason="ProjectionNotReady")
        if isinstance(projection, ProjectionUnsupported):
            return AudienceUnavailableOut(reason="ProjectionUnsupported")
        if not isinstance(projection, ProjectionAvailable):
            raise AssertionError("unknown public projection availability")
    return AudienceAvailableOut()


def _owned_share(
    db: Session,
    grant: resource_grants.ResourceGrantRecord,
) -> OwnedShareOut:
    if isinstance(grant.audience, resource_grants.UserGrantAudience):
        user = db.get(User, grant.audience.user_id)
        if user is None:
            raise AssertionError("resource grant references a missing recipient")
        return UserShareOut(handle=grant.handle, user=_user_out(user))
    if grant.share_token is None:
        raise AssertionError("link resource grant is missing its token")
    return LinkShareOut(
        handle=grant.handle,
        public_href=_absolute_href(f"/s#share={grant.share_token}"),
    )


def get_share_snapshot(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
) -> ResourceShareSnapshotOut:
    mode = capability_for_ref(subject).sharing
    route = route_for_ref(db, viewer_id=viewer_user_id, ref=subject)
    if route is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    owned: list[OwnedShareOut] = []
    received: list[ReceivedUserShareOut] = []
    if mode in {"ResourceGrants", "HighlightGrants"}:
        for grant in resource_grants.list_creator_grants(
            db,
            creator_id=viewer_user_id,
            subject=subject,
        ):
            owned.append(_owned_share(db, grant))
        for grant in resource_grants.list_received_grants(
            db,
            recipient_id=viewer_user_id,
            snapshot_subject=subject,
        ):
            creator = db.get(User, grant.creator_id)
            if creator is None:
                raise AssertionError("resource grant references a missing creator")
            received.append(
                ReceivedUserShareOut(
                    handle=grant.handle,
                    shared_by=_user_out(creator),
                    subject=grant.subject.uri,
                )
            )

    return ResourceShareSnapshotOut(
        subject=subject.uri,
        sharing=mode,
        authenticated_href=_absolute_href(route),
        creation_availability=GrantCreationAvailabilityOut(
            user=_availability(
                db,
                viewer_user_id=viewer_user_id,
                subject=subject,
                link=False,
            ),
            link=_availability(
                db,
                viewer_user_id=viewer_user_id,
                subject=subject,
                link=True,
            ),
        ),
        shares=owned,
        received_access=received,
    )


def create_share(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
    audience: UserAudienceIn | LinkAudienceIn,
) -> CreateResourceShareOut:
    selected = _availability(
        db,
        viewer_user_id=viewer_user_id,
        subject=subject,
        link=isinstance(audience, LinkAudienceIn),
        check_entitlement=False,
        check_link_projection=False,
    )
    if isinstance(selected, AudienceUnavailableOut):
        if selected.reason == "EntitlementRequired":
            raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Sharing requires an eligible plan")
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Share unavailable: {selected.reason}")

    if isinstance(audience, UserAudienceIn):
        try:
            recipient_id = unseal_user(audience.user_handle)
        except InvalidSealedHandle as exc:
            raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found") from exc
        grant_audience: resource_grants.GrantAudience = resource_grants.UserGrantAudience(
            user_id=recipient_id
        )
    else:
        grant_audience = resource_grants.LinkGrantAudience()
    result = resource_grants.create_grant(
        db,
        viewer_user_id=viewer_user_id,
        subject=subject,
        audience=grant_audience,
    )
    return CreateResourceShareOut(
        share=_owned_share(db, result.grant),
        created=result.created,
    )
