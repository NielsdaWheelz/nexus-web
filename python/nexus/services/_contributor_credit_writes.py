"""Credit-slice writes and the media author-mode flag.

Visibly private (underscore-prefixed): only :mod:`nexus.services.contributors`
composes these. This module owns exactly the ``contributor_credits`` DML and the
``media.authors_manually_managed`` flag — never contributor/alias/key identity
(that is ``_contributor_identity``) and never replay memos.

All functions run on the caller's session and never commit: the facade wraps them
in ``retry_serializable`` on a fresh session and commits on every attempt. The
partial unique indexes ``uq_contributor_credits_{target}_{ordinal|contributor_role}``
own per-target uniqueness; a race surfaces as ``IntegrityError`` and the retry owner
recomputes the whole operation from current rows.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, assert_never, cast
from uuid import UUID

from sqlalchemy import ColumnElement, CursorResult, select, update
from sqlalchemy.orm import Session

from nexus.db.models import ContributorCredit, Media
from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_RAW_ROLE_LENGTH,
    ContributorObservation,
    contributor_match_key,
)

if TYPE_CHECKING:
    # Type-only: the frozen contract pairs each resolved credit with its
    # observation. Only ``.contributor_id`` is read at runtime (duck-typed), so
    # this introduces no runtime coupling to the identity module.
    from nexus.services._contributor_identity import ResolvedCredit

_ROLE_SET = frozenset(CONTRIBUTOR_ROLES_ORDERED)


# ---------------------------------------------------------------------------
# Credit target — one tagged union over the three mutually exclusive targets.
# ---------------------------------------------------------------------------


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
class ReplaceOutcome:
    """Result of a slice replacement.

    ``dropped_contributor_ids`` are contributors that held a credit on this target
    before and hold none after; the facade tests each for global orphan eligibility.
    """

    changed: bool
    dropped_contributor_ids: frozenset[UUID]


@dataclass(frozen=True, slots=True)
class _PlannedRow:
    """One credit row exactly as it would persist, for structural comparison."""

    contributor_id: UUID
    role: str
    credited_name: str
    normalized_credited_name: str
    raw_role: str | None
    source: str
    ordinal: int


def replace_role_slices(
    db: Session,
    *,
    target: CreditTarget,
    managed_roles: frozenset[str],
    resolved: Sequence[tuple[ResolvedCredit, ContributorObservation]],
    source: str,
) -> ReplaceOutcome:
    """Replace exactly the declared managed-role slices for one target (spec 2.4).

    Undeclared roles and their relative order are preserved. Each replaced role is
    anchored at its prior first position; a genuinely new role is appended in
    vocabulary order; the combined list is renumbered densely. Canonical persisted
    facts are compared: an unchanged list performs zero DML; otherwise only the rows
    that changed are deleted and reinserted.
    """

    new_by_role = _group_new_by_role(resolved, managed_roles)
    current = list(
        db.scalars(
            select(ContributorCredit)
            .where(_target_filter(target))
            .order_by(ContributorCredit.ordinal)
        )
    )
    current_by_role, prior_role_order = _index_current(current)

    planned = _build_planned(
        managed_roles=managed_roles,
        source=source,
        new_by_role=new_by_role,
        current_by_role=current_by_role,
        prior_role_order=prior_role_order,
    )
    _validate_planned(planned)

    changed = _apply_diff(db, target=target, current=current, planned=planned)

    dropped = frozenset(
        {row.contributor_id for row in current} - {row.contributor_id for row in planned}
    )
    return ReplaceOutcome(changed=changed, dropped_contributor_ids=dropped)


def _group_new_by_role(
    resolved: Sequence[tuple[ResolvedCredit, ContributorObservation]],
    managed_roles: frozenset[str],
) -> dict[str, list[tuple[ResolvedCredit, ContributorObservation]]]:
    """Group replacement rows by role, keeping the first row per (contributor, role)."""

    grouped: dict[str, list[tuple[ResolvedCredit, ContributorObservation]]] = {}
    seen: dict[str, set[UUID]] = {}
    for resolved_credit, observation in resolved:
        role = observation.role
        if role not in managed_roles:
            continue
        role_seen = seen.setdefault(role, set())
        if resolved_credit.contributor_id in role_seen:
            continue
        role_seen.add(resolved_credit.contributor_id)
        grouped.setdefault(role, []).append((resolved_credit, observation))
    return grouped


def _index_current(
    current: Sequence[ContributorCredit],
) -> tuple[dict[str, list[ContributorCredit]], list[str]]:
    """Return current rows grouped by role plus the roles in prior-first-seen order."""

    by_role: dict[str, list[ContributorCredit]] = {}
    order: list[str] = []
    for row in current:
        if row.role not in by_role:
            order.append(row.role)
            by_role[row.role] = []
        by_role[row.role].append(row)
    return by_role, order


def _build_planned(
    *,
    managed_roles: frozenset[str],
    source: str,
    new_by_role: dict[str, list[tuple[ResolvedCredit, ContributorObservation]]],
    current_by_role: dict[str, list[ContributorCredit]],
    prior_role_order: list[str],
) -> list[_PlannedRow]:
    ordered_roles: list[str] = []
    for role in prior_role_order:
        if role in managed_roles:
            # A replaced role survives only if it has replacement rows; an empty
            # managed slice removes the role entirely.
            if role in new_by_role:
                ordered_roles.append(role)
        else:
            ordered_roles.append(role)
    existing_roles = set(prior_role_order)
    new_roles = sorted(
        (role for role in new_by_role if role not in existing_roles),
        key=CONTRIBUTOR_ROLES_ORDERED.index,
    )
    ordered_roles.extend(new_roles)

    planned: list[_PlannedRow] = []
    ordinal = 0
    for role in ordered_roles:
        if role in managed_roles:
            for resolved_credit, observation in new_by_role[role]:
                planned.append(
                    _PlannedRow(
                        contributor_id=resolved_credit.contributor_id,
                        role=role,
                        credited_name=observation.credited_name,
                        normalized_credited_name=contributor_match_key(observation.credited_name),
                        raw_role=observation.raw_role,
                        source=source,
                        ordinal=ordinal,
                    )
                )
                ordinal += 1
        else:
            for row in current_by_role[role]:
                planned.append(
                    _PlannedRow(
                        contributor_id=row.contributor_id,
                        role=row.role,
                        credited_name=row.credited_name,
                        normalized_credited_name=row.normalized_credited_name,
                        raw_role=row.raw_role,
                        source=row.source,
                        ordinal=ordinal,
                    )
                )
                ordinal += 1
    return planned


def _validate_planned(planned: Sequence[_PlannedRow]) -> None:
    # justify-service-invariant-check: the dropped credit CHECK constraints (role
    # vocabulary, nonnegative dense ordinal, one target) and (contributor, role)
    # uniqueness now live in application code (D-19). These catch a construction
    # bug before it reaches the partial unique indexes.
    seen_pairs: set[tuple[UUID, str]] = set()
    for index, row in enumerate(planned):
        if row.role not in _ROLE_SET:
            raise AssertionError(f"planned credit has unknown role {row.role!r}")
        if row.ordinal != index:
            raise AssertionError(f"planned credit ordinals are not dense: {row.ordinal} != {index}")
        if not (0 < len(row.credited_name) <= MAX_CONTRIBUTOR_NAME_CODE_POINTS):
            raise AssertionError("planned credit credited_name is out of bounds")
        if row.raw_role is not None and not (0 < len(row.raw_role) <= MAX_RAW_ROLE_LENGTH):
            raise AssertionError("planned credit raw_role is out of bounds")
        pair = (row.contributor_id, row.role)
        if pair in seen_pairs:
            raise AssertionError(f"planned credits duplicate (contributor, role) {pair!r}")
        seen_pairs.add(pair)


def _apply_diff(
    db: Session,
    *,
    target: CreditTarget,
    current: Sequence[ContributorCredit],
    planned: Sequence[_PlannedRow],
) -> bool:
    """Delete then insert only the rows whose persisted facts differ.

    Ordinal is unique per target, so it keys the comparison: a current and a planned
    row at the same ordinal are kept only when every persisted fact matches. Deletes
    are flushed before inserts so a shifted row never collides with its own prior
    occupant on ``uq_contributor_credits_{target}_ordinal``.
    """

    planned_by_ordinal = {row.ordinal: row for row in planned}
    kept_ordinals: set[int] = set()
    to_delete: list[ContributorCredit] = []
    for row in current:
        candidate = planned_by_ordinal.get(row.ordinal)
        if candidate is not None and _current_facts(row) == _planned_facts(candidate):
            kept_ordinals.add(row.ordinal)
        else:
            to_delete.append(row)
    to_insert = [row for ordinal, row in planned_by_ordinal.items() if ordinal not in kept_ordinals]

    if not to_delete and not to_insert:
        return False

    for row in to_delete:
        db.delete(row)
    if to_delete:
        db.flush()
    for planned_row in to_insert:
        db.add(
            ContributorCredit(
                contributor_id=planned_row.contributor_id,
                credited_name=planned_row.credited_name,
                normalized_credited_name=planned_row.normalized_credited_name,
                role=planned_row.role,
                raw_role=planned_row.raw_role,
                ordinal=planned_row.ordinal,
                source=planned_row.source,
                **_target_columns(target),
            )
        )
    if to_insert:
        db.flush()
    return True


def _current_facts(
    row: ContributorCredit,
) -> tuple[UUID, str, str, str, str | None, str, int]:
    return (
        row.contributor_id,
        row.role,
        row.credited_name,
        row.normalized_credited_name,
        row.raw_role,
        row.source,
        row.ordinal,
    )


def _planned_facts(row: _PlannedRow) -> tuple[UUID, str, str, str, str | None, str, int]:
    return (
        row.contributor_id,
        row.role,
        row.credited_name,
        row.normalized_credited_name,
        row.raw_role,
        row.source,
        row.ordinal,
    )


def set_media_author_mode(db: Session, *, media_id: UUID, manual: bool) -> None:
    """Pin (``manual=True``) or release (``manual=False``) the media author slice."""

    result = cast(
        CursorResult[Any],
        db.execute(
            update(Media).where(Media.id == media_id).values(authors_manually_managed=manual)
        ),
    )
    if result.rowcount != 1:
        # justify-service-invariant-check: put_media_authors already loaded and
        # authorized this media in the same transaction, so a missing row here is a
        # broken invariant, not a user-facing condition.
        raise AssertionError(
            f"expected exactly one media row for {media_id!r}, updated {result.rowcount}"
        )
