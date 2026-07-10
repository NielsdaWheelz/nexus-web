"""Contributor duplicate-candidate reconciliation.

This service owns persisted dedupe runs and persisted candidate decisions. It
never mutates canonical contributor identity directly except by accepting a
candidate through ``contributors.merge_contributor``.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping, bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_contributor_ids_cte_sql
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.contributors import (
    ContributorMergeRequest,
    ContributorOut,
    ContributorReconciliationCandidateOut,
    ContributorReconciliationContributorOut,
    ContributorReconciliationEvidenceOut,
    ContributorReconciliationRunOut,
    ContributorReconciliationSignal,
)
from nexus.services import contributors as contributors_service
from nexus.services.contributor_taxonomy import (
    CONFIRMED_ALIAS_SOURCES,
    STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    normalize_contributor_name,
)

RECONCILIATION_ALGORITHM_VERSION = "contributor_reconciliation_v2"
VISIBLE_CANDIDATE_STATUSES = frozenset({"pending", "accepted", "rejected", "stale"})
MIN_CANDIDATE_SCORE = 65
MAX_ALIAS_GROUP_SIZE = 8
MAX_WORK_GROUP_SIZE = 8


@dataclass(frozen=True)
class _ContributorProfile:
    id: UUID
    handle: str
    display_name: str
    sort_name: str
    disambiguation: str | None
    normalized_display_name: str
    normalized_sort_name: str
    kind: str
    status: str
    created_at: Any
    work_count: int
    confirmed_alias_count: int
    strong_external_id_count: int


@dataclass(frozen=True)
class _CandidateContributorSnapshot:
    handle: str
    display_name: str
    sort_name: str
    kind: str
    status: str
    disambiguation: str | None
    work_count: int


@dataclass
class _PairAccumulator:
    shared_aliases: set[str] = field(default_factory=set)
    shared_confirmed_aliases: set[str] = field(default_factory=set)
    shared_work_keys: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class _ScoredCandidate:
    contributor_a_id: UUID
    contributor_b_id: UUID
    proposed_source_id: UUID
    proposed_target_id: UUID
    source_snapshot: _CandidateContributorSnapshot
    target_snapshot: _CandidateContributorSnapshot
    score: int
    evidence: ContributorReconciliationEvidenceOut


def generate_contributor_reconciliation_run_for_media(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
    actor_user_id: UUID | None = None,
    actor_roles: Collection[str] = frozenset(),
) -> ContributorReconciliationRunOut | None:
    contributor_ids = _active_media_contributor_ids(db, media_id)
    if not contributor_ids:
        return None
    return generate_contributor_reconciliation_run_for_contributors(
        db,
        contributor_ids=contributor_ids,
        reason=reason,
        actor_user_id=actor_user_id,
        actor_roles=actor_roles,
    )


def generate_contributor_reconciliation_run_for_podcast(
    db: Session,
    *,
    podcast_id: UUID,
    reason: str,
    actor_user_id: UUID | None = None,
    actor_roles: Collection[str] = frozenset(),
) -> ContributorReconciliationRunOut | None:
    contributor_ids = _active_podcast_contributor_ids(db, podcast_id)
    if not contributor_ids:
        return None
    return generate_contributor_reconciliation_run_for_contributors(
        db,
        contributor_ids=contributor_ids,
        reason=reason,
        actor_user_id=actor_user_id,
        actor_roles=actor_roles,
    )


def generate_contributor_reconciliation_run_for_contributors(
    db: Session,
    *,
    contributor_ids: Collection[UUID],
    reason: str,
    actor_user_id: UUID | None = None,
    actor_roles: Collection[str] = frozenset(),
) -> ContributorReconciliationRunOut:
    if actor_user_id is not None or actor_roles:
        _require_contributor_curator(actor_roles)
    anchor_ids = tuple(dict.fromkeys(contributor_ids))
    if not anchor_ids:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Contributor reconciliation requires ids")

    def _txn() -> ContributorReconciliationRunOut:
        candidates, evaluated_pair_count = _compute_candidates(
            db,
            anchor_ids=anchor_ids,
            reason=reason,
        )
        run_id = _insert_run(
            db,
            actor_user_id=actor_user_id,
            candidate_count=len(candidates),
            evaluated_pair_count=evaluated_pair_count,
        )
        _stale_existing_pending_candidates(db, anchor_ids=anchor_ids)
        _insert_candidates(db, run_id=run_id, candidates=candidates)
        db.commit()
        return _load_run(db, run_id, include_candidates=True)

    return retry_serializable(db, "generate_contributor_reconciliation_run", _txn)


def refresh_contributor_reconciliation_for_media(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
) -> dict[str, int | str]:
    run = generate_contributor_reconciliation_run_for_media(
        db,
        media_id=media_id,
        reason=reason,
    )
    if run is None:
        return {
            "status": "skipped",
            "reason": "no_active_contributors",
            "contributors": 0,
            "candidates": 0,
        }
    return {
        "status": "success",
        "contributors": len(_active_media_contributor_ids(db, media_id)),
        "candidates": run.candidate_count,
        "run_id": str(run.id),
    }


def refresh_contributor_reconciliation_for_podcast(
    db: Session,
    *,
    podcast_id: UUID,
    reason: str,
) -> dict[str, int | str]:
    run = generate_contributor_reconciliation_run_for_podcast(
        db,
        podcast_id=podcast_id,
        reason=reason,
    )
    contributor_ids = _active_podcast_contributor_ids(db, podcast_id)
    if run is None:
        return {
            "status": "skipped",
            "reason": "no_active_contributors",
            "contributors": 0,
            "candidates": 0,
        }
    return {
        "status": "success",
        "contributors": len(contributor_ids),
        "candidates": run.candidate_count,
        "run_id": str(run.id),
    }


def refresh_contributor_reconciliation_for_contributors(
    db: Session,
    *,
    contributor_ids: Collection[UUID],
    reason: str,
) -> dict[str, int | str]:
    run = generate_contributor_reconciliation_run_for_contributors(
        db,
        contributor_ids=contributor_ids,
        reason=reason,
    )
    return {
        "contributors": len(tuple(dict.fromkeys(contributor_ids))),
        "candidates": run.candidate_count,
        "run_id": str(run.id),
    }


def list_contributor_reconciliation_runs(
    db: Session,
    *,
    limit: int = 20,
) -> list[ContributorReconciliationRunOut]:
    rows = (
        db.execute(
            text(
                """
                SELECT
                    id,
                    actor_user_id,
                    algorithm_version,
                    candidate_count,
                    evaluated_pair_count,
                    created_at
                FROM contributor_reconciliation_runs
                ORDER BY created_at DESC, id DESC
                LIMIT :limit
                """
            ),
            {"limit": limit},
        )
        .mappings()
        .all()
    )
    return [_run_out(row) for row in rows]


def list_contributor_reconciliation_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    contributor_handle: str | None = None,
    status: str = "pending",
    limit: int = 20,
    run_id: UUID | None = None,
) -> list[ContributorReconciliationCandidateOut]:
    if status not in VISIBLE_CANDIDATE_STATUSES:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid reconciliation candidate status")
    contributor_id = (
        _visible_contributor_id_for_handle(db, viewer_id, contributor_handle)
        if contributor_handle is not None
        else None
    )
    rows = (
        db.execute(
            text(
                f"""
                WITH visible_contributors AS ({visible_contributor_ids_cte_sql()})
                SELECT
                    cand.id,
                    cand.run_id,
                    cand.status,
                    cand.score,
                    cand.evidence,
                    cand.decided_by_user_id,
                    cand.created_at,
                    cand.updated_at,
                    cand.decided_at,
                    cand.source_snapshot_handle AS source_handle,
                    cand.source_snapshot_display_name AS source_display_name,
                    cand.source_snapshot_sort_name AS source_sort_name,
                    cand.source_snapshot_kind AS source_kind,
                    cand.source_snapshot_status AS source_status,
                    cand.source_snapshot_disambiguation AS source_disambiguation,
                    cand.source_snapshot_work_count AS source_work_count,
                    cand.target_snapshot_handle AS target_handle,
                    cand.target_snapshot_display_name AS target_display_name,
                    cand.target_snapshot_sort_name AS target_sort_name,
                    cand.target_snapshot_kind AS target_kind,
                    cand.target_snapshot_status AS target_status,
                    cand.target_snapshot_disambiguation AS target_disambiguation,
                    cand.target_snapshot_work_count AS target_work_count
                FROM contributor_reconciliation_candidates cand
                JOIN contributors src_live ON src_live.id = cand.proposed_source_contributor_id
                JOIN contributors tgt_live ON tgt_live.id = cand.proposed_target_contributor_id
                JOIN contributors pair_a ON pair_a.id = cand.contributor_a_id
                JOIN contributors pair_b ON pair_b.id = cand.contributor_b_id
                JOIN visible_contributors visible_src
                  ON visible_src.contributor_id =
                     COALESCE(src_live.merged_into_contributor_id, src_live.id)
                JOIN visible_contributors visible_tgt
                  ON visible_tgt.contributor_id =
                     COALESCE(tgt_live.merged_into_contributor_id, tgt_live.id)
                WHERE (:run_id IS NULL OR cand.run_id = :run_id)
                  AND cand.status = :status
                  AND (
                        :contributor_id IS NULL
                        OR cand.contributor_a_id = :contributor_id
                        OR cand.contributor_b_id = :contributor_id
                        OR COALESCE(pair_a.merged_into_contributor_id, pair_a.id)
                           = :contributor_id
                        OR COALESCE(pair_b.merged_into_contributor_id, pair_b.id)
                           = :contributor_id
                      )
                ORDER BY cand.score DESC, cand.updated_at DESC, cand.id ASC
                LIMIT :limit
                """
            ).bindparams(
                bindparam("contributor_id", type_=PG_UUID(as_uuid=True)),
                bindparam("run_id", type_=PG_UUID(as_uuid=True)),
            ),
            {
                "viewer_id": viewer_id,
                "run_id": run_id,
                "status": status,
                "contributor_id": contributor_id,
                "limit": limit,
            },
        )
        .mappings()
        .all()
    )
    return [_candidate_out(row) for row in rows]


def accept_contributor_reconciliation_candidate(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str],
    candidate_id: UUID,
) -> ContributorOut:
    _require_contributor_curator(actor_roles)
    source_handle, target_handle, _source_id, _target_id = _pending_candidate_direction(
        db,
        candidate_id,
    )

    return contributors_service.merge_contributor(
        db,
        actor_user_id=actor_user_id,
        actor_roles=actor_roles,
        contributor_handle=source_handle,
        request=ContributorMergeRequest(target_handle=target_handle),
        on_merge_transaction=lambda txn_db, source, target: _accept_candidate_in_merge_transaction(
            txn_db,
            candidate_id=candidate_id,
            actor_user_id=actor_user_id,
            source_id=source.id,
            target_id=target.id,
        ),
    )


def _accept_candidate_in_merge_transaction(
    db: Session,
    *,
    candidate_id: UUID,
    actor_user_id: UUID,
    source_id: UUID,
    target_id: UUID,
) -> None:
    row = (
        db.execute(
            text(
                """
                SELECT
                    proposed_source_contributor_id,
                    proposed_target_contributor_id
                FROM contributor_reconciliation_candidates
                WHERE id = :candidate_id
                  AND status = 'pending'
                FOR UPDATE
                """
            ),
            {"candidate_id": candidate_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(
            ApiErrorCode.E_NOT_FOUND,
            "Pending contributor reconciliation candidate not found",
        )
    if row["proposed_source_contributor_id"] != source_id or (
        row["proposed_target_contributor_id"] != target_id
    ):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Contributor reconciliation candidate no longer matches merge direction",
        )
    db.execute(
        text(
            """
            UPDATE contributor_reconciliation_candidates
            SET status = 'accepted',
                decided_by_user_id = :actor_user_id,
                decided_at = now(),
                updated_at = now()
            WHERE id = :candidate_id
              AND status = 'pending'
            """
        ),
        {"candidate_id": candidate_id, "actor_user_id": actor_user_id},
    )
    db.execute(
        text(
            """
            UPDATE contributor_reconciliation_candidates
            SET status = 'stale',
                updated_at = now()
            WHERE id != :candidate_id
              AND status = 'pending'
              AND (
                    contributor_a_id IN (:source_id, :target_id)
                    OR contributor_b_id IN (:source_id, :target_id)
                    OR proposed_source_contributor_id IN (:source_id, :target_id)
                    OR proposed_target_contributor_id IN (:source_id, :target_id)
                  )
            """
        ),
        {
            "candidate_id": candidate_id,
            "source_id": source_id,
            "target_id": target_id,
        },
    )


def reject_contributor_reconciliation_candidate(
    db: Session,
    *,
    actor_user_id: UUID,
    actor_roles: Collection[str],
    candidate_id: UUID,
) -> ContributorReconciliationCandidateOut:
    _require_contributor_curator(actor_roles)

    def _txn() -> None:
        row = (
            db.execute(
                text(
                    """
                SELECT id
                FROM contributor_reconciliation_candidates
                WHERE id = :candidate_id
                  AND status = 'pending'
                FOR UPDATE
                """
                ),
                {"candidate_id": candidate_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError(
                ApiErrorCode.E_NOT_FOUND,
                "Pending contributor reconciliation candidate not found",
            )
        db.execute(
            text(
                """
                UPDATE contributor_reconciliation_candidates
                SET status = 'rejected',
                    decided_by_user_id = :actor_user_id,
                    decided_at = now(),
                    updated_at = now()
                WHERE id = :candidate_id
                  AND status = 'pending'
                """
            ),
            {"candidate_id": candidate_id, "actor_user_id": actor_user_id},
        )
        db.commit()

    retry_serializable(db, "reject_contributor_reconciliation_candidate", _txn)
    row = db.execute(
        text(
            """
            SELECT
                cand.id,
                cand.run_id,
                cand.status,
                cand.score,
                cand.evidence,
                cand.decided_by_user_id,
                cand.created_at,
                cand.updated_at,
                cand.decided_at,
                cand.source_snapshot_handle AS source_handle,
                cand.source_snapshot_display_name AS source_display_name,
                cand.source_snapshot_sort_name AS source_sort_name,
                cand.source_snapshot_kind AS source_kind,
                cand.source_snapshot_status AS source_status,
                cand.source_snapshot_disambiguation AS source_disambiguation,
                cand.source_snapshot_work_count AS source_work_count,
                cand.target_snapshot_handle AS target_handle,
                cand.target_snapshot_display_name AS target_display_name,
                cand.target_snapshot_sort_name AS target_sort_name,
                cand.target_snapshot_kind AS target_kind,
                cand.target_snapshot_status AS target_status,
                cand.target_snapshot_disambiguation AS target_disambiguation,
                cand.target_snapshot_work_count AS target_work_count
            FROM contributor_reconciliation_candidates cand
            WHERE cand.id = :candidate_id
            """
        ),
        {"candidate_id": candidate_id},
    )
    mapped = row.mappings().one_or_none()
    if mapped is None:
        raise NotFoundError(
            ApiErrorCode.E_NOT_FOUND,
            "Contributor reconciliation candidate not found",
        )
    return _candidate_out(mapped)


def _require_contributor_curator(actor_roles: Collection[str]) -> None:
    if contributors_service.CONTRIBUTOR_CURATOR_ROLES.isdisjoint(set(actor_roles)):
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Contributor curator role required")


def _active_media_contributor_ids(db: Session, media_id: UUID) -> tuple[UUID, ...]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT cc.contributor_id
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
              AND c.status IN ('unverified', 'verified')
            ORDER BY cc.contributor_id
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    return tuple(row[0] for row in rows)


def _active_podcast_contributor_ids(db: Session, podcast_id: UUID) -> tuple[UUID, ...]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT cc.contributor_id
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = :podcast_id
              AND c.status IN ('unverified', 'verified')
            ORDER BY cc.contributor_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchall()
    return tuple(row[0] for row in rows)


def _compute_candidates(
    db: Session,
    *,
    anchor_ids: tuple[UUID, ...],
    reason: str,
) -> tuple[list[_ScoredCandidate], int]:
    profiles = _load_profiles(db)
    if not profiles:
        return [], 0
    anchor_set = set(anchor_ids)
    rejected_pairs = _rejected_pairs(db)
    accumulators = _build_pair_accumulators(db, profile_ids=set(profiles))
    candidates: list[_ScoredCandidate] = []
    evaluated_pair_count = 0
    for pair, accumulator in sorted(
        accumulators.items(),
        key=lambda item: (str(item[0][0]), str(item[0][1])),
    ):
        if pair[0] not in anchor_set and pair[1] not in anchor_set:
            continue
        if pair in rejected_pairs:
            continue
        left = profiles.get(pair[0])
        right = profiles.get(pair[1])
        if left is None or right is None:
            continue
        evaluated_pair_count += 1
        score = _candidate_score(left, right, accumulator)
        if score < MIN_CANDIDATE_SCORE:
            continue
        source, target = _proposed_direction(left, right)
        candidates.append(
            _ScoredCandidate(
                contributor_a_id=pair[0],
                contributor_b_id=pair[1],
                proposed_source_id=source.id,
                proposed_target_id=target.id,
                source_snapshot=_snapshot_for_profile(source),
                target_snapshot=_snapshot_for_profile(target),
                score=score,
                evidence=_candidate_evidence(
                    reason=reason,
                    source=source,
                    target=target,
                    accumulator=accumulator,
                    score=score,
                ),
            )
        )
    candidates.sort(
        key=lambda item: (
            -item.score,
            str(item.proposed_target_id),
            str(item.proposed_source_id),
            str(item.contributor_a_id),
            str(item.contributor_b_id),
        )
    )
    return candidates, evaluated_pair_count


def _snapshot_for_profile(profile: _ContributorProfile) -> _CandidateContributorSnapshot:
    return _CandidateContributorSnapshot(
        handle=profile.handle,
        display_name=profile.display_name,
        sort_name=profile.sort_name,
        kind=profile.kind,
        status=profile.status,
        disambiguation=profile.disambiguation,
        work_count=profile.work_count,
    )


def _rejected_pairs(db: Session) -> set[tuple[UUID, UUID]]:
    rows = db.execute(
        text(
            """
            SELECT contributor_a_id, contributor_b_id
            FROM contributor_reconciliation_candidates
            WHERE status = 'rejected'
            """
        )
    ).fetchall()
    return {_ordered_pair(row[0], row[1]) for row in rows}


def _build_pair_accumulators(
    db: Session,
    *,
    profile_ids: set[UUID],
) -> dict[tuple[UUID, UUID], _PairAccumulator]:
    accumulators: dict[tuple[UUID, UUID], _PairAccumulator] = {}
    alias_groups: dict[str, dict[UUID, set[str]]] = defaultdict(lambda: defaultdict(set))
    for row in _load_alias_rows(db):
        contributor_id = row["contributor_id"]
        if contributor_id not in profile_ids:
            continue
        alias_groups[row["normalized_alias"]][contributor_id].add(row["source"])
    for normalized_alias, contributor_sources in alias_groups.items():
        contributor_ids = sorted(contributor_sources, key=str)
        if len(contributor_ids) < 2 or len(contributor_ids) > MAX_ALIAS_GROUP_SIZE:
            continue
        for left_id, right_id in combinations(contributor_ids, 2):
            accumulator = accumulators.setdefault(
                _ordered_pair(left_id, right_id),
                _PairAccumulator(),
            )
            accumulator.shared_aliases.add(normalized_alias)
            if (
                contributor_sources[left_id] & CONFIRMED_ALIAS_SOURCES
                or contributor_sources[right_id] & CONFIRMED_ALIAS_SOURCES
            ):
                accumulator.shared_confirmed_aliases.add(normalized_alias)

    work_groups: dict[str, set[UUID]] = defaultdict(set)
    for row in _load_work_rows(db):
        contributor_id = row["contributor_id"]
        if contributor_id not in profile_ids:
            continue
        work_groups[row["match_key"]].add(contributor_id)
    for match_key, contributor_ids_set in work_groups.items():
        contributor_ids = sorted(contributor_ids_set, key=str)
        if len(contributor_ids) < 2 or len(contributor_ids) > MAX_WORK_GROUP_SIZE:
            continue
        work_key = match_key.split("|", 1)[1]
        for left_id, right_id in combinations(contributor_ids, 2):
            accumulator = accumulators.setdefault(
                _ordered_pair(left_id, right_id),
                _PairAccumulator(),
            )
            accumulator.shared_work_keys.add(work_key)
    return accumulators


def _load_profiles(db: Session) -> dict[UUID, _ContributorProfile]:
    rows = (
        db.execute(
            text(
                f"""
                WITH work_counts AS ({_work_counts_sql()}),
                     confirmed_alias_counts AS (
                         SELECT contributor_id, count(DISTINCT normalized_alias) AS confirmed_alias_count
                         FROM contributor_aliases
                         WHERE source = ANY(:confirmed_alias_sources)
                         GROUP BY contributor_id
                     ),
                     strong_external_counts AS (
                         SELECT contributor_id, count(*) AS strong_external_id_count
                         FROM contributor_external_ids
                         WHERE authority = ANY(:strong_external_id_authorities)
                         GROUP BY contributor_id
                     )
                SELECT
                    c.id,
                    c.handle,
                    c.display_name,
                    c.sort_name,
                    c.disambiguation,
                    c.kind,
                    c.status,
                    c.created_at,
                    COALESCE(work_counts.work_count, 0) AS work_count,
                    COALESCE(confirmed_alias_counts.confirmed_alias_count, 0) AS confirmed_alias_count,
                    COALESCE(strong_external_counts.strong_external_id_count, 0) AS strong_external_id_count
                FROM contributors c
                LEFT JOIN work_counts ON work_counts.contributor_id = c.id
                LEFT JOIN confirmed_alias_counts ON confirmed_alias_counts.contributor_id = c.id
                LEFT JOIN strong_external_counts ON strong_external_counts.contributor_id = c.id
                WHERE c.status IN ('unverified', 'verified')
                """
            ),
            {
                "confirmed_alias_sources": sorted(CONFIRMED_ALIAS_SOURCES),
                "strong_external_id_authorities": sorted(
                    STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES
                ),
            },
        )
        .mappings()
        .all()
    )
    return {
        row["id"]: _ContributorProfile(
            id=row["id"],
            handle=row["handle"],
            display_name=row["display_name"],
            sort_name=row["sort_name"],
            disambiguation=row["disambiguation"],
            normalized_display_name=normalize_contributor_name(row["display_name"]),
            normalized_sort_name=normalize_contributor_name(row["sort_name"]),
            kind=row["kind"],
            status=row["status"],
            created_at=row["created_at"],
            work_count=int(row["work_count"] or 0),
            confirmed_alias_count=int(row["confirmed_alias_count"] or 0),
            strong_external_id_count=int(row["strong_external_id_count"] or 0),
        )
        for row in rows
    }


def _load_alias_rows(db: Session) -> Sequence[RowMapping]:
    return (
        db.execute(
            text(
                """
                SELECT
                    ca.contributor_id,
                    ca.normalized_alias,
                    ca.source
                FROM contributor_aliases ca
                JOIN contributors c ON c.id = ca.contributor_id
                WHERE c.status IN ('unverified', 'verified')
                  AND ca.normalized_alias != ''
                """
            )
        )
        .mappings()
        .all()
    )


def _load_work_rows(db: Session) -> Sequence[RowMapping]:
    return (
        db.execute(
            text(
                """
                SELECT
                    cc.contributor_id,
                    cc.role || '|' || COALESCE(
                        CASE
                            WHEN cc.media_id IS NOT NULL THEN 'media:' || cc.media_id::text
                            WHEN cc.podcast_id IS NOT NULL THEN 'podcast:' || cc.podcast_id::text
                            ELSE 'gutenberg:' || cc.project_gutenberg_catalog_ebook_id::text
                        END,
                        ''
                    ) || '|' || cc.normalized_credited_name AS match_key
                FROM contributor_credits cc
                JOIN contributors c ON c.id = cc.contributor_id
                WHERE c.status IN ('unverified', 'verified')
                  AND cc.normalized_credited_name != ''
                """
            )
        )
        .mappings()
        .all()
    )


def _candidate_score(
    left: _ContributorProfile,
    right: _ContributorProfile,
    accumulator: _PairAccumulator,
) -> int:
    score = 0
    if accumulator.shared_aliases:
        score += 45 + min(10, max(len(accumulator.shared_aliases) - 1, 0) * 5)
    if accumulator.shared_confirmed_aliases:
        score += 15
    if left.normalized_display_name == right.normalized_display_name:
        score += 10
    if left.normalized_sort_name == right.normalized_sort_name:
        score += 5
    if accumulator.shared_work_keys:
        score += 20 + min(10, max(len(accumulator.shared_work_keys) - 1, 0) * 5)
    if left.kind == right.kind:
        score += 5
    if left.status == right.status == "verified":
        score += 5
    return min(score, 100)


def _proposed_direction(
    left: _ContributorProfile,
    right: _ContributorProfile,
) -> tuple[_ContributorProfile, _ContributorProfile]:
    ranked = sorted(
        (left, right),
        key=lambda item: (
            0 if item.status == "verified" else 1,
            -item.strong_external_id_count,
            -item.confirmed_alias_count,
            -item.work_count,
            item.created_at,
            item.handle,
        ),
    )
    target = ranked[0]
    source = ranked[1]
    return source, target


def _candidate_evidence(
    *,
    reason: str,
    source: _ContributorProfile,
    target: _ContributorProfile,
    accumulator: _PairAccumulator,
    score: int,
) -> ContributorReconciliationEvidenceOut:
    signals: list[ContributorReconciliationSignal] = []
    if accumulator.shared_aliases:
        signals.append("shared_alias")
    if accumulator.shared_confirmed_aliases:
        signals.append("shared_confirmed_alias")
    if accumulator.shared_work_keys:
        signals.append("shared_work")
    if source.normalized_display_name == target.normalized_display_name:
        signals.append("same_display_name")
    if source.normalized_sort_name == target.normalized_sort_name:
        signals.append("same_sort_name")
    if source.kind == target.kind:
        signals.append("same_kind")
    return ContributorReconciliationEvidenceOut(
        matcher="deterministic",
        algorithm_version=RECONCILIATION_ALGORITHM_VERSION,
        reason=reason,
        score=score,
        signals=signals,
        shared_aliases=sorted(accumulator.shared_aliases),
        shared_confirmed_aliases=sorted(accumulator.shared_confirmed_aliases),
        shared_work_count=len(accumulator.shared_work_keys),
        source_handle=source.handle,
        target_handle=target.handle,
        source_work_count=source.work_count,
        target_work_count=target.work_count,
        source_confirmed_alias_count=source.confirmed_alias_count,
        target_confirmed_alias_count=target.confirmed_alias_count,
        source_strong_external_id_count=source.strong_external_id_count,
        target_strong_external_id_count=target.strong_external_id_count,
    )


def _insert_run(
    db: Session,
    *,
    actor_user_id: UUID | None,
    candidate_count: int,
    evaluated_pair_count: int,
) -> UUID:
    row = db.execute(
        text(
            """
            INSERT INTO contributor_reconciliation_runs (
                actor_user_id,
                algorithm_version,
                candidate_count,
                evaluated_pair_count
            )
            VALUES (
                :actor_user_id,
                :algorithm_version,
                :candidate_count,
                :evaluated_pair_count
            )
            RETURNING id
            """
        ),
        {
            "actor_user_id": actor_user_id,
            "algorithm_version": RECONCILIATION_ALGORITHM_VERSION,
            "candidate_count": candidate_count,
            "evaluated_pair_count": evaluated_pair_count,
        },
    ).one()
    return row[0]


def _insert_candidates(
    db: Session,
    *,
    run_id: UUID,
    candidates: Sequence[_ScoredCandidate],
) -> None:
    if not candidates:
        return
    db.execute(
        text(
            """
            INSERT INTO contributor_reconciliation_candidates (
                run_id,
                contributor_a_id,
                contributor_b_id,
                proposed_source_contributor_id,
                proposed_target_contributor_id,
                source_snapshot_handle,
                source_snapshot_display_name,
                source_snapshot_sort_name,
                source_snapshot_kind,
                source_snapshot_status,
                source_snapshot_disambiguation,
                source_snapshot_work_count,
                target_snapshot_handle,
                target_snapshot_display_name,
                target_snapshot_sort_name,
                target_snapshot_kind,
                target_snapshot_status,
                target_snapshot_disambiguation,
                target_snapshot_work_count,
                status,
                score,
                evidence
            )
            VALUES (
                :run_id,
                :contributor_a_id,
                :contributor_b_id,
                :proposed_source_contributor_id,
                :proposed_target_contributor_id,
                :source_snapshot_handle,
                :source_snapshot_display_name,
                :source_snapshot_sort_name,
                :source_snapshot_kind,
                :source_snapshot_status,
                :source_snapshot_disambiguation,
                :source_snapshot_work_count,
                :target_snapshot_handle,
                :target_snapshot_display_name,
                :target_snapshot_sort_name,
                :target_snapshot_kind,
                :target_snapshot_status,
                :target_snapshot_disambiguation,
                :target_snapshot_work_count,
                'pending',
                :score,
                :evidence
            )
            """
        ).bindparams(bindparam("evidence", type_=JSONB)),
        [
            {
                "run_id": run_id,
                "contributor_a_id": candidate.contributor_a_id,
                "contributor_b_id": candidate.contributor_b_id,
                "proposed_source_contributor_id": candidate.proposed_source_id,
                "proposed_target_contributor_id": candidate.proposed_target_id,
                "source_snapshot_handle": candidate.source_snapshot.handle,
                "source_snapshot_display_name": candidate.source_snapshot.display_name,
                "source_snapshot_sort_name": candidate.source_snapshot.sort_name,
                "source_snapshot_kind": candidate.source_snapshot.kind,
                "source_snapshot_status": candidate.source_snapshot.status,
                "source_snapshot_disambiguation": candidate.source_snapshot.disambiguation,
                "source_snapshot_work_count": candidate.source_snapshot.work_count,
                "target_snapshot_handle": candidate.target_snapshot.handle,
                "target_snapshot_display_name": candidate.target_snapshot.display_name,
                "target_snapshot_sort_name": candidate.target_snapshot.sort_name,
                "target_snapshot_kind": candidate.target_snapshot.kind,
                "target_snapshot_status": candidate.target_snapshot.status,
                "target_snapshot_disambiguation": candidate.target_snapshot.disambiguation,
                "target_snapshot_work_count": candidate.target_snapshot.work_count,
                "score": candidate.score,
                "evidence": candidate.evidence.model_dump(mode="json"),
            }
            for candidate in candidates
        ],
    )


def _stale_existing_pending_candidates(
    db: Session,
    *,
    anchor_ids: Sequence[UUID],
) -> None:
    if not anchor_ids:
        return
    db.execute(
        text(
            """
            UPDATE contributor_reconciliation_candidates existing
            SET status = 'stale',
                updated_at = now()
            WHERE existing.status = 'pending'
              AND (
                    existing.contributor_a_id = ANY(:anchor_ids)
                    OR existing.contributor_b_id = ANY(:anchor_ids)
              )
            """
        ),
        {"anchor_ids": list(anchor_ids)},
    )


def _work_counts_sql() -> str:
    return """
        SELECT
            contributor_id,
            count(DISTINCT COALESCE(
                media_id::text,
                podcast_id::text,
                project_gutenberg_catalog_ebook_id::text
            )) AS work_count
        FROM contributor_credits
        GROUP BY contributor_id
    """


def _load_run(
    db: Session,
    run_id: UUID,
    *,
    include_candidates: bool,
) -> ContributorReconciliationRunOut:
    row = (
        db.execute(
            text(
                """
                SELECT
                    id,
                    actor_user_id,
                    algorithm_version,
                    candidate_count,
                    evaluated_pair_count,
                    created_at
                FROM contributor_reconciliation_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor reconciliation run not found")
    out = _run_out(row)
    if include_candidates:
        out.candidates = _list_candidates_for_run(db, run_id)
    return out


