"""Contributor reads and pane hydration."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import String, bindparam, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    visible_content_credit_rows_sql,
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    Contributor,
    ContributorAlias,
    ContributorCredit,
    ContributorExternalId,
    ContributorIdentityEvent,
    ResourceEdge,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.contributors import (
    ContributorAliasCreateRequest,
    ContributorAliasOut,
    ContributorDirectoryEntry,
    ContributorDirectoryFacets,
    ContributorDirectoryPage,
    ContributorDirectoryPageInfo,
    ContributorExternalIdCreateRequest,
    ContributorExternalIdOut,
    ContributorKind,
    ContributorMergeRequest,
    ContributorOut,
    ContributorSearchResultOut,
    ContributorSplitRequest,
    ContributorStatus,
    ContributorWorkOut,
    FacetCount,
)
from nexus.schemas.resource_items import HydratedObjectRef
from nexus.services.chat_context_refs import contributor_is_referenced_in_persisted_context
from nexus.services.contributor_taxonomy import (
    CONFIRMED_ALIAS_SOURCES,
    CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    normalize_contributor_name,
    normalize_contributor_role,
)
from nexus.services.resource_graph.refs import ResourceRef

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


def resolve_contributor_ref_by_handle(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: str,
) -> ResourceRef:
    contributor = _load_visible_contributor_by_handle(db, contributor_handle, viewer_id)
    return ResourceRef(scheme="contributor", id=contributor.id)


def resolve_canonical_contributor_ids(db: Session, handles: Sequence[str]) -> list[UUID]:
    """Map handles to their canonical survivor ids (following merges), deduped and order-preserving.

    Unknown handles are dropped. Callers filter by these ids so a merged handle returns the
    survivor's content."""
    canonical_ids: list[UUID] = []
    seen: set[UUID] = set()
    for handle in handles:
        start_id = db.scalar(select(Contributor.id).where(Contributor.handle == handle))
        if start_id is None:
            continue
        canonical_id = _canonical_contributor_id(db, start_id)
        if canonical_id not in seen:
            seen.add(canonical_id)
            canonical_ids.append(canonical_id)
    return canonical_ids


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
                  AND cc.podcast_id IN ({visible_podcast_ids_cte_sql()})

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


