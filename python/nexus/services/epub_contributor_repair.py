"""Source-matched EPUB credit repair with one reviewed identity plan per apply."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Contributor, ContributorCredit, Media, MediaFile
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
    NewContributor,
    ObservationIdentityPlan,
    ensure_alias,
    materialize_observation_credits,
    plan_observation_credits,
    planned_contributor_identity,
)
from nexus.services.resource_mutation_replay import canonical_json_bytes

if TYPE_CHECKING:
    from nexus.services.epub_ingest import EpubExtractionResult


@dataclass(frozen=True, slots=True)
class SourceCreditSnapshot:
    id: UUID
    contributor_id: UUID
    handle: str
    display_name: str
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


@dataclass(frozen=True, slots=True)
class EpubContributorRepairPreview:
    report: EpubContributorRepairReport
    preview: dict[str, object]
    preview_digest: str


def _source_credit_snapshot(db: Session, media_id: UUID) -> tuple[SourceCreditSnapshot, ...]:
    return tuple(
        SourceCreditSnapshot(
            row.id,
            row.contributor_id,
            handle,
            display_name,
            row.credited_name,
            row.role,
            presence_from_nullable(row.raw_role),
            row.ordinal,
            row.source,
            row.created_at,
            row.updated_at,
        )
        for row, handle, display_name in db.execute(
            select(ContributorCredit, Contributor.handle, Contributor.display_name)
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


@dataclass(frozen=True, slots=True)
class _PreparedRepair:
    preview: EpubContributorRepairPreview
    rows: list[_RepairCredit]
    identities: ObservationIdentityPlan


def _prepare_reviewed_repair(
    db: Session, *, plan: EpubContributorRepairPlan, viewer_id: UUID, source: MediaFile
) -> _PreparedRepair | EpubContributorRepairSkipped:
    proposed = [credit for _, credits in plan.replacements for credit in credits] + list(
        plan.additions
    )
    selected = plan_observation_credits(db, proposed)
    identities = [planned_contributor_identity(identity) for identity in selected.identities]
    planned = _plan_repair_rows(plan, identities)
    if isinstance(planned, EpubContributorRepairSkipped):
        return planned
    rows, report = planned
    # Held authors affect neither allocations nor key/alias publication.
    effective = [
        (credit, identity)
        for credit, identity in zip(selected.credits, selected.identities, strict=True)
        if not (plan.expected_manual_authors and credit.role == "author")
    ]
    effective_keys = {
        (
            planned_contributor_identity(identity),
            credit.identity_key.authority,
            credit.identity_key.key,
        )
        for credit, identity in effective
        if credit.identity_key is not None
    }
    selected = ObservationIdentityPlan(
        tuple(credit for credit, _ in effective),
        tuple(identity for _, identity in effective),
        tuple(
            (identity, authority, key)
            for identity, authority, key in selected.new_keys
            if (planned_contributor_identity(identity), authority, key) in effective_keys
        ),
    )
    people: dict[UUID | NewContributor, dict[str, object]] = {
        row.contributor_id: {
            "kind": "existing",
            "id": str(row.contributor_id),
            "handle": row.handle,
            "display_name": row.display_name,
        }
        for row in plan.expected_credits
    }
    new_ordinal = 0
    for identity in selected.identities:
        key = planned_contributor_identity(identity)
        if isinstance(identity, NewContributor):
            if key not in people:
                people[key] = {
                    "kind": "new",
                    "ordinal": new_ordinal,
                    "display_name": identity.display_name,
                }
                new_ordinal += 1
        else:
            people[key] = {
                "kind": "existing",
                "id": str(identity.contributor_id),
                "handle": identity.handle,
                "display_name": identity.display_name,
            }
    preview: dict[str, object] = {
        "viewer_id": str(viewer_id),
        "media_id": str(plan.media_id),
        "source": {
            "storage_path": source.storage_path,
            "source_sha256": source.source_sha256,
            "size_bytes": source.size_bytes,
            "content_type": source.content_type,
        },
        "authors_manually_managed": plan.expected_manual_authors,
        "before_credits": [
            {
                "credit_id": str(row.id),
                "person": people[row.contributor_id],
                "credited_name": row.credited_name,
                "role": row.role,
                "raw_role": nullable_from_presence(row.raw_role),
                "source": row.source,
                "ordinal": row.ordinal,
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in plan.expected_credits
        ],
        "proposed_credits": [
            {
                "credit_id": str(row.row_id.value) if isinstance(row.row_id, Present) else None,
                "person": people[row.identity],
                "credited_name": row.observation.credited_name,
                "role": row.observation.role,
                "raw_role": row.observation.raw_role,
                "source": row.source,
                "ordinal": ordinal,
            }
            for ordinal, row in enumerate(rows)
        ],
        "identities": [
            people[planned_contributor_identity(identity)] for identity in selected.identities
        ],
        "new_key_intents": [
            {
                "person": people[planned_contributor_identity(identity)],
                "authority": authority,
                "key": key,
            }
            for identity, authority, key in selected.new_keys
        ],
    }
    return _PreparedRepair(
        EpubContributorRepairPreview(
            report, preview, hashlib.sha256(canonical_json_bytes(preview)).hexdigest()
        ),
        rows,
        selected,
    )


def preview_epub_contributor_repair(
    db: Session, *, plan: EpubContributorRepairPlan, viewer_id: UUID, source: MediaFile
) -> EpubContributorRepairPreview | EpubContributorRepairSkipped:
    """Bind the complete source/credit/identity proposal without allocating anything."""
    prepared = _prepare_reviewed_repair(db, plan=plan, viewer_id=viewer_id, source=source)
    return prepared if isinstance(prepared, EpubContributorRepairSkipped) else prepared.preview


def apply_epub_contributor_repair_in_current_transaction(
    db: Session,
    *,
    media: Media,
    plan: EpubContributorRepairPlan,
    viewer_id: UUID,
    source: MediaFile,
    preview_digest: str,
) -> EpubContributorRepairPreview | EpubContributorRepairSkipped:
    """Check then materialize one plan in the caller's locked serializable attempt.

    The caller rechecks access/source and prepares the source match inside every
    retry. Nothing, including an identity allocation, precedes this digest check.
    """
    if media.id != plan.media_id:
        raise ValueError("EPUB repair belongs to another media item")
    if (
        media.authors_manually_managed != plan.expected_manual_authors
        or _source_credit_snapshot(db, media.id) != plan.expected_credits
    ):
        return EpubContributorRepairSkipped("credits_changed")
    prepared = _prepare_reviewed_repair(db, plan=plan, viewer_id=viewer_id, source=source)
    if isinstance(prepared, EpubContributorRepairSkipped):
        return prepared
    if prepared.preview.preview_digest != preview_digest:
        return EpubContributorRepairSkipped("preview_changed")
    if not prepared.preview.report.changed:
        return prepared.preview
    resolved = materialize_observation_credits(db, plan=prepared.identities)
    allocated = {
        planned_contributor_identity(identity): credit.contributor_id
        for identity, credit in zip(prepared.identities.identities, resolved, strict=True)
    }
    rows = prepared.rows
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
        row = (
            current[planned_row.row_id.value]
            if isinstance(planned_row.row_id, Present)
            else ContributorCredit(media_id=media.id)
        )
        row.contributor_id = (
            planned_row.identity
            if isinstance(planned_row.identity, UUID)
            else allocated[planned_row.identity]
        )
        row.credited_name = planned_row.observation.credited_name
        row.role = planned_row.observation.role
        row.raw_role = planned_row.observation.raw_role
        row.source = planned_row.source
        row.ordinal = ordinal
        db.add(row)
    db.flush()
    for credit, observation in zip(resolved, prepared.identities.credits, strict=True):
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
    return prepared.preview