def _list_candidates_for_run(
    db: Session,
    run_id: UUID,
) -> list[ContributorReconciliationCandidateOut]:
    rows = (
        db.execute(
            text(
                """
                SELECT
                    cand.id,
                    cand.run_id,
                    cand.status,
                    cand.score,
                    cand.evidence,
                    cand.decided_by_user_id,
                    cand.created_at,
                    cand.updated_at,
                    cand.decided_at,
                    cand.source_snapshot_handle AS source_handle,
                    cand.source_snapshot_display_name AS source_display_name,
                    cand.source_snapshot_sort_name AS source_sort_name,
                    cand.source_snapshot_kind AS source_kind,
                    cand.source_snapshot_status AS source_status,
                    cand.source_snapshot_disambiguation AS source_disambiguation,
                    cand.source_snapshot_work_count AS source_work_count,
                    cand.target_snapshot_handle AS target_handle,
                    cand.target_snapshot_display_name AS target_display_name,
                    cand.target_snapshot_sort_name AS target_sort_name,
                    cand.target_snapshot_kind AS target_kind,
                    cand.target_snapshot_status AS target_status,
                    cand.target_snapshot_disambiguation AS target_disambiguation,
                    cand.target_snapshot_work_count AS target_work_count
                FROM contributor_reconciliation_candidates cand
                WHERE cand.run_id = :run_id
                ORDER BY cand.score DESC, cand.id ASC
                """
            ),
            {"run_id": run_id},
        )
        .mappings()
        .all()
    )
    return [_candidate_out(row) for row in rows]


