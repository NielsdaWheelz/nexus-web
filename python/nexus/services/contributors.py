"""The public author facade: search, detail, works, and the four write entry points."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from functools import partial
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer
from nexus.auth.permissions import (
    can_read_media,
    credited_visible_contributor_ids_cte_sql,
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
    ExternalContributorWorkItemOut,
    ManualMediaAuthorsRequest,
    MediaAuthorCreditOut,
    MediaAuthorsOut,
    MediaAuthorsPutRequest,
    MediaContributorWorkItemOut,
    PodcastContributorWorkItemOut,
    ResourceActionSubjectOut,
)
from nexus.schemas.presence import (
    Presence,
    Present,
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)
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
from nexus.services.contributor_credits import (
    distinct_visible_works_sql,
    load_contributor_credits_for_catalogue,
)
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
    ContributorObservationRejected,
    CreditTarget,
    MediaTarget,
    NewContributor,
    ObservationIdentityPlan,
    ResolvedCredit,
    create_contributor,
    ensure_alias,
    materialize_observation_credits,
    plan_observation_credits,
    planned_contributor_identity,
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

if TYPE_CHECKING:
    from nexus.services.epub_ingest import EpubExtractionResult

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
    from nexus.services.media import list_collection_media_for_viewer_by_ids

    media = {
        item.id: item.summary
        for item in list_collection_media_for_viewer_by_ids(
            db,
            viewer_id=viewer_id,
            media_ids=[UUID(str(row["media_id"])) for row in page if row["media_id"] is not None],
        )
    }
    catalogue_credits = load_contributor_credits_for_catalogue(
        db,
        [
            int(row["project_gutenberg_catalog_ebook_id"])
            for row in page
            if row["media_id"] is None and row["project_gutenberg_catalog_ebook_id"] is not None
        ],
    )
    next_cursor: CollectionCursor | None = None
    if len(rows) > limit and page:
        next_cursor = encode_keyset_cursor(
            family=_WORKS_CURSOR_FAMILY,
            query=cursor_query,
            after=after_values(plan, page[-1]),
        )
    items: list[ContributorWorkItemOut] = []
    for row in page:
        facts = [
            ContributorRoleFactOut(
                creditedName=fact["credited_name"],
                role=cast(ContributorRole, fact["role"]),
                rawRole=fact["raw_role"],
            )
            for fact in row["role_facts"]
        ]
        subject = _work_action_subject(row)
        if row["media_id"] is not None:
            if subject is None:
                raise AssertionError("media work has no action subject")
            items.append(
                MediaContributorWorkItemOut(
                    mediaSummary=media[UUID(str(row["media_id"]))],
                    href=row["href"],
                    roleFacts=facts,
                    actionSubject=subject,
                )
            )
        elif row["podcast_id"] is not None:
            if subject is None:
                raise AssertionError("podcast work has no action subject")
            items.append(
                PodcastContributorWorkItemOut(
                    title=row["title"],
                    href=row["href"],
                    contentKind=row["content_kind"],
                    date=row["date_key"],
                    roleFacts=facts,
                    actionSubject=subject,
                )
            )
        else:
            items.append(
                ExternalContributorWorkItemOut(
                    title=row["title"],
                    href=row["href"],
                    contentKind=row["content_kind"],
                    date=row["date_key"],
                    contributors=catalogue_credits.get(
                        int(row["project_gutenberg_catalog_ebook_id"]), []
                    ),
                    roleFacts=facts,
                    actionSubject=None,
                )
            )
    return CollectionPage[ContributorWorkItemOut](
        items=items,
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
) -> ContributorPublicationResult:
    """Apply one automatic observation inside an owning source transaction.

    Source publication needs its credits to commit with the facts they describe, so this
    entry point runs on the caller's transaction and starts no retry runner.
    """
    prepared = prepare_observed_role_slices_in_current_transaction(
        db, target=target, observation=observation, source=source
    )
    return apply_prepared_role_slices_in_current_transaction(db, prepared=prepared)


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


def prepare_observed_role_slices_in_current_transaction(
    db: Session, *, target: CreditTarget, observation: ContributorObservationBatch, source: str
) -> PreparedContributorPublication:
    """Validate the complete role roster read-only, before the owner writes any facts.

    Preparation and publication belong to the same serializable transaction. Held
    author proposals participate in validation and comparison, but never allocation.
    """
    if isinstance(observation, NotObserved):
        return PreparedContributorPublication(
            target, frozenset(), ObservationIdentityPlan((), (), ()), source, False
        )
    managed_roles = observation.managed_roles
    current: list[tuple[ContributorCredit, str]] = []
    manual_authors = False
    if isinstance(target, MediaTarget):
        media = db.scalar(select(Media).where(Media.id == target.media_id))
        if media is None:
            return PreparedContributorPublication(
                target, frozenset(), ObservationIdentityPlan((), (), ()), source, False
            )
        manual_authors = media.authors_manually_managed
        current = [
            (row, handle)
            for row, handle in db.execute(
                select(ContributorCredit, Contributor.handle)
                .join(Contributor, Contributor.id == ContributorCredit.contributor_id)
                .where(ContributorCredit.media_id == target.media_id)
                .order_by(ContributorCredit.ordinal)
            )
        ]
        admitted_handles = {handle for _, handle in current}
        if any(
            isinstance(credit.contributor_handle, Present)
            and credit.contributor_handle.value not in admitted_handles
            for credit in observation.credits
        ):
            raise ContributorObservationRejected(
                "A bound contributor is not credited on this media"
            )
    full_plan = plan_observation_credits(db, observation.credits)
    if source == "metadata_enrichment" and len(
        {
            (planned_contributor_identity(identity), credit.role)
            for identity, credit in zip(full_plan.identities, full_plan.credits, strict=True)
        }
    ) != len(full_plan.credits):
        raise ContributorObservationRejected("Duplicate contributor identity within a role")
    retained_manual_authors = False
    if manual_authors:
        if "author" in managed_roles:
            proposed = [
                (planned_contributor_identity(identity), credit.credited_name, credit.raw_role)
                for identity, credit in zip(full_plan.identities, full_plan.credits, strict=True)
                if credit.role == "author"
            ]
            existing = [
                (row.contributor_id, row.credited_name, row.raw_role)
                for row, _ in current
                if row.role == "author"
            ]
            retained_manual_authors = proposed != existing
        managed_roles = managed_roles - {"author"}
    relevant = [credit for credit in observation.credits if credit.role in managed_roles]
    # Re-select only when pinning removes observations: withheld external keys and
    # spellings must not influence the canonical identity allocated for another role.
    effective_plan = (
        full_plan
        if tuple(relevant) == full_plan.credits
        else plan_observation_credits(db, relevant)
    )
    return PreparedContributorPublication(
        target, managed_roles, effective_plan, source, retained_manual_authors
    )


def apply_prepared_role_slices_in_current_transaction(
    db: Session, *, prepared: PreparedContributorPublication
) -> ContributorPublicationResult:
    """Write a prevalidated roster without a late observation rejection or savepoint."""
    if not prepared.managed_roles:
        return ContributorPublicationResult(False, prepared.retained_manual_authors)
    resolved = materialize_observation_credits(db, plan=prepared.identities, record_aliases=False)
    pairs = list(zip(resolved, prepared.identities.credits, strict=True))
    changed = replace_role_slices(
        db,
        target=prepared.target,
        managed_roles=prepared.managed_roles,
        resolved=pairs,
        source=prepared.source,
    )
    if changed:
        for credit, observation in pairs:
            if not isinstance(observation.contributor_handle, Present):
                ensure_alias(
                    db,
                    contributor_id=credit.contributor_id,
                    alias=credit.display_name,
                    resolves_identity=True,
                )
            ensure_alias(
                db,
                contributor_id=credit.contributor_id,
                alias=observation.credited_name,
                resolves_identity=False,
            )
    return ContributorPublicationResult(changed, prepared.retained_manual_authors)


@dataclass(frozen=True, slots=True)
class SourceCreditSnapshot:
    id: UUID
    contributor_id: UUID
    handle: str
    credited_name: str
    role: str
    raw_role: Presence[str]
    ordinal: int
    source: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class EpubContributorRepairPlan:
    media_id: UUID
    expected_credits: tuple[SourceCreditSnapshot, ...]
    expected_manual_authors: bool
    replacements: tuple[tuple[UUID, tuple[ContributorObservation, ...]], ...]
    additions: tuple[ContributorObservation, ...]


@dataclass(frozen=True, slots=True)
class EpubContributorRepairSkipped:
    reason: str


@dataclass(frozen=True, slots=True)
class EpubContributorRepairReport:
    changed: bool
    before_counts: dict[str, int]
    after_counts: dict[str, int]
    moved: tuple[str, ...]
    added: tuple[str, ...]
    retained_manual_authors: bool


def _source_credit_snapshot(db: Session, media_id: UUID) -> tuple[SourceCreditSnapshot, ...]:
    return tuple(
        SourceCreditSnapshot(
            row.id,
            row.contributor_id,
            handle,
            row.credited_name,
            row.role,
            presence_from_nullable(row.raw_role),
            row.ordinal,
            row.source,
            row.created_at,
            row.updated_at,
        )
        for row, handle in db.execute(
            select(ContributorCredit, Contributor.handle)
            .join(Contributor, Contributor.id == ContributorCredit.contributor_id)
            .where(ContributorCredit.media_id == media_id)
            .order_by(ContributorCredit.ordinal)
        )
    )


def prepare_epub_contributor_repair(
    db: Session, *, media: Media, metadata: EpubExtractionResult
) -> EpubContributorRepairPlan | EpubContributorRepairSkipped:
    """Match legacy source observations without deriving an identity from a guessed name."""
    if metadata.contributor_issues:
        return EpubContributorRepairSkipped("unrepresentable_observation")
    current = _source_credit_snapshot(db, media.id)
    legacy = [
        row
        for row in current
        if row.source == "epub_opf"
        and row.role == "author"
        and not isinstance(row.raw_role, Present)
    ]
    creators = [entity for entity in metadata.contributor_entities if entity.kind == "creator"]
    if legacy and any(";" in entity.credited_name for entity in creators):
        return EpubContributorRepairSkipped("split_name")
    matched: dict[int, SourceCreditSnapshot] = {}
    for row in legacy:
        matches = [
            idx
            for idx, entity in enumerate(metadata.contributor_entities)
            if entity.kind == "creator" and entity.credited_name == row.credited_name
        ]
        if len(matches) != 1 or matches[0] in matched:
            return EpubContributorRepairSkipped("ambiguous_credit")
        matched[matches[0]] = row
    replacements: list[tuple[UUID, tuple[ContributorObservation, ...]]] = []
    additions: list[ContributorObservation] = []
    for idx, entity in enumerate(metadata.contributor_entities):
        row = matched.get(idx)
        if row is None:
            if entity.kind == "creator":
                # A later observation may have replaced the flattened source author.
                # Only an exact, surviving source credit proves this creator was
                # already repaired; silence cannot authorize adding it back.
                source_people = {
                    credit.contributor_id
                    for credit in current
                    if credit.source == "epub_opf"
                    and credit.credited_name == entity.credited_name
                    and any(credit.role == observation.role for observation in entity.credits)
                }
                if len(source_people) != 1 or not all(
                    any(
                        credit.contributor_id in source_people and credit.role == observation.role
                        for credit in current
                    )
                    for observation in entity.credits
                ):
                    return EpubContributorRepairSkipped("unmatched_creator")
                continue
            additions.extend(entity.credits)
        else:
            replacements.append(
                (
                    row.id,
                    tuple(
                        replace(credit, contributor_handle=present(ContributorHandle(row.handle)))
                        for credit in entity.credits
                    ),
                )
            )
    return EpubContributorRepairPlan(
        media.id, current, media.authors_manually_managed, tuple(replacements), tuple(additions)
    )


@dataclass(frozen=True, slots=True)
class _RepairCredit:
    row_id: Presence[UUID]
    identity: UUID | NewContributor
    observation: ContributorObservation
    source: str


def _plan_repair_rows(
    plan: EpubContributorRepairPlan, identities: Sequence[UUID | NewContributor]
) -> tuple[list[_RepairCredit], EpubContributorRepairReport] | EpubContributorRepairSkipped:
    before_counts: dict[str, int] = {}
    rows: list[_RepairCredit] = []
    replacements = dict(plan.replacements)
    for row in plan.expected_credits:
        before_counts[row.role] = before_counts.get(row.role, 0) + 1
        if row.id not in replacements or plan.expected_manual_authors:
            rows.append(
                _RepairCredit(
                    present(row.id),
                    row.contributor_id,
                    ContributorObservation(
                        row.credited_name, row.role, nullable_from_presence(row.raw_role), None
                    ),
                    row.source,
                )
            )
    occupied = {(row.identity, row.observation.role) for row in rows}
    moved: list[str] = []
    added: list[str] = []
    retained = plan.expected_manual_authors and any(
        [(credit.role, credit.credited_name, credit.raw_role) for credit in credits]
        != [(row.role, row.credited_name, nullable_from_presence(row.raw_role))]
        for row_id, credits in plan.replacements
        for row in plan.expected_credits
        if row.id == row_id
    )
    proposed: list[tuple[Presence[UUID], ContributorObservation]] = [
        (present(row_id), credit) for row_id, credits in plan.replacements for credit in credits
    ]
    proposed.extend((absent(), credit) for credit in plan.additions)
    used_rows: set[UUID] = set()
    for (row_id, credit), identity in zip(proposed, identities, strict=True):
        if plan.expected_manual_authors and credit.role == "author":
            retained = retained or not any(
                row.contributor_id == identity
                and row.role == "author"
                and row.credited_name == credit.credited_name
                and nullable_from_presence(row.raw_role) == credit.raw_role
                for row in plan.expected_credits
            )
            continue
        if (identity, credit.role) in occupied:
            continue
        occupied.add((identity, credit.role))
        reuse = (
            isinstance(row_id, Present)
            and not plan.expected_manual_authors
            and row_id.value not in used_rows
        )
        if isinstance(row_id, Present) and reuse:
            used_rows.add(row_id.value)
            original = next(row for row in plan.expected_credits if row.id == row_id.value)
            if (
                original.role,
                original.credited_name,
                nullable_from_presence(original.raw_role),
            ) != (credit.role, credit.credited_name, credit.raw_role):
                moved.append(f"{credit.credited_name}: author → {credit.role}")
        else:
            added.append(f"{credit.credited_name}: {credit.role}")
        rows.append(_RepairCredit(row_id if reuse else absent(), identity, credit, "epub_opf"))
    original_order = {row.id: row.ordinal for row in plan.expected_credits}
    rows.sort(
        key=lambda row: original_order.get(row.row_id.value, len(original_order))
        if isinstance(row.row_id, Present)
        else len(original_order)
    )
    after_counts: dict[str, int] = {}
    for row in rows:
        after_counts[row.observation.role] = after_counts.get(row.observation.role, 0) + 1
    if any(count > 20 for count in after_counts.values()):
        return EpubContributorRepairSkipped("unrepresentable_observation")
    before = [
        (
            row.id,
            row.contributor_id,
            row.credited_name,
            row.role,
            nullable_from_presence(row.raw_role),
            row.source,
        )
        for row in plan.expected_credits
    ]
    after = [
        (
            row.row_id.value if isinstance(row.row_id, Present) else None,
            row.identity,
            row.observation.credited_name,
            row.observation.role,
            row.observation.raw_role,
            row.source,
        )
        for row in rows
    ]
    return rows, EpubContributorRepairReport(
        before != after, before_counts, after_counts, tuple(moved), tuple(added), retained
    )


def preview_epub_contributor_repair(
    db: Session, *, plan: EpubContributorRepairPlan
) -> EpubContributorRepairReport | EpubContributorRepairSkipped:
    """Preview exact aliases without creating contributors or changing source facts."""
    proposed = [credit for _, credits in plan.replacements for credit in credits] + list(
        plan.additions
    )
    selected = plan_observation_credits(db, proposed)
    identities = [planned_contributor_identity(identity) for identity in selected.identities]
    planned = _plan_repair_rows(plan, identities)
    return planned if isinstance(planned, EpubContributorRepairSkipped) else planned[1]


def apply_epub_contributor_repair_in_current_transaction(
    db: Session, *, media: Media, plan: EpubContributorRepairPlan
) -> EpubContributorRepairReport | EpubContributorRepairSkipped:
    """Apply a source-specific repair after the caller locks/fences media and source bytes."""
    if media.id != plan.media_id:
        raise ValueError("EPUB repair belongs to another media item")
    if (
        media.authors_manually_managed != plan.expected_manual_authors
        or _source_credit_snapshot(db, media.id) != plan.expected_credits
    ):
        return EpubContributorRepairSkipped("credits_changed")
    preview = preview_epub_contributor_repair(db, plan=plan)
    if isinstance(preview, EpubContributorRepairSkipped) or not preview.changed:
        return preview
    proposed = [credit for _, credits in plan.replacements for credit in credits] + list(
        plan.additions
    )
    # Held author proposals never allocate people or aliases.
    effective = [
        credit
        for credit in proposed
        if not (plan.expected_manual_authors and credit.role == "author")
    ]
    full_plan = plan_observation_credits(db, proposed)
    resolved = resolve_observation_credits(db, effective, record_aliases=False)
    iterator = iter(resolved)
    identities = [
        planned_contributor_identity(selected)
        if plan.expected_manual_authors and credit.role == "author"
        else next(iterator).contributor_id
        for credit, selected in zip(proposed, full_plan.identities, strict=True)
    ]
    planned = _plan_repair_rows(plan, identities)
    if isinstance(planned, EpubContributorRepairSkipped):
        raise ValueError("EPUB repair changed representability after exact identity resolution")
    rows, report = planned
    current = {
        row.id: row
        for row in db.scalars(
            select(ContributorCredit).where(ContributorCredit.media_id == media.id)
        )
    }
    for row in current.values():
        row.ordinal = -row.ordinal - 1
    db.flush()
    kept_ids = {row.row_id.value for row in rows if isinstance(row.row_id, Present)}
    for identity, row in current.items():
        if identity not in kept_ids:
            db.delete(row)
    db.flush()
    for ordinal, planned_row in enumerate(rows):
        if not isinstance(planned_row.identity, UUID):
            raise AssertionError("Applied EPUB repair has an unresolved contributor")
        row = (
            current[planned_row.row_id.value]
            if isinstance(planned_row.row_id, Present)
            else ContributorCredit(media_id=media.id)
        )
        row.contributor_id = planned_row.identity
        row.credited_name = planned_row.observation.credited_name
        row.role = planned_row.observation.role
        row.raw_role = planned_row.observation.raw_role
        row.source = planned_row.source
        row.ordinal = ordinal
        db.add(row)
    db.flush()
    for credit, observation in zip(resolved, effective, strict=True):
        if not isinstance(observation.contributor_handle, Present):
            ensure_alias(
                db,
                contributor_id=credit.contributor_id,
                alias=credit.display_name,
                resolves_identity=True,
            )
        ensure_alias(
            db,
            contributor_id=credit.contributor_id,
            alias=observation.credited_name,
            resolves_identity=False,
        )
    _bump_contributor_collection_revisions(db)
    return report


def _apply_observation(
    db: Session, *, target: CreditTarget, observation: ObservedRoleSlices, source: str
) -> ContributorPublicationResult:
    prepared = prepare_observed_role_slices_in_current_transaction(
        db, target=target, observation=observation, source=source
    )
    return apply_prepared_role_slices_in_current_transaction(db, prepared=prepared)


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
