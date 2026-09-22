"""The public author facade: search, detail, works, and the four write entry points."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from functools import partial
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer
from nexus.auth.permissions import (
    can_read_media,
    credited_visible_contributor_ids_cte_sql,
    visible_contributor_ids_cte_sql,
)
from nexus.db.models import Contributor, ContributorAlias, Media, ResourceMutation
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
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
    ManualMediaAuthorsRequest,
    MediaAuthorCreditOut,
    MediaAuthorsOut,
    MediaAuthorsPutRequest,
    ResourceActionSubjectOut,
)
from nexus.schemas.presence import absent, present
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
    bump_all_collection_revisions,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.contributor_credits import distinct_visible_works_sql
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorHandle,
    ContributorObservation,
    ContributorObservationBatch,
    ContributorRole,
    ManualDistinctSeed,
    NotObserved,
    ObservedRoleSlices,
    clean_contributor_display,
    contributor_handle_candidates,
    contributor_match_key,
)
from nexus.services.contributor_writes import (
    CreditTarget,
    MediaTarget,
    ResolvedCredit,
    create_contributor,
    ensure_alias,
    replace_role_slices,
    resolve_observation_credits,
    set_media_author_mode,
)
from nexus.services.keyset_cursor import KeysetValueKind, decode_keyset_cursor, encode_keyset_cursor
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.text import escape_like

# One fresh session and one serializable operation per chunk of targets: a 75k-row
# Gutenberg first sync is ~375 transactions, none spanning the source/author boundary.
_BATCH_CHUNK_SIZE = 200


def search_contributors(
    db: Session,
    *,
    viewer_id: UUID,
    q: str,
    cursor: str | None = None,
    limit: int = 20,
) -> ContributorSearchPageOut:
    """Picker search: substring match on the normalized form of every alias.

    Only contributors with a visible credit appear. Ordering is
    ``(match_key(display_name), handle)``, which the display alias row carries verbatim,
    so it is SQL-computable for the keyset.
    """
    q_key = contributor_match_key(q)
    if not q_key:
        return ContributorSearchPageOut(contributors=[], nextCursor=None)

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "pattern": f"%{escape_like(q_key)}%",
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        decoded = _decode_search_cursor(cursor)
        keyset_sql = "AND (da.normalized_alias, c.handle) > (:after_key, :after_handle)"
        params["after_key"], params["after_handle"] = decoded

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
                        FROM ({distinct_visible_works_sql()}) w
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
    next_cursor = None
    if len(rows) > limit and page:
        next_cursor = _encode_search_cursor(page[-1]["display_key"], page[-1]["handle"])
    return ContributorSearchPageOut(
        contributors=[
            ContributorSearchItemOut(
                handle=row["handle"],
                href=f"/authors/{row['handle']}",
                displayName=row["display_name"],
                workCount=int(row["work_count"]),
                workExamples=[
                    ContributorWorkExampleOut(title=example["title"], href=example["href"])
                    for example in (row["work_examples"] or [])
                ],
                # The canonical name did not match; surface the alias that did.
                matchedAlias=None if q_key in row["display_key"] else row["matched_alias"],
            )
            for row in page
        ],
        nextCursor=next_cursor,
    )


def _encode_search_cursor(display_key: str, handle: str) -> str:
    payload = json.dumps({"n": display_key, "h": handle}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_search_cursor(cursor: str) -> tuple[str, str]:
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except ValueError:
        raise InvalidRequestError(message="Invalid cursor") from None
    if not isinstance(decoded, dict) or set(decoded) != {"n", "h"}:
        raise InvalidRequestError(message="Invalid cursor")
    after_key, after_handle = decoded["n"], decoded["h"]
    if not isinstance(after_key, str) or not isinstance(after_handle, str):
        raise InvalidRequestError(message="Invalid cursor")
    return after_key, after_handle


def get_contributor_detail(
    db: Session, *, viewer_id: UUID, contributor_handle: ContributorHandle
) -> ContributorDetailOut:
    """The author pane header, under broad visibility."""
    contributor = _load_visible_contributor_by_handle(db, str(contributor_handle), viewer_id)
    other_names = list(
        db.scalars(
            select(ContributorAlias.alias)
            .where(
                ContributorAlias.contributor_id == contributor.id,
                ContributorAlias.alias != contributor.display_name,
            )
            .order_by(ContributorAlias.alias.asc())
        )
    )
    return ContributorDetailOut(
        handle=contributor.handle,
        href=f"/authors/{contributor.handle}",
        displayName=contributor.display_name,
        otherNames=other_names,
        canRename=False,
        actionSubject=ResourceActionSubjectOut(
            ref=ResourceRef(scheme="contributor", id=contributor.id).uri
        ),
    )


# The date source changed even for cursors whose title-order plan hash did not.
# A new family rejects every cursor minted under the previous semantics.
_WORKS_CURSOR_FAMILY = f"{CollectionFamily.AuthorWorks.value}:v3"

# The four advertised views and their total sort-key plans, keyed by the raw
# ``(sort, direction)`` query pair; both absent is oldest-first and ``published+asc``
# is rejected rather than normalized, so each view keeps exactly one URL.
# ``date_missing`` is always ASC (undated works last in both directions) and ``href``
# is the works relation's unique key, which makes every plan total. Each list is hashed
# into the signed cursor: reordering one invalidates every outstanding cursor.
_WORKS_PLANS: dict[tuple[str | None, str | None], list[SortKey]] = {
    (None, None): [
        SortKey("date_missing", "asc", KeysetValueKind.Int),
        SortKey("date_key", "asc", KeysetValueKind.TextOrNull),
        SortKey("title", "asc", KeysetValueKind.Text),
        SortKey("href", "asc", KeysetValueKind.Text),
    ],
    ("published", "desc"): [
        SortKey("date_missing", "asc", KeysetValueKind.Int),
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        SortKey("title", "asc", KeysetValueKind.Text),
        SortKey("href", "asc", KeysetValueKind.Text),
    ],
    ("title", "asc"): [
        SortKey("title_key", "asc", KeysetValueKind.Text),
        SortKey("title", "asc", KeysetValueKind.Text),
        SortKey("date_missing", "asc", KeysetValueKind.Int),
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        SortKey("href", "asc", KeysetValueKind.Text),
    ],
    ("title", "desc"): [
        SortKey("title_key", "desc", KeysetValueKind.Text),
        SortKey("title", "desc", KeysetValueKind.Text),
        SortKey("date_missing", "asc", KeysetValueKind.Int),
        SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
        SortKey("href", "asc", KeysetValueKind.Text),
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
    """Distinct visible works with nested role facts, in the requested total order.

    The ``facts`` wrapper projects the derived sort columns once so ORDER BY, the keyset
    and the cursor read identical expressions; the returned cursor is bound to this
    exact viewer, author, plan and revision.
    """
    contributor = _load_visible_contributor_by_handle(db, str(contributor_handle), viewer_id)
    current_revision = (
        read_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.AuthorWorks)
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.AuthorWorks,
            expected=collection_revision,
        )
    )
    cursor_query = {
        "contributorHandle": str(contributor_handle),
        "family": _WORKS_CURSOR_FAMILY,
        "plan": plan_json(plan),
        "revision": current_revision,
        "viewerId": str(viewer_id),
    }

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "contributor_id": contributor.id,
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias="facts")
        params.update(
            keyset_params(
                plan,
                decode_keyset_cursor(
                    cursor,
                    family=_WORKS_CURSOR_FAMILY,
                    query=cursor_query,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )

    rows = (
        db.execute(
            text(
                f"""
                WITH works AS ({distinct_visible_works_sql()}),
                facts AS (
                    SELECT w.*, (w.date_key IS NULL)::int AS date_missing,
                           lower(btrim(w.title)) AS title_key
                    FROM works w
                    WHERE w.contributor_id = :contributor_id
                )
                SELECT facts.title, facts.href, facts.content_kind, facts.date_key,
                       facts.date_missing, facts.title_key, facts.role_facts,
                       facts.media_id, facts.podcast_id,
                       facts.project_gutenberg_catalog_ebook_id
                FROM facts
                WHERE 1 = 1
                  {keyset_sql}
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
    next_cursor: CollectionCursor | None = None
    if len(rows) > limit and page:
        next_cursor = encode_keyset_cursor(
            family=_WORKS_CURSOR_FAMILY,
            query=cursor_query,
            after=after_values(plan, page[-1]),
        )
    return CollectionPage[ContributorWorkItemOut](
        items=[
            ContributorWorkItemOut(
                title=row["title"],
                href=row["href"],
                contentKind=row["content_kind"],
                date=row["date_key"],
                roleFacts=[
                    ContributorRoleFactOut(
                        creditedName=fact["credited_name"],
                        role=cast(ContributorRole, fact["role"]),
                        rawRole=fact["raw_role"],
                    )
                    for fact in row["role_facts"]
                ],
                actionSubject=_work_action_subject(row),
            )
            for row in page
        ],
        collectionRevision=current_revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )


