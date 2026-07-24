"""Typed owner of active authenticated-user and bearer-link resource grants."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import delete, exists, func, literal, or_, select, text
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from nexus.db.models import Highlight, Media, MediaTeardownIntent, ResourceGrant
from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.services.resource_graph.refs import (
    ResourceRef,
    assert_resource_ref,
)
from nexus.services.sealed_handles import (
    ResourceGrantHandle,
    ShareToken,
    new_share_token,
    parse_share_token,
    seal_resource_grant,
    share_token_hash,
    unseal_resource_grant,
)


@dataclass(frozen=True, slots=True)
class UserGrantAudience:
    user_id: UUID


@dataclass(frozen=True, slots=True)
class LinkGrantAudience:
    pass


GrantAudience = UserGrantAudience | LinkGrantAudience


@dataclass(frozen=True, slots=True)
class ResourceGrantRecord:
    grant_id: UUID
    subject: ResourceRef
    creator_id: UUID
    audience: GrantAudience
    share_token: ShareToken | None
    created_at: datetime

    @property
    def handle(self) -> ResourceGrantHandle:
        return seal_resource_grant(self.grant_id)


@dataclass(frozen=True, slots=True)
class ResolvedLinkGrant:
    grant_id: UUID
    subject: ResourceRef
    creator_id: UUID
    canonical_token: ShareToken


@dataclass(frozen=True, slots=True)
class CreateGrantResult:
    grant: ResourceGrantRecord
    created: bool


@dataclass(frozen=True, slots=True)
class DeleteGrantResult:
    grant: ResourceGrantRecord
    parent_media_id: UUID


def _subject_from_parts(scheme: str, subject_id: UUID) -> ResourceRef:
    return assert_resource_ref(f"{scheme}:{subject_id}")


def _record_from_row(row: ResourceGrant) -> ResourceGrantRecord:
    subject = _subject_from_parts(row.subject_scheme, row.subject_id)
    has_user = row.grantee_user_id is not None
    has_raw_token = row.share_token is not None
    has_token_hash = row.share_token_hash is not None
    if has_user and not has_raw_token and not has_token_hash:
        return ResourceGrantRecord(
            grant_id=row.id,
            subject=subject,
            creator_id=row.created_by_user_id,
            audience=UserGrantAudience(user_id=cast(UUID, row.grantee_user_id)),
            share_token=None,
            created_at=row.created_at,
        )
    if not has_user and has_raw_token and has_token_hash:
        token = parse_share_token(cast(str, row.share_token))
        stored_hash = cast(bytes, row.share_token_hash)
        if len(stored_hash) != 32 or not hmac.compare_digest(
            stored_hash,
            share_token_hash(token),
        ):
            # justify-defect: the typed writer always persists the canonical
            # token and its exact 32-byte verifier together.
            raise AssertionError("resource grant link verifier does not match its token")
        return ResourceGrantRecord(
            grant_id=row.id,
            subject=subject,
            creator_id=row.created_by_user_id,
            audience=LinkGrantAudience(),
            share_token=token,
            created_at=row.created_at,
        )
    # justify-defect: trusted storage contains exactly one of the two audience
    # branches; malformed rows indicate writer/schema drift.
    raise AssertionError("resource grant has an impossible audience branch")


def media_grant_path_exists_expr(
    viewer_user_id: UUID,
    media_id_expr: UUID | ColumnElement[UUID],
):
    """SQLAlchemy predicate for a direct-media or child-highlight grant path."""

    grant = ResourceGrant.__table__.alias("media_grant_path_g")
    highlight = Highlight.__table__.alias("media_grant_path_h")
    audience = or_(
        grant.c.grantee_user_id == viewer_user_id,
        grant.c.created_by_user_id == viewer_user_id,
    )
    direct = exists(
        select(literal(1))
        .select_from(grant)
        .where(
            grant.c.subject_scheme == "media",
            grant.c.subject_id == media_id_expr,
            audience,
        )
    )
    child = exists(
        select(literal(1))
        .select_from(grant.join(highlight, highlight.c.id == grant.c.subject_id))
        .where(
            grant.c.subject_scheme == "highlight",
            highlight.c.anchor_media_id == media_id_expr,
            audience,
        )
    )
    return direct | child


def highlight_grant_path_exists_expr(
    viewer_user_id: UUID,
    highlight_id_expr: UUID | ColumnElement[UUID],
):
    """SQLAlchemy predicate for an exact-highlight grant path."""

    grant = ResourceGrant.__table__.alias("highlight_grant_path_g")
    return exists(
        select(literal(1))
        .select_from(grant)
        .where(
            grant.c.subject_scheme == "highlight",
            grant.c.subject_id == highlight_id_expr,
            or_(
                grant.c.grantee_user_id == viewer_user_id,
                grant.c.created_by_user_id == viewer_user_id,
            ),
        )
    )


def media_grant_path_exists_sql(
    media_expr: str,
    viewer_param: str = ":viewer_id",
) -> str:
    """Text-SQL twin of :func:`media_grant_path_exists_expr`."""

    return f"""EXISTS (
        SELECT 1
        FROM resource_grants media_grant_path_g
        LEFT JOIN highlights media_grant_path_h
          ON media_grant_path_g.subject_scheme = 'highlight'
         AND media_grant_path_h.id = media_grant_path_g.subject_id
        WHERE (
            (
              media_grant_path_g.subject_scheme = 'media'
              AND media_grant_path_g.subject_id = {media_expr}
            )
            OR media_grant_path_h.anchor_media_id = {media_expr}
          )
          AND (
            media_grant_path_g.grantee_user_id = {viewer_param}
            OR media_grant_path_g.created_by_user_id = {viewer_param}
          )
    )"""


def highlight_grant_path_exists_sql(
    highlight_expr: str,
    viewer_param: str = ":viewer_id",
) -> str:
    """Text-SQL twin of :func:`highlight_grant_path_exists_expr`."""

    return f"""EXISTS (
        SELECT 1
        FROM resource_grants highlight_grant_path_g
        WHERE highlight_grant_path_g.subject_scheme = 'highlight'
          AND highlight_grant_path_g.subject_id = {highlight_expr}
          AND (
            highlight_grant_path_g.grantee_user_id = {viewer_param}
            OR highlight_grant_path_g.created_by_user_id = {viewer_param}
          )
    )"""


def media_grant_path_exists(
    db: Session,
    *,
    viewer_user_id: UUID,
    media_id: UUID,
) -> bool:
    return bool(db.scalar(select(media_grant_path_exists_expr(viewer_user_id, media_id))))


def highlight_grant_path_exists(
    db: Session,
    *,
    viewer_user_id: UUID,
    highlight_id: UUID,
) -> bool:
    return bool(db.scalar(select(highlight_grant_path_exists_expr(viewer_user_id, highlight_id))))


def count_for_media(db: Session, media_id: UUID) -> int:
    """Count direct-media plus child-highlight active grant references."""

    count = db.scalar(
        select(func.count(ResourceGrant.id))
        .select_from(ResourceGrant)
        .outerjoin(
            Highlight,
            (ResourceGrant.subject_scheme == "highlight")
            & (Highlight.id == ResourceGrant.subject_id),
        )
        .where(
            or_(
                (ResourceGrant.subject_scheme == "media") & (ResourceGrant.subject_id == media_id),
                Highlight.anchor_media_id == media_id,
            )
        )
    )
    return int(count or 0)


def _notify_user_visibility_changed(db: Session, user_ids: set[UUID]) -> None:
    if not user_ids:
        return
    from nexus.services.artifacts.dossier_types import AudienceUser
    from nexus.services.artifacts.engine import on_audience_visibility_changed

    for user_id in sorted(user_ids):
        on_audience_visibility_changed(db, audience=AudienceUser(user_id=user_id))


def _delete_returning_affected_users(
    db: Session,
    statement,
) -> tuple[int, set[UUID]]:
    rows = db.execute(
        statement.returning(
            ResourceGrant.created_by_user_id,
            ResourceGrant.grantee_user_id,
        )
    ).all()
    affected = {UUID(str(user_id)) for row in rows for user_id in row if user_id is not None}
    _notify_user_visibility_changed(db, affected)
    return len(rows), affected


def delete_exact_subject(db: Session, subject: ResourceRef) -> int:
    """Delete every grant on one exact subject inside the caller transaction."""

    count, _ = _delete_returning_affected_users(
        db,
        delete(ResourceGrant).where(
            ResourceGrant.subject_scheme == subject.scheme,
            ResourceGrant.subject_id == subject.id,
        ),
    )
    return count


def delete_media_and_child_highlight_subjects(
    db: Session,
    media_id: UUID,
) -> int:
    """Delete direct-media and child-highlight grants inside the caller transaction."""

    child_ids = select(Highlight.id).where(Highlight.anchor_media_id == media_id)
    count, _ = _delete_returning_affected_users(
        db,
        delete(ResourceGrant).where(
            or_(
                (ResourceGrant.subject_scheme == "media") & (ResourceGrant.subject_id == media_id),
                (ResourceGrant.subject_scheme == "highlight")
                & (ResourceGrant.subject_id.in_(child_ids)),
            )
        ),
    )
    return count


def delete_viewer_media_paths(
    db: Session,
    *,
    viewer_user_id: UUID,
    media_id: UUID,
) -> int:
    """Delete the viewer's incoming and creator-owned paths for a media tree."""

    child_ids = select(Highlight.id).where(Highlight.anchor_media_id == media_id)
    subject_predicate = or_(
        (ResourceGrant.subject_scheme == "media") & (ResourceGrant.subject_id == media_id),
        (ResourceGrant.subject_scheme == "highlight") & (ResourceGrant.subject_id.in_(child_ids)),
    )
    audience_predicate = or_(
        ResourceGrant.grantee_user_id == viewer_user_id,
        ResourceGrant.created_by_user_id == viewer_user_id,
    )
    count, affected_users = _delete_returning_affected_users(
        db,
        delete(ResourceGrant).where(subject_predicate, audience_predicate),
    )
    _notify_user_visibility_changed(db, {viewer_user_id} - affected_users)
    return count


