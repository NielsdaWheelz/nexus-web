"""Private identity-mutation helpers: contributors, aliases, and exact keys only.

Visibly internal (underscore path): imported only by the ``contributors`` facade
and the author tests. It owns contributor rows, alias rows, and external-id rows.
It never touches credits, media flags, or replay memos, and never opens or commits
a transaction — the facade owns the fresh session and the single
``retry_serializable`` runner (spec 2.7, D-22). Uniqueness races surface here as
plain ``IntegrityError`` from a flush; the caller's retry re-runs the whole
operation (D-11). No savepoints, upserts, or locks — plain SELECT-then-INSERT.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import Contributor, ContributorAlias, ContributorExternalId
from nexus.services.contributor_taxonomy import (
    ContributorIdentityKey,
    ContributorObservation,
    KeyDistinctSeed,
    ManualDistinctSeed,
    contributor_handle_candidates,
    contributor_match_key,
)


@dataclass(frozen=True, slots=True)
class ResolvedCredit:
    """A resolved contributor identity for one observation.

    ``display_name`` is the contributor's canonical display name (not the observed
    credited spelling — that stays on the observation the caller pairs with this).
    """

    contributor_id: UUID
    handle: str
    display_name: str


def resolve_observation_credits(
    db: Session,
    credits: Sequence[ContributorObservation],
) -> list[ResolvedCredit]:
    """Resolve a whole observation batch to contributor identities (spec 2.2).

    Returns one :class:`ResolvedCredit` per input observation, positionally
    aligned so the caller can pair each with its observation for credit writes.

    Exactly two batched lookups back the resolution reads (perf budget): one
    bulk key-owner SELECT and one bulk resolving-alias SELECT; grouping and
    winner choice then run from in-memory batch state. Writes are not read-free:
    ``ensure_alias``/``create_contributor`` still issue per-row existence
    SELECTs for the aliases/handles they must create.
    An existing exact key always wins over a name candidate; an unseen key that
    contradicts a same-authority key on the name winner forces a distinct
    contributor; otherwise at most one contributor is created per unresolved
    equivalence group (same name / same key).
    """

    if not credits:
        return []

    match_keys = [contributor_match_key(obs.credited_name) for obs in credits]

    # --- Batched lookup 1: exact key owners --------------------------------
    key_owner: dict[tuple[str, str], ResolvedCredit] = {}
    # authority -> set of keys each contributor already owns; used both to reuse
    # keys within the batch and to detect same-authority contradictions.
    contributor_keys: dict[UUID, dict[str, set[str]]] = {}
    key_pairs = {
        (obs.identity_key.authority, obs.identity_key.key)
        for obs in credits
        if obs.identity_key is not None
    }
    if key_pairs:
        rows = db.execute(
            select(
                ContributorExternalId.authority,
                ContributorExternalId.external_key,
                Contributor.id,
                Contributor.handle,
                Contributor.display_name,
            )
            .join(Contributor, Contributor.id == ContributorExternalId.contributor_id)
            .where(
                tuple_(
                    ContributorExternalId.authority,
                    ContributorExternalId.external_key,
                ).in_(list(key_pairs))
            )
        ).all()
        for authority, external_key, cid, handle, display_name in rows:
            key_owner[(authority, external_key)] = ResolvedCredit(cid, handle, display_name)
            contributor_keys.setdefault(cid, {}).setdefault(authority, set()).add(external_key)

    # --- Batched lookup 2: resolving-alias name winners --------------------
    # Only names that did not already resolve through an exact key need it.
    unresolved_match_keys = {
        match_keys[i]
        for i, obs in enumerate(credits)
        if obs.identity_key is None
        or (obs.identity_key.authority, obs.identity_key.key) not in key_owner
    }
    batch_authorities = {
        obs.identity_key.authority for obs in credits if obs.identity_key is not None
    }
    alias_winner: dict[str, ResolvedCredit] = {}
    if unresolved_match_keys:
        base = (
            select(
                ContributorAlias.normalized_alias,
                Contributor.id,
                Contributor.created_at,
                Contributor.handle,
                Contributor.display_name,
            )
            .join(Contributor, Contributor.id == ContributorAlias.contributor_id)
            .where(
                ContributorAlias.normalized_alias.in_(unresolved_match_keys),
                ContributorAlias.resolves_identity.is_(True),
            )
        )
        # normalized_alias -> {contributor_id: (created_at, handle, display_name)}
        candidates: dict[str, dict[UUID, tuple[datetime, str, str]]] = {}
        if batch_authorities:
            # LEFT JOIN the candidates' same-authority external ids so the winner's
            # existing keys are known for contradiction detection without a third
            # query; filtering the join to batch authorities keeps it bounded.
            stmt = base.add_columns(
                ContributorExternalId.authority,
                ContributorExternalId.external_key,
            ).outerjoin(
                ContributorExternalId,
                and_(
                    ContributorExternalId.contributor_id == Contributor.id,
                    ContributorExternalId.authority.in_(batch_authorities),
                ),
            )
            for (
                normalized,
                cid,
                created_at,
                handle,
                display_name,
                authority,
                external_key,
            ) in db.execute(stmt).all():
                candidates.setdefault(normalized, {})[cid] = (created_at, handle, display_name)
                if authority is not None:
                    contributor_keys.setdefault(cid, {}).setdefault(authority, set()).add(
                        external_key
                    )
        else:
            for normalized, cid, created_at, handle, display_name in db.execute(base).all():
                candidates.setdefault(normalized, {})[cid] = (created_at, handle, display_name)
        for normalized, owners in candidates.items():
            # Earliest (created_at, id) wins forever; work counts never participate.
            winner_id = min(owners, key=lambda i: (owners[i][0], i))
            _, handle, display_name = owners[winner_id]
            alias_winner[normalized] = ResolvedCredit(winner_id, handle, display_name)

    # --- Resolution pass ---------------------------------------------------
    # name winner cached per match key so keyless same-name observations reuse
    # one identity; forced-distinct creations are deliberately NOT cached here.
    name_winner: dict[str, ResolvedCredit] = {}
    ensured_display: set[UUID] = set()
    ensured_alias: set[tuple[UUID, str]] = set()
    resolved: list[ResolvedCredit] = []

    for match_key, obs in zip(match_keys, credits, strict=True):
        key = obs.identity_key
        pair = (key.authority, key.key) if key is not None else None

        if pair is not None and pair in key_owner:
            # An existing exact key always wins over a name candidate.
            chosen = key_owner[pair]
        else:
            winner = name_winner.get(match_key) or alias_winner.get(match_key)
            if key is not None and _contradicts(contributor_keys, winner, key):
                # Same-authority key conflict is positive evidence of two people.
                chosen = create_contributor(
                    db,
                    display_name=obs.credited_name,
                    distinct_seed=KeyDistinctSeed(key.authority, key.key),
                )
                _attach_key(db, key_owner, contributor_keys, contributor=chosen, key=key)
                if winner is not None:
                    # Keep the stable name winner cached so keyless same-name
                    # observations still reuse it, not this forced-distinct row.
                    name_winner.setdefault(match_key, winner)
            else:
                if winner is None:
                    winner = create_contributor(db, display_name=obs.credited_name)
                chosen = winner
                name_winner[match_key] = winner
                if key is not None:
                    _attach_key(db, key_owner, contributor_keys, contributor=chosen, key=key)

        _ensure_observation_aliases(
            db, chosen, obs, match_key, ensured_display=ensured_display, ensured_alias=ensured_alias
        )
        resolved.append(chosen)

    return resolved


def create_contributor(
    db: Session,
    *,
    display_name: str,
    distinct_seed: KeyDistinctSeed | ManualDistinctSeed | None = None,
) -> ResolvedCredit:
    """Insert one contributor with the first free deterministic handle candidate.

    ``distinct_seed=None`` yields the single base handle (ordinary create); a seed
    yields the forced-distinct ladder. A candidate taken in this snapshot is
    skipped; a collision after the flush surfaces as ``IntegrityError`` for the
    caller's whole-operation retry. Exhausting the ladder is a defect, never a
    random fallback.
    """

    for handle in contributor_handle_candidates(display_name, distinct_seed=distinct_seed):
        if db.scalar(select(Contributor.id).where(Contributor.handle == handle)) is not None:
            continue
        contributor = Contributor(handle=handle, display_name=display_name)
        db.add(contributor)
        db.flush()  # assign id and surface a uniqueness race now → whole-op retry
        return ResolvedCredit(contributor.id, handle, display_name)

    # justify-defect: the deterministic handle ladder is exhausted, which for a
    # forced-distinct seed means an astronomically improbable digest collision and
    # for a base handle means a same-name contributor exists without a resolving
    # alias (a broken invariant). Neither is recoverable by a random handle.
    raise RuntimeError(f"Contributor handle candidates exhausted for {display_name!r}")


def ensure_alias(
    db: Session,
    *,
    contributor_id: UUID,
    alias: str,
    resolves_identity: bool,
) -> None:
    """Ensure ``(contributor, normalized_alias)`` exists with a monotonic flag.

    The ``resolves_identity`` flag is monotonic OR: an observation can never
    demote a trusted alias. A resolving ensure also keeps the stored literal
    aligned with the passed canonical spelling — callers pass canonical
    display/rename spellings on the resolving path, and the search display-join
    (``alias = display_name``) relies on the literal staying current even when a
    rename only changes case or ignorable code points (same match key). A
    non-resolving (observed) spelling never overwrites an existing literal.
    Plain SELECT-then-INSERT — a race raises ``IntegrityError``.
    """

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
        db.flush()  # surface the owner/normalized uniqueness race → whole-op retry
        return
    if resolves_identity:
        existing.resolves_identity = True
        existing.alias = alias  # the resolving/canonical literal wins and stays current


def _contradicts(
    contributor_keys: dict[UUID, dict[str, set[str]]],
    winner: ResolvedCredit | None,
    key: ContributorIdentityKey,
) -> bool:
    if winner is None:
        return False
    owned = contributor_keys.get(winner.contributor_id, {}).get(key.authority, set())
    return bool(owned - {key.key})


def _attach_key(
    db: Session,
    key_owner: dict[tuple[str, str], ResolvedCredit],
    contributor_keys: dict[UUID, dict[str, set[str]]],
    *,
    contributor: ResolvedCredit,
    key: ContributorIdentityKey,
) -> None:
    db.add(
        ContributorExternalId(
            contributor_id=contributor.contributor_id,
            authority=key.authority,
            external_key=key.key,
        )
    )
    db.flush()  # surface the authority/key uniqueness race → whole-op retry
    key_owner[(key.authority, key.key)] = contributor
    contributor_keys.setdefault(contributor.contributor_id, {}).setdefault(
        key.authority, set()
    ).add(key.key)


def _ensure_observation_aliases(
    db: Session,
    chosen: ResolvedCredit,
    obs: ContributorObservation,
    observed_match_key: str,
    *,
    ensured_display: set[UUID],
    ensured_alias: set[tuple[UUID, str]],
) -> None:
    cid = chosen.contributor_id
    if cid not in ensured_display:
        ensure_alias(db, contributor_id=cid, alias=chosen.display_name, resolves_identity=True)
        ensured_display.add(cid)
        ensured_alias.add((cid, contributor_match_key(chosen.display_name)))
    if (cid, observed_match_key) not in ensured_alias:
        # Provider-observed spellings are searchable but do not resolve identity.
        ensure_alias(db, contributor_id=cid, alias=obs.credited_name, resolves_identity=False)
        ensured_alias.add((cid, observed_match_key))
