"""The author facade: search, detail, works, references, and every credit write entry point."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from functools import partial
from typing import Literal
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer
from nexus.auth.permissions import (
    can_read_media,
    credited_visible_contributor_ids_cte_sql,
    visible_content_credit_rows_sql,
    visible_contributor_ids_cte_sql,
)
from nexus.db.models import (
    Contributor,
    ContributorAlias,
    ContributorCredit,
    Media,
    ResourceMutation,
)
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    ParsedCollectionQuery,
    parse_collection_query,
)
from nexus.schemas.contributors import (
    ContributorDetailOut,
    ContributorRoleFactOut,
    ContributorSearchItemOut,
    ContributorSearchPageOut,
    ContributorWorkExampleOut,
    ContributorWorkItemOut,
    ExistingAuthorBinding,
    ExternalContributorWorkItemOut,
    ManualMediaAuthorsRequest,
    MediaAuthorsOut,
    MediaAuthorsPutRequest,
    MediaContributorWorkItemOut,
    PodcastContributorWorkItemOut,
    ResourceActionSubjectOut,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services.capabilities import can_edit_media_authors
from nexus.services.collection_keyset import (
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.contributor_credits import load_contributor_credits_for_catalogue
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorHandle,
    ContributorObservation,
    ContributorObservationBatch,
    NotObserved,
    ObservedRoleSlices,
    clean_contributor_display,
    contributor_match_key,
)
from nexus.services.contributor_writes import (
    ContributorObservationRejected,
    CreditTarget,
    MediaTarget,
    ObservationIdentityPlan,
    bump_credit_revisions,
    create_contributor,
    ensure_alias,
    materialize_observation_credits,
    plan_observation_credits,
    planned_contributor_identity,
    replace_role_slices,
)
from nexus.services.keyset_cursor import KeysetValueKind, decode_keyset_cursor, encode_keyset_cursor
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.search.query import decode_cursor, encode_cursor
from nexus.text import escape_like

# One fresh session and one serializable operation per chunk: a 75k-row Gutenberg
# first sync is ~375 transactions, none spanning the source/author boundary.
_BATCH_CHUNK_SIZE = 200


def _works_sql() -> str:
    """One row per (contributor, visible target): the works relation, keyed by ``href``."""
    return f"""
        SELECT
            vcc.contributor_id, vcc.media_id, vcc.podcast_id,
            vcc.project_gutenberg_catalog_ebook_id,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN '/media/' || vcc.media_id::text
                WHEN vcc.podcast_id IS NOT NULL THEN '/podcasts/' || vcc.podcast_id::text
                ELSE 'https://www.gutenberg.org/ebooks/'
                    || vcc.project_gutenberg_catalog_ebook_id::text
            END AS href,
            COALESCE(m.title, p.title, pg.title, '') AS title,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN m.kind
                WHEN vcc.podcast_id IS NOT NULL THEN 'podcast'
                ELSE 'project_gutenberg_ebook'
            END AS content_kind,
            m.original_published_date AS date_key,
            jsonb_agg(
                jsonb_build_object(
                    'credited_name', vcc.credited_name, 'role', vcc.role, 'raw_role', vcc.raw_role
                )
                ORDER BY vcc.ordinal ASC
            ) AS role_facts
        FROM ({visible_content_credit_rows_sql()}) vcc
        LEFT JOIN media m ON m.id = vcc.media_id
        LEFT JOIN podcasts p ON p.id = vcc.podcast_id
        LEFT JOIN project_gutenberg_catalog pg
            ON pg.ebook_id = vcc.project_gutenberg_catalog_ebook_id
        GROUP BY
            vcc.contributor_id, vcc.media_id, vcc.podcast_id,
            vcc.project_gutenberg_catalog_ebook_id,
            m.title, m.kind, m.original_published_date, p.title, pg.title
    """


def search_contributors(
    db: Session, *, viewer_id: UUID, q: str, cursor: str | None = None, limit: int = 20
) -> ContributorSearchPageOut:
    """Picker search: substring match on every alias's key, only people with a visible
    credit, ordered by ``(display key, handle)`` (the display alias row carries both)."""
    q_key = contributor_match_key(q)
    if not q_key:
        return ContributorSearchPageOut(contributors=[], next_cursor=None)
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "pattern": f"%{escape_like(q_key)}%",
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        position = decode_cursor(cursor)
        if set(position) != {"n", "h"} or not all(isinstance(v, str) for v in position.values()):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
        keyset_sql = "AND (da.normalized_alias, c.handle) > (:after_key, :after_handle)"
        params["after_key"], params["after_handle"] = position["n"], position["h"]
    rows = (
        db.execute(
            text(
                f"""
                WITH page AS (
                    SELECT c.id, c.handle, c.display_name, da.normalized_alias AS display_key
                    FROM contributors c
                    JOIN ({credited_visible_contributor_ids_cte_sql()}) cv ON cv.contributor_id = c.id
                    JOIN contributor_aliases da ON da.contributor_id = c.id AND da.alias = c.display_name
                    WHERE EXISTS (
                        SELECT 1 FROM contributor_aliases ca
                        WHERE ca.contributor_id = c.id AND ca.normalized_alias LIKE :pattern ESCAPE '\\'
                    )
                    {keyset_sql}
                    ORDER BY da.normalized_alias ASC, c.handle ASC
                    LIMIT :limit_plus_one
                )
                SELECT page.handle, page.display_name, page.display_key,
                       matched.alias AS matched_alias, stats.work_count, stats.work_examples
                FROM page
                LEFT JOIN LATERAL (
                    SELECT ca.alias FROM contributor_aliases ca
                    WHERE ca.contributor_id = page.id AND ca.alias <> page.display_name
                      AND ca.normalized_alias LIKE :pattern ESCAPE '\\'
                    ORDER BY ca.created_at ASC, ca.id ASC LIMIT 1
                ) matched ON TRUE
                LEFT JOIN LATERAL (
                    SELECT count(*) AS work_count,
                           jsonb_agg(jsonb_build_object('title', r.title, 'href', r.href)
                                     ORDER BY r.rn ASC) FILTER (WHERE r.rn <= 2) AS work_examples
                    FROM (
                        SELECT w.title, w.href,
                               row_number() OVER (
                                   ORDER BY w.date_key DESC NULLS LAST, w.title ASC, w.href ASC
                               ) AS rn
                        FROM ({_works_sql()}) w
                        WHERE w.contributor_id = page.id
                    ) r
                ) stats ON TRUE
                ORDER BY page.display_key ASC, page.handle ASC
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    page = rows[:limit]
    return ContributorSearchPageOut(
        contributors=[
            ContributorSearchItemOut(
                handle=row["handle"],
                href=f"/authors/{row['handle']}",
                display_name=row["display_name"],
                work_count=int(row["work_count"]),
                work_examples=[ContributorWorkExampleOut(**e) for e in row["work_examples"] or []],
                # The canonical name did not match: surface the alias that did.
                matched_alias=None if q_key in row["display_key"] else row["matched_alias"],
            )
            for row in page
        ],
        next_cursor=encode_cursor({"n": page[-1]["display_key"], "h": page[-1]["handle"]})
        if len(rows) > limit
        else None,
    )