def repoint_media_subjects(
    db: Session,
    *,
    loser_media_id: UUID,
    winner_media_id: UUID,
) -> int:
    """Repoint direct-media grants during canonical media dedupe.

    Exact child-highlight grants are intentionally untouched because existing
    dedupe flows do not repoint Highlight identity. Duplicate active audiences
    converge on the oldest ``(created_at, id)`` path.
    """

    rows = list(
        db.scalars(
            select(ResourceGrant)
            .where(
                ResourceGrant.subject_scheme == "media",
                ResourceGrant.subject_id.in_([loser_media_id, winner_media_id]),
            )
            .order_by(ResourceGrant.created_at.asc(), ResourceGrant.id.asc())
            .with_for_update()
        )
    )
    groups: dict[tuple[UUID, Literal["User", "Link"], UUID | None], list[ResourceGrant]] = {}
    for row in rows:
        record = _record_from_row(row)
        if isinstance(record.audience, UserGrantAudience):
            key = (record.creator_id, "User", record.audience.user_id)
        else:
            key = (record.creator_id, "Link", None)
        groups.setdefault(key, []).append(row)

    changed = 0
    affected_users: set[UUID] = set()
    for group in groups.values():
        survivor, *duplicates = group
        for duplicate in duplicates:
            affected_users.add(duplicate.created_by_user_id)
            if duplicate.grantee_user_id is not None:
                affected_users.add(duplicate.grantee_user_id)
            db.delete(duplicate)
            changed += 1
        if survivor.subject_id == loser_media_id:
            affected_users.add(survivor.created_by_user_id)
            survivor.subject_id = winner_media_id
            if survivor.grantee_user_id is not None:
                affected_users.add(survivor.grantee_user_id)
            changed += 1
    db.flush()
    _notify_user_visibility_changed(db, affected_users)
    return changed