def _work_action_subject(row: Mapping[Any, Any]) -> ResourceActionSubjectOut | None:
    """Gutenberg ebooks are not Nexus resources and carry no action subject."""
    if row["media_id"] is not None:
        ref = ResourceRef(scheme="media", id=UUID(str(row["media_id"])))
    elif row["podcast_id"] is not None:
        ref = ResourceRef(scheme="podcast", id=UUID(str(row["podcast_id"])))
    else:
        return None
    return ResourceActionSubjectOut(ref=ref.uri)


def resolve_contributor_ref_by_handle(
    db: Session, *, viewer_id: UUID, contributor_handle: str
) -> ResourceRef:
    contributor = _load_visible_contributor_by_handle(db, contributor_handle, viewer_id)
    return ResourceRef(scheme="contributor", id=contributor.id)


def resolve_contributor_ids_by_handles(db: Session, handles: Sequence[str]) -> dict[str, UUID]:
    """Map handles to contributor ids, dropping unknown ones, in first-seen input order."""
    unique_handles = list(dict.fromkeys(handles))
    if not unique_handles:
        return {}
    found = {
        handle: contributor_id
        for handle, contributor_id in db.execute(
            select(Contributor.handle, Contributor.id).where(Contributor.handle.in_(unique_handles))
        ).tuples()
    }
    return {handle: found[handle] for handle in unique_handles if handle in found}


