"""Contributor identity selection, credit DML and its collection invalidation.

Runs on the caller's session and never commits: the facade owns sessions and the
``retry_serializable`` runner, so a uniqueness race surfaces as ``IntegrityError``
and the retry recomputes the whole operation from current rows.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import media_viewer_ids_sql, podcast_viewer_ids_sql
from nexus.db.models import Contributor, ContributorAlias, ContributorCredit, ContributorExternalId
from nexus.schemas.presence import Present
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    bump_collection_families,
)
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorObservation,
    contributor_match_key,
    new_contributor_handle,
)


@dataclass(frozen=True, slots=True)
class MediaTarget:
    media_id: UUID


@dataclass(frozen=True, slots=True)
class PodcastTarget:
    podcast_id: UUID


@dataclass(frozen=True, slots=True)
class GutenbergTarget:
    ebook_id: int


CreditTarget = MediaTarget | PodcastTarget | GutenbergTarget


def _target_column(target: CreditTarget) -> tuple[str, object]:
    match target:
        case MediaTarget(media_id):
            return "media_id", media_id
        case PodcastTarget(podcast_id):
            return "podcast_id", podcast_id
        case GutenbergTarget(ebook_id):
            return "project_gutenberg_catalog_ebook_id", ebook_id


class ContributorObservationRejected(ValueError):
    """An observation cannot identify a valid contributor roster; nothing was written."""


@dataclass(frozen=True, slots=True)
class ResolvedCredit:
    """An existing person; ``display_name`` is canonical, not the observed spelling."""

    contributor_id: UUID
    handle: str
    display_name: str


@dataclass(frozen=True, eq=False, slots=True)
class NewContributor:
    """One person to create in the owning transaction (identity equality: one per instance)."""

    display_name: str


PlannedContributor = ResolvedCredit | NewContributor


@dataclass(frozen=True, slots=True)
class ObservationIdentityPlan:
    """The read-only half of a publication: one identity per credit, plus unseen keys."""

    credits: tuple[ContributorObservation, ...]
    identities: tuple[PlannedContributor, ...]
    new_keys: tuple[tuple[PlannedContributor, str, str], ...]


def planned_contributor_identity(planned: PlannedContributor) -> UUID | NewContributor:
    return planned.contributor_id if isinstance(planned, ResolvedCredit) else planned


def plan_observation_credits(
    db: Session, credits: Sequence[ContributorObservation]
) -> ObservationIdentityPlan:
    """Select one identity per credit without writing.

    A bound handle names its person. An existing exact key beats any name. Otherwise
    the earliest-created owner of a resolving alias wins, unless it already holds a
    different key of the same authority: that proves a second person, created apart.
    Keyless same-name credits of one batch share one identity; an unseen key belongs
    to whoever won.
    """
    if not credits:
        return ObservationIdentityPlan((), (), ())
    handles = {
        c.contributor_handle.value for c in credits if isinstance(c.contributor_handle, Present)
    }
    bound = {
        row.handle: ResolvedCredit(row.id, row.handle, row.display_name)
        for row in db.scalars(select(Contributor).where(Contributor.handle.in_(handles)))
    }
    if set(bound) != handles:
        raise ContributorObservationRejected("A bound contributor no longer exists")
    if any(isinstance(c.contributor_handle, Present) and c.identity_key for c in credits):
        raise ContributorObservationRejected(
            "A contributor handle cannot be combined with an identity key"
        )

    pairs = [(k.authority, k.key) if (k := c.identity_key) else None for c in credits]
    claimed = [pair for pair in pairs if pair is not None]
    # contributor -> authority -> keys it owns, for same-authority contradiction.
    keys_of: dict[UUID | NewContributor, dict[str, set[str]]] = {}
    key_owner: dict[tuple[str, str], PlannedContributor] = {}
    for authority, key, cid, handle, name in db.execute(
        text(
            """
            SELECT x.authority, x.external_key, c.id, c.handle, c.display_name
            FROM contributor_external_ids x
            JOIN contributors c ON c.id = x.contributor_id
            WHERE (x.authority, x.external_key) IN (
                SELECT a, k FROM unnest(CAST(:authorities AS text[]), CAST(:keys AS text[])) t(a, k)
            )
            """
        ),
        {"authorities": [a for a, _ in claimed], "keys": [k for _, k in claimed]},
    ):
        key_owner[(authority, key)] = ResolvedCredit(cid, handle, name)
        keys_of.setdefault(cid, {}).setdefault(authority, set()).add(key)

    # Names no exact key resolved need their alias owner; the LEFT JOIN carries each
    # candidate's same-authority keys and the ORDER BY puts the earliest person first.
    match_keys = [contributor_match_key(c.credited_name) for c in credits]
    unresolved = sorted(
        {m for m, pair in zip(match_keys, pairs, strict=True) if pair not in key_owner}
    )
    alias_winner: dict[str, ResolvedCredit] = {}
    for normalized, cid, handle, name, authority, key in db.execute(
        text(
            """
            SELECT ca.normalized_alias, c.id, c.handle, c.display_name, x.authority, x.external_key
            FROM contributor_aliases ca
            JOIN contributors c ON c.id = ca.contributor_id
            LEFT JOIN contributor_external_ids x
                   ON x.contributor_id = c.id AND x.authority = ANY(CAST(:authorities AS text[]))
            WHERE ca.normalized_alias = ANY(CAST(:match_keys AS text[])) AND ca.resolves_identity
            ORDER BY ca.normalized_alias, c.created_at, c.id
            """
        ),
        {"authorities": sorted({a for a, _ in claimed}), "match_keys": unresolved},
    ):
        alias_winner.setdefault(normalized, ResolvedCredit(cid, handle, name))
        if authority is not None:
            keys_of.setdefault(cid, {}).setdefault(authority, set()).add(key)

    # Name winners are cached so keyless same-name credits share one identity; a
    # forced-distinct person is not.
    name_winner: dict[str, PlannedContributor] = {}
    identities: list[PlannedContributor] = []
    new_keys: list[tuple[PlannedContributor, str, str]] = []
    for match_key, pair, credit in zip(match_keys, pairs, credits, strict=True):
        winner = name_winner.get(match_key) or alias_winner.get(match_key)
        winner_keys = keys_of.get(planned_contributor_identity(winner), {}) if winner else {}
        if isinstance(credit.contributor_handle, Present):
            chosen: PlannedContributor = bound[credit.contributor_handle.value]
        elif pair in key_owner:
            chosen = key_owner[pair]
        elif pair is not None and winner_keys.get(pair[0], set()) - {pair[1]}:
            chosen = NewContributor(credit.credited_name)
        else:
            chosen = winner or NewContributor(credit.credited_name)
            name_winner[match_key] = chosen
        if pair is not None and pair not in key_owner:
            new_keys.append((chosen, *pair))
            key_owner[pair] = chosen
            owned = keys_of.setdefault(planned_contributor_identity(chosen), {})
            owned.setdefault(pair[0], set()).add(pair[1])
        identities.append(chosen)
    return ObservationIdentityPlan(tuple(credits), tuple(identities), tuple(new_keys))


def materialize_observation_credits(
    db: Session, *, plan: ObservationIdentityPlan
) -> list[ResolvedCredit]:
    """Create each planned person once and record the unseen keys."""
    created: dict[NewContributor, ResolvedCredit] = {}

    def resolve(planned: PlannedContributor) -> ResolvedCredit:
        if isinstance(planned, ResolvedCredit):
            return planned
        if planned not in created:
            created[planned] = create_contributor(db, display_name=planned.display_name)
        return created[planned]

    resolved = [resolve(planned) for planned in plan.identities]
    for planned, authority, key in plan.new_keys:
        owner = resolve(planned).contributor_id
        db.add(ContributorExternalId(contributor_id=owner, authority=authority, external_key=key))
    db.flush()
    return resolved


def create_contributor(db: Session, *, display_name: str) -> ResolvedCredit:
    """A new person with a resolving display alias, at the base handle while it is free."""
    handle = new_contributor_handle(display_name, distinct=False)
    if db.scalar(select(Contributor.id).where(Contributor.handle == handle)) is not None:
        handle = new_contributor_handle(display_name, distinct=True)
    contributor = Contributor(handle=handle, display_name=display_name)
    db.add(contributor)
    db.flush()  # assigns the id; a uniqueness race retries the whole operation
    ensure_alias(db, contributor_id=contributor.id, alias=display_name, resolves_identity=True)
    return ResolvedCredit(contributor.id, handle, display_name)


def ensure_alias(db: Session, *, contributor_id: UUID, alias: str, resolves_identity: bool) -> None:
    """Ensure the alias row; the flag only rises, and a resolving ensure refreshes the
    literal so the search display join (``alias = display_name``) stays exact."""
    normalized = contributor_match_key(alias)
    existing = db.scalar(
        select(ContributorAlias).where(
            ContributorAlias.contributor_id == contributor_id,
            ContributorAlias.normalized_alias == normalized,
        )
    )
    if existing is None:
        db.add(
            ContributorAlias(
                contributor_id=contributor_id,
                alias=alias,
                normalized_alias=normalized,
                resolves_identity=resolves_identity,
            )
        )
        db.flush()
    elif resolves_identity:
        existing.resolves_identity = True
        existing.alias = alias


def replace_role_slices(
    db: Session,
    *,
    target: CreditTarget,
    managed_roles: frozenset[str],
    resolved: Sequence[tuple[UUID, ContributorObservation]],
    source: str,
) -> bool:
    """Replace exactly the managed roles' slices of one target; true when a row changed.

    Other roles keep their rows, source and relative order. A replaced role keeps its
    first position; a new role is appended in vocabulary order; an emptied role
    disappears; ordinals are renumbered 0..n-1 through a negative scratch range.
    """
    column, value = _target_column(target)
    new_by_role: dict[str, list[tuple[UUID, ContributorObservation]]] = {}
    seen: set[tuple[str, UUID]] = set()
    for contributor_id, observation in resolved:
        if observation.role in managed_roles and (observation.role, contributor_id) not in seen:
            seen.add((observation.role, contributor_id))
            new_by_role.setdefault(observation.role, []).append((contributor_id, observation))

    current_by_role: dict[str, list[ContributorCredit]] = {}
    for row in db.scalars(
        select(ContributorCredit)
        .where(getattr(ContributorCredit, column) == value)
        .order_by(ContributorCredit.ordinal)
    ):
        current_by_role.setdefault(row.role, []).append(row)

    changed_roles = {
        role
        for role in managed_roles
        if [(r.contributor_id, r.credited_name, r.raw_role) for r in current_by_role.get(role, [])]
        != [(cid, o.credited_name, o.raw_role) for cid, o in new_by_role.get(role, [])]
    }
    if not changed_roles:
        return False

    kept = [role for role in current_by_role if role not in managed_roles or role in new_by_role]
    fresh = sorted(set(new_by_role) - set(current_by_role), key=CONTRIBUTOR_ROLES_ORDERED.index)
    planned: list[ContributorCredit] = []
    for role in kept + fresh:
        if role not in changed_roles:
            planned.extend(current_by_role[role])
            continue
        for contributor_id, observation in new_by_role[role]:
            planned.append(
                ContributorCredit(
                    contributor_id=contributor_id,
                    credited_name=observation.credited_name,
                    role=role,
                    raw_role=observation.raw_role,
                    source=source,
                    ordinal=0,
                    **{column: value},
                )
            )

    current = [row for rows in current_by_role.values() for row in rows]
    for row in current:
        row.ordinal = -row.ordinal - 1
    db.flush()
    for row in current:
        if row.role in changed_roles:
            db.delete(row)
    db.flush()
    for ordinal, row in enumerate(planned):
        row.ordinal = ordinal
    db.add_all(planned)
    db.flush()
    return True


def bump_credit_revisions(db: Session, targets: Sequence[CreditTarget]) -> None:
    """Advance each collection whose rows embed these targets' credits, for every viewer
    who can see one of them, so a continuation across the change fails with
    E_COLLECTION_CHANGED. Catalogue ebooks are visible to everyone."""
    media_ids = [t.media_id for t in targets if isinstance(t, MediaTarget)]
    podcast_ids = [t.podcast_id for t in targets if isinstance(t, PodcastTarget)]
    if media_ids:
        bump_collection_families(
            db,
            viewer_ids=list(db.scalars(text(media_viewer_ids_sql()), {"media_ids": media_ids})),
            families=(
                CollectionFamily.AuthorWorks,
                CollectionFamily.LibraryEntries,
                CollectionFamily.PodcastEpisodes,
            ),
        )
    if podcast_ids:
        viewers = db.scalars(text(podcast_viewer_ids_sql()), {"podcast_ids": podcast_ids})
        bump_collection_families(
            db,
            viewer_ids=list(viewers),
            families=(
                CollectionFamily.AuthorWorks,
                CollectionFamily.LibraryEntries,
                CollectionFamily.PodcastSubscriptions,
            ),
        )
    if any(isinstance(target, GutenbergTarget) for target in targets):
        bump_all_collection_revisions(db, family=CollectionFamily.AuthorWorks)