def get_contributor_detail(
    db: Session, *, viewer_id: UUID, contributor_handle: ContributorHandle
) -> ContributorDetailOut:
    """The author pane header, under broad visibility."""
    contributor = _visible_contributor(db, contributor_handle, viewer_id)
    other_names = db.scalars(
        select(ContributorAlias.alias)
        .where(
            ContributorAlias.contributor_id == contributor.id,
            ContributorAlias.alias != contributor.display_name,
        )
        .order_by(ContributorAlias.alias.asc())
    )
    return ContributorDetailOut(
        handle=contributor.handle,
        href=f"/authors/{contributor.handle}",
        display_name=contributor.display_name,
        other_names=list(other_names),
        action_subject=ResourceActionSubjectOut(
            ref=ResourceRef(scheme="contributor", id=contributor.id).uri
        ),
    )


# A new family rejects every cursor minted under earlier works semantics.
_WORKS_CURSOR_FAMILY = f"{CollectionFamily.AuthorWorks.value}:v3"
_DATE_MISSING = SortKey("date_missing", "asc", KeysetValueKind.Int)  # undated last, both ways
_HREF = SortKey("href", "asc", KeysetValueKind.Text)  # the relation's unique key: plans are total

# The four views, keyed by the raw (sort, direction) pair. Both absent is oldest-first;
# ``published+asc`` is rejected, so every view has exactly one url. Each plan is hashed
# into its cursors: changing one invalidates its outstanding cursors.
_WORKS_PLANS: dict[tuple[str | None, str | None], list[SortKey]] = {
    (None, None): [
        _DATE_MISSING,
        SortKey("date_key", "asc", KeysetValueKind.TextOrNull),
        SortKey("title", "asc", KeysetValueKind.Text),
        _HREF,
    ],
    ("published", "desc"): [
        _DATE_MISSING,
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        SortKey("title", "asc", KeysetValueKind.Text),
        _HREF,
    ],
    ("title", "asc"): [
        SortKey("title_key", "asc", KeysetValueKind.Text),
        SortKey("title", "asc", KeysetValueKind.Text),
        _DATE_MISSING,
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        _HREF,
    ],
    ("title", "desc"): [
        SortKey("title_key", "desc", KeysetValueKind.Text),
        SortKey("title", "desc", KeysetValueKind.Text),
        _DATE_MISSING,
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        _HREF,
    ],
}