def _load_visible_contributor_by_handle(
    db: Session, contributor_handle: str, viewer_id: UUID
) -> Contributor:
    contributor = db.scalar(select(Contributor).where(Contributor.handle == contributor_handle))
    if contributor is None or not _contributor_visible(db, contributor.id, viewer_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _contributor_visible(db: Session, contributor_id: UUID, viewer_id: UUID) -> bool:
    """Broad visibility: a visible credit or a viewer-owned graph edge."""
    sql = f"SELECT 1 FROM ({visible_contributor_ids_cte_sql()}) v WHERE v.contributor_id = :cid"
    params = {"viewer_id": viewer_id, "cid": contributor_id}
    return db.execute(text(sql + " LIMIT 1"), params).first() is not None


def replace_observed_role_slices_batch(
    items: Sequence[tuple[CreditTarget, ContributorObservationBatch, str]],
) -> None:
    """Apply automatic observations in chunks, one fresh transaction per chunk.

    ``NOT_OBSERVED`` targets are dropped before any session opens and never erase prior
    credits. Nothing is memoized: a stable job key may legitimately observe different
    authors later, and background lanes have no user.
    """
    observed = [
        (target, observation, source)
        for target, observation, source in items
        if isinstance(observation, ObservedRoleSlices)
    ]
    for start in range(0, len(observed), _BATCH_CHUNK_SIZE):
        chunk = observed[start : start + _BATCH_CHUNK_SIZE]
        fresh = get_session_factory()()
        try:
            retry_serializable(
                fresh,
                "replace_observed_role_slices_batch",
                partial(_run_observations_op, fresh, chunk),
            )
        finally:
            fresh.close()


def _run_observations_op(
    db: Session, items: Sequence[tuple[CreditTarget, ObservedRoleSlices, str]]
) -> None:
    for target, observation, source in items:
        _apply_observation(db, target=target, observation=observation, source=source)
    _bump_contributor_collection_revisions(db)
    db.commit()


def apply_observed_role_slices_in_current_transaction(
    db: Session, *, target: CreditTarget, observation: ContributorObservationBatch, source: str
) -> None:
    """Apply one automatic observation inside an owning source transaction.

    Source publication needs its credits to commit with the facts they describe, so this
    entry point runs on the caller's transaction and starts no retry runner.
    """
    if isinstance(observation, NotObserved):
        return
    _apply_observation(db, target=target, observation=observation, source=source)


def _apply_observation(
    db: Session, *, target: CreditTarget, observation: ObservedRoleSlices, source: str
) -> None:
    managed_roles = observation.managed_roles
    if isinstance(target, MediaTarget):
        # select, not Session.get: get() raises ObjectDeletedError on a retry attempt
        # when the expired identity-map row was deleted concurrently.
        media = db.scalar(select(Media).where(Media.id == target.media_id))
        if media is None:
            return  # target deleted mid-flight; nothing to credit
        if media.authors_manually_managed:
            # The pin freezes only the author slice; other declared slices replace.
            managed_roles = managed_roles - {"author"}
    if not managed_roles:
        return
    relevant = [credit for credit in observation.credits if credit.role in managed_roles]
    resolved = resolve_observation_credits(db, relevant)
    replace_role_slices(
        db,
        target=target,
        managed_roles=managed_roles,
        resolved=list(zip(resolved, relevant, strict=True)),
        source=source,
    )


def cleanup_credits_for_deleted_target(db: Session, *, target: CreditTarget) -> None:
    """Drop a deleted target's credits and its author-edit memos, on the caller's transaction."""
    replace_role_slices(
        db,
        target=target,
        managed_roles=frozenset(CONTRIBUTOR_ROLES_ORDERED),
        resolved=(),
        source="cleanup",
    )
    if isinstance(target, MediaTarget):
        db.execute(
            delete(ResourceMutation).where(
                ResourceMutation.mutation_scope == f"media:{target.media_id}:authors"
            )
        )
    _bump_contributor_collection_revisions(db)


def _bump_contributor_collection_revisions(db: Session) -> None:
    for family in (
        CollectionFamily.AuthorWorks,
        CollectionFamily.LibraryEntries,
        CollectionFamily.PodcastSubscriptions,
        CollectionFamily.PodcastEpisodes,
    ):
        bump_all_collection_revisions(db, family=family)


def put_media_authors(
    *, viewer: Viewer, media_id: UUID, request: MediaAuthorsPutRequest
) -> MediaAuthorsOut:
    """Replayable manual author-slice PUT / automatic reset, in one fresh transaction."""
    fresh = get_session_factory()()
    try:
        return retry_serializable(
            fresh,
            "put_media_authors",
            partial(_put_media_authors_op, fresh, viewer, media_id, request),
        )
    finally:
        fresh.close()


def _put_media_authors_op(
    db: Session, viewer: Viewer, media_id: UUID, request: MediaAuthorsPutRequest
) -> MediaAuthorsOut:
    media = db.scalar(select(Media).where(Media.id == media_id))
    if media is None or not can_read_media(db, viewer.user_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if not can_edit_media_authors(
        can_read=True, is_creator=media.created_by_user_id == viewer.user_id
    ):
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Only the media creator can edit authors")

    scope = f"media:{media_id}:authors"
    # Alias-free hash basis, deliberately unlike other scopes: the memo is keyed to the
    # request's meaning, so a wire-alias rename never masquerades as a different mutation.
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=False))
    stored = lookup_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        return MediaAuthorsOut.model_validate(stored)

    if isinstance(request, ManualMediaAuthorsRequest):
        replace_role_slices(
            db,
            target=MediaTarget(media_id),
            managed_roles=frozenset({"author"}),
            resolved=_bind_manual_author_rows(
                db, viewer=viewer, media_id=media_id, request=request
            ),
            source="user",
        )
        set_media_author_mode(db, media_id=media_id, manual=True)
        author_mode: Literal["automatic", "manual"] = "manual"
    else:
        # Reset: release the pin and leave the current rows in place; the next observed
        # author slice replaces them.
        set_media_author_mode(db, media_id=media_id, manual=False)
        author_mode = "automatic"

    response = _media_authors_out(db, media_id=media_id, author_mode=author_mode)
    record_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
    )
    _bump_contributor_collection_revisions(db)
    db.commit()
    return response