def _parent_media_id_for_subject(db: Session, subject: ResourceRef) -> UUID:
    if subject.scheme == "media":
        return subject.id
    if subject.scheme == "highlight":
        media_id = db.scalar(select(Highlight.anchor_media_id).where(Highlight.id == subject.id))
        if media_id is not None:
            return UUID(str(media_id))
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")


def _lock_subject_rows(db: Session, subject: ResourceRef) -> UUID:
    parent_media_id = _parent_media_id_for_subject(db, subject)
    media_exists = db.scalar(select(Media.id).where(Media.id == parent_media_id).with_for_update())
    if media_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    if subject.scheme == "highlight":
        highlight = db.scalar(
            select(Highlight)
            .where(
                Highlight.id == subject.id,
                Highlight.anchor_media_id == parent_media_id,
            )
            .with_for_update()
        )
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    return parent_media_id


def _lock_authorized_subject(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
) -> UUID:
    if subject.scheme not in {"media", "highlight"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Resource does not support grants",
        )
    parent_media_id = _lock_subject_rows(db, subject)

    from nexus.auth.permissions import can_read_media

    if db.scalar(select(exists().where(MediaTeardownIntent.media_id == parent_media_id))):
        raise ApiError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")
    if not can_read_media(
        db,
        viewer_user_id,
        parent_media_id,
        include_tearing_down=True,
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    if subject.scheme == "highlight":
        owner_id = db.scalar(select(Highlight.user_id).where(Highlight.id == subject.id))
        if owner_id != viewer_user_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    return parent_media_id


def _existing_for_audience(
    db: Session,
    *,
    creator_id: UUID,
    subject: ResourceRef,
    audience: GrantAudience,
) -> ResourceGrant | None:
    predicates = [
        ResourceGrant.created_by_user_id == creator_id,
        ResourceGrant.subject_scheme == subject.scheme,
        ResourceGrant.subject_id == subject.id,
    ]
    if isinstance(audience, UserGrantAudience):
        predicates.extend(
            [
                ResourceGrant.grantee_user_id == audience.user_id,
                ResourceGrant.share_token.is_(None),
                ResourceGrant.share_token_hash.is_(None),
            ]
        )
    else:
        predicates.extend(
            [
                ResourceGrant.grantee_user_id.is_(None),
                ResourceGrant.share_token.is_not(None),
                ResourceGrant.share_token_hash.is_not(None),
            ]
        )
    return db.scalar(select(ResourceGrant).where(*predicates).limit(1))


def create_grant(
    db: Session,
    *,
    viewer_user_id: UUID,
    subject: ResourceRef,
    audience: GrantAudience,
) -> CreateGrantResult:
    """Create or return the caller's one active exact-subject audience grant."""

    def attempt() -> CreateGrantResult:
        with transaction(db):
            _lock_authorized_subject(
                db,
                viewer_user_id=viewer_user_id,
                subject=subject,
            )
            from nexus.services.public_resource_sharing import (
                Available as ProjectionAvailable,
            )
            from nexus.services.public_resource_sharing import (
                ProjectionNotReady,
                ProjectionUnsupported,
                highlight_target_available,
                link_projection_availability,
            )

            if subject.scheme == "highlight" and not highlight_target_available(
                db,
                highlight_id=subject.id,
            ):
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Share unavailable: HighlightUnresolved",
                )
            if isinstance(audience, UserGrantAudience):
                if audience.user_id == viewer_user_id:
                    raise InvalidRequestError(
                        ApiErrorCode.E_INVALID_REQUEST,
                        "Cannot share a resource with yourself",
                    )
                user_exists = db.scalar(
                    text("SELECT 1 FROM users WHERE id = :user_id"),
                    {"user_id": audience.user_id},
                )
                if user_exists is None:
                    raise NotFoundError(ApiErrorCode.E_USER_NOT_FOUND, "User not found")

            existing = _existing_for_audience(
                db,
                creator_id=viewer_user_id,
                subject=subject,
                audience=audience,
            )
            if existing is not None:
                return CreateGrantResult(grant=_record_from_row(existing), created=False)

            from nexus.services.billing_entitlements import get_effective_entitlements

            if not get_effective_entitlements(db, viewer_user_id).can_share:
                raise ApiError(
                    ApiErrorCode.E_BILLING_REQUIRED,
                    "Sharing requires an eligible plan",
                )

            if isinstance(audience, LinkGrantAudience):
                projection = link_projection_availability(db, subject=subject)
                if isinstance(projection, ProjectionNotReady):
                    raise ApiError(
                        ApiErrorCode.E_INVALID_REQUEST,
                        "Share unavailable: ProjectionNotReady",
                    )
                if isinstance(projection, ProjectionUnsupported):
                    raise ApiError(
                        ApiErrorCode.E_INVALID_REQUEST,
                        "Share unavailable: ProjectionUnsupported",
                    )
                if not isinstance(projection, ProjectionAvailable):
                    raise AssertionError("unknown public projection availability")

            token = new_share_token() if isinstance(audience, LinkGrantAudience) else None
            grant = ResourceGrant(
                id=new_uuid7(),
                subject_scheme=subject.scheme,
                subject_id=subject.id,
                created_by_user_id=viewer_user_id,
                grantee_user_id=(
                    audience.user_id if isinstance(audience, UserGrantAudience) else None
                ),
                share_token=str(token) if token is not None else None,
                share_token_hash=share_token_hash(token) if token is not None else None,
            )
            db.add(grant)
            db.flush()
            if isinstance(audience, UserGrantAudience):
                _notify_user_visibility_changed(db, {audience.user_id})
            return CreateGrantResult(grant=_record_from_row(grant), created=True)

    return retry_serializable(db, "create_resource_grant", attempt)