def parse_contributor_works_query(
    items: Sequence[tuple[str, str]],
) -> tuple[list[SortKey], ParsedCollectionQuery]:
    """Strict works-view parse over ``multi_items()``, so duplicate keys are visible."""
    query = parse_collection_query(items, domain_keys={"sort", "direction"})
    plan = _WORKS_PLANS.get((query.parameters.get("sort"), query.parameters.get("direction")))
    if plan is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported author works view")
    return plan, query


def list_contributor_works(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: ContributorHandle,
    plan: list[SortKey],
    cursor: CollectionCursor | None = None,
    collection_revision: CollectionRevision | None = None,
    limit: int = 100,
) -> CollectionPage[ContributorWorkItemOut]:
    """Distinct visible works with their role facts, in one total order.

    The ``facts`` wrapper projects the derived sort columns once, so ORDER BY, the keyset
    and the cursor read identical expressions. A cursor is bound to this viewer, author,
    plan and AuthorWorks revision.
    """
    from nexus.services.media import list_collection_media_for_viewer_by_ids

    contributor = _visible_contributor(db, contributor_handle, viewer_id)
    family = CollectionFamily.AuthorWorks
    revision = (
        read_collection_revision(db, viewer_id=viewer_id, family=family)
        if collection_revision is None
        else collection_revision
    )
    cursor_query = {
        "contributorHandle": contributor_handle,
        "family": _WORKS_CURSOR_FAMILY,
        "plan": plan_json(plan),
        "revision": revision,
        "viewerId": str(viewer_id),
    }
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "contributor_id": contributor.id,
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        # The cursor's own binding first: a cursor issued to another viewer, author, view
        # or revision is invalid whatever the collection did; then a moved one is a 409.
        after = decode_keyset_cursor(
            cursor,
            family=_WORKS_CURSOR_FAMILY,
            query=cursor_query,
            expected_kinds=expected_kinds(plan),
        )
        require_collection_revision(db, viewer_id=viewer_id, family=family, expected=revision)
        keyset_sql = keyset_clause(plan, alias="facts")
        params.update(keyset_params(plan, after))
    rows = (
        db.execute(
            text(
                f"""
                WITH facts AS (
                    SELECT w.*, (w.date_key IS NULL)::int AS date_missing,
                           lower(btrim(w.title)) AS title_key
                    FROM ({_works_sql()}) w
                    WHERE w.contributor_id = :contributor_id
                )
                SELECT * FROM facts
                WHERE TRUE {keyset_sql}
                ORDER BY {order_by_sql(plan, alias="facts")}
                LIMIT :limit_plus_one
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    page = rows[:limit]
    summaries = {
        item.id: item.summary
        for item in list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=[r["media_id"] for r in page if r["media_id"]]
        )
    }
    catalogue = load_contributor_credits_for_catalogue(
        db,
        [
            r["project_gutenberg_catalog_ebook_id"]
            for r in page
            if r["media_id"] is None and r["podcast_id"] is None
        ],
    )
    items: list[ContributorWorkItemOut] = []
    for row in page:
        facts = [ContributorRoleFactOut(**fact) for fact in row["role_facts"]]
        if row["media_id"] is not None:
            items.append(
                MediaContributorWorkItemOut(
                    media_summary=summaries[row["media_id"]],
                    href=row["href"],
                    role_facts=facts,
                    action_subject=_subject("media", row["media_id"]),
                )
            )
        elif row["podcast_id"] is not None:
            items.append(
                PodcastContributorWorkItemOut(
                    title=row["title"],
                    href=row["href"],
                    content_kind=row["content_kind"],
                    role_facts=facts,
                    action_subject=_subject("podcast", row["podcast_id"]),
                )
            )
        else:
            items.append(
                ExternalContributorWorkItemOut(
                    title=row["title"],
                    href=row["href"],
                    content_kind=row["content_kind"],
                    contributors=catalogue.get(row["project_gutenberg_catalog_ebook_id"], []),
                    role_facts=facts,
                )
            )
    next_cursor = (
        present(
            encode_keyset_cursor(
                family=_WORKS_CURSOR_FAMILY, query=cursor_query, after=after_values(plan, page[-1])
            )
        )
        if len(rows) > limit
        else absent()
    )
    return CollectionPage[ContributorWorkItemOut](
        items=items, collectionRevision=revision, nextCursor=next_cursor
    )


def _subject(scheme: Literal["media", "podcast"], target_id: UUID) -> ResourceActionSubjectOut:
    return ResourceActionSubjectOut(ref=ResourceRef(scheme=scheme, id=target_id).uri)


def resolve_contributor_ref_by_handle(
    db: Session, *, viewer_id: UUID, contributor_handle: str
) -> ResourceRef:
    contributor = _visible_contributor(db, contributor_handle, viewer_id)
    return ResourceRef(scheme="contributor", id=contributor.id)


def resolve_contributor_ids_by_handles(db: Session, handles: Sequence[str]) -> dict[str, UUID]:
    """Map handles to contributor ids, dropping unknown ones, in first-seen input order."""
    wanted = list(dict.fromkeys(handles))
    rows = db.execute(
        select(Contributor.handle, Contributor.id).where(Contributor.handle.in_(wanted))
    ).tuples()
    found = {handle: contributor_id for handle, contributor_id in rows}
    return {handle: found[handle] for handle in wanted if handle in found}


def _visible_contributor(db: Session, handle: str, viewer_id: UUID) -> Contributor:
    """Unknown and invisible are one answer: 404."""
    contributor = db.scalar(select(Contributor).where(Contributor.handle == handle))
    if contributor is None or not _visible(db, contributor.id, viewer_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _visible(db: Session, contributor_id: UUID, viewer_id: UUID) -> bool:
    """Broad visibility: a visible credit or a viewer-owned graph edge."""
    sql = f"SELECT 1 FROM ({visible_contributor_ids_cte_sql()}) v WHERE v.contributor_id = :cid"
    params = {"viewer_id": viewer_id, "cid": contributor_id}
    return db.execute(text(sql + " LIMIT 1"), params).first() is not None


@dataclass(frozen=True, slots=True)
class ContributorPublicationResult:
    changed: bool
    retained_manual_authors: bool


@dataclass(frozen=True, slots=True)
class PreparedContributorPublication:
    target: CreditTarget
    managed_roles: frozenset[str]
    identities: ObservationIdentityPlan
    source: str
    retained_manual_authors: bool


def replace_observed_role_slices_batch(
    items: Sequence[tuple[CreditTarget, ContributorObservationBatch, str]],
) -> None:
    """Publish automatic observations in chunks, one fresh committed transaction each.

    ``NOT_OBSERVED`` targets are dropped before any session opens and never erase credits.
    """
    observed = [item for item in items if isinstance(item[1], ObservedRoleSlices)]
    for start in range(0, len(observed), _BATCH_CHUNK_SIZE):
        chunk = observed[start : start + _BATCH_CHUNK_SIZE]
        db = get_session_factory()()
        try:
            retry_serializable(
                db, "replace_observed_role_slices_batch", partial(_publish_chunk, db, chunk)
            )
        finally:
            db.close()


def _publish_chunk(
    db: Session, chunk: Sequence[tuple[CreditTarget, ContributorObservationBatch, str]]
) -> None:
    changed = [
        target
        for target, observation, source in chunk
        if _write(
            db,
            prepare_observed_role_slices_in_current_transaction(
                db, target=target, observation=observation, source=source
            ),
        )
    ]
    if changed:
        bump_credit_revisions(db, changed)
    db.commit()


def apply_observed_role_slices_in_current_transaction(
    db: Session, *, target: CreditTarget, observation: ContributorObservationBatch, source: str
) -> ContributorPublicationResult:
    """Prepare and apply one observation on the owning source transaction (no retry runner)."""
    prepared = prepare_observed_role_slices_in_current_transaction(
        db, target=target, observation=observation, source=source
    )
    return apply_prepared_role_slices_in_current_transaction(db, prepared=prepared)


def prepare_observed_role_slices_in_current_transaction(
    db: Session, *, target: CreditTarget, observation: ContributorObservationBatch, source: str
) -> PreparedContributorPublication:
    """Validate the whole roster read-only, before the owner writes any fact.

    A pinned media withholds its author slice: the proposal still takes part in
    validation and in ``retained_manual_authors``, but never in allocation, and the
    other roles are re-planned without it so withheld keys and spellings cannot shape
    their identities.
    """
    nothing = PreparedContributorPublication(
        target, frozenset(), ObservationIdentityPlan((), (), ()), source, False
    )
    if isinstance(observation, NotObserved):
        return nothing
    managed_roles = observation.managed_roles
    pinned = False
    current_authors: list[tuple[UUID, str, str | None]] = []
    if isinstance(target, MediaTarget):
        media = db.get(Media, target.media_id)
        if media is None:
            return nothing
        pinned = media.authors_manually_managed
        credited = db.execute(
            select(ContributorCredit, Contributor.handle)
            .join(Contributor, Contributor.id == ContributorCredit.contributor_id)
            .where(ContributorCredit.media_id == target.media_id)
            .order_by(ContributorCredit.ordinal)
        ).all()
        handles = {handle for _, handle in credited}
        if any(
            isinstance(c.contributor_handle, Present) and c.contributor_handle.value not in handles
            for c in observation.credits
        ):
            raise ContributorObservationRejected(
                "A bound contributor is not credited on this media"
            )
        current_authors = [
            (row.contributor_id, row.credited_name, row.raw_role)
            for row, _ in credited
            if row.role == "author"
        ]
    plan = plan_observation_credits(db, observation.credits)
    planned = list(zip(plan.identities, plan.credits, strict=True))
    if source == "metadata_enrichment" and len(
        {(planned_contributor_identity(p), c.role) for p, c in planned}
    ) != len(planned):
        raise ContributorObservationRejected("Duplicate contributor identity within a role")
    retained = False
    if pinned:
        if "author" in managed_roles:
            proposed = [
                (planned_contributor_identity(p), c.credited_name, c.raw_role)
                for p, c in planned
                if c.role == "author"
            ]
            retained = proposed != current_authors
        managed_roles = managed_roles - {"author"}
    relevant = [c for c in observation.credits if c.role in managed_roles]
    if len(relevant) != len(plan.credits):
        plan = plan_observation_credits(db, relevant)
    return PreparedContributorPublication(target, managed_roles, plan, source, retained)


def apply_prepared_role_slices_in_current_transaction(
    db: Session, *, prepared: PreparedContributorPublication
) -> ContributorPublicationResult:
    """Write a prevalidated roster; no late rejection, no savepoint."""
    changed = _write(db, prepared)
    if changed:
        bump_credit_revisions(db, [prepared.target])
    return ContributorPublicationResult(changed, prepared.retained_manual_authors)


def _write(db: Session, prepared: PreparedContributorPublication) -> bool:
    if not prepared.managed_roles:
        return False
    resolved = materialize_observation_credits(db, plan=prepared.identities)
    pairs = list(zip(resolved, prepared.identities.credits, strict=True))
    changed = replace_role_slices(
        db,
        target=prepared.target,
        managed_roles=prepared.managed_roles,
        resolved=[(person.contributor_id, credit) for person, credit in pairs],
        source=prepared.source,
    )
    if changed:
        for person, credit in pairs:
            if not isinstance(credit.contributor_handle, Present):
                ensure_alias(
                    db,
                    contributor_id=person.contributor_id,
                    alias=person.display_name,
                    resolves_identity=True,
                )
            # Observed spellings are searchable but never resolve identity.
            ensure_alias(
                db,
                contributor_id=person.contributor_id,
                alias=credit.credited_name,
                resolves_identity=False,
            )
    return changed


def cleanup_credits_for_deleted_target(db: Session, *, target: CreditTarget) -> None:
    """Drop a deleted target's credits and author-edit memos, on the caller's transaction."""
    if replace_role_slices(
        db,
        target=target,
        managed_roles=frozenset(CONTRIBUTOR_ROLES_ORDERED),
        resolved=(),
        source="cleanup",
    ):
        bump_credit_revisions(db, [target])
    if isinstance(target, MediaTarget):
        scope = f"media:{target.media_id}:authors"
        db.execute(delete(ResourceMutation).where(ResourceMutation.mutation_scope == scope))


def put_media_authors(
    *, viewer: Viewer, media_id: UUID, request: MediaAuthorsPutRequest
) -> MediaAuthorsOut:
    """Pin a manual author list, or release the pin; replayable, in one fresh transaction."""
    db = get_session_factory()()
    try:
        op = partial(_put_media_authors, db, viewer.user_id, media_id, request)
        return retry_serializable(db, "put_media_authors", op)
    finally:
        db.close()


def _put_media_authors(
    db: Session, viewer_id: UUID, media_id: UUID, request: MediaAuthorsPutRequest
) -> MediaAuthorsOut:
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if not can_edit_media_authors(can_read=True, is_creator=media.created_by_user_id == viewer_id):
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Only the media creator can edit authors")
    scope = f"media:{media_id}:authors"
    mutation_id = request.client_mutation_id
    # Hashed by field name, not wire alias: the memo is keyed to the request's meaning.
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=False))
    stored = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        # Every memo, old or new, carries authorMode.
        return MediaAuthorsOut.model_validate({"authorMode": stored["authorMode"]})
    target = MediaTarget(media_id)
    if isinstance(request, ManualMediaAuthorsRequest) and replace_role_slices(
        db,
        target=target,
        managed_roles=frozenset({"author"}),
        resolved=_bind_manual_authors(db, viewer_id, request),
        source="user",
    ):
        bump_credit_revisions(db, [target])
    # Releasing the pin leaves the rows; the next observed author slice replaces them.
    media.authors_manually_managed = request.mode == "manual"
    response = MediaAuthorsOut(author_mode=request.mode)
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
    )
    db.commit()
    return response


def _bind_manual_authors(
    db: Session, viewer_id: UUID, request: ManualMediaAuthorsRequest
) -> list[tuple[UUID, ContributorObservation]]:
    rows: list[tuple[UUID, ContributorObservation]] = []
    for row in request.authors:
        if isinstance(row.binding, ExistingAuthorBinding):
            handle = row.binding.contributor_handle
            found = db.scalar(select(Contributor.id).where(Contributor.handle == handle))
            if found is None or not _visible(db, found, viewer_id):
                # One answer for unknown and invisible: selection never reveals a person.
                raise ApiError(
                    ApiErrorCode.E_AUTHOR_NOT_SELECTABLE, "That author can't be selected."
                )
            contributor_id = found
        else:
            display = clean_contributor_display(row.binding.display_name)
            contributor_id = create_contributor(db, display_name=display).contributor_id
        if any(contributor_id == listed for listed, _ in rows):
            raise ApiError(
                ApiErrorCode.E_AUTHOR_ALREADY_LISTED, "That author is already listed for this role."
            )
        credited = clean_contributor_display(row.credited_name)
        rows.append((contributor_id, ContributorObservation(credited, "author", None, None)))
    return rows
