"""The resource_grants table: a creator and one audience (a grantee user, or any holder of the
row's raw share token) may read one media or one owned highlight. Rows are authorization paths
and teardown references; each mutation invalidates audience visibility for the users it affects.
Grants are addressed by their plain id; a create takes the client's id.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import ColumnElement, ColumnExpressionArgument, delete, exists, func, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import Highlight, Media, ResourceGrant, User
from nexus.db.retries import TransactionRestart, retry_serializable
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import new_share_token
from nexus.services.suggestion_changes import record_input_change


def media_grant_path_exists_expr(
    viewer_user_id: UUID, media_id_expr: UUID | ColumnExpressionArgument[UUID | None]
) -> ColumnElement[bool]:
    """A grant on the media, or on one of its highlights, that the viewer created or received."""
    g = ResourceGrant.__table__.alias("media_grant_path_g")
    h = Highlight.__table__.alias("media_grant_path_h")
    viewer = or_(g.c.grantee_user_id == viewer_user_id, g.c.created_by_user_id == viewer_user_id)
    direct = exists().where(g.c.subject_scheme == "media", g.c.subject_id == media_id_expr, viewer)
    child = exists().where(
        g.c.subject_scheme == "highlight",
        h.c.id == g.c.subject_id,
        h.c.anchor_media_id == media_id_expr,
        viewer,
    )
    return direct | child


def media_grant_path_exists_sql(media_expr: str, viewer_param: str = ":viewer_id") -> str:
    """Text-SQL twin of `media_grant_path_exists_expr`."""
    return f"""EXISTS (
        SELECT 1 FROM resource_grants media_grant_path_g
        LEFT JOIN highlights media_grant_path_h
          ON media_grant_path_g.subject_scheme = 'highlight'
         AND media_grant_path_h.id = media_grant_path_g.subject_id
        WHERE ((media_grant_path_g.subject_scheme = 'media'
                AND media_grant_path_g.subject_id = {media_expr})
               OR media_grant_path_h.anchor_media_id = {media_expr})
          AND (media_grant_path_g.grantee_user_id = {viewer_param}
               OR media_grant_path_g.created_by_user_id = {viewer_param})
    )"""


def highlight_grant_path_exists_sql(highlight_expr: str, viewer_param: str = ":viewer_id") -> str:
    """A grant on exactly this highlight that the viewer created or received."""
    return f"""EXISTS (
        SELECT 1 FROM resource_grants highlight_grant_path_g
        WHERE highlight_grant_path_g.subject_scheme = 'highlight'
          AND highlight_grant_path_g.subject_id = {highlight_expr}
          AND (highlight_grant_path_g.grantee_user_id = {viewer_param}
               OR highlight_grant_path_g.created_by_user_id = {viewer_param})
    )"""


def media_grant_path_exists(db: Session, *, viewer_user_id: UUID, media_id: UUID) -> bool:
    return bool(db.scalar(select(media_grant_path_exists_expr(viewer_user_id, media_id))))


def _exact(subject: ResourceRef) -> ColumnElement[bool]:
    return (ResourceGrant.subject_scheme == subject.scheme) & (
        ResourceGrant.subject_id == subject.id
    )


def _media_tree(media_id: UUID) -> ColumnElement[bool]:
    """Grants on the media and on its highlights."""
    child_ids = select(Highlight.id).where(Highlight.anchor_media_id == media_id)
    return _exact(ResourceRef("media", media_id)) | (
        (ResourceGrant.subject_scheme == "highlight") & ResourceGrant.subject_id.in_(child_ids)
    )


def count_for_media(db: Session, media_id: UUID) -> int:
    """Grants on the media and its highlights: each keeps a document media from teardown."""
    count = select(func.count()).select_from(ResourceGrant).where(_media_tree(media_id))
    return db.execute(count).scalar_one()


def _notify(db: Session, user_ids: set[UUID]) -> None:
    from nexus.services.dossier.engine import on_visibility_lost

    for user_id in sorted(user_ids):
        on_visibility_lost(db, user_id=user_id)


def _delete(db: Session, *where: ColumnElement[bool], also: frozenset[UUID] = frozenset()) -> int:
    """Delete the matching grants and notify their creators and grantees, plus `also`."""
    rows = db.execute(
        delete(ResourceGrant)
        .where(*where)
        .returning(ResourceGrant.created_by_user_id, ResourceGrant.grantee_user_id)
    ).all()
    _notify(db, {user for row in rows for user in row if user is not None} | also)
    return len(rows)


def delete_exact_subject(db: Session, subject: ResourceRef) -> int:
    return _delete(db, _exact(subject))


def delete_media_and_child_highlight_subjects(db: Session, media_id: UUID) -> int:
    return _delete(db, _media_tree(media_id))


def delete_viewer_media_paths(db: Session, *, viewer_user_id: UUID, media_id: UUID) -> int:
    """Revoke what the viewer created, and decline what they received, on the media tree."""
    viewer = or_(
        ResourceGrant.grantee_user_id == viewer_user_id,
        ResourceGrant.created_by_user_id == viewer_user_id,
    )
    return _delete(db, _media_tree(media_id), viewer, also=frozenset({viewer_user_id}))


def repoint_media_subjects(db: Session, *, loser_media_id: UUID, winner_media_id: UUID) -> int:
    """Move direct-media grants onto the dedupe winner; per audience the oldest row survives.

    Grants on the loser's highlights stay put: dedupe does not repoint highlights.
    """
    rows = db.scalars(
        select(ResourceGrant)
        .where(
            ResourceGrant.subject_scheme == "media",
            ResourceGrant.subject_id.in_([loser_media_id, winner_media_id]),
        )
        .order_by(ResourceGrant.created_at, ResourceGrant.id)
        .with_for_update()
    ).all()
    survivors: dict[tuple[UUID, UUID | None], ResourceGrant] = {}
    for row in rows:
        survivors.setdefault((row.created_by_user_id, row.grantee_user_id), row)
    duplicates = [row for row in rows if row not in survivors.values()]
    moved = [row for row in survivors.values() if row.subject_id == loser_media_id]
    changed = [*duplicates, *moved]
    affected = {u for row in changed for u in (row.created_by_user_id, row.grantee_user_id) if u}
    for row in duplicates:
        db.delete(row)
    db.flush()  # the unique indexes must see the deletes before a survivor moves
    for row in moved:
        row.subject_id = winner_media_id
    db.flush()
    _notify(db, affected)
    return len(changed)


def lock_subject(db: Session, subject: ResourceRef) -> UUID | None:
    """Lock the parent media, then the highlight, FOR UPDATE; the parent media id, or None if gone."""
    media_id = subject.id
    if subject.scheme == "highlight":
        media_id = db.scalar(select(Highlight.anchor_media_id).where(Highlight.id == subject.id))
    if db.scalar(select(Media.id).where(Media.id == media_id).with_for_update()) is None:
        return None
    if subject.scheme == "highlight":
        same = select(Highlight.id).where(
            Highlight.id == subject.id, Highlight.anchor_media_id == media_id
        )
        if db.scalar(same.with_for_update()) is None:
            return None
    return media_id


def find_grant(
    db: Session, *, creator_id: UUID, subject: ResourceRef, grantee_id: UUID | None
) -> ResourceGrant | None:
    """The creator's grant on the exact subject for a grantee, or their link when grantee_id is None."""
    return db.scalar(
        select(ResourceGrant).where(
            ResourceGrant.created_by_user_id == creator_id,
            _exact(subject),
            ResourceGrant.grantee_user_id == grantee_id,
        )
    )