def _bind_manual_author_rows(
    db: Session, *, viewer: Viewer, media_id: UUID, request: ManualMediaAuthorsRequest
) -> list[tuple[ResolvedCredit, ContributorObservation]]:
    rows: list[tuple[ResolvedCredit, ContributorObservation]] = []
    bound_ids: set[UUID] = set()
    for row_index, row in enumerate(request.authors):
        if isinstance(row.binding, ExistingAuthorBinding):
            resolved = _load_selectable_author(
                db, viewer_id=viewer.user_id, handle=row.binding.contributor_handle
            )
        else:
            resolved = _create_manual_author(
                db,
                viewer=viewer,
                media_id=media_id,
                client_mutation_id=request.client_mutation_id,
                row_index=row_index,
                display_name=row.binding.display_name,
            )
        if resolved.contributor_id in bound_ids:
            raise ApiError(
                ApiErrorCode.E_AUTHOR_ALREADY_LISTED,
                "That author is already listed for this role.",
            )
        bound_ids.add(resolved.contributor_id)
        observation = ContributorObservation(
            credited_name=clean_contributor_display(row.credited_name),
            role="author",
            raw_role=None,
            identity_key=None,
        )
        rows.append((resolved, observation))
    return rows


def _load_selectable_author(db: Session, *, viewer_id: UUID, handle: str) -> ResolvedCredit:
    contributor = db.scalar(select(Contributor).where(Contributor.handle == handle))
    if contributor is None or not _contributor_visible(db, contributor.id, viewer_id):
        # One message for unknown and invisible: selection never reveals a hidden record.
        raise ApiError(ApiErrorCode.E_AUTHOR_NOT_SELECTABLE, "That author can't be selected.")
    return ResolvedCredit(contributor.id, contributor.handle, contributor.display_name)