def list_contributors(
    db: Session,
    *,
    viewer_id: UUID,
    q: str | None = None,
    roles: frozenset[str] = frozenset(),
    kinds: frozenset[str] = frozenset(),
    content_kinds: frozenset[str] = frozenset(),
    statuses: frozenset[str] = frozenset(),
    sort: Literal["works", "name"] = "works",
    cursor: str | None = None,
    limit: int = 40,
) -> ContributorDirectoryPage:
    """Faceted directory of contributors visible to the viewer, with visibility-scoped work counts.

    Object-link-only contributors appear with a work_count of 0. ``sort="name"`` paginates with a
    keyset cursor over (sort_name, id); ``sort="works"`` paginates with an offset cursor."""
    params: dict[str, Any] = {"viewer_id": viewer_id, "limit": limit + 1}
    filters = ["c.status NOT IN ('merged', 'tombstoned')"]
    if roles:
        filters.append(
            "EXISTS (SELECT 1 FROM scoped s WHERE s.contributor_id = c.id AND s.role = ANY(:roles))"
        )
        params["roles"] = sorted(roles)
    if kinds:
        filters.append("c.kind = ANY(:kinds)")
        params["kinds"] = sorted(kinds)
    if content_kinds:
        filters.append(
            "EXISTS (SELECT 1 FROM scoped s "
            "WHERE s.contributor_id = c.id AND s.content_kind = ANY(:content_kinds))"
        )
        params["content_kinds"] = sorted(content_kinds)
    if statuses:
        filters.append("c.status = ANY(:statuses)")
        params["statuses"] = sorted(statuses)
    q_text = q.strip() if q else ""
    if q_text:
        filters.append(
            "(c.display_name ILIKE :q_like OR c.sort_name ILIKE :q_like "
            "OR EXISTS (SELECT 1 FROM contributor_aliases a "
            "WHERE a.contributor_id = c.id AND a.normalized_alias ILIKE :q_prefix))"
        )
        params["q_like"] = f"%{q_text}%"
        params["q_prefix"] = f"{q_text.lower()}%"

    if sort == "name":
        decoded = _decode_directory_cursor(cursor, "name") if cursor else None
        if decoded is not None:
            filters.append("(c.sort_name, c.id) > (:after_sort, CAST(:after_id AS uuid))")
            params["after_sort"] = decoded["after"][0]
            params["after_id"] = decoded["after"][1]
        order_by = "ORDER BY c.sort_name ASC, c.id ASC"
        offset = 0
    else:
        offset = _decode_directory_cursor(cursor, "works")["offset"] if cursor else 0
        params["offset"] = offset
        order_by = "ORDER BY work_count DESC, c.sort_name ASC, c.id ASC OFFSET :offset"

    rows = (
        db.execute(
            text(
                f"""
            WITH {_directory_scoped_cte_sql()},
                 counts AS (
                     SELECT contributor_id,
                            COUNT(DISTINCT work_key) AS work_count,
                            array_agg(DISTINCT role) AS roles,
                            array_agg(DISTINCT content_kind) AS content_kinds
                     FROM scoped GROUP BY contributor_id
                 )
            SELECT c.id, c.handle, c.display_name, c.sort_name, c.kind, c.status, c.disambiguation,
                   COALESCE(counts.work_count, 0) AS work_count,
                   COALESCE(counts.roles, ARRAY[]::text[]) AS roles,
                   COALESCE(counts.content_kinds, ARRAY[]::text[]) AS content_kinds
            FROM contributors c
            JOIN visible v ON v.contributor_id = c.id
            LEFT JOIN counts ON counts.contributor_id = c.id
            WHERE {" AND ".join(filters)}
            {order_by}
            LIMIT :limit
            """
            ),
            params,
        )
        .mappings()
        .all()
    )

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    entries = [
        ContributorDirectoryEntry(
            handle=row["handle"],
            href=f"/authors/{row['handle']}",
            display_name=row["display_name"],
            sort_name=row["sort_name"],
            kind=row["kind"],
            status=row["status"],
            disambiguation=row["disambiguation"],
            work_count=row["work_count"],
            roles=sorted(row["roles"]),
            content_kinds=sorted(row["content_kinds"]),
        )
        for row in page_rows
    ]

    next_cursor: str | None = None
    if has_more and page_rows:
        if sort == "name":
            last = page_rows[-1]
            next_cursor = _encode_directory_cursor(
                {"k": "name", "after": [last["sort_name"], str(last["id"])]}
            )
        else:
            next_cursor = _encode_directory_cursor({"k": "works", "offset": offset + limit})

    return ContributorDirectoryPage(
        entries=entries,
        facets=_contributor_directory_facets(db, viewer_id),
        page=ContributorDirectoryPageInfo(has_more=has_more, next_cursor=next_cursor),
    )