def _run_out(row: RowMapping) -> ContributorReconciliationRunOut:
    return ContributorReconciliationRunOut(
        id=row["id"],
        algorithm_version=row["algorithm_version"],
        candidate_count=int(row["candidate_count"] or 0),
        evaluated_pair_count=int(row["evaluated_pair_count"] or 0),
        actor_user_id=row["actor_user_id"],
        created_at=row["created_at"],
    )


def _candidate_out(row: RowMapping) -> ContributorReconciliationCandidateOut:
    return ContributorReconciliationCandidateOut(
        id=row["id"],
        run_id=row["run_id"],
        status=row["status"],
        score=int(row["score"]),
        source_contributor=ContributorReconciliationContributorOut(
            handle=row["source_handle"],
            href=f"/authors/{row['source_handle']}",
            display_name=row["source_display_name"],
            sort_name=row["source_sort_name"],
            kind=row["source_kind"],
            status=row["source_status"],
            disambiguation=row["source_disambiguation"],
            work_count=int(row["source_work_count"] or 0),
        ),
        target_contributor=ContributorReconciliationContributorOut(
            handle=row["target_handle"],
            href=f"/authors/{row['target_handle']}",
            display_name=row["target_display_name"],
            sort_name=row["target_sort_name"],
            kind=row["target_kind"],
            status=row["target_status"],
            disambiguation=row["target_disambiguation"],
            work_count=int(row["target_work_count"] or 0),
        ),
        evidence=ContributorReconciliationEvidenceOut.model_validate(row["evidence"] or {}),
        decided_by_user_id=row["decided_by_user_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        decided_at=row["decided_at"],
    )


def _visible_contributor_id_for_handle(
    db: Session,
    viewer_id: UUID,
    contributor_handle: str,
) -> UUID:
    canonical_ids = contributors_service.resolve_canonical_contributor_ids(
        db,
        [contributor_handle],
    )
    if not canonical_ids:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    canonical_id = canonical_ids[0]
    row = (
        db.execute(
            text(
                f"""
                WITH visible_contributors AS ({visible_contributor_ids_cte_sql()})
                SELECT c.id
                FROM contributors c
                JOIN visible_contributors visible ON visible.contributor_id = c.id
                WHERE c.id = :contributor_id
                  AND c.status IN ('unverified', 'verified')
                """
            ),
            {"viewer_id": viewer_id, "contributor_id": canonical_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return row["id"]


def _pending_candidate_direction(
    db: Session,
    candidate_id: UUID,
) -> tuple[str, str, UUID, UUID]:
    row = (
        db.execute(
            text(
                """
                SELECT
                    source.id AS source_id,
                    source.handle AS source_handle,
                    target.id AS target_id,
                    target.handle AS target_handle
                FROM contributor_reconciliation_candidates cand
                JOIN contributors source ON source.id = cand.proposed_source_contributor_id
                JOIN contributors target ON target.id = cand.proposed_target_contributor_id
                WHERE cand.id = :candidate_id
                  AND cand.status = 'pending'
                  AND source.status IN ('unverified', 'verified')
                  AND target.status IN ('unverified', 'verified')
                """
            ),
            {"candidate_id": candidate_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(
            ApiErrorCode.E_NOT_FOUND,
            "Pending contributor reconciliation candidate not found",
        )
    return row["source_handle"], row["target_handle"], row["source_id"], row["target_id"]


def _ordered_pair(left_id: UUID, right_id: UUID) -> tuple[UUID, UUID]:
    ordered = sorted((left_id, right_id), key=str)
    return ordered[0], ordered[1]