def _create_manual_author(
    db: Session,
    *,
    viewer: Viewer,
    media_id: UUID,
    client_mutation_id: str,
    row_index: int,
    display_name: str,
) -> ResolvedCredit:
    """Create an explicitly new author.

    With no same-name resolving owner and a free base handle this is an ordinary create
    that future automatic observations will find; otherwise it is a deliberately distinct
    identity, seeded so a whole-operation retry converges on the same handle.
    """
    display = clean_contributor_display(display_name)
    base_handle = next(iter(contributor_handle_candidates(display)))
    collides = db.scalar(
        text(
            """
            SELECT EXISTS (SELECT 1 FROM contributors WHERE handle = :handle)
                OR EXISTS (
                    SELECT 1 FROM contributor_aliases
                    WHERE normalized_alias = :match_key AND resolves_identity
                )
            """
        ),
        {"handle": base_handle, "match_key": contributor_match_key(display)},
    )
    seed = (
        ManualDistinctSeed(
            user_id=str(viewer.user_id),
            media_id=str(media_id),
            client_mutation_id=client_mutation_id,
            row_index=row_index,
        )
        if collides
        else None
    )
    created = create_contributor(db, display_name=display, distinct_seed=seed)
    # Every canonical display owns a resolving alias.
    ensure_alias(db, contributor_id=created.contributor_id, alias=display, resolves_identity=True)
    return created


def _media_authors_out(
    db: Session, *, media_id: UUID, author_mode: Literal["automatic", "manual"]
) -> MediaAuthorsOut:
    rows = db.execute(
        text(
            """
            SELECT c.handle, c.display_name, cc.credited_name
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id AND cc.role = 'author'
            ORDER BY cc.ordinal ASC
            """
        ),
        {"media_id": media_id},
    ).all()
    return MediaAuthorsOut(
        authorMode=author_mode,
        authors=[
            MediaAuthorCreditOut(
                contributorHandle=handle,
                href=f"/authors/{handle}",
                displayName=display_name,
                creditedName=credited_name,
            )
            for handle, display_name, credited_name in rows
        ],
        # True by construction: the PUT already authorized this viewer.
        canEditAuthors=True,
    )


def ensure_contributor_display_name(
    *, viewer: Viewer, contributor_handle: ContributorHandle
) -> ContributorDetailOut:
    """Rename an author: 404 an invisible handle, then refuse — no principal may rename."""
    fresh = get_session_factory()()
    try:
        _load_visible_contributor_by_handle(fresh, str(contributor_handle), viewer.user_id)
    finally:
        fresh.close()
    raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Renaming an author is not available")