def delete_grant(
    db: Session,
    *,
    viewer_user_id: UUID,
    handle: ResourceGrantHandle | str,
) -> DeleteGrantResult:
    """Revoke a creator path or decline the exact recipient's user path.

    The retry owner is READ COMMITTED: discovery may precede a media-lock wait,
    while the locked grant re-read and final reference count must observe commits
    that won that wait.
    """

    try:
        grant_id = unseal_resource_grant(str(handle))
    except InvalidRequestError as exc:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource grant not found") from exc

    def attempt() -> DeleteGrantResult:
        with transaction(db):
            discovered = db.get(ResourceGrant, grant_id)
            if discovered is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource grant not found")
            discovered_subject = _subject_from_parts(
                discovered.subject_scheme,
                discovered.subject_id,
            )
            parent_media_id = _lock_subject_rows(db, discovered_subject)
            grant = db.scalar(
                select(ResourceGrant).where(ResourceGrant.id == grant_id).with_for_update()
            )
            if grant is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource grant not found")
            record = _record_from_row(grant)
            if record.subject != discovered_subject:
                # A canonical media repoint won the race. Retrying discovers and
                # locks the new parent before the grant row.
                from nexus.db.errors import TransactionRestart

                raise TransactionRestart("resource grant subject changed before delete")
            recipient_id = (
                record.audience.user_id if isinstance(record.audience, UserGrantAudience) else None
            )
            if viewer_user_id != record.creator_id and viewer_user_id != recipient_id:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource grant not found")
            db.delete(grant)
            db.flush()
            _notify_user_visibility_changed(
                db,
                {record.creator_id, *({recipient_id} if recipient_id is not None else set())},
            )
            from nexus.services.media_deletion import (
                claim_document_teardown_if_unreferenced_locked,
            )

            claim_document_teardown_if_unreferenced_locked(db, parent_media_id)
            return DeleteGrantResult(grant=record, parent_media_id=parent_media_id)

    return retry_read_committed(db, "delete_resource_grant", attempt)