def insert_grant(
    db: Session,
    *,
    id: UUID,
    creator_id: UUID,
    subject: ResourceRef,
    grantee_id: UUID | None,
    grantee_email: str | None,
) -> ResourceGrant:
    from nexus.services.library_entries import lock_media_for_reference

    media_id = (
        subject.id
        if subject.scheme == "media"
        else db.execute(
            select(Highlight.anchor_media_id).where(Highlight.id == subject.id)
        ).scalar_one()
    )
    if media_id is None:
        # justify-defect: share admission already locked and validated the highlight's anchor.
        raise AssertionError("Grant subject has no media anchor")
    lock_media_for_reference(db, media_id)
    grant = ResourceGrant(
        id=id,
        subject_scheme=subject.scheme,
        subject_id=subject.id,
        created_by_user_id=creator_id,
        grantee_user_id=grantee_id,
        grantee_email=grantee_email,
        share_token=None if grantee_id is not None else new_share_token(),
    )
    db.add(grant)
    db.flush()
    if grantee_id is not None:
        _notify(db, {grantee_id})
    return grant


def delete_grant(db: Session, *, viewer_user_id: UUID, grant_id: UUID) -> None:
    """Revoke a grant the viewer created, or decline one they received. Absent or not the
    viewer's: success.

    The grant and subject locks conflict with dedupe repointing. A changed grant
    tuple restarts the serializable snapshot before its dependency is removed.
    """
    by_id = select(ResourceGrant.__table__).where(ResourceGrant.id == grant_id)

    def attempt() -> None:
        found = db.execute(by_id).one_or_none()
        if found is None or viewer_user_id not in (
            found.created_by_user_id,
            found.grantee_user_id,
        ):
            return
        media_id = lock_subject(db, ResourceRef(found.subject_scheme, found.subject_id))
        grant = db.execute(by_id.with_for_update()).one_or_none()
        if media_id is None or grant is None:
            return
        if grant.subject_id != found.subject_id:
            raise TransactionRestart("resource grant subject moved before delete")
        _delete(db, ResourceGrant.id == grant_id)
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        claim_document_teardown_if_unreferenced_locked(db, media_id)
        record_input_change(db, owners=[f"{grant.subject_scheme}:{grant.subject_id}"])

    retry_serializable(db, "delete_resource_grant", attempt)


def link_grant(db: Session, token: str) -> ResourceGrant | None:
    """The link grant whose stored raw token equals the presented one (stored tokens are canonical)."""
    return db.scalar(select(ResourceGrant).where(ResourceGrant.share_token == token))


def creator_grants(
    db: Session, *, creator_id: UUID, subject: ResourceRef
) -> list[tuple[ResourceGrant, User | None]]:
    """The creator's grants on the exact subject with each grantee (None for the link)."""
    return list(
        db.execute(
            select(ResourceGrant, User)
            .outerjoin(User, User.id == ResourceGrant.grantee_user_id)
            .where(ResourceGrant.created_by_user_id == creator_id, _exact(subject))
            .order_by(ResourceGrant.created_at, ResourceGrant.id)
        ).tuples()
    )


def received_grants(
    db: Session, *, recipient_id: UUID, subject: ResourceRef
) -> list[tuple[ResourceGrant, User]]:
    """The recipient's grants on the subject, or on the media tree, each with its creator."""
    on_subject = _media_tree(subject.id) if subject.scheme == "media" else _exact(subject)
    return list(
        db.execute(
            select(ResourceGrant, User)
            .join(User, User.id == ResourceGrant.created_by_user_id)
            .where(ResourceGrant.grantee_user_id == recipient_id, on_subject)
            .order_by(ResourceGrant.created_at, ResourceGrant.id)
        ).tuples()
    )
