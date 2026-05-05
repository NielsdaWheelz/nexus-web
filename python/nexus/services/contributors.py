"""Contributor reads and pane hydration."""

from __future__ import annotations

from collections.abc import Collection
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import String, bindparam, func, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import (
    Contributor,
    ContributorAlias,
    ContributorCredit,
    ContributorExternalId,
    ContributorIdentityEvent,
    MessageContextItem,
    ObjectLink,
)
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.contributors import (
    ContributorAliasCreateRequest,
    ContributorAliasOut,
    ContributorExternalIdCreateRequest,
    ContributorExternalIdOut,
    ContributorKind,
    ContributorMergeRequest,
    ContributorOut,
    ContributorSearchResultOut,
    ContributorSplitRequest,
    ContributorStatus,
    ContributorWorkOut,
)
from nexus.schemas.notes import HydratedObjectRef
from nexus.services.contributor_credits import (
    CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    normalize_contributor_name,
    normalize_contributor_role,
    unique_contributor_handle_for_name,
)

ACTIVE_STATUSES = ("unverified", "verified")
CONTRIBUTOR_CURATOR_ROLES = frozenset({"admin", "contributor_curator"})


def get_contributor_by_handle(
    db: Session,
    contributor_handle: str,
    viewer_id: UUID | None = None,
) -> ContributorOut:
    contributor = (
        _load_visible_contributor_by_handle(db, contributor_handle, viewer_id)
        if viewer_id is not None
        else _load_active_contributor_by_handle(db, contributor_handle)
    )
    return _contributor_out(db, contributor)


def get_contributor_by_id(
    db: Session,
    contributor_id: UUID,
    viewer_id: UUID | None = None,
) -> ContributorOut:
    contributor = (
        _load_visible_contributor_by_id(db, contributor_id, viewer_id)
        if viewer_id is not None
        else db.get(Contributor, contributor_id)
    )
    if contributor is None or contributor.status not in ACTIVE_STATUSES:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return _contributor_out(db, contributor)


