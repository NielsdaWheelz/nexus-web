"""The public author operations facade (spec §3).

Sole transaction/operation owner for contributor identity. The final semantic
surface is exactly: contributor search, contributor detail, distinct works,
ref resolve/hydrate for panes, observed role-slice replacement (single and
gutenberg-chunked batch), media-author PUT/reset, display-name rename, and the
transaction-scoped target cleanup + orphan prune helpers. No second public
identity/write path exists.

Composition:

- identity rows (contributors/aliases/keys) mutate only via the visibly private
  ``_contributor_identity``; credit rows and the media pin only via
  ``_contributor_credit_writes``; replay memos only via the shared
  ``resource_mutation_replay`` (byte basis: alias-free, see the two call sites);
- reads compose the canonical credit relation owned by ``contributor_credits``
  and the visibility CTEs owned by ``auth/permissions``;
- the four mutation entry points take NO session: each opens a fresh session
  (precedent: ``tasks/enrich_metadata.dispatch_enrich_metadata``) and terminates
  in ``retry_serializable`` so SERIALIZABLE + the named-constraint whole-op
  retry is the only race recovery (spec 2.7, D-11/D-22) — no savepoints, no
  locks, no nested runners;
- ``cleanup_credits_for_deleted_target``/``prune_contributors_if_orphaned`` are
  the deliberate composition exception: they run on the caller's deletion
  transaction and start no runner (spec §3).
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterable, Sequence
from functools import partial
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer
from nexus.auth.permissions import (
    can_read_media,
    credited_visible_contributor_ids_cte_sql,
    visible_contributor_ids_cte_sql,
)
from nexus.db.models import (
    ChatRunTurnContext,
    Contributor,
    ContributorAlias,
    ContributorCredit,
    ContributorExternalId,
    Media,
    ResourceEdge,
    ResourceMutation,
    ResourceVersion,
    ResourceViewState,
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
from nexus.schemas.contributors import (
    ContributorDetailOut,
    ContributorRenameRequest,
    ContributorRole,
    ContributorRoleFactOut,
    ContributorSearchItemOut,
    ContributorSearchPageOut,
    ContributorWorkExampleOut,
    ContributorWorkItemOut,
    ContributorWorkPageOut,
    ExistingAuthorBinding,
    ManualMediaAuthorsRequest,
    MediaAuthorCreditOut,
    MediaAuthorsOut,
    MediaAuthorsPutRequest,
)
from nexus.services._contributor_credit_writes import (
    CreditTarget as CreditTarget,
)
from nexus.services._contributor_credit_writes import (
    GutenbergTarget as GutenbergTarget,
)
from nexus.services._contributor_credit_writes import (
    MediaTarget as MediaTarget,
)
from nexus.services._contributor_credit_writes import (
    PodcastTarget as PodcastTarget,
)

# Internal-use helpers are bound to underscored names: the facade is the only
# public author surface, and a plain re-export would mint a second write path
# (e.g. calling the credit writer with a job session, bypassing the fresh-session
# + retry_serializable discipline). Gated in test_contributor_ownership_guards.
from nexus.services._contributor_credit_writes import (
    replace_role_slices as _replace_role_slices,
)
from nexus.services._contributor_credit_writes import (
    set_media_author_mode as _set_media_author_mode,
)
from nexus.services._contributor_identity import (
    ResolvedCredit as _ResolvedCredit,
)
from nexus.services._contributor_identity import (
    create_contributor as _create_contributor,
)
from nexus.services._contributor_identity import (
    ensure_alias as _ensure_alias,
)
from nexus.services._contributor_identity import (
    resolve_observation_credits as _resolve_observation_credits,
)
from nexus.services.capabilities import can_edit_media_authors, can_rename_contributor
from nexus.services.chat_context_refs import contributor_is_referenced_in_persisted_context
from nexus.services.contributor_credits import (
    distinct_visible_works_sql,
    load_contributor_credits_for_media,
)
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorHandle,
    ContributorObservation,
    ContributorObservationBatch,
    ManualDistinctSeed,
    NotObserved,
    ObservedRoleSlices,
    clean_contributor_display,
    contributor_handle_candidates,
    contributor_match_key,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

# One fresh session + one serializable operation per chunk of gutenberg targets
# (D-15): caps a 75k-row first sync at ~375 transactions without sharing any
# transaction across the source/author boundary.
_BATCH_CHUNK_SIZE = 200

_WORKS_ORDER_SQL = "w.date_key DESC NULLS LAST, w.title ASC, w.href ASC"


# ---------------------------------------------------------------------------
# Queries (caller session)
# ---------------------------------------------------------------------------


def search_contributors(
    db: Session,
    *,
    viewer_id: UUID,
    q: str,
    cursor: str | None = None,
    limit: int = 20,
) -> ContributorSearchPageOut:
    """Lexical canonical-name/alias search for the picker (spec §6, D-8/D-25).

    Matching is on the normalized (match-key) form of every alias; the canonical
    display spelling always owns an alias row, so display matches are alias
    matches. Ordering is ``(match_key(display_name), handle)``: the display
    alias row (literal equal to ``display_name``) carries exactly that match key,
    which makes the ordering key SQL-computable for keyset pagination.
    """
    q_key = contributor_match_key(q)
    if not q_key:
        return ContributorSearchPageOut(contributors=[], nextCursor=None)

    pattern = f"%{_escape_like(q_key)}%"
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "pattern": pattern,
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        decoded = _decode_cursor(cursor, ("n", "h"))
        after_key, after_handle = decoded["n"], decoded["h"]
        if not isinstance(after_key, str) or not isinstance(after_handle, str):
            raise InvalidRequestError(message="Invalid cursor")
        keyset_sql = "AND (da.normalized_alias, c.handle) > (:after_key, :after_handle)"
        params["after_key"] = after_key
        params["after_handle"] = after_handle

    rows = db.execute(
        text(
            f"""
            SELECT c.id, c.handle, c.display_name, da.normalized_alias AS display_key
            FROM contributors c
            JOIN ({credited_visible_contributor_ids_cte_sql()}) cv
                ON cv.contributor_id = c.id
            JOIN contributor_aliases da
                ON da.contributor_id = c.id AND da.alias = c.display_name
            WHERE EXISTS (
                SELECT 1
                FROM contributor_aliases ca
                WHERE ca.contributor_id = c.id
                  AND ca.normalized_alias LIKE :pattern ESCAPE '\\'
            )
            {keyset_sql}
            ORDER BY da.normalized_alias ASC, c.handle ASC
            LIMIT :limit_plus_one
            """
        ),
        params,
    ).all()

    page = rows[:limit]
    next_cursor = None
    if len(rows) > limit and page:
        next_cursor = _encode_cursor({"n": page[-1].display_key, "h": page[-1].handle})

    contributor_ids = [row.id for row in page]
    matched_alias_by_id = _matched_aliases(db, {row.id: row.display_name for row in page}, pattern)
    stats_by_id = _work_stats(db, viewer_id=viewer_id, contributor_ids=contributor_ids)

    items: list[ContributorSearchItemOut] = []
    for row in page:
        work_count, examples = stats_by_id.get(row.id, (0, []))
        matched_alias = None
        if q_key not in row.display_key:
            # The canonical name did not match; surface the alias that did.
            matched_alias = matched_alias_by_id.get(row.id)
        items.append(
            ContributorSearchItemOut(
                handle=row.handle,
                href=f"/authors/{row.handle}",
                displayName=row.display_name,
                workCount=work_count,
                workExamples=examples,
                matchedAlias=matched_alias,
            )
        )
    return ContributorSearchPageOut(contributors=items, nextCursor=next_cursor)


def get_contributor_detail(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: ContributorHandle,
    viewer_roles: frozenset[str] = frozenset(),
) -> ContributorDetailOut:
    """Detail view under broad visibility. ``viewer_roles`` shapes ``canRename``.

    Roles ride the viewer's token (they are not database-derivable from
    ``viewer_id``), so the route passes ``viewer.roles``; the default keeps the
    capability truthfully false for role-less callers.
    """
    contributor = _load_visible_contributor_by_handle(db, str(contributor_handle), viewer_id)
    return _contributor_detail_out(db, contributor, can_rename=can_rename_contributor(viewer_roles))


def list_contributor_works(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: ContributorHandle,
    cursor: str | None = None,
    limit: int = 100,
) -> ContributorWorkPageOut:
    """Distinct visible works with nested role facts (spec §4, D-25 ordering)."""
    contributor = _load_visible_contributor_by_handle(db, str(contributor_handle), viewer_id)

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "contributor_id": contributor.id,
        "limit_plus_one": limit + 1,
    }
    keyset_sql = ""
    if cursor is not None:
        decoded = _decode_cursor(cursor, ("d", "t", "h"))
        after_date, after_title, after_href = decoded["d"], decoded["t"], decoded["h"]
        if (
            not (after_date is None or isinstance(after_date, str))
            or not isinstance(after_title, str)
            or not isinstance(after_href, str)
        ):
            raise InvalidRequestError(message="Invalid cursor")
        params["after_title"] = after_title
        params["after_href"] = after_href
        if after_date is not None:
            params["after_date"] = after_date
            keyset_sql = """AND (
                w.date_key IS NULL
                OR w.date_key < :after_date
                OR (
                    w.date_key = :after_date
                    AND (w.title, w.href) > (:after_title, :after_href)
                )
            )"""
        else:
            keyset_sql = (
                "AND w.date_key IS NULL AND (w.title, w.href) > (:after_title, :after_href)"
            )

    rows = db.execute(
        text(
            f"""
            WITH works AS ({distinct_visible_works_sql()})
            SELECT w.title, w.href, w.content_kind, w.date_key, w.role_facts
            FROM works w
            WHERE w.contributor_id = :contributor_id
            {keyset_sql}
            ORDER BY {_WORKS_ORDER_SQL}
            LIMIT :limit_plus_one
            """
        ),
        params,
    ).all()

    page = rows[:limit]
    next_cursor = None
    if len(rows) > limit and page:
        last = page[-1]
        next_cursor = _encode_cursor({"d": last.date_key, "t": last.title, "h": last.href})

    works = [
        ContributorWorkItemOut(
            title=row.title,
            href=row.href,
            contentKind=row.content_kind,
            date=row.date_key,
            roleFacts=[
                ContributorRoleFactOut(
                    creditedName=fact["credited_name"],
                    role=cast(ContributorRole, fact["role"]),
                    rawRole=fact["raw_role"],
                )
                for fact in row.role_facts
            ],
        )
        for row in page
    ]
    return ContributorWorkPageOut(works=works, nextCursor=next_cursor)


def resolve_contributor_ref_by_handle(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: str,
) -> ResourceRef:
    contributor = _load_visible_contributor_by_handle(db, contributor_handle, viewer_id)
    return ResourceRef(scheme="contributor", id=contributor.id)


def resolve_contributor_ids_by_handles(db: Session, handles: Sequence[str]) -> dict[str, UUID]:
    """Map handles directly to contributor ids, dropping unknown handles (D-29).

    Every row is active post-cutover; there is no merge chain to follow. Result
    preserves first-seen input order.
    """
    unique_handles = list(dict.fromkeys(handles))
    if not unique_handles:
        return {}
    found: dict[str, UUID] = {}
    for handle, contributor_id in db.execute(
        select(Contributor.handle, Contributor.id).where(Contributor.handle.in_(unique_handles))
    ).tuples():
        found[handle] = contributor_id
    return {handle: found[handle] for handle in unique_handles if handle in found}


# ---------------------------------------------------------------------------
# Mutations (no session parameter: fresh session + retry_serializable inside)
# ---------------------------------------------------------------------------


def replace_observed_role_slices(
    *,
    target: CreditTarget,
    observation: ContributorObservationBatch,
    source: str,
) -> None:
    """One unreplayable automatic author mutation (spec 2.4).

    ``NOT_OBSERVED`` returns before any session is opened and never erases prior
    credits. Never touches ``resource_mutations`` (D-43): a stable job key may
    legitimately observe different authors later, and background lanes have no
    user.
    """
    if isinstance(observation, NotObserved):
        return
    fresh = _fresh_author_session()
    try:
        retry_serializable(
            fresh,
            "replace_observed_role_slices",
            partial(_run_observations_op, fresh, ((target, observation, source),)),
        )
    finally:
        fresh.close()


def replace_observed_role_slices_batch(
    items: Sequence[tuple[CreditTarget, ContributorObservationBatch, str]],
) -> None:
    """Chunked variant of :func:`replace_observed_role_slices` (D-15).

    Used only by the gutenberg catalog sync: one fresh session and one
    serializable operation per chunk of ``_BATCH_CHUNK_SIZE`` targets, applying
    the same per-target semantics sequentially. A chunk retry recomputes from
    current rows; unchanged targets perform no DML, so retries converge.
    """
    observed = [
        (target, observation, source)
        for target, observation, source in items
        if isinstance(observation, ObservedRoleSlices)
    ]
    for start in range(0, len(observed), _BATCH_CHUNK_SIZE):
        chunk = observed[start : start + _BATCH_CHUNK_SIZE]
        fresh = _fresh_author_session()
        try:
            retry_serializable(
                fresh,
                "replace_observed_role_slices_batch",
                partial(_run_observations_op, fresh, chunk),
            )
        finally:
            fresh.close()


def put_media_authors(
    *,
    viewer: Viewer,
    media_id: UUID,
    request: MediaAuthorsPutRequest,
) -> MediaAuthorsOut:
    """Replayable manual author-slice PUT / automatic reset (spec 2.5)."""
    fresh = _fresh_author_session()
    try:
        return retry_serializable(
            fresh,
            "put_media_authors",
            partial(_put_media_authors_op, fresh, viewer, media_id, request),
        )
    finally:
        fresh.close()


def ensure_contributor_display_name(
    *,
    viewer: Viewer,
    contributor_handle: ContributorHandle,
    request: ContributorRenameRequest,
) -> ContributorDetailOut:
    """Replayable display-name rename; an already-equal cleaned name is success."""
    fresh = _fresh_author_session()
    try:
        return retry_serializable(
            fresh,
            "ensure_contributor_display_name",
            partial(_ensure_display_name_op, fresh, viewer, contributor_handle, request),
        )
    finally:
        fresh.close()


# ---------------------------------------------------------------------------
# Transaction-scoped composition (caller's deletion transaction, no runner)
# ---------------------------------------------------------------------------


def cleanup_credits_for_deleted_target(db: Session, *, target: CreditTarget) -> None:
    """Remove a deleted target's credits, its author-edit memos, then prune.

    The deliberate composition exception (spec §3): media/podcast/Gutenberg
    deletion calls this inside its owning deletion transaction; it performs no
    resolution and starts no runner or retry loop. (No podcast deletion flow
    exists today; if one appears it must call this.)
    """
    outcome = _replace_role_slices(
        db,
        target=target,
        managed_roles=frozenset(CONTRIBUTOR_ROLES_ORDERED),
        resolved=(),
        source="cleanup",
    )
    to_prune = set(outcome.dropped_contributor_ids)
    if isinstance(target, MediaTarget):
        scope = f"media:{target.media_id}:authors"
        # The memos deleted here may be the LAST reference keeping a
        # replay-protected identity alive (spec 2.8: "not pruned until its
        # owning media memo is removed") — e.g. a manual author a later PUT
        # already dropped from the slice. Collect the contributors those memos
        # name so they are prune-tested once the memos are gone.
        memo_handles = set(
            db.scalars(
                text(
                    "SELECT DISTINCT jsonb_path_query(rm.response_json,"
                    " '$.authors[*].contributorHandle') #>> '{}'"
                    " FROM resource_mutations rm WHERE rm.mutation_scope = :scope"
                ),
                {"scope": scope},
            )
        )
        if memo_handles:
            to_prune.update(
                db.scalars(select(Contributor.id).where(Contributor.handle.in_(memo_handles)))
            )
        db.execute(delete(ResourceMutation).where(ResourceMutation.mutation_scope == scope))
    if to_prune:
        prune_contributors_if_orphaned(db, contributor_ids=to_prune)


def prune_contributors_if_orphaned(db: Session, *, contributor_ids: Iterable[UUID]) -> None:
    """Delete each contributor that is provably unreferenced (spec 2.8, D-41).

    Eligible only with zero credits, no exact key, and no graph/pin/version/
    view-state/chat or foreign replay reference. Deletes the contributor's own
    display-name memos and aliases before the row. Keyed or referenced zero-work
    identities remain privately reusable but undiscoverable.
    """
    for contributor_id in dict.fromkeys(contributor_ids):
        # select, not Session.get: on a retry attempt the identity map may hold
        # an expired instance and get() would raise ObjectDeletedError for a row
        # a concurrent transaction deleted.
        contributor = db.scalar(select(Contributor).where(Contributor.id == contributor_id))
        if contributor is None or not _contributor_is_orphaned(db, contributor):
            continue
        db.execute(
            delete(ResourceMutation).where(
                ResourceMutation.mutation_scope == f"contributor:{contributor.id}:display-name"
            )
        )
        db.execute(
            delete(ContributorAlias).where(ContributorAlias.contributor_id == contributor.id)
        )
        db.delete(contributor)
        # Flush the row delete now (sessions are autoflush=False): a later
        # same-transaction resolution of the same name must see the freed base
        # handle, or create_contributor would skip its only candidate and
        # exhaust the deterministic ladder.
        db.flush()


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _fresh_author_session() -> Session:
    fresh = get_session_factory()()
    # An open transaction would make use_serializable_if_available silently
    # retain weaker isolation (spec 2.7); factory sessions must arrive clean.
    assert not fresh.in_transaction(), "author mutations require a fresh session"
    return fresh


def _run_observations_op(
    db: Session,
    items: Sequence[tuple[CreditTarget, ObservedRoleSlices, str]],
) -> None:
    for target, observation, source in items:
        _apply_observation(db, target=target, observation=observation, source=source)
    db.commit()


def _apply_observation(
    db: Session,
    *,
    target: CreditTarget,
    observation: ObservedRoleSlices,
    source: str,
) -> None:
    managed_roles = observation.managed_roles
    if isinstance(target, MediaTarget):
        # select, not Session.get: get() raises ObjectDeletedError on a retry
        # attempt when the expired identity-map row was deleted concurrently.
        media = db.scalar(select(Media).where(Media.id == target.media_id))
        if media is None:
            return  # target deleted mid-flight; nothing to credit
        if media.authors_manually_managed:
            # The pin freezes only the author slice; declared non-author slices
            # still replace normally (spec 2.4).
            managed_roles = managed_roles - {"author"}
    if not managed_roles:
        return
    relevant = [credit for credit in observation.credits if credit.role in managed_roles]
    resolved = _resolve_observation_credits(db, relevant)
    outcome = _replace_role_slices(
        db,
        target=target,
        managed_roles=managed_roles,
        resolved=list(zip(resolved, relevant, strict=True)),
        source=source,
    )
    if outcome.dropped_contributor_ids:
        prune_contributors_if_orphaned(db, contributor_ids=outcome.dropped_contributor_ids)


def _put_media_authors_op(
    db: Session,
    viewer: Viewer,
    media_id: UUID,
    request: MediaAuthorsPutRequest,
) -> MediaAuthorsOut:
    media = db.scalar(select(Media).where(Media.id == media_id))
    if media is None or not can_read_media(db, viewer.user_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    if not can_edit_media_authors(
        can_read=True,
        is_creator=media.created_by_user_id == viewer.user_id,
        is_admin="admin" in viewer.roles,
    ):
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the media creator or an administrator can edit authors",
        )
    scope = f"media:{media_id}:authors"
    # Alias-free hash basis (spec 4/D-21), deliberately unlike other scopes'
    # by_alias=True: keys the memo to the request's meaning, not its camelCase
    # wire spelling, so a wire-alias rename never masquerades as a different
    # mutation.
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=False))
    stored = lookup_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        return _revalidated_memo(MediaAuthorsOut, stored)

    dropped: frozenset[UUID] = frozenset()
    if isinstance(request, ManualMediaAuthorsRequest):
        resolved_rows = _bind_manual_author_rows(
            db, viewer=viewer, media_id=media_id, request=request
        )
        outcome = _replace_role_slices(
            db,
            target=MediaTarget(media_id),
            managed_roles=frozenset({"author"}),
            resolved=resolved_rows,
            source="user",
        )
        dropped = outcome.dropped_contributor_ids
        _set_media_author_mode(db, media_id=media_id, manual=True)
        author_mode: Literal["automatic", "manual"] = "manual"
    else:
        # Reset: release the pin and leave current rows in place; the next
        # successful observed author slice replaces them (spec 2.5).
        _set_media_author_mode(db, media_id=media_id, manual=False)
        author_mode = "automatic"

    response = _media_authors_out(db, media_id=media_id, author_mode=author_mode)
    # changed_lanes is intentionally empty: author mutations do not participate
    # in the resource-item lane-version protocol.
    record_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
        changed_lanes={},
    )
    if dropped:
        prune_contributors_if_orphaned(db, contributor_ids=dropped)
    db.commit()
    return response


def _bind_manual_author_rows(
    db: Session,
    *,
    viewer: Viewer,
    media_id: UUID,
    request: ManualMediaAuthorsRequest,
) -> list[tuple[_ResolvedCredit, ContributorObservation]]:
    resolved_rows: list[tuple[_ResolvedCredit, ContributorObservation]] = []
    bound_ids: set[UUID] = set()
    for row_index, row in enumerate(request.authors):
        binding = row.binding
        if isinstance(binding, ExistingAuthorBinding):
            resolved = _load_selectable_author(
                db, viewer_id=viewer.user_id, handle=binding.contributor_handle
            )
        else:
            resolved = _create_manual_author(
                db,
                viewer=viewer,
                media_id=media_id,
                client_mutation_id=request.client_mutation_id,
                row_index=row_index,
                display_name=binding.display_name,
            )
        if resolved.contributor_id in bound_ids:
            raise ApiError(
                ApiErrorCode.E_AUTHOR_ALREADY_LISTED,
                "That author is already listed for this role.",
            )
        bound_ids.add(resolved.contributor_id)
        resolved_rows.append(
            (
                resolved,
                ContributorObservation(
                    credited_name=clean_contributor_display(row.credited_name),
                    role="author",
                    raw_role=None,
                    identity_key=None,
                ),
            )
        )
    return resolved_rows


def _load_selectable_author(db: Session, *, viewer_id: UUID, handle: str) -> _ResolvedCredit:
    contributor = db.scalar(select(Contributor).where(Contributor.handle == handle))
    if contributor is None or not _contributor_visible(db, contributor.id, viewer_id):
        # One message for unknown and invisible: selection must never reveal
        # whether an invisible record exists (spec §6).
        raise ApiError(ApiErrorCode.E_AUTHOR_NOT_SELECTABLE, "That author can't be selected.")
    return _ResolvedCredit(contributor.id, contributor.handle, contributor.display_name)


def _create_manual_author(
    db: Session,
    *,
    viewer: Viewer,
    media_id: UUID,
    client_mutation_id: str,
    row_index: int,
    display_name: str,
) -> _ResolvedCredit:
    """Create a manual ``new`` author per the D-7 manual rule.

    With no same-name resolving owner and a free base handle this is an ordinary
    create (future automatic observations should find this person); otherwise it
    is a deliberately distinct identity seeded by user/media/mutation/row, which
    makes whole-operation retries converge on the same handle.
    """
    display = clean_contributor_display(display_name)
    base_handle = next(iter(contributor_handle_candidates(display)))
    has_resolving_owner = (
        db.scalar(
            select(ContributorAlias.id)
            .where(
                ContributorAlias.normalized_alias == contributor_match_key(display),
                ContributorAlias.resolves_identity.is_(True),
            )
            .limit(1)
        )
        is not None
    )
    base_taken = (
        db.scalar(select(Contributor.id).where(Contributor.handle == base_handle)) is not None
    )
    if has_resolving_owner or base_taken:
        seed = ManualDistinctSeed(
            user_id=str(viewer.user_id),
            media_id=str(media_id),
            client_mutation_id=client_mutation_id,
            row_index=row_index,
        )
        created = _create_contributor(db, display_name=display, distinct_seed=seed)
    else:
        created = _create_contributor(db, display_name=display)
    # Every canonical display owns a resolving alias (spec §4 invariant).
    _ensure_alias(db, contributor_id=created.contributor_id, alias=display, resolves_identity=True)
    return created


def _media_authors_out(
    db: Session,
    *,
    media_id: UUID,
    author_mode: Literal["automatic", "manual"],
) -> MediaAuthorsOut:
    credits = load_contributor_credits_for_media(db, [media_id])[media_id]
    authors: list[MediaAuthorCreditOut] = []
    for credit in credits:
        if credit.role != "author":
            continue
        if (
            credit.contributor_handle is None
            or credit.contributor_display_name is None
            or credit.href is None
        ):
            # justify-defect: stored credits always join a contributor; the
            # narrowed DTO keeps these optional only for handle-less preview
            # facts that never come from this loader.
            raise AssertionError("stored media author credit lost its contributor")
        authors.append(
            MediaAuthorCreditOut(
                contributorHandle=credit.contributor_handle,
                href=credit.href,
                displayName=credit.contributor_display_name,
                creditedName=credit.credited_name,
            )
        )
    # canEditAuthors is True by construction: the PUT already authorized this
    # viewer, and the response describes what that same viewer may do.
    return MediaAuthorsOut(authorMode=author_mode, authors=authors, canEditAuthors=True)


def _ensure_display_name_op(
    db: Session,
    viewer: Viewer,
    contributor_handle: ContributorHandle,
    request: ContributorRenameRequest,
) -> ContributorDetailOut:
    # D-44 order: load via broad visibility (404) -> authorize (403) -> replay.
    contributor = _load_visible_contributor_by_handle(db, str(contributor_handle), viewer.user_id)
    if not can_rename_contributor(viewer.roles):
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Renaming an author requires an administrator or curator role",
        )
    scope = f"contributor:{contributor.id}:display-name"
    # Alias-free hash basis (spec 4/D-21), deliberately unlike other scopes'
    # by_alias=True: keys the memo to the request's meaning, not its camelCase
    # wire spelling, so a wire-alias rename never masquerades as a different
    # mutation.
    request_bytes = canonical_json_bytes(request.model_dump(mode="json", by_alias=False))
    stored = lookup_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
    )
    if stored is not None:
        return _revalidated_memo(ContributorDetailOut, stored)

    new_display = clean_contributor_display(request.display_name)
    if new_display and new_display != contributor.display_name:
        old_display = contributor.display_name
        contributor.display_name = new_display
        contributor.updated_at = func.now()
        # Old and new canonical spellings both resolve future identity; the
        # handle and existing credited spellings never change (spec 2.6). The
        # new spelling is ensured LAST so a same-match-key rename (case or
        # ignorable-codepoint variant) leaves the shared alias row's literal
        # equal to the new display name.
        _ensure_alias(db, contributor_id=contributor.id, alias=old_display, resolves_identity=True)
        _ensure_alias(db, contributor_id=contributor.id, alias=new_display, resolves_identity=True)

    response = _contributor_detail_out(db, contributor, can_rename=True)
    # changed_lanes is intentionally empty: author mutations do not participate
    # in the resource-item lane-version protocol.
    record_replay(
        db,
        viewer_id=viewer.user_id,
        scope=scope,
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
        changed_lanes={},
    )
    db.commit()
    return response


def _contributor_detail_out(
    db: Session,
    contributor: Contributor,
    *,
    can_rename: bool,
) -> ContributorDetailOut:
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
        canRename=can_rename,
    )


def _revalidated_memo[TModel: BaseModel](model: type[TModel], stored: dict[str, object]) -> TModel:
    try:
        return model.model_validate(stored)
    except ValidationError as exc:
        # justify-defect: a stored replay memo must decode as the exact public
        # response (D-42); a mismatch means the memo or the model drifted, and
        # returning the raw dict would leak an unvalidated shape.
        raise AssertionError("Stored author mutation memo failed response validation") from exc


def _matched_aliases(
    db: Session,
    display_by_id: dict[UUID, str],
    pattern: str,
) -> dict[UUID, str]:
    """First matching non-display alias literal per contributor (D-25)."""
    if not display_by_id:
        return {}
    rows = db.execute(
        text(
            """
            SELECT ca.contributor_id, ca.alias
            FROM contributor_aliases ca
            WHERE ca.contributor_id = ANY(:contributor_ids)
              AND ca.normalized_alias LIKE :pattern ESCAPE '\\'
            ORDER BY ca.contributor_id ASC, ca.created_at ASC, ca.id ASC
            """
        ),
        {"contributor_ids": list(display_by_id), "pattern": pattern},
    ).all()
    matched: dict[UUID, str] = {}
    for contributor_id, alias in rows:
        if alias != display_by_id[contributor_id] and contributor_id not in matched:
            matched[contributor_id] = alias
    return matched


def _work_stats(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_ids: Sequence[UUID],
) -> dict[UUID, tuple[int, list[ContributorWorkExampleOut]]]:
    """Distinct visible work count and up to two examples per contributor."""
    if not contributor_ids:
        return {}
    rows = db.execute(
        text(
            f"""
            WITH works AS ({distinct_visible_works_sql()}),
            ranked AS (
                SELECT
                    w.contributor_id,
                    w.title,
                    w.href,
                    row_number() OVER (
                        PARTITION BY w.contributor_id
                        ORDER BY {_WORKS_ORDER_SQL}
                    ) AS rn
                FROM works w
                WHERE w.contributor_id = ANY(:contributor_ids)
            )
            SELECT
                contributor_id,
                count(*) AS work_count,
                jsonb_agg(jsonb_build_object('title', title, 'href', href) ORDER BY rn ASC)
                    FILTER (WHERE rn <= 2) AS work_examples
            FROM ranked
            GROUP BY contributor_id
            """
        ),
        {"viewer_id": viewer_id, "contributor_ids": list(contributor_ids)},
    ).all()
    return {
        row.contributor_id: (
            int(row.work_count),
            [
                ContributorWorkExampleOut(title=example["title"], href=example["href"])
                for example in (row.work_examples or [])
            ],
        )
        for row in rows
    }


def _load_visible_contributor_by_handle(
    db: Session,
    contributor_handle: str,
    viewer_id: UUID,
) -> Contributor:
    contributor = db.scalar(select(Contributor).where(Contributor.handle == contributor_handle))
    if contributor is None or not _contributor_visible(db, contributor.id, viewer_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return contributor


def _contributor_visible(db: Session, contributor_id: UUID, viewer_id: UUID) -> bool:
    """Broad visibility: a visible credit or a viewer-owned graph edge (D-8)."""
    row = db.execute(
        text(
            f"""
            SELECT 1
            FROM ({visible_contributor_ids_cte_sql()}) visible
            WHERE visible.contributor_id = :contributor_id
            LIMIT 1
            """
        ),
        {"viewer_id": viewer_id, "contributor_id": contributor_id},
    ).first()
    return row is not None


def _contributor_is_orphaned(db: Session, contributor: Contributor) -> bool:
    contributor_id = contributor.id
    if (
        db.scalar(
            select(ContributorCredit.id)
            .where(ContributorCredit.contributor_id == contributor_id)
            .limit(1)
        )
        is not None
    ):
        return False
    if (
        db.scalar(
            select(ContributorExternalId.id)
            .where(ContributorExternalId.contributor_id == contributor_id)
            .limit(1)
        )
        is not None
    ):
        return False
    # Any user's edge blocks; note-body embeds sync to resource_edges
    # (origin='note_body') in the note-save transaction, so this transitively
    # gates note-body references (D-41). A view-state edge_id points at one of
    # these rows, so no separate edge-id probe is needed.
    if (
        db.scalar(
            select(ResourceEdge.id)
            .where(
                or_(
                    (ResourceEdge.source_scheme == "contributor")
                    & (ResourceEdge.source_id == contributor_id),
                    (ResourceEdge.target_scheme == "contributor")
                    & (ResourceEdge.target_id == contributor_id),
                )
            )
            .limit(1)
        )
        is not None
    ):
        return False
    if (
        db.scalar(
            select(ResourceVersion.id)
            .where(
                ResourceVersion.resource_scheme == "contributor",
                ResourceVersion.resource_id == contributor_id,
            )
            .limit(1)
        )
        is not None
    ):
        return False
    if (
        db.scalar(
            select(ResourceViewState.id)
            .where(
                or_(
                    (ResourceViewState.surface_scheme == "contributor")
                    & (ResourceViewState.surface_id == contributor_id),
                    (ResourceViewState.target_scheme == "contributor")
                    & (ResourceViewState.target_id == contributor_id),
                )
            )
            .limit(1)
        )
        is not None
    ):
        return False
    if (
        db.scalar(
            select(ChatRunTurnContext.chat_run_id)
            .where(
                or_(
                    (ChatRunTurnContext.requested_subject_scheme == "contributor")
                    & (ChatRunTurnContext.requested_subject_id == contributor_id),
                    (ChatRunTurnContext.subject_scheme == "contributor")
                    & (ChatRunTurnContext.subject_id == contributor_id),
                )
            )
            .limit(1)
        )
        is not None
    ):
        return False
    if contributor_is_referenced_in_persisted_context(
        db, contributor_id=contributor_id, contributor_handle=contributor.handle
    ):
        return False
    if _foreign_author_memo_exists(db, contributor=contributor):
        return False
    return True


def _foreign_author_memo_exists(db: Session, *, contributor: Contributor) -> bool:
    """D-41 foreign replay probe: typed object, URI string, or foreign scope.

    ``jsonb_path_exists`` (not text LIKE) over ``response_json`` for the known
    ref forms — any ``contributorHandle`` field (author-edit memos are recorded
    ``by_alias=True``, so they carry the camel spelling), plus the typed
    contributor object, the snake ``contributor_handle`` field, and the
    ``contributor:<uuid>`` URI (D-41's future-proof forms; no current memo shape
    produces them) — plus a scope-prefix check that excludes the contributor's
    own display-name scope, which the prune deletes itself. A media-author memo
    naming this contributor therefore keeps a replay-protected identity alive
    until that memo is removed (spec 2.8).
    """
    handle_path = (
        '$.** ? ((@.type == "contributor" && @.id == $h)'
        " || @.contributorHandle == $h || @.contributor_handle == $h)"
    )
    row = db.execute(
        text(
            """
            SELECT 1
            FROM resource_mutations rm
            WHERE (
                jsonb_path_exists(
                    rm.response_json,
                    CAST(:handle_path AS jsonpath),
                    jsonb_build_object('h', CAST(:contributor_handle AS text))
                )
                OR jsonb_path_exists(
                    rm.response_json,
                    '$.** ? (@ == $uri)',
                    jsonb_build_object('uri', CAST(:contributor_uri AS text))
                )
                OR (
                    rm.mutation_scope LIKE :scope_prefix
                    AND rm.mutation_scope != :own_scope
                )
            )
            LIMIT 1
            """
        ),
        {
            "handle_path": handle_path,
            "contributor_handle": contributor.handle,
            "contributor_uri": f"contributor:{contributor.id}",
            "scope_prefix": f"contributor:{contributor.id}:%",
            "own_scope": f"contributor:{contributor.id}:display-name",
        },
    ).first()
    return row is not None


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _encode_cursor(payload: dict[str, object]) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")


def _decode_cursor(cursor: str, keys: tuple[str, ...]) -> dict[str, object]:
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except ValueError:
        raise InvalidRequestError(message="Invalid cursor") from None
    if not isinstance(decoded, dict) or set(decoded) != set(keys):
        raise InvalidRequestError(message="Invalid cursor")
    return decoded
