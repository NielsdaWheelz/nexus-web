"""Contributor, alias, external-key and credit DML, on the caller's session.

Never opens or commits a transaction: the facade owns the fresh session and the one
``retry_serializable`` runner, so a uniqueness race surfaces as ``IntegrityError``
and the retry recomputes the whole operation from current rows.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import assert_never
from uuid import UUID

from sqlalchemy import ColumnElement, select, text, update
from sqlalchemy.orm import Session

from nexus.db.models import (
    Contributor,
    ContributorAlias,
    ContributorCredit,
    ContributorExternalId,
    Media,
)
from nexus.schemas.presence import Present
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorObservation,
    KeyDistinctSeed,
    ManualDistinctSeed,
    contributor_handle_candidates,
    contributor_match_key,
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


def _target_filter(target: CreditTarget) -> ColumnElement[bool]:
    match target:
        case MediaTarget(media_id):
            return ContributorCredit.media_id == media_id
        case PodcastTarget(podcast_id):
            return ContributorCredit.podcast_id == podcast_id
        case GutenbergTarget(ebook_id):
            return ContributorCredit.project_gutenberg_catalog_ebook_id == ebook_id
        case _:
            assert_never(target)


def _target_columns(target: CreditTarget) -> dict[str, object]:
    match target:
        case MediaTarget(media_id):
            return {"media_id": media_id}
        case PodcastTarget(podcast_id):
            return {"podcast_id": podcast_id}
        case GutenbergTarget(ebook_id):
            return {"project_gutenberg_catalog_ebook_id": ebook_id}
        case _:
            assert_never(target)


@dataclass(frozen=True, slots=True)
class ResolvedCredit:
    """A resolved identity; ``display_name`` is canonical, not the observed spelling."""

    contributor_id: UUID
    handle: str
    display_name: str


class ContributorObservationRejected(ValueError):
    """An observation cannot identify a valid contributor roster; nothing was written."""


@dataclass(frozen=True, slots=True)
class NewContributor:
    """One read-only identity selection awaiting allocation in the owning transaction."""

    position: int
    display_name: str
    distinct_seed: KeyDistinctSeed | None = None


PlannedContributor = ResolvedCredit | NewContributor


@dataclass(frozen=True, slots=True)
class ObservationIdentityPlan:
    credits: tuple[ContributorObservation, ...]
    identities: tuple[PlannedContributor, ...]
    new_keys: tuple[tuple[PlannedContributor, str, str], ...]


def planned_contributor_identity(credit: PlannedContributor) -> UUID | NewContributor:
    return credit.contributor_id if isinstance(credit, ResolvedCredit) else credit


def plan_observation_credits(
    db: Session, credits: Sequence[ContributorObservation]
) -> ObservationIdentityPlan:
    """Select identities for the whole observation without allocating rows.

    An existing exact key always beats a name candidate; an unseen key contradicting a
    same-authority key on the name winner is positive evidence of two people and forces
    a distinct contributor; otherwise one contributor is created per equivalence group.
    """
    if not credits:
        return ObservationIdentityPlan((), (), ())

    handles = {
        obs.contributor_handle.value
        for obs in credits
        if isinstance(obs.contributor_handle, Present)
    }
    bound = {
        contributor.handle: ResolvedCredit(
            contributor.id, contributor.handle, contributor.display_name
        )
        for contributor in db.scalars(select(Contributor).where(Contributor.handle.in_(handles)))
    }
    if set(bound) != handles:
        raise ContributorObservationRejected("A bound contributor no longer exists")
    if any(
        isinstance(obs.contributor_handle, Present) and obs.identity_key is not None
        for obs in credits
    ):
        raise ContributorObservationRejected(
            "A contributor handle cannot be combined with an identity key"
        )

    match_keys = [contributor_match_key(obs.credited_name) for obs in credits]
    pairs = [(k.authority, k.key) if (k := obs.identity_key) else None for obs in credits]
    claimed = [pair for pair in pairs if pair is not None]
    # contributor -> authority -> owned keys, for reuse within the batch and for
    # same-authority contradiction detection.
    contributor_keys: dict[UUID | NewContributor, dict[str, set[str]]] = {}
    key_owner: dict[tuple[str, str], PlannedContributor] = {}
    for authority, external_key, cid, handle, name in db.execute(
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
        key_owner[(authority, external_key)] = ResolvedCredit(cid, handle, name)
        contributor_keys.setdefault(cid, {}).setdefault(authority, set()).add(external_key)

    # Names that no exact key already resolved still need their alias owner. The LEFT
    # JOIN carries each candidate's same-authority keys, so contradiction detection
    # needs no third query, and the ORDER BY puts the earliest contributor first.
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
        # Earliest (created_at, id) wins forever; work counts never participate.
        alias_winner.setdefault(normalized, ResolvedCredit(cid, handle, name))
        if authority is not None:
            contributor_keys.setdefault(cid, {}).setdefault(authority, set()).add(key)

    # Name winners are cached so keyless same-name observations reuse one identity;
    # forced-distinct creations are deliberately not cached.
    name_winner: dict[str, PlannedContributor] = {}
    resolved: list[PlannedContributor] = []
    new_keys: list[tuple[PlannedContributor, str, str]] = []
    for match_key, pair, obs in zip(match_keys, pairs, credits, strict=True):
        key = obs.identity_key
        winner = name_winner.get(match_key) or alias_winner.get(match_key)
        winner_keys = (
            contributor_keys.get(planned_contributor_identity(winner), {}) if winner else {}
        )
        if isinstance(obs.contributor_handle, Present):
            chosen = bound[obs.contributor_handle.value]
        elif pair is not None and pair in key_owner:
            chosen = key_owner[pair]
        elif key is not None and winner_keys.get(key.authority, set()) - {key.key}:
            chosen = NewContributor(
                position=len(resolved),
                display_name=obs.credited_name,
                distinct_seed=KeyDistinctSeed(key.authority, key.key),
            )
        else:
            chosen = winner or NewContributor(len(resolved), obs.credited_name)
            name_winner[match_key] = chosen
        if key is not None and pair is not None and pair not in key_owner:
            # The key is unseen: it belongs to whoever just won.
            new_keys.append((chosen, key.authority, key.key))
            key_owner[pair] = chosen
            contributor_keys.setdefault(planned_contributor_identity(chosen), {}).setdefault(
                key.authority, set()
            ).add(key.key)
        resolved.append(chosen)
    return ObservationIdentityPlan(tuple(credits), tuple(resolved), tuple(new_keys))


def materialize_observation_credits(
    db: Session, *, plan: ObservationIdentityPlan, record_aliases: bool = True
) -> list[ResolvedCredit]:
    """Allocate a fully selected roster; uniqueness races retry the whole transaction."""
    allocated: dict[NewContributor, ResolvedCredit] = {}
    resolved: list[ResolvedCredit] = []
    for selected in plan.identities:
        if isinstance(selected, ResolvedCredit):
            resolved.append(selected)
            continue
        if selected not in allocated:
            allocated[selected] = create_contributor(
                db, display_name=selected.display_name, distinct_seed=selected.distinct_seed
            )
        resolved.append(allocated[selected])
    for selected, authority, key in plan.new_keys:
        chosen = selected if isinstance(selected, ResolvedCredit) else allocated[selected]
        db.add(
            ContributorExternalId(
                contributor_id=chosen.contributor_id, authority=authority, external_key=key
            )
        )
    if plan.new_keys:
        db.flush()

    ensured: set[tuple[UUID, str]] = set()
    for chosen, obs in zip(resolved, plan.credits, strict=True):
        match_key = contributor_match_key(obs.credited_name)
        cid = chosen.contributor_id
        display_key = contributor_match_key(chosen.display_name)
        if (
            record_aliases
            and not isinstance(obs.contributor_handle, Present)
            and (cid, display_key) not in ensured
        ):
            ensure_alias(db, contributor_id=cid, alias=chosen.display_name, resolves_identity=True)
            ensured.add((cid, display_key))
        if record_aliases and (cid, match_key) not in ensured:
            # Provider-observed spellings are searchable but do not resolve identity.
            ensure_alias(db, contributor_id=cid, alias=obs.credited_name, resolves_identity=False)
            ensured.add((cid, match_key))
    return resolved


def resolve_observation_credits(
    db: Session, credits: Sequence[ContributorObservation], *, record_aliases: bool = True
) -> list[ResolvedCredit]:
    """Select and allocate one exact identity batch in the caller's transaction."""
    return materialize_observation_credits(
        db, plan=plan_observation_credits(db, credits), record_aliases=record_aliases
    )


