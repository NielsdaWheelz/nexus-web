"""The resource_grants table: a creator and one audience (a grantee user, or any holder of the
row's raw share token) may read one media or one owned live highlight. Rows are authorization
paths and teardown references; each mutation invalidates audience visibility for the users it
affects, bumping their media ``annotations`` lane and waking their writing stream.
Grants are addressed by their plain id; a create takes the client's id. Public
capture output is pinned separately in resource_grant_captures at grant creation
and authorized media publication; later account admissions never widen a token.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    ColumnExpressionArgument,
    delete,
    exists,
    func,
    or_,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import Highlight, ResourceGrant, ResourceGrantCapture, User
from nexus.db.retries import TransactionRestart, retry_serializable
from nexus.ids import new_uuid7
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import new_share_token
from nexus.services.suggestion_changes import record_input_change


def media_grant_path_exists_expr(
    viewer_user_id: UUID, media_id_expr: UUID | ColumnExpressionArgument[UUID | None]
) -> ColumnElement[bool]:
    """A grant on the media, or on one of its live highlights, that the viewer created or
    received. A deleted highlight's grant confers nothing until the highlight revives."""
    g = ResourceGrant.__table__.alias("media_grant_path_g")
    h = Highlight.__table__.alias("media_grant_path_h")
    viewer = or_(g.c.grantee_user_id == viewer_user_id, g.c.created_by_user_id == viewer_user_id)
    direct = exists().where(g.c.subject_scheme == "media", g.c.subject_id == media_id_expr, viewer)
    child = exists().where(
        g.c.subject_scheme == "highlight",
        h.c.id == g.c.subject_id,
        h.c.authored_visible,
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
         AND media_grant_path_h.authored_visible
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


def _media_tree(media_id: UUID, *, live_highlights_only: bool = False) -> ColumnElement[bool]:
    """Grants on the media and its highlights; cleanup also includes hidden highlights."""
    child_ids = select(Highlight.id).where(Highlight.anchor_media_id == media_id)
    if live_highlights_only:
        child_ids = child_ids.where(Highlight.authored_visible)
    return _exact(ResourceRef("media", media_id)) | (
        (ResourceGrant.subject_scheme == "highlight") & ResourceGrant.subject_id.in_(child_ids)
    )


def count_for_media(db: Session, media_id: UUID) -> int:
    """Grants on the media and its highlights: each keeps a document media from teardown."""
    count = select(func.count()).select_from(ResourceGrant).where(_media_tree(media_id))
    return db.execute(count).scalar_one()


def media_audience_account_ids(db: Session, *, media_ids: Sequence[UUID]) -> list[UUID]:
    """Current readable parent audience, including exact grants and suppression."""
    from nexus.auth.permissions import visible_media_ids_cte_sql

    readable = visible_media_ids_cte_sql().replace(":viewer_id", "audience.id")
    return (
        list(
            db.scalars(
                text(f"""
        SELECT audience.id FROM users audience WHERE EXISTS (
            SELECT 1 FROM ({readable}) readable WHERE readable.media_id=ANY(:ids))
    """),
                {"ids": list(media_ids)},
            )
        )
        if media_ids
        else []
    )


def capture_manifest_for_media(
    db: Session, *, grantor_id: UUID, media_ids: Sequence[UUID]
) -> list[UUID]:
    """Freeze only selected captures/direct context the grantor can read NOW."""
    from nexus.services.media_text_scope import x_capture_scope_rows_sql
    from nexus.services.x_source import readable_x_capture_ids_sql

    return (
        list(
            db.scalars(
                text(f"""
        SELECT DISTINCT x.capture_id
        FROM ({x_capture_scope_rows_sql("SELECT unnest(CAST(:media_ids AS uuid[])) AS media_id")}) x
        WHERE x.capture_id IN ({readable_x_capture_ids_sql()})
    """),
                {"viewer_id": grantor_id, "media_ids": list(media_ids)},
            )
        )
        if media_ids
        else []
    )


def _insert_public_capture_manifest(
    db: Session, *, grant_ids: Sequence[UUID], capture_ids: Sequence[UUID]
) -> None:
    values = [
        {"id": new_uuid7(), "grant_id": grant_id, "capture_id": capture_id}
        for grant_id in sorted(set(grant_ids))
        for capture_id in sorted(set(capture_ids))
    ]
    if values:
        db.execute(
            insert(ResourceGrantCapture)
            .values(values)
            .on_conflict_do_nothing(index_elements=["grant_id", "capture_id"])
        )


def extend_public_media_capture_manifests(
    db: Session, *, media_id: UUID, capture_ids: Sequence[UUID]
) -> None:
    """Publish authorized selected evidence to public media and live child-highlight grants.

    The source publisher holds the media lock and supplies its exact authorized
    manifest, frozen before authority changes for reuse. Only explicit source
    publication calls this; account admissions and unrelated imports never do.
    Retained old rows are harmless: public reads also require current selection.
    Flush-only; this confers no account admission or account read authority.
    """
    from nexus.services.media_text_scope import x_capture_scope_rows_sql

    if not capture_ids:
        return
    selected = list(
        db.scalars(
            text(f"""
        SELECT DISTINCT x.capture_id
        FROM ({x_capture_scope_rows_sql("SELECT CAST(:media_id AS uuid) AS media_id")}) x
        WHERE x.capture_id=ANY(:capture_ids)
    """),
            {"media_id": media_id, "capture_ids": list(capture_ids)},
        )
    )
    grants = list(
        db.scalars(
            select(ResourceGrant.id).where(
                _media_tree(media_id, live_highlights_only=True),
                ResourceGrant.grantee_user_id.is_(None),
                ResourceGrant.share_token.is_not(None),
            )
        )
    )
    _insert_public_capture_manifest(db, grant_ids=grants, capture_ids=selected)


def admit_library_captures(
    db: Session, *, grantor_id: UUID, media_ids: Sequence[UUID], library_ids: Sequence[UUID]
) -> None:
    """Transfer a pre-mutation readable manifest to current destination members.

    Call before inserting placements or memberships; a new root must never expand
    the grantor's authority to nested context while constructing this manifest.
    """
    from nexus.services.x_source import admit_x_captures_for_accounts

    captures = capture_manifest_for_media(db, grantor_id=grantor_id, media_ids=media_ids)
    accounts = list(
        db.scalars(
            text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
            {"ids": list(library_ids)},
        )
    )
    admit_x_captures_for_accounts(db, account_ids=accounts, capture_ids=captures)


def highlight_parent_media_ids(db: Session, *, highlight_ids: Sequence[UUID]) -> set[UUID]:
    """Current containing presentations, derived through the shared capture scope."""
    from nexus.services.media_text_scope import x_capture_scope_rows_sql

    if not highlight_ids:
        return set()
    return set(
        db.scalars(
            text(f"""
        SELECT anchor_media_id FROM highlights
        WHERE id=ANY(:ids) AND anchor_media_id IS NOT NULL
        UNION
        SELECT x.reading_media_id
        FROM ({x_capture_scope_rows_sql("SELECT id AS media_id FROM media")}) x
        JOIN highlight_fragment_anchors a ON a.fragment_id=x.fragment_id
        WHERE a.highlight_id=ANY(:ids)
    """),
            {"ids": list(highlight_ids)},
        )
    )


def annotation_visibility(
    db: Session, *, user_ids: set[UUID], media_ids: set[UUID]
) -> set[tuple[UUID, UUID]]:
    """Capture readable annotation projections before/after a bounded permission change."""
    from nexus.auth.permissions import highlight_readability_sql
    from nexus.services.media_text_scope import highlight_in_reading_scope_sql

    if not media_ids:
        return set()
    return {
        (user_id, media_id)
        for user_id in sorted(user_ids)
        for media_id in db.scalars(
            text(f"""
            SELECT DISTINCT reading.media_id
            FROM unnest(CAST(:media_ids AS uuid[])) reading(media_id)
            JOIN highlights h ON h.anchor_media_id=reading.media_id
              OR {highlight_in_reading_scope_sql("h.id", "reading.media_id")}
            WHERE {highlight_readability_sql()}
        """),
            {"viewer_id": user_id, "media_ids": list(media_ids)},
        )
    }


def invalidate_annotation_visibility(db: Session, projections: set[tuple[UUID, UUID]]) -> None:
    """Bump each ``(viewer, media)`` annotations lane in one sorted order, then wake each viewer's
    writing stream; flush-only, the notification publishes with the caller's commit."""
    from nexus.services.resource_items.versions import bump_version

    for user_id, media_id in sorted(projections):
        bump_version(db, viewer_id=user_id, ref=ResourceRef("media", media_id), lane="annotations")
    for user_id in sorted({user_id for user_id, _ in projections}):
        db.execute(text("SELECT pg_notify('nexus_writing', :viewer)"), {"viewer": str(user_id)})


def library_annotation_visibility(
    db: Session, library_id: UUID, *, media_ids: set[UUID] | None = None
) -> set[tuple[UUID, UUID]]:
    """Annotation projections over the library's placed media, including capture anchors."""
    users = set(
        db.scalars(text("SELECT user_id FROM memberships WHERE library_id=:id"), {"id": library_id})
    )
    media = (
        media_ids
        if media_ids is not None
        else set(
            db.scalars(
                text("""
        SELECT DISTINCT e.media_id FROM library_entries e
        WHERE e.library_id=:id
    """),
                {"id": library_id},
            )
        )
    )
    return annotation_visibility(db, user_ids=users, media_ids=media)


def _delete(db: Session, *where: ColumnElement[bool], also: frozenset[UUID] = frozenset()) -> int:
    """Delete matching grants and invalidate their affected annotation projections."""
    previous = list(db.scalars(select(ResourceGrant).where(*where)))
    users = {
        user
        for row in previous
        for user in (row.created_by_user_id, row.grantee_user_id)
        if user is not None
    } | set(also)
    highlight_ids = [row.subject_id for row in previous if row.subject_scheme == "highlight"]
    media = {row.subject_id for row in previous if row.subject_scheme == "media"}
    media.update(highlight_parent_media_ids(db, highlight_ids=highlight_ids))
    projections = annotation_visibility(db, user_ids=users, media_ids=media)
    db.execute(
        delete(ResourceGrantCapture).where(
            ResourceGrantCapture.grant_id.in_([row.id for row in previous])
        )
    )
    rows = db.execute(
        delete(ResourceGrant)
        .where(*where)
        .returning(ResourceGrant.created_by_user_id, ResourceGrant.grantee_user_id)
    ).all()
    invalidate_annotation_visibility(db, projections)
    for user_id in sorted(users):
        db.execute(text("SELECT pg_notify('nexus_writing', :viewer)"), {"viewer": str(user_id)})
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


def decline_received_media_paths(db: Session, *, viewer_user_id: UUID, media_id: UUID) -> int:
    """Decline the viewer's received access; their issued grants remain independent roots."""
    return _delete(
        db,
        _media_tree(media_id),
        ResourceGrant.grantee_user_id == viewer_user_id,
        also=frozenset({viewer_user_id}),
    )


def snapshot_public_capture_manifests_for_repoint(
    db: Session, *, loser_media_id: UUID, winner_media_id: UUID
) -> dict[UUID, list[UUID]]:
    """Freeze each public grantor's winner scope before any holding or grant transfer.

    The caller holds both media locks. A new winner placement must never become
    authority for extending an old public token.
    """
    return {
        grant.id: capture_manifest_for_media(
            db, grantor_id=grant.created_by_user_id, media_ids=[winner_media_id]
        )
        for grant in db.scalars(
            select(ResourceGrant).where(
                ResourceGrant.subject_scheme == "media",
                ResourceGrant.subject_id == loser_media_id,
                ResourceGrant.grantee_user_id.is_(None),
                ResourceGrant.share_token.is_not(None),
            )
        )
    }


def repoint_media_subjects(
    db: Session,
    *,
    loser_media_id: UUID,
    winner_media_id: UUID,
    public_capture_manifests: Mapping[UUID, Sequence[UUID]],
) -> int:
    """Move direct-media grants onto the dedupe winner; per audience the oldest row survives.

    Grants on the loser's highlights stay put: dedupe does not repoint highlights.
    Public manifests were frozen before any holding or grant transfer; never
    recompute them from the new winner authority here.
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
    projections = annotation_visibility(
        db, user_ids=affected, media_ids={loser_media_id, winner_media_id}
    )
    db.execute(
        delete(ResourceGrantCapture).where(
            ResourceGrantCapture.grant_id.in_([row.id for row in duplicates])
        )
    )
    for row in duplicates:
        db.delete(row)
    db.flush()  # the unique indexes must see the deletes before a survivor moves
    for row in moved:
        row.subject_id = winner_media_id
    db.flush()
    for row in moved:
        if row.grantee_user_id is None and row.share_token is not None:
            _insert_public_capture_manifest(
                db, grant_ids=[row.id], capture_ids=public_capture_manifests[row.id]
            )
    projections.update(annotation_visibility(db, user_ids=affected, media_ids={winner_media_id}))
    invalidate_annotation_visibility(db, projections)
    return len(changed)


def lock_subject(db: Session, subject: ResourceRef) -> bool:
    """Lock a media family, or validate a live retained capture highlight."""
    from nexus.services.library_entries import lock_media_rows_in_order

    media_id = subject.id
    if subject.scheme == "highlight":
        row = db.execute(
            select(Highlight.anchor_media_id, Highlight.anchor_kind).where(
                Highlight.id == subject.id, Highlight.authored_visible
            )
        ).one_or_none()
        if row is None:
            return False
        media_id = row.anchor_media_id
        if media_id is None:
            return row.anchor_kind == "fragment_offsets" and bool(
                db.scalar(
                    text("""
                SELECT 1 FROM highlight_fragment_anchors a JOIN fragments f ON f.id=a.fragment_id
                WHERE a.highlight_id=:id AND f.x_post_capture_id IS NOT NULL
            """),
                    {"id": subject.id},
                )
            )
    if media_id is None or not lock_media_rows_in_order(db, [media_id]):
        return False
    return (
        subject.scheme != "highlight"
        or db.scalar(
            select(Highlight.id).where(
                Highlight.id == subject.id,
                Highlight.anchor_media_id == media_id,
                Highlight.authored_visible,
            )
        )
        is not None
    )


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
    if media_id is not None:
        lock_media_for_reference(db, media_id)
    from nexus.services.x_source import admit_x_captures_for_accounts, readable_x_capture_ids_sql

    if media_id is not None:
        captures = capture_manifest_for_media(db, grantor_id=creator_id, media_ids=[media_id])
    else:
        captures = list(
            db.scalars(
                text(f"""
            WITH roots AS (
                SELECT f.x_post_capture_id AS capture_id FROM highlight_fragment_anchors a
                JOIN fragments f ON f.id=a.fragment_id WHERE a.highlight_id=:id
                  AND f.x_post_capture_id IS NOT NULL
            ), manifest AS (
                SELECT capture_id FROM roots
                UNION SELECT c.target_capture_id FROM roots
                JOIN x_post_capture_contexts c ON c.capture_id=roots.capture_id
                WHERE c.target_capture_id IS NOT NULL
            )
            SELECT capture_id FROM manifest WHERE capture_id IN ({readable_x_capture_ids_sql()})
        """),
                {"id": subject.id, "viewer_id": creator_id},
            )
        )
    # Materialized before the grant becomes a new root for either audience.
    admit_x_captures_for_accounts(
        db,
        account_ids=[creator_id, *([] if grantee_id is None else [grantee_id])],
        capture_ids=captures,
    )
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
    if grantee_id is None:
        _insert_public_capture_manifest(db, grant_ids=[grant.id], capture_ids=captures)
    invalidate_annotation_visibility(
        db,
        annotation_visibility(
            db,
            user_ids={creator_id} | ({grantee_id} if grantee_id is not None else set()),
            media_ids=highlight_parent_media_ids(db, highlight_ids=[subject.id])
            if subject.scheme == "highlight"
            else {subject.id},
        ),
    )
    for account_id in {creator_id, *([] if grantee_id is None else [grantee_id])}:
        db.execute(text("SELECT pg_notify('nexus_writing', :viewer)"), {"viewer": str(account_id)})
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
        locked = lock_subject(db, ResourceRef(found.subject_scheme, found.subject_id))
        media_id = (
            found.subject_id
            if found.subject_scheme == "media"
            else db.scalar(
                select(Highlight.anchor_media_id).where(Highlight.id == found.subject_id)
            )
        )
        grant = db.execute(by_id.with_for_update()).one_or_none()
        if not locked or grant is None:
            return
        if grant.subject_id != found.subject_id:
            raise TransactionRestart("resource grant subject moved before delete")
        _delete(db, ResourceGrant.id == grant_id)
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        if media_id is not None:
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