def resolve_link_token(db: Session, raw_token: str) -> ResolvedLinkGrant:
    token = parse_share_token(raw_token)
    row = db.scalar(
        select(ResourceGrant).where(ResourceGrant.share_token_hash == share_token_hash(token))
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable")
    record = _record_from_row(row)
    if not isinstance(record.audience, LinkGrantAudience) or record.share_token is None:
        # justify-defect: verifier lookup can only resolve the link audience
        # branch written by this service.
        raise AssertionError("share token resolved a non-link resource grant")
    if not hmac.compare_digest(record.share_token, token):
        # justify-defect: SHA-256 collisions are not modeled product behavior.
        raise AssertionError("share token verifier collision")
    return ResolvedLinkGrant(
        grant_id=record.grant_id,
        subject=record.subject,
        creator_id=record.creator_id,
        canonical_token=record.share_token,
    )


def list_creator_grants(
    db: Session,
    *,
    creator_id: UUID,
    subject: ResourceRef,
) -> list[ResourceGrantRecord]:
    rows = db.scalars(
        select(ResourceGrant)
        .where(
            ResourceGrant.created_by_user_id == creator_id,
            ResourceGrant.subject_scheme == subject.scheme,
            ResourceGrant.subject_id == subject.id,
        )
        .order_by(ResourceGrant.created_at.asc(), ResourceGrant.id.asc())
    )
    return [_record_from_row(row) for row in rows]


def list_received_grants(
    db: Session,
    *,
    recipient_id: UUID,
    snapshot_subject: ResourceRef,
) -> list[ResourceGrantRecord]:
    predicate = (ResourceGrant.subject_scheme == snapshot_subject.scheme) & (
        ResourceGrant.subject_id == snapshot_subject.id
    )
    if snapshot_subject.scheme == "media":
        child_ids = select(Highlight.id).where(Highlight.anchor_media_id == snapshot_subject.id)
        predicate = or_(
            predicate,
            (ResourceGrant.subject_scheme == "highlight")
            & (ResourceGrant.subject_id.in_(child_ids)),
        )
    rows = db.scalars(
        select(ResourceGrant)
        .where(
            ResourceGrant.grantee_user_id == recipient_id,
            predicate,
        )
        .order_by(ResourceGrant.created_at.asc(), ResourceGrant.id.asc())
    )
    return [_record_from_row(row) for row in rows]