def _contributor_directory_facets(db: Session, viewer_id: UUID) -> ContributorDirectoryFacets:
    rows = (
        db.execute(
            text(
                f"""
            WITH {_directory_scoped_cte_sql()},
                 active AS (
                     SELECT c.id, c.kind, c.status
                     FROM contributors c
                     JOIN visible v ON v.contributor_id = c.id
                     WHERE c.status NOT IN ('merged', 'tombstoned')
                 )
            SELECT 'role' AS facet, role AS value, COUNT(DISTINCT contributor_id) AS count
            FROM scoped GROUP BY role
            UNION ALL
            SELECT 'content_kind', content_kind, COUNT(DISTINCT contributor_id) FROM scoped
            GROUP BY content_kind
            UNION ALL
            SELECT 'kind', kind, COUNT(*) FROM active GROUP BY kind
            UNION ALL
            SELECT 'status', status, COUNT(*) FROM active GROUP BY status
            """
            ),
            {"viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )

    buckets: dict[str, list[FacetCount]] = {
        "role": [],
        "content_kind": [],
        "kind": [],
        "status": [],
    }
    for row in rows:
        buckets[row["facet"]].append(FacetCount(value=row["value"], count=row["count"]))
    for facet_counts in buckets.values():
        facet_counts.sort(key=lambda fc: (-fc.count, fc.value))
    return ContributorDirectoryFacets(
        roles=buckets["role"],
        kinds=buckets["kind"],
        content_kinds=buckets["content_kind"],
        statuses=buckets["status"],
    )


def _directory_scoped_cte_sql() -> str:
    """`visible` (viewer-visible contributor ids) + `scoped` (their visible credit rows with
    role/content_kind/work_key) — the shared base of the directory listing and its facets."""
    return f"""visible AS ({visible_contributor_ids_cte_sql()}),
                 scoped AS (
                     SELECT cc.contributor_id, cc.role,
                            CASE WHEN cc.media_id IS NOT NULL THEN m.kind
                                 WHEN cc.podcast_id IS NOT NULL THEN 'podcast'
                                 ELSE 'gutenberg' END AS content_kind,
                            COALESCE(cc.media_id::text, cc.podcast_id::text,
                                     cc.project_gutenberg_catalog_ebook_id::text) AS work_key
                     FROM ({visible_content_credit_rows_sql()}) cc
                     LEFT JOIN media m ON m.id = cc.media_id
                 )"""


def _encode_directory_cursor(payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode_directory_cursor(cursor: str, expected_kind: str) -> dict[str, Any]:
    invalid = ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid directory cursor")
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (ValueError, json.JSONDecodeError) as exc:
        raise invalid from exc
    if not isinstance(payload, dict) or payload.get("k") != expected_kind:
        raise invalid
    if expected_kind == "name":
        after = payload.get("after")
        if not (isinstance(after, list) and len(after) == 2 and isinstance(after[0], str)):
            raise invalid
        try:
            UUID(after[1])
        except (ValueError, TypeError) as exc:
            raise invalid from exc
    else:
        offset = payload.get("offset")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise invalid
    return payload


# ---------------------------------------------------------------------------
# Identity writes — curator-gated, each atomic under SERIALIZABLE with retry
# via retry_serializable (no explicit row locking, per concurrency.md).
# ---------------------------------------------------------------------------


def split_contributor(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorSplitRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    # Function-local import: resource_graph.edges reaches back here via
    # resolve → notes → object_refs → contributors.
    from nexus.services.resource_graph.edges import repoint_edges

    if not (request.credit_ids or request.alias_ids or request.external_id_ids):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Select contributor records to split")
    display_name = request.display_name.strip()

    def _txn() -> ContributorOut:
        source = _load_active_contributor_by_handle(db, contributor_handle)
        selected_credits = _load_selected_credits_for_split(db, source.id, request.credit_ids)
        selected_aliases = _load_selected_aliases_for_split(db, source.id, request.alias_ids)
        selected_external_ids = _load_selected_external_ids_for_split(
            db, source.id, request.external_id_ids
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

        moved_credit_count = _move_selected_credits(selected_credits, new_contributor.id)
        moved_alias_count = _move_selected_aliases(selected_aliases, new_contributor.id)
        moved_external_id_count = _move_selected_external_ids(
            selected_external_ids, new_contributor.id
        )
        # All of the actor's graph edges follow the new identity (AC11);
        # ordinals and snapshots ride along untouched.
        moved_link_count = repoint_edges(
            db,
            viewer_id=actor_user_id,
            from_ref=ResourceRef(scheme="contributor", id=source.id),
            to_ref=ResourceRef(scheme="contributor", id=new_contributor.id),
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
                },
            )
        )
        db.commit()
        db.refresh(new_contributor)
        return _contributor_out(db, new_contributor)

    return retry_serializable(db, "run_identity_write", _txn)


def tombstone_contributor(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> ContributorOut:
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

    return retry_serializable(db, "run_identity_write", _txn)


def add_contributor_alias(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorAliasCreateRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> ContributorOut:
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

    return retry_serializable(db, "run_identity_write", _txn)


def delete_contributor_alias(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    alias_id: UUID,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> ContributorOut:
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

    return retry_serializable(db, "run_identity_write", _txn)


def add_contributor_external_id(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorExternalIdCreateRequest,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> ContributorOut:
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

    return retry_serializable(db, "run_identity_write", _txn)


def delete_contributor_external_id(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    external_id_id: UUID,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> ContributorOut:
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

    return retry_serializable(db, "run_identity_write", _txn)


def merge_contributor(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str] = frozenset(),
    contributor_handle: str,
    request: ContributorMergeRequest,
) -> ContributorOut:
    """Redirect a duplicate contributor (source, from the path handle) into a survivor (target).

    Repoints credits/aliases/external-ids onto the target (deduping equivalents), writes a confirmed
    merge-alias for the source name so name-only reingest resolves to the survivor, flattens prior
    merge chains, and marks the source ``merged``. Graph edges are repointed explicitly and totally
    through ``resource_graph.edges.repoint_edges`` (AC11) — including citation edges, whose
    ordinals and snapshots are untouched."""
    _require_contributor_curator(actor_roles)
    # Function-local import: resource_graph.edges reaches back here via
    # resolve → notes → object_refs → contributors.
    from nexus.services.resource_graph.edges import repoint_edges

    def _txn() -> ContributorOut:
        source = _load_contributor_for_merge(db, contributor_handle)
        target = _load_contributor_for_merge(db, request.target_handle)
        if source.id == target.id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Cannot merge a contributor into itself")

        ids = {"source_id": source.id, "target_id": target.id}
        merged_duplicate_credits = len(
            db.execute(
                text(
                    """
                    DELETE FROM contributor_credits src
                    WHERE src.contributor_id = :source_id
                      AND EXISTS (
                          SELECT 1 FROM contributor_credits tgt
                          WHERE tgt.contributor_id = :target_id
                            AND tgt.role = src.role
                            AND tgt.normalized_credited_name = src.normalized_credited_name
                            AND tgt.media_id IS NOT DISTINCT FROM src.media_id
                            AND tgt.podcast_id IS NOT DISTINCT FROM src.podcast_id
                            AND tgt.project_gutenberg_catalog_ebook_id
                                IS NOT DISTINCT FROM src.project_gutenberg_catalog_ebook_id
                      )
                    RETURNING src.id
                    """
                ),
                ids,
            ).fetchall()
        )
        repointed_credits = len(
            db.execute(
                text(
                    """
                    UPDATE contributor_credits SET contributor_id = :target_id, updated_at = now()
                    WHERE contributor_id = :source_id
                    RETURNING id
                    """
                ),
                ids,
            ).fetchall()
        )

        db.execute(
            text(
                """
                DELETE FROM contributor_aliases src
                WHERE src.contributor_id = :source_id
                  AND EXISTS (
                      SELECT 1 FROM contributor_aliases tgt
                      WHERE tgt.contributor_id = :target_id
                        AND tgt.normalized_alias = src.normalized_alias
                        AND tgt.alias_kind = src.alias_kind
                  )
                """
            ),
            ids,
        )
        db.execute(
            text(
                """
                UPDATE contributor_aliases SET contributor_id = :target_id, is_primary = false
                WHERE contributor_id = :source_id
                """
            ),
            ids,
        )

        # Durable confirmed merge-alias so name-only reingest of the source name resolves to the
        # target. "merge" is in CONFIRMED_ALIAS_SOURCES; written even if another confirmed alias
        # exists, so the breadcrumb survives later alias edits. Idempotent on (name, source="merge").
        merged_name = normalize_contributor_name(source.display_name)
        existing_merge_alias = db.scalar(
            select(ContributorAlias.id).where(
                ContributorAlias.contributor_id == target.id,
                ContributorAlias.normalized_alias == merged_name,
                ContributorAlias.source == "merge",
            )
        )
        if existing_merge_alias is None:
            db.add(
                ContributorAlias(
                    contributor_id=target.id,
                    alias=source.display_name,
                    normalized_alias=merged_name,
                    alias_kind="search",
                    source="merge",
                    is_primary=False,
                )
            )

        # External ids are globally unique on (authority, external_key), so a plain repoint never
        # collides; differing keys for one authority simply coexist on the target (R3).
        db.execute(
            text(
                "UPDATE contributor_external_ids SET contributor_id = :target_id "
                "WHERE contributor_id = :source_id"
            ),
            ids,
        )
        # Every graph edge follows the survivor — bare links (dropping bare-pair
        # duplicates) and citations with ordinals/snapshots intact (§9.6, AC11).
        repointed_edges = repoint_edges(
            db,
            viewer_id=actor_user_id,
            from_ref=ResourceRef(scheme="contributor", id=source.id),
            to_ref=ResourceRef(scheme="contributor", id=target.id),
        )
        # Flatten prior chains so resolution stays depth 1.
        db.execute(
            text(
                "UPDATE contributors SET merged_into_contributor_id = :target_id "
                "WHERE merged_into_contributor_id = :source_id"
            ),
            ids,
        )

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
                    "merged_duplicate_credits": merged_duplicate_credits,
                    "repointed_credits": repointed_credits,
                    "repointed_edges": repointed_edges,
                },
            )
        )
        db.commit()
        db.refresh(target)
        return _contributor_out(db, target)

    return retry_serializable(db, "run_identity_write", _txn)


def _load_contributor_for_merge(db: Session, contributor_handle: str) -> Contributor:
    contributor = db.scalar(select(Contributor).where(Contributor.handle == contributor_handle))
    if contributor is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    if contributor.status not in ACTIVE_STATUSES:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Contributor is already merged or tombstoned"
        )
    return contributor


def hydrate_contributor_object_ref(
    db: Session,
    viewer_id: UUID,
    contributor_id: UUID,
) -> HydratedObjectRef:
    from nexus.services.resource_items.routing import route_for_ref

    contributor = _load_visible_contributor_by_id(
        db,
        _canonical_contributor_id(db, contributor_id),
        viewer_id,
        message="Object not found",
    )
    return HydratedObjectRef(
        object_type="contributor",
        object_id=contributor.id,
        label=contributor.display_name,
        snippet=contributor.disambiguation or contributor.sort_name,
        route=route_for_ref(
            db, viewer_id=viewer_id, ref=ResourceRef(scheme="contributor", id=contributor.id)
        ),
        icon="user-round",
    )


def _require_contributor_curator(actor_roles: Collection[str]) -> None:
    if CONTRIBUTOR_CURATOR_ROLES.isdisjoint(actor_roles):
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Contributor identity curation requires a curator role",
        )


def _canonical_contributor_id(db: Session, contributor_id: UUID) -> UUID:
    """Follow ``merged_into_contributor_id`` to the surviving contributor. Merge flattens chains,
    so depth is normally 1; the guard catches a cycle (a defect)."""
    current = contributor_id
    for _ in range(8):
        merged_into = db.scalar(
            select(Contributor.merged_into_contributor_id).where(Contributor.id == current)
        )
        if merged_into is None:
            return current
        current = merged_into
    # justify-defect: merge flattens chains to depth 1; a longer chain is a cycle/defect.
    raise AssertionError(f"contributor merge chain too deep from {contributor_id}")


def _canonical_id_for_handle(db: Session, contributor_handle: str) -> UUID:
    row = db.execute(
        select(Contributor.id, Contributor.status).where(Contributor.handle == contributor_handle)
    ).first()
    if row is None or row.status == "tombstoned":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return _canonical_contributor_id(db, row.id)


def _load_active_contributor_by_handle(db: Session, contributor_handle: str) -> Contributor:
    contributor = db.get(Contributor, _canonical_id_for_handle(db, contributor_handle))
    if contributor is None or contributor.status not in ACTIVE_STATUSES:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _load_visible_contributor_by_handle(
    db: Session,
    contributor_handle: str,
    viewer_id: UUID,
) -> Contributor:
    return _load_visible_contributor_by_id(
        db, _canonical_id_for_handle(db, contributor_handle), viewer_id
    )


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
    """Define ``visible_contributor_credits`` (rows) and ``visible_contributors`` (ids)
    from the single owner in ``permissions``."""
    return f"""
            visible_contributor_credits AS (
                {visible_content_credit_rows_sql()}
            ),
            visible_contributors AS (
                {visible_contributor_ids_cte_sql()}
            )
    """


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


def _blocking_contributor_reference_kind(db: Session, contributor: Contributor) -> str | None:
    credit_id = db.scalar(
        select(ContributorCredit.id)
        .where(ContributorCredit.contributor_id == contributor.id)
        .limit(1)
    )
    if credit_id is not None:
        return "credits"

    # Read-only existence probe on the graph (any user, either endpoint);
    # writes stay with resource_graph (AC13).
    edge_id = db.scalar(
        select(ResourceEdge.id)
        .where(
            or_(
                (ResourceEdge.source_scheme == "contributor")
                & (ResourceEdge.source_id == contributor.id),
                (ResourceEdge.target_scheme == "contributor")
                & (ResourceEdge.target_id == contributor.id),
            )
        )
        .limit(1)
    )
    if edge_id is not None:
        return "links"

    if contributor_is_referenced_in_persisted_context(db, contributor_handle=contributor.handle):
        return "persisted references"

    return None


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


# ---------------------------------------------------------------------------
# Identity resolution — the single owner, called by contributor_credits.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContributorExternalIdEvidence:
    """A strong-authority external identifier that asserts contributor identity."""

    authority: str
    external_key: str
    external_url: str | None = None


@dataclass(frozen=True)
class ContributorResolutionInput:
    """Typed identity evidence for one credit. Provider IDs and ``source_ref`` provenance are
    deliberately absent — only explicit ids/handles and strong external ids assert identity."""

    credited_name: str
    source: str
    explicit_id: UUID | None = None
    explicit_handle: str | None = None
    external_ids: tuple[ContributorExternalIdEvidence, ...] = ()


@dataclass(frozen=True)
class ContributorResolution:
    contributor_id: UUID
    resolution_status: str  # external_id | manual | confirmed_alias | unverified


def resolve_or_create_contributor(
    db: Session, item: ContributorResolutionInput
) -> ContributorResolution:
    explicit = _resolve_explicit_contributor(db, item)
    if explicit is not None:
        return ContributorResolution(explicit, "manual")

    if item.external_ids:
        return ContributorResolution(
            _resolve_or_attach_external_id(db, item, item.external_ids[0]), "external_id"
        )

    confirmed_alias = _resolve_confirmed_alias(db, item.credited_name)
    if confirmed_alias is not None:
        return ContributorResolution(confirmed_alias, "confirmed_alias")

    return ContributorResolution(_create_unverified_contributor(db, item), "unverified")


def _resolve_explicit_contributor(db: Session, item: ContributorResolutionInput) -> UUID | None:
    if item.explicit_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                FROM contributors
                WHERE id = :contributor_id
                  AND status IN ('unverified', 'verified')
                """
            ),
            {"contributor_id": item.explicit_id},
        ).fetchone()
        return row[0] if row is not None else None

    if item.explicit_handle:
        row = db.execute(
            text(
                """
                SELECT id
                FROM contributors
                WHERE handle = :contributor_handle
                  AND status IN ('unverified', 'verified')
                """
            ),
            {"contributor_handle": item.explicit_handle},
        ).fetchone()
        return row[0] if row is not None else None

    return None


def _resolve_or_attach_external_id(
    db: Session,
    item: ContributorResolutionInput,
    evidence: ContributorExternalIdEvidence,
) -> UUID:
    existing = _select_contributor_by_external_id(db, evidence.authority, evidence.external_key)
    if existing is not None:
        return existing
    try:
        with db.begin_nested():
            contributor_id = _create_unverified_contributor(db, item)
            _insert_external_id(db, contributor_id, evidence, item.source)
            return contributor_id
    except IntegrityError as exc:
        if not _is_contributor_identity_race(exc):
            raise
        existing = _select_contributor_by_external_id(db, evidence.authority, evidence.external_key)
        if existing is not None:
            return existing
        # The handle was taken in the race; attach the external id to that owner instead.
        handle_owner = _select_contributor_by_handle(
            db, contributor_handle_for_name(normalize_contributor_name(item.credited_name))
        )
        if handle_owner is None:
            raise
        try:
            with db.begin_nested():
                _insert_external_id(db, handle_owner, evidence, item.source)
        except IntegrityError as attach_exc:
            if not _is_contributor_external_id_conflict(attach_exc):
                raise
            external_owner = _select_contributor_by_external_id(
                db, evidence.authority, evidence.external_key
            )
            if external_owner is None:
                raise
            handle_owner = external_owner
        return handle_owner


def _insert_external_id(
    db: Session,
    contributor_id: UUID,
    evidence: ContributorExternalIdEvidence,
    source: str,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO contributor_external_ids (
                contributor_id, authority, external_key, external_url, source
            )
            VALUES (:contributor_id, :authority, :external_key, :external_url, :source)
            """
        ),
        {
            "contributor_id": contributor_id,
            "authority": evidence.authority,
            "external_key": evidence.external_key,
            "external_url": evidence.external_url,
            "source": source,
        },
    )


def _resolve_confirmed_alias(db: Session, credited_name: str) -> UUID | None:
    normalized_name = normalize_contributor_name(credited_name)
    rows = db.execute(
        text(
            """
            SELECT
                c.id,
                bool_or(ca.is_primary) AS has_primary,
                min(c.created_at) AS created_at
            FROM contributor_aliases ca
            JOIN contributors c ON c.id = ca.contributor_id
            WHERE ca.normalized_alias = :normalized_name
              AND ca.source = ANY(:confirmed_alias_sources)
              AND c.status IN ('unverified', 'verified')
            GROUP BY c.id
            ORDER BY has_primary DESC, created_at ASC, c.id ASC
            LIMIT 2
            """
        ),
        {
            "normalized_name": normalized_name,
            "confirmed_alias_sources": sorted(CONFIRMED_ALIAS_SOURCES),
        },
    ).fetchall()
    return rows[0][0] if len(rows) == 1 else None


def _create_unverified_contributor(db: Session, item: ContributorResolutionInput) -> UUID:
    # justify-service-invariant-check: contributors.sort_name is NOT NULL and is written
    # from credited_name here; `str` cannot express "non-empty". Callers drop empty credited
    # names before resolving, so an empty one reaching the sole create seam is a defect.
    assert item.credited_name.strip(), "contributor credited_name must be non-empty"
    normalized_name = normalize_contributor_name(item.credited_name)
    handle = unique_contributor_handle_for_name(db, normalized_name)
    contributor_id = uuid4()
    try:
        with db.begin_nested():
            db.execute(
                text(
                    """
                    INSERT INTO contributors (id, handle, display_name, sort_name, kind, status)
                    VALUES (:id, :handle, :display_name, :sort_name, 'unknown', 'unverified')
                    """
                ),
                {
                    "id": contributor_id,
                    "handle": handle,
                    "display_name": item.credited_name,
                    "sort_name": item.credited_name,
                },
            )
            db.execute(
                text(
                    """
                    INSERT INTO contributor_aliases (
                        contributor_id, alias, normalized_alias, alias_kind, source, is_primary
                    )
                    VALUES (:contributor_id, :alias, :normalized_alias, 'display', :source, true)
                    """
                ),
                {
                    "contributor_id": contributor_id,
                    "alias": item.credited_name,
                    "normalized_alias": normalized_name,
                    "source": item.source,
                },
            )
            return contributor_id
    except IntegrityError as exc:
        if not _is_contributor_handle_conflict(exc):
            raise
        existing = _select_contributor_by_handle(db, handle)
        if existing is None:
            raise
        return existing


def unique_contributor_handle_for_name(db: Session, normalized_name: str) -> str:
    base_handle = contributor_handle_for_name(normalized_name)
    handle = base_handle
    while True:
        row = db.execute(
            text("SELECT 1 FROM contributors WHERE handle = :handle"),
            {"handle": handle},
        ).fetchone()
        if row is None:
            return handle
        handle = f"{base_handle}-{uuid4().hex[:8]}"


def contributor_handle_for_name(normalized_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", normalized_name).strip("-") or "contributor"
    suffix = hashlib.md5(normalized_name.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:48]}-{suffix}"


def _select_contributor_by_external_id(
    db: Session, authority: str, external_key: str
) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT c.id
            FROM contributor_external_ids cei
            JOIN contributors c ON c.id = cei.contributor_id
            WHERE cei.authority = :authority
              AND cei.external_key = :external_key
              AND c.status IN ('unverified', 'verified')
            LIMIT 1
            """
        ),
        {"authority": authority, "external_key": external_key},
    ).fetchone()
    return row[0] if row is not None else None


def _select_contributor_by_handle(db: Session, handle: str) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT id
            FROM contributors
            WHERE handle = :handle
              AND status IN ('unverified', 'verified')
            """
        ),
        {"handle": handle},
    ).fetchone()
    return row[0] if row is not None else None


def _is_contributor_identity_race(exc: IntegrityError) -> bool:
    return _is_contributor_handle_conflict(exc) or _is_contributor_external_id_conflict(exc)


def _is_contributor_handle_conflict(exc: IntegrityError) -> bool:
    return _resolved_constraint_name(exc) == "uq_contributors_handle"


def _is_contributor_external_id_conflict(exc: IntegrityError) -> bool:
    return _resolved_constraint_name(exc) == "uq_contributor_external_ids_authority_key"


def _resolved_constraint_name(exc: IntegrityError) -> str | None:
    name = integrity_constraint_name(exc)
    if name:
        return name
    message = str(getattr(exc, "orig", None) or exc)
    if "uq_contributors_handle" in message:
        return "uq_contributors_handle"
    if "uq_contributor_external_ids_authority_key" in message:
        return "uq_contributor_external_ids_authority_key"
    return None
