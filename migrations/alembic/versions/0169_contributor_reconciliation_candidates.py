"""Contributor reconciliation candidates hard cutover.

Revision ID: 0169
Revises: 0168
Create Date: 2026-07-07
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0169"
down_revision: str | Sequence[str] | None = "0168"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE contributor_reconciliation_runs (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_user_id uuid REFERENCES users(id),
            algorithm_version text NOT NULL,
            candidate_count integer NOT NULL,
            evaluated_pair_count integer NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        CREATE TABLE contributor_reconciliation_candidates (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id uuid NOT NULL REFERENCES contributor_reconciliation_runs(id),
            contributor_a_id uuid NOT NULL REFERENCES contributors(id),
            contributor_b_id uuid NOT NULL REFERENCES contributors(id),
            proposed_source_contributor_id uuid NOT NULL REFERENCES contributors(id),
            proposed_target_contributor_id uuid NOT NULL REFERENCES contributors(id),
            source_snapshot_handle text NOT NULL,
            source_snapshot_display_name text NOT NULL,
            source_snapshot_sort_name text NOT NULL,
            source_snapshot_kind text NOT NULL,
            source_snapshot_status text NOT NULL,
            source_snapshot_disambiguation text,
            source_snapshot_work_count integer NOT NULL,
            target_snapshot_handle text NOT NULL,
            target_snapshot_display_name text NOT NULL,
            target_snapshot_sort_name text NOT NULL,
            target_snapshot_kind text NOT NULL,
            target_snapshot_status text NOT NULL,
            target_snapshot_disambiguation text,
            target_snapshot_work_count integer NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            score integer NOT NULL,
            evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
            decided_by_user_id uuid REFERENCES users(id),
            decided_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_contributor_reconciliation_candidates_run_pair UNIQUE (
                run_id,
                contributor_a_id,
                contributor_b_id
            )
        )
    """)
    op.create_index(
        "ix_contributor_reconciliation_candidates_run_status_score",
        "contributor_reconciliation_candidates",
        ["run_id", "status", "score"],
    )
    op.create_index(
        "ix_contributor_reconciliation_candidates_a_status_score",
        "contributor_reconciliation_candidates",
        ["contributor_a_id", "status", "score"],
    )
    op.create_index(
        "ix_contributor_reconciliation_candidates_b_status_score",
        "contributor_reconciliation_candidates",
        ["contributor_b_id", "status", "score"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0169 is not reversible")
