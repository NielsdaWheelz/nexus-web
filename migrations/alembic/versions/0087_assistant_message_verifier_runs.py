"""Add assistant message verifier run ledger.

Revision ID: 0087
Revises: 0086_source_manifests
Create Date: 2026-05-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0087"
down_revision: str | None = "0086_source_manifests"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "assistant_message_verifier_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("prompt_assembly_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("verifier_name", sa.Text(), nullable=False),
        sa.Column("verifier_version", sa.Text(), nullable=False),
        sa.Column("verifier_status", sa.Text(), nullable=False),
        sa.Column("support_status", sa.Text(), nullable=False),
        sa.Column("claim_count", sa.Integer(), nullable=False),
        sa.Column("supported_claim_count", sa.Integer(), nullable=False),
        sa.Column("unsupported_claim_count", sa.Integer(), nullable=False),
        sa.Column("not_enough_evidence_count", sa.Integer(), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(verifier_name) BETWEEN 1 AND 128",
            name="ck_assistant_verifier_runs_name_length",
        ),
        sa.CheckConstraint(
            "char_length(verifier_version) BETWEEN 1 AND 128",
            name="ck_assistant_verifier_runs_version_length",
        ),
        sa.CheckConstraint(
            "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
            name="ck_assistant_verifier_runs_status",
        ),
        sa.CheckConstraint(
            """
            support_status IN (
                'supported',
                'partially_supported',
                'contradicted',
                'not_enough_evidence',
                'out_of_scope',
                'not_source_grounded'
            )
            """,
            name="ck_assistant_verifier_runs_support_status",
        ),
        sa.CheckConstraint(
            """
            claim_count >= 0
            AND supported_claim_count >= 0
            AND unsupported_claim_count >= 0
            AND not_enough_evidence_count >= 0
            """,
            name="ck_assistant_verifier_runs_counts",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_assistant_verifier_runs_metadata_object",
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["chat_run_id"], ["chat_runs.id"]),
        sa.ForeignKeyConstraint(
            ["prompt_assembly_id"],
            ["chat_prompt_assemblies.id"],
        ),
    )
    op.create_index(
        "idx_assistant_verifier_runs_message_created",
        "assistant_message_verifier_runs",
        ["message_id", "created_at", "id"],
    )
    op.create_index(
        "idx_assistant_verifier_runs_chat_run",
        "assistant_message_verifier_runs",
        ["chat_run_id"],
    )

    op.add_column(
        "assistant_message_evidence_summaries",
        sa.Column("verifier_run_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "assistant_message_claims",
        sa.Column("verifier_run_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_assistant_evidence_summaries_verifier_run",
        "assistant_message_evidence_summaries",
        "assistant_message_verifier_runs",
        ["verifier_run_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_assistant_claims_verifier_run",
        "assistant_message_claims",
        "assistant_message_verifier_runs",
        ["verifier_run_id"],
        ["id"],
    )

    op.drop_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        type_="check",
    )
    op.execute(
        """
        UPDATE assistant_message_evidence_summaries
        SET verifier_status = 'lexical_baseline'
        WHERE verifier_status = 'verified'
        """
    )
    op.execute(
        """
        UPDATE assistant_message_claims
        SET verifier_status = 'lexical_baseline'
        WHERE verifier_status = 'verified'
        """
    )
    op.create_check_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        "verifier_status IN ('lexical_baseline', 'llm_verified', 'parse_failed', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        type_="check",
    )
    op.drop_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        type_="check",
    )
    op.execute(
        """
        UPDATE assistant_message_evidence_summaries
        SET verifier_status = 'verified'
        WHERE verifier_status = 'lexical_baseline'
        """
    )
    op.execute(
        """
        UPDATE assistant_message_claims
        SET verifier_status = 'verified'
        WHERE verifier_status = 'lexical_baseline'
        """
    )
    op.create_check_constraint(
        "ck_assistant_evidence_summaries_verifier_status",
        "assistant_message_evidence_summaries",
        "verifier_status IN ('verified', 'failed')",
    )
    op.create_check_constraint(
        "ck_assistant_claims_verifier_status",
        "assistant_message_claims",
        "verifier_status IN ('verified', 'failed')",
    )

    op.drop_constraint(
        "fk_assistant_claims_verifier_run",
        "assistant_message_claims",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_assistant_evidence_summaries_verifier_run",
        "assistant_message_evidence_summaries",
        type_="foreignkey",
    )
    op.drop_column("assistant_message_claims", "verifier_run_id")
    op.drop_column("assistant_message_evidence_summaries", "verifier_run_id")
    op.drop_index(
        "idx_assistant_verifier_runs_chat_run",
        table_name="assistant_message_verifier_runs",
    )
    op.drop_index(
        "idx_assistant_verifier_runs_message_created",
        table_name="assistant_message_verifier_runs",
    )
    op.drop_table("assistant_message_verifier_runs")