def list_contributor_works(
    db: Session,
    viewer_id: UUID,
    contributor_handle: str,
    *,
    role: str | None = None,
    content_kind: str | None = None,
    q: str | None = None,
    limit: int = 100,
) -> list[ContributorWorkOut]:
    contributor = _load_visible_contributor_by_handle(db, contributor_handle, viewer_id)
    normalized_role = normalize_contributor_role(role) if role else None
    q_pattern = f"%{q.strip()}%" if q and q.strip() else None

    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
            works AS (
                SELECT
                    'media' AS object_type,
                    cc.media_id::text AS object_id,
                    '/media/' || cc.media_id::text AS route,
                    m.title,
                    m.kind AS content_kind,
                    m.published_date,
                    m.publisher,
                    m.description,
                    cc.credited_name,
                    cc.role,
                    cc.raw_role,
                    cc.ordinal,
                    cc.source,
                    cc.created_at
                FROM contributor_credits cc
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = m.id
                WHERE cc.contributor_id = :contributor_id
                  AND cc.media_id IS NOT NULL

                UNION ALL

                SELECT
                    'podcast' AS object_type,
                    cc.podcast_id::text AS object_id,
                    '/podcasts/' || cc.podcast_id::text AS route,
                    p.title,
                    'podcast' AS content_kind,
                    NULL AS published_date,
                    NULL AS publisher,
                    p.description,
                    cc.credited_name,
                    cc.role,
                    cc.raw_role,
                    cc.ordinal,
                    cc.source,
                    cc.created_at
                FROM contributor_credits cc
                JOIN podcasts p ON p.id = cc.podcast_id
                WHERE cc.contributor_id = :contributor_id
                  AND cc.podcast_id IS NOT NULL
                  AND (
                        EXISTS (
                            SELECT 1
                            FROM podcast_subscriptions ps
                            WHERE ps.podcast_id = p.id
                              AND ps.user_id = :viewer_id
                              AND ps.status = 'active'
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM library_entries le
                            JOIN memberships mship
                              ON mship.library_id = le.library_id
                             AND mship.user_id = :viewer_id
                            WHERE le.podcast_id = p.id
                        )
                  )

                UNION ALL

                SELECT
                    'project_gutenberg_catalog' AS object_type,
                    cc.project_gutenberg_catalog_ebook_id::text AS object_id,
                    '/browse/gutenberg/' ||
                        cc.project_gutenberg_catalog_ebook_id::text AS route,
                    pg.title,
                    'project_gutenberg_ebook' AS content_kind,
                    pg.issued::text AS published_date,
                    NULL AS publisher,
                    NULL AS description,
                    cc.credited_name,
                    cc.role,
                    cc.raw_role,
                    cc.ordinal,
                    cc.source,
                    cc.created_at
                FROM contributor_credits cc
                JOIN project_gutenberg_catalog pg
                  ON pg.ebook_id = cc.project_gutenberg_catalog_ebook_id
                WHERE cc.contributor_id = :contributor_id
                  AND cc.project_gutenberg_catalog_ebook_id IS NOT NULL
            )
            SELECT *
            FROM works
            WHERE (:role IS NULL OR role = :role)
              AND (:content_kind IS NULL OR content_kind = :content_kind)
              AND (
                    :q_pattern IS NULL
                    OR title ILIKE :q_pattern
                    OR credited_name ILIKE :q_pattern
                  )
            ORDER BY role ASC, content_kind ASC, title ASC, ordinal ASC, created_at ASC
            LIMIT :limit
            """
        ).bindparams(
            bindparam("role", type_=String),
            bindparam("content_kind", type_=String),
            bindparam("q_pattern", type_=String),
        ),
        {
            "viewer_id": viewer_id,
            "contributor_id": contributor.id,
            "role": normalized_role,
            "content_kind": content_kind,
            "q_pattern": q_pattern,
            "limit": limit,
        },
    ).mappings()

    works: list[ContributorWorkOut] = []
    for row in rows:
        object_id: str | int = row["object_id"]
        if row["object_type"] == "project_gutenberg_catalog":
            object_id = int(object_id)
        works.append(
            ContributorWorkOut(
                object_type=row["object_type"],
                object_id=object_id,
                route=row["route"],
                title=row["title"],
                content_kind=row["content_kind"],
                published_date=row["published_date"],
                publisher=row["publisher"],
                description=row["description"],
                credited_name=row["credited_name"],
                role=row["role"],
                raw_role=row["raw_role"],
                ordinal=row["ordinal"],
                source=row["source"],
            )
        )
    return works


def search_contributors(
    db: Session,
    *,
    viewer_id: UUID,
    q: str | None = None,
    limit: int = 20,
) -> list[ContributorSearchResultOut]:
    q_text = q.strip() if q else ""
    q_pattern = f"%{q_text}%" if q_text else None
    rows = db.execute(
        text(
            f"""
            WITH {_visible_contributor_ctes_sql()},
            matches AS (
                SELECT
                    c.id,
                    c.handle,
                    c.display_name,
                    c.sort_name,
                    c.kind,
                    c.status,
                    c.disambiguation,
                    c.display_name AS matched_name,
                    0 AS match_rank
                FROM contributors c
                JOIN visible_contributors vc ON vc.contributor_id = c.id
                WHERE c.status IN ('unverified', 'verified')
                  AND (
                        :q_pattern IS NULL
                        OR c.display_name ILIKE :q_pattern
                        OR c.handle ILIKE :q_pattern
                  )

                UNION ALL

                SELECT
                    c.id,
                    c.handle,
                    c.display_name,
                    c.sort_name,
                    c.kind,
                    c.status,
                    c.disambiguation,
                    ca.alias AS matched_name,
                    1 AS match_rank
                FROM contributor_aliases ca
                JOIN contributors c ON c.id = ca.contributor_id
                JOIN visible_contributors vc ON vc.contributor_id = c.id
                WHERE c.status IN ('unverified', 'verified')
                  AND :q_pattern IS NOT NULL
                  AND ca.alias ILIKE :q_pattern

                UNION ALL

                SELECT
                    c.id,
                    c.handle,
                    c.display_name,
                    c.sort_name,
                    c.kind,
                    c.status,
                    c.disambiguation,
                    cc.credited_name AS matched_name,
                    2 AS match_rank
                FROM visible_contributor_credits cc
                JOIN contributors c ON c.id = cc.contributor_id
                JOIN visible_contributors vc ON vc.contributor_id = c.id
                WHERE c.status IN ('unverified', 'verified')
                  AND :q_pattern IS NOT NULL
                  AND cc.credited_name ILIKE :q_pattern

                UNION ALL

                SELECT
                    c.id,
                    c.handle,
                    c.display_name,
                    c.sort_name,
                    c.kind,
                    c.status,
                    c.disambiguation,
                    cei.external_key AS matched_name,
                    3 AS match_rank
                FROM contributor_external_ids cei
                JOIN contributors c ON c.id = cei.contributor_id
                JOIN visible_contributors vc ON vc.contributor_id = c.id
                WHERE c.status IN ('unverified', 'verified')
                  AND :q_pattern IS NOT NULL
                  AND (
                        cei.external_key ILIKE :q_pattern
                        OR cei.external_url ILIKE :q_pattern
                  )
            ),
            ranked AS (
                SELECT DISTINCT ON (id) *
                FROM matches
                ORDER BY id, match_rank ASC, display_name ASC
            )
            SELECT *
            FROM ranked
            ORDER BY match_rank ASC, display_name ASC, handle ASC
            LIMIT :limit
            """
        ).bindparams(bindparam("q_pattern", type_=String)),
        {"viewer_id": viewer_id, "q_pattern": q_pattern, "limit": limit},
    ).mappings()

    return [
        ContributorSearchResultOut(
            handle=row["handle"],
            href=f"/authors/{row['handle']}",
            display_name=row["display_name"],
            sort_name=row["sort_name"],
            kind=row["kind"],
            status=row["status"],
            disambiguation=row["disambiguation"],
            matched_name=row["matched_name"],
        )
        for row in rows
    ]


def merge_contributors(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    request: ContributorMergeRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    source = _load_active_contributor_by_handle(db, request.source_handle)
    target = _load_active_contributor_by_handle(db, request.target_handle)
    if source.id == target.id:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Choose two different contributors")

    _move_external_ids_for_merge(db, source, target)

    moved_credit_count = 0
    for credit in db.scalars(
        select(ContributorCredit).where(ContributorCredit.contributor_id == source.id)
    ):
        credit.contributor_id = target.id
        credit.resolution_status = "manual"
        moved_credit_count += 1

    moved_alias_count = 0
    for alias in db.scalars(
        select(ContributorAlias).where(ContributorAlias.contributor_id == source.id)
    ):
        alias.contributor_id = target.id
        alias.source = "manual"
        moved_alias_count += 1

    moved_link_count = _retarget_contributor_object_links(db, source.id, target.id)
    moved_context_count = _retarget_contributor_context_items(db, source.id, target)

    db_now = db.scalar(select(func.now()))
    assert (
        db_now is not None
    )  # justify-service-invariant-check: PostgreSQL now() always yields a row.
    source.status = "merged"
    source.merged_into_contributor_id = target.id
    source.merged_at = db_now
    source.updated_at = db_now
    target.updated_at = db_now
    db.add(
        ContributorIdentityEvent(
            event_type="merge",
            actor_user_id=actor_user_id,
            source_contributor_id=source.id,
            target_contributor_id=target.id,
            payload={
                "source_handle": source.handle,
                "target_handle": target.handle,
                "moved_credit_count": moved_credit_count,
                "moved_alias_count": moved_alias_count,
                "moved_link_count": moved_link_count,
                "moved_context_count": moved_context_count,
            },
        )
    )
    db.commit()
    db.refresh(target)
    return _contributor_out(db, target)


def split_contributor(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorSplitRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    source = _load_active_contributor_by_handle(db, contributor_handle)
    if not (
        request.credit_ids
        or request.alias_ids
        or request.external_id_ids
        or request.object_link_ids
        or request.message_context_item_ids
    ):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Select contributor records to split")

    display_name = request.display_name.strip()
    selected_credits = _load_selected_credits_for_split(db, source.id, request.credit_ids)
    selected_aliases = _load_selected_aliases_for_split(db, source.id, request.alias_ids)
    selected_external_ids = _load_selected_external_ids_for_split(
        db,
        source.id,
        request.external_id_ids,
    )
    selected_object_links = _load_selected_object_links_for_split(
        db,
        actor_user_id,
        source.id,
        request.object_link_ids,
    )
    selected_context_items = _load_selected_context_items_for_split(
        db,
        actor_user_id,
        source.id,
        request.message_context_item_ids,
    )

    new_contributor = Contributor(
        id=uuid4(),
        handle=unique_contributor_handle_for_name(db, normalize_contributor_name(display_name)),
        display_name=display_name,
        sort_name=display_name,
        kind=source.kind,
        status="unverified",
        disambiguation=source.disambiguation,
    )
    db.add(new_contributor)
    db.flush()
    db.add(
        ContributorAlias(
            contributor_id=new_contributor.id,
            alias=display_name,
            normalized_alias=normalize_contributor_name(display_name),
            alias_kind="display",
            source="manual",
            is_primary=True,
        )
    )

    moved_credit_count = _move_selected_credits(
        selected_credits,
        new_contributor.id,
    )
    moved_alias_count = _move_selected_aliases(
        selected_aliases,
        new_contributor.id,
    )
    moved_external_id_count = _move_selected_external_ids(
        selected_external_ids,
        new_contributor.id,
    )
    moved_link_count = _move_selected_object_links(
        selected_object_links,
        source.id,
        new_contributor.id,
    )
    moved_context_count = _move_selected_context_items(
        selected_context_items,
        new_contributor,
    )

    db_now = db.scalar(select(func.now()))
    assert (
        db_now is not None
    )  # justify-service-invariant-check: PostgreSQL now() always yields a row.
    source.updated_at = db_now
    new_contributor.updated_at = db_now
    db.add(
        ContributorIdentityEvent(
            event_type="split",
            actor_user_id=actor_user_id,
            source_contributor_id=source.id,
            target_contributor_id=new_contributor.id,
            payload={
                "source_handle": source.handle,
                "target_handle": new_contributor.handle,
                "moved_credit_count": moved_credit_count,
                "moved_alias_count": moved_alias_count,
                "moved_external_id_count": moved_external_id_count,
                "moved_link_count": moved_link_count,
                "moved_context_count": moved_context_count,
            },
        )
    )
    db.commit()
    db.refresh(new_contributor)
    return _contributor_out(db, new_contributor)


def tombstone_contributor(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    contributor = _load_active_contributor_by_handle(db, contributor_handle)
    blocking_reference = _blocking_contributor_reference_kind(db, contributor)
    if blocking_reference is not None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Move or remove contributor {blocking_reference} before tombstoning",
        )
    db_now = db.scalar(select(func.now()))
    assert (
        db_now is not None
    )  # justify-service-invariant-check: PostgreSQL now() always yields a row.
    contributor.status = "tombstoned"
    contributor.updated_at = db_now
    db.add(
        ContributorIdentityEvent(
            event_type="tombstone",
            actor_user_id=actor_user_id,
            source_contributor_id=contributor.id,
            target_contributor_id=None,
            payload={"handle": contributor.handle},
        )
    )
    db.commit()
    db.refresh(contributor)
    return _contributor_out(db, contributor)


def add_contributor_alias(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorAliasCreateRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    contributor = _load_active_contributor_by_handle(db, contributor_handle)
    alias_text = " ".join(request.alias.split())
    normalized_alias = normalize_contributor_name(alias_text)
    duplicate_id = db.scalar(
        select(ContributorAlias.id).where(
            ContributorAlias.contributor_id == contributor.id,
            ContributorAlias.normalized_alias == normalized_alias,
            ContributorAlias.alias_kind == request.alias_kind,
        )
    )
    if duplicate_id is not None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Contributor alias already exists")

    alias = ContributorAlias(
        contributor_id=contributor.id,
        alias=alias_text,
        normalized_alias=normalized_alias,
        sort_name=request.sort_name,
        alias_kind=request.alias_kind,
        locale=request.locale,
        script=request.script,
        source=request.source,
        confidence=request.confidence,
        is_primary=request.is_primary,
    )
    db.add(alias)
    db.flush()
    db.add(
        ContributorIdentityEvent(
            event_type="alias_add",
            actor_user_id=actor_user_id,
            source_contributor_id=contributor.id,
            target_contributor_id=None,
            payload={
                "contributor_handle": contributor.handle,
                "alias_id": str(alias.id),
                "alias": alias.alias,
                "alias_kind": alias.alias_kind,
            },
        )
    )
    db.commit()
    db.refresh(contributor)
    return _contributor_out(db, contributor)


def delete_contributor_alias(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    alias_id: UUID,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    contributor = _load_active_contributor_by_handle(db, contributor_handle)
    alias = db.scalar(
        select(ContributorAlias).where(
            ContributorAlias.id == alias_id,
            ContributorAlias.contributor_id == contributor.id,
        )
    )
    if alias is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor alias not found")
    payload = {
        "contributor_handle": contributor.handle,
        "alias_id": str(alias.id),
        "alias": alias.alias,
        "alias_kind": alias.alias_kind,
    }
    db.delete(alias)
    db.add(
        ContributorIdentityEvent(
            event_type="alias_remove",
            actor_user_id=actor_user_id,
            source_contributor_id=contributor.id,
            target_contributor_id=None,
            payload=payload,
        )
    )
    db.commit()
    db.refresh(contributor)
    return _contributor_out(db, contributor)


def add_contributor_external_id(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorExternalIdCreateRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    contributor = _load_active_contributor_by_handle(db, contributor_handle)
    authority = request.authority.strip().lower()
    external_key = request.external_key.strip()
    if authority not in CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Contributor external ID authority is invalid"
        )

    existing = db.scalar(
        select(ContributorExternalId).where(
            ContributorExternalId.authority == authority,
            ContributorExternalId.external_key == external_key,
        )
    )
    if existing is not None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Contributor external ID already exists")

    external_id = ContributorExternalId(
        contributor_id=contributor.id,
        authority=authority,
        external_key=external_key,
        external_url=request.external_url,
        source=request.source,
    )
    db.add(external_id)
    db.flush()
    db.add(
        ContributorIdentityEvent(
            event_type="external_id_add",
            actor_user_id=actor_user_id,
            source_contributor_id=contributor.id,
            target_contributor_id=None,
            payload={
                "contributor_handle": contributor.handle,
                "external_id_id": str(external_id.id),
                "authority": external_id.authority,
                "external_key": external_id.external_key,
            },
        )
    )
    db.commit()
    db.refresh(contributor)
    return _contributor_out(db, contributor)


def delete_contributor_external_id(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    external_id_id: UUID,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    contributor = _load_active_contributor_by_handle(db, contributor_handle)
    external_id = db.scalar(
        select(ContributorExternalId).where(
            ContributorExternalId.id == external_id_id,
            ContributorExternalId.contributor_id == contributor.id,
        )
    )
    if external_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor external ID not found")
    payload = {
        "contributor_handle": contributor.handle,
        "external_id_id": str(external_id.id),
        "authority": external_id.authority,
        "external_key": external_id.external_key,
    }
    db.delete(external_id)
    db.add(
        ContributorIdentityEvent(
            event_type="external_id_remove",
            actor_user_id=actor_user_id,
            source_contributor_id=contributor.id,
            target_contributor_id=None,
            payload=payload,
        )
    )
    db.commit()
    db.refresh(contributor)
    return _contributor_out(db, contributor)


def hydrate_contributor_object_ref(
    db: Session,
    viewer_id: UUID,
    contributor_id: UUID,
) -> HydratedObjectRef:
    contributor = _load_visible_contributor_by_id(
        db,
        contributor_id,
        viewer_id,
        message="Object not found",
    )
    return HydratedObjectRef(
        object_type="contributor",
        object_id=contributor.id,
        label=contributor.display_name,
        snippet=contributor.disambiguation or contributor.sort_name,
        route=f"/authors/{contributor.handle}",
        icon="user-round",
    )


def _require_contributor_curator(actor_roles: Collection[str]) -> None:
    if CONTRIBUTOR_CURATOR_ROLES.isdisjoint(actor_roles):
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Contributor identity curation requires a curator role",
        )


def _load_active_contributor_by_handle(db: Session, contributor_handle: str) -> Contributor:
    contributor = db.scalar(
        select(Contributor).where(
            Contributor.handle == contributor_handle,
            Contributor.status.in_(ACTIVE_STATUSES),
        )
    )
    if contributor is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _load_visible_contributor_by_handle(
    db: Session,
    contributor_handle: str,
    viewer_id: UUID,
) -> Contributor:
    contributor_id = db.execute(
        text(
            f"""
            WITH {_visible_contributor_ctes_sql()}
            SELECT c.id
            FROM contributors c
            JOIN visible_contributors vc ON vc.contributor_id = c.id
            WHERE c.handle = :contributor_handle
              AND c.status IN ('unverified', 'verified')
            """
        ),
        {"viewer_id": viewer_id, "contributor_handle": contributor_handle},
    ).scalar_one_or_none()
    if contributor_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    contributor = db.get(Contributor, contributor_id)
    if contributor is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _load_visible_contributor_by_id(
    db: Session,
    contributor_id: UUID,
    viewer_id: UUID,
    *,
    message: str = "Contributor not found",
) -> Contributor:
    visible_id = db.execute(
        text(
            f"""
            WITH {_visible_contributor_ctes_sql()}
            SELECT c.id
            FROM contributors c
            JOIN visible_contributors vc ON vc.contributor_id = c.id
            WHERE c.id = :contributor_id
              AND c.status IN ('unverified', 'verified')
            """
        ),
        {"viewer_id": viewer_id, "contributor_id": contributor_id},
    ).scalar_one_or_none()
    if visible_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, message)
    contributor = db.get(Contributor, contributor_id)
    if contributor is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, message)
    return contributor


def _visible_contributor_ctes_sql() -> str:
    return f"""
            visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            visible_podcasts AS (
                SELECT ps.podcast_id
                FROM podcast_subscriptions ps
                WHERE ps.user_id = :viewer_id
                  AND ps.status = 'active'

                UNION

                SELECT le.podcast_id
                FROM library_entries le
                JOIN memberships mship
                  ON mship.library_id = le.library_id
                 AND mship.user_id = :viewer_id
                WHERE le.podcast_id IS NOT NULL
            ),
            visible_contributor_credits AS (
                SELECT cc.*
                FROM contributor_credits cc
                LEFT JOIN visible_media vm ON vm.media_id = cc.media_id
                LEFT JOIN visible_podcasts vp ON vp.podcast_id = cc.podcast_id
                WHERE vm.media_id IS NOT NULL
                   OR vp.podcast_id IS NOT NULL
                   OR cc.project_gutenberg_catalog_ebook_id IS NOT NULL
            ),
            visible_contributor_object_links AS (
                SELECT ol.a_id AS contributor_id
                FROM object_links ol
                WHERE ol.user_id = :viewer_id
                  AND ol.a_type = 'contributor'

                UNION

                SELECT ol.b_id AS contributor_id
                FROM object_links ol
                WHERE ol.user_id = :viewer_id
                  AND ol.b_type = 'contributor'
            ),
            visible_contributor_context_items AS (
                SELECT mci.object_id AS contributor_id
                FROM message_context_items mci
                WHERE mci.user_id = :viewer_id
                  AND mci.object_type = 'contributor'
            ),
            visible_contributors AS (
                SELECT contributor_id
                FROM visible_contributor_credits

                UNION

                SELECT contributor_id
                FROM visible_contributor_object_links

                UNION

                SELECT contributor_id
                FROM visible_contributor_context_items
            )
    """


def _move_external_ids_for_merge(db: Session, source: Contributor, target: Contributor) -> None:
    target_external_ids = db.scalars(
        select(ContributorExternalId).where(ContributorExternalId.contributor_id == target.id)
    ).all()
    for external_id in db.scalars(
        select(ContributorExternalId).where(ContributorExternalId.contributor_id == source.id)
    ):
        target_matches = [
            existing
            for existing in target_external_ids
            if existing.authority == external_id.authority
        ]
        duplicate = next(
            (
                existing
                for existing in target_matches
                if existing.external_key == external_id.external_key
            ),
            None,
        )
        if duplicate is not None:
            db.delete(external_id)
            continue
        if target_matches:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Contributor external IDs conflict",
            )
        external_id.contributor_id = target.id


def _retarget_contributor_object_links(db: Session, source_id: UUID, target_id: UUID) -> int:
    moved = 0
    links = db.scalars(
        select(ObjectLink).where(
            or_(
                (ObjectLink.a_type == "contributor") & (ObjectLink.a_id == source_id),
                (ObjectLink.b_type == "contributor") & (ObjectLink.b_id == source_id),
            )
        )
    ).all()
    for link in links:
        next_a_type = link.a_type
        next_a_id = link.a_id
        next_b_type = link.b_type
        next_b_id = link.b_id
        if link.a_type == "contributor" and link.a_id == source_id:
            next_a_id = target_id
            moved += 1
        if link.b_type == "contributor" and link.b_id == source_id:
            next_b_id = target_id
            moved += 1
        if next_a_type == next_b_type and next_a_id == next_b_id:
            db.delete(link)
            continue
        if _duplicate_unlocated_object_link_exists(
            db,
            link,
            a_type=next_a_type,
            a_id=next_a_id,
            b_type=next_b_type,
            b_id=next_b_id,
        ):
            db.delete(link)
            continue
        link.a_type = next_a_type
        link.a_id = next_a_id
        link.b_type = next_b_type
        link.b_id = next_b_id
    return moved


def _retarget_contributor_context_items(
    db: Session,
    source_id: UUID,
    target: Contributor,
) -> int:
    moved = 0
    items = db.scalars(
        select(MessageContextItem).where(
            MessageContextItem.object_type == "contributor",
            MessageContextItem.object_id == source_id,
        )
    ).all()
    for item in items:
        item.object_id = target.id
        item.context_snapshot_json = _contributor_context_snapshot(
            item.context_snapshot_json,
            target,
        )
        moved += 1
    return moved


def _load_selected_credits_for_split(
    db: Session,
    source_id: UUID,
    credit_ids: list[UUID],
) -> list[ContributorCredit]:
    if not credit_ids:
        return []
    credits = db.scalars(
        select(ContributorCredit).where(
            ContributorCredit.id.in_(credit_ids),
            ContributorCredit.contributor_id == source_id,
        )
    ).all()
    if len(credits) != len(set(credit_ids)):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split credit selection is invalid")
    return list(credits)


def _move_selected_credits(
    credits: list[ContributorCredit],
    target_id: UUID,
) -> int:
    for credit in credits:
        credit.contributor_id = target_id
        credit.resolution_status = "manual"
    return len(credits)


def _load_selected_aliases_for_split(
    db: Session,
    source_id: UUID,
    alias_ids: list[UUID],
) -> list[ContributorAlias]:
    if not alias_ids:
        return []
    aliases = db.scalars(
        select(ContributorAlias).where(
            ContributorAlias.id.in_(alias_ids),
            ContributorAlias.contributor_id == source_id,
        )
    ).all()
    if len(aliases) != len(set(alias_ids)):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split alias selection is invalid")
    return list(aliases)


def _move_selected_aliases(
    aliases: list[ContributorAlias],
    target_id: UUID,
) -> int:
    for alias in aliases:
        alias.contributor_id = target_id
        alias.source = "manual"
    return len(aliases)


def _load_selected_external_ids_for_split(
    db: Session,
    source_id: UUID,
    external_id_ids: list[UUID],
) -> list[ContributorExternalId]:
    if not external_id_ids:
        return []
    external_ids = db.scalars(
        select(ContributorExternalId).where(
            ContributorExternalId.id.in_(external_id_ids),
            ContributorExternalId.contributor_id == source_id,
        )
    ).all()
    if len(external_ids) != len(set(external_id_ids)):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Split external ID selection is invalid",
        )
    return list(external_ids)


def _move_selected_external_ids(
    external_ids: list[ContributorExternalId],
    target_id: UUID,
) -> int:
    for external_id in external_ids:
        external_id.contributor_id = target_id
    return len(external_ids)


def _load_selected_object_links_for_split(
    db: Session,
    actor_user_id: UUID,
    source_id: UUID,
    link_ids: list[UUID],
) -> list[ObjectLink]:
    if not link_ids:
        return []
    links = db.scalars(select(ObjectLink).where(ObjectLink.id.in_(link_ids))).all()
    if len(links) != len(set(link_ids)):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split object-link selection is invalid")
    for link in links:
        if link.user_id != actor_user_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split object-link selection is invalid")
        if not (
            (link.a_type == "contributor" and link.a_id == source_id)
            or (link.b_type == "contributor" and link.b_id == source_id)
        ):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split object-link selection is invalid")
    return list(links)


def _move_selected_object_links(
    links: list[ObjectLink],
    source_id: UUID,
    target_id: UUID,
) -> int:
    moved = 0
    for link in links:
        if link.a_type == "contributor" and link.a_id == source_id:
            link.a_id = target_id
            moved += 1
        if link.b_type == "contributor" and link.b_id == source_id:
            link.b_id = target_id
            moved += 1
    return moved


def _duplicate_unlocated_object_link_exists(
    db: Session,
    link: ObjectLink,
    *,
    a_type: str,
    a_id: UUID,
    b_type: str,
    b_id: UUID,
) -> bool:
    if link.a_locator_json is not None or link.b_locator_json is not None:
        return False
    return (
        db.scalar(
            select(ObjectLink.id)
            .where(
                ObjectLink.id != link.id,
                ObjectLink.user_id == link.user_id,
                ObjectLink.relation_type == link.relation_type,
                ObjectLink.a_locator_json.is_(None),
                ObjectLink.b_locator_json.is_(None),
                or_(
                    (
                        (ObjectLink.a_type == a_type)
                        & (ObjectLink.a_id == a_id)
                        & (ObjectLink.b_type == b_type)
                        & (ObjectLink.b_id == b_id)
                    ),
                    (
                        (ObjectLink.a_type == b_type)
                        & (ObjectLink.a_id == b_id)
                        & (ObjectLink.b_type == a_type)
                        & (ObjectLink.b_id == a_id)
                    ),
                ),
            )
            .limit(1)
        )
        is not None
    )


def _load_selected_context_items_for_split(
    db: Session,
    actor_user_id: UUID,
    source_id: UUID,
    item_ids: list[UUID],
) -> list[MessageContextItem]:
    if not item_ids:
        return []
    items = db.scalars(select(MessageContextItem).where(MessageContextItem.id.in_(item_ids))).all()
    if len(items) != len(set(item_ids)):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split context selection is invalid")
    for item in items:
        if item.user_id != actor_user_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split context selection is invalid")
        if item.object_type != "contributor" or item.object_id != source_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Split context selection is invalid")
    return list(items)


def _move_selected_context_items(
    items: list[MessageContextItem],
    target: Contributor,
) -> int:
    for item in items:
        item.object_id = target.id
        item.context_snapshot_json = _contributor_context_snapshot(
            item.context_snapshot_json,
            target,
        )
    return len(items)


def _contributor_context_snapshot(
    snapshot: dict[str, object],
    contributor: Contributor,
) -> dict[str, object]:
    next_snapshot = dict(snapshot)
    next_snapshot["objectType"] = "contributor"
    next_snapshot["objectId"] = str(contributor.id)
    next_snapshot["label"] = contributor.display_name
    next_snapshot["route"] = f"/authors/{contributor.handle}"
    return next_snapshot


def _blocking_contributor_reference_kind(db: Session, contributor: Contributor) -> str | None:
    credit_id = db.scalar(
        select(ContributorCredit.id)
        .where(ContributorCredit.contributor_id == contributor.id)
        .limit(1)
    )
    if credit_id is not None:
        return "credits"

    object_link_id = db.scalar(
        select(ObjectLink.id)
        .where(
            or_(
                (ObjectLink.a_type == "contributor") & (ObjectLink.a_id == contributor.id),
                (ObjectLink.b_type == "contributor") & (ObjectLink.b_id == contributor.id),
            )
        )
        .limit(1)
    )
    if object_link_id is not None:
        return "object links"

    context_item_id = db.scalar(
        select(MessageContextItem.id)
        .where(
            MessageContextItem.object_type == "contributor",
            MessageContextItem.object_id == contributor.id,
        )
        .limit(1)
    )
    if context_item_id is not None:
        return "message context items"

    if _persisted_contributor_ref_exists(db, contributor):
        return "persisted references"

    return None


def _persisted_contributor_ref_exists(db: Session, contributor: Contributor) -> bool:
    selected_context_refs_sql = _json_array_contains_contributor_ref_sql(
        "mtc.selected_context_refs",
        "selected_ref",
    )
    included_context_refs_sql = _json_array_contains_contributor_ref_sql(
        "cpa.included_context_refs",
        "included_ref",
    )
    row = db.execute(
        text(
            f"""
            SELECT 1
            WHERE EXISTS (
                SELECT 1
                FROM message_retrievals mr
                WHERE {_json_contains_contributor_ref_sql("mr.context_ref")}
                   OR {_json_contains_contributor_ref_sql("mr.result_ref")}
                LIMIT 1
            )
            OR EXISTS (
                SELECT 1
                FROM message_tool_calls mtc
                WHERE {_json_array_contains_contributor_ref_sql("mtc.result_refs", "result_ref")}
                   OR {selected_context_refs_sql}
                LIMIT 1
            )
            OR EXISTS (
                SELECT 1
                FROM assistant_message_claim_evidence ace
                WHERE {_json_contains_contributor_ref_sql("ace.context_ref")}
                   OR {_json_contains_contributor_ref_sql("ace.result_ref")}
                LIMIT 1
            )
            OR EXISTS (
                SELECT 1
                FROM chat_prompt_assemblies cpa
                WHERE {included_context_refs_sql}
                LIMIT 1
            )
            """
        ),
        {
            "contributor_id_text": str(contributor.id),
            "contributor_handle": contributor.handle,
            "contributor_resource_ref": f"contributor:{contributor.handle}",
        },
    ).fetchone()
    return row is not None


def _json_array_contains_contributor_ref_sql(column: str, alias: str) -> str:
    return f"""
        EXISTS (
            SELECT 1
            FROM jsonb_array_elements({column}) AS {alias}(value)
            WHERE {_json_contains_contributor_ref_sql(f"{alias}.value")}
        )
    """


def _json_contains_contributor_ref_sql(column: str) -> str:
    return f"""
        (
            {column} @> jsonb_build_object(
                'type', 'contributor',
                'id', CAST(:contributor_id_text AS text)
            )
            OR {column} @> jsonb_build_object(
                'type', 'contributor',
                'id', CAST(:contributor_handle AS text)
            )
            OR {column} @> jsonb_build_object(
                'type', 'contributor',
                'id', CAST(:contributor_resource_ref AS text)
            )
            OR {column} @> jsonb_build_object(
                'type', 'contributor',
                'contributor_handle', CAST(:contributor_handle AS text)
            )
            OR {column} @> jsonb_build_object(
                'type', 'contributor',
                'handle', CAST(:contributor_handle AS text)
            )
            OR {column} @> jsonb_build_object(
                'objectType', 'contributor',
                'objectId', CAST(:contributor_id_text AS text)
            )
            OR {column} @> jsonb_build_object(
                'result_type', 'contributor',
                'source_id', CAST(:contributor_id_text AS text)
            )
            OR {column} @> jsonb_build_object(
                'result_type', 'contributor',
                'source_id', CAST(:contributor_handle AS text)
            )
            OR {column} @> jsonb_build_object(
                'result_type', 'contributor',
                'source_id', CAST(:contributor_resource_ref AS text)
            )
            OR {column} @> jsonb_build_object(
                'context_ref',
                jsonb_build_object('type', 'contributor', 'id', CAST(:contributor_id_text AS text))
            )
            OR {column} @> jsonb_build_object(
                'context_ref',
                jsonb_build_object('type', 'contributor', 'id', CAST(:contributor_handle AS text))
            )
            OR {column} @> jsonb_build_object(
                'context_ref',
                jsonb_build_object('type', 'contributor', 'id', CAST(:contributor_resource_ref AS text))
            )
            OR {column} @> jsonb_build_object(
                'context_ref',
                jsonb_build_object(
                    'type', 'contributor',
                    'contributor_handle', CAST(:contributor_handle AS text)
                )
            )
        )
    """


def _contributor_out(db: Session, contributor: Contributor) -> ContributorOut:
    aliases = db.scalars(
        select(ContributorAlias)
        .where(ContributorAlias.contributor_id == contributor.id)
        .order_by(
            ContributorAlias.is_primary.desc(),
            ContributorAlias.alias.asc(),
            ContributorAlias.id.asc(),
        )
    ).all()
    external_ids = db.scalars(
        select(ContributorExternalId)
        .where(ContributorExternalId.contributor_id == contributor.id)
        .order_by(
            ContributorExternalId.authority.asc(),
            ContributorExternalId.external_key.asc(),
        )
    ).all()
    return ContributorOut(
        handle=contributor.handle,
        href=f"/authors/{contributor.handle}",
        display_name=contributor.display_name,
        sort_name=contributor.sort_name,
        kind=cast(ContributorKind, contributor.kind),
        status=cast(ContributorStatus, contributor.status),
        disambiguation=contributor.disambiguation,
        aliases=[ContributorAliasOut.model_validate(alias) for alias in aliases],
        external_ids=[
            ContributorExternalIdOut.model_validate(external_id) for external_id in external_ids
        ],
        created_at=contributor.created_at,
        updated_at=contributor.updated_at,
    )