def create_contributor(
    db: Session,
    *,
    display_name: str,
    distinct_seed: KeyDistinctSeed | ManualDistinctSeed | None = None,
) -> ResolvedCredit:
    """Insert one contributor at the first free deterministic handle candidate."""
    for handle in contributor_handle_candidates(display_name, distinct_seed=distinct_seed):
        if db.scalar(select(Contributor.id).where(Contributor.handle == handle)) is not None:
            continue
        contributor = Contributor(handle=handle, display_name=display_name)
        db.add(contributor)
        db.flush()  # assign the id and surface a uniqueness race → whole-op retry
        return ResolvedCredit(contributor.id, handle, display_name)
    raise RuntimeError(f"Contributor handle candidates exhausted for {display_name!r}")


def ensure_alias(db: Session, *, contributor_id: UUID, alias: str, resolves_identity: bool) -> None:
    """Ensure the alias row; the flag is a monotonic OR and a resolving ensure also
    refreshes the literal, keeping the search display JOIN (``alias = display_name``) exact."""
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
    resolved: Sequence[tuple[ResolvedCredit, ContributorObservation]],
    source: str,
) -> bool:
    """Replace exactly the declared managed-role slices for one target.

    Undeclared roles keep their rows and relative position; a replaced role is anchored
    at its prior first position; a new role is appended in vocabulary order; the list is
    renumbered densely 0..n-1. Identical roles and unaffected rows retain identity,
    source and timestamps; a temporary ordinal range avoids uniqueness collisions.
    """
    new_by_role: dict[str, list[tuple[ResolvedCredit, ContributorObservation]]] = {}
    seen: set[tuple[str, UUID]] = set()
    for credit, observation in resolved:
        pair = (observation.role, credit.contributor_id)
        if observation.role not in managed_roles or pair in seen:
            continue
        seen.add(pair)
        new_by_role.setdefault(observation.role, []).append((credit, observation))

    current_by_role: dict[str, list[ContributorCredit]] = {}
    for row in db.scalars(
        select(ContributorCredit).where(_target_filter(target)).order_by(ContributorCredit.ordinal)
    ):
        current_by_role.setdefault(row.role, []).append(row)

    changed_roles = {
        role
        for role in managed_roles
        if [
            (row.contributor_id, row.credited_name, row.raw_role)
            for row in current_by_role.get(role, [])
        ]
        != [
            (credit.contributor_id, observation.credited_name, observation.raw_role)
            for credit, observation in new_by_role.get(role, [])
        ]
    }
    if not changed_roles:
        return False

    # An emptied managed role disappears; a genuinely new one is appended.
    kept = [role for role in current_by_role if role not in managed_roles or role in new_by_role]
    fresh = sorted(set(new_by_role) - set(current_by_role), key=CONTRIBUTOR_ROLES_ORDERED.index)

    columns = _target_columns(target)
    planned: list[ContributorCredit] = []
    for role in kept + fresh:
        if role not in changed_roles:
            planned.extend(current_by_role[role])
            continue
        for credit, observation in new_by_role[role]:
            planned.append(
                ContributorCredit(
                    contributor_id=credit.contributor_id,
                    credited_name=observation.credited_name,
                    role=role,
                    raw_role=observation.raw_role,
                    source=source,
                    ordinal=0,
                    **columns,
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


def set_media_author_mode(db: Session, *, media_id: UUID, manual: bool) -> None:
    """Pin (``manual=True``) or release the media author slice."""
    db.execute(update(Media).where(Media.id == media_id).values(authors_manually_managed=manual))
