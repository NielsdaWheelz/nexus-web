"""The saved-EPUB contributor repair: plan, preview and apply (``scripts/repair_epub_contributors.py``).

Moved verbatim from ``services/contributors.py``; gated on the pending production run
(docs/tickets/epub-contributors-production-repair-pending.md).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Contributor, ContributorCredit, Media
from nexus.schemas.presence import (
    Presence,
    Present,
    absent,
    nullable_from_presence,
    presence_from_nullable,
    present,
)
from nexus.services.contributor_taxonomy import ContributorHandle, ContributorObservation
from nexus.services.contributor_writes import (
    MediaTarget,
    NewContributor,
    ResolvedCredit,
    bump_credit_revisions,
    ensure_alias,
    materialize_observation_credits,
    plan_observation_credits,
    planned_contributor_identity,
)

if TYPE_CHECKING:
    from nexus.services.epub_ingest import EpubExtractionResult


def resolve_observation_credits(
    db: Session, credits: Sequence[ContributorObservation]
) -> list[ResolvedCredit]:
    """Select and allocate one exact identity batch in the caller's transaction."""
    return materialize_observation_credits(db, plan=plan_observation_credits(db, credits))


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
    resolved = resolve_observation_credits(db, effective)
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
    bump_credit_revisions(db, [MediaTarget(media.id)])
    return report
