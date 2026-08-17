"""Add the native-agent audit ledger and hard-cut legacy metadata call rows.

Revision ID: 0216
Revises: 0215
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0216"
down_revision: str | Sequence[str] | None = "0215"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_turns",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_kind", sa.Text(), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("turn_seq", sa.Integer(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("operation_revision", sa.Text(), nullable=False),
        sa.Column("backend", sa.Text(), nullable=False),
        sa.Column("transport", sa.Text(), nullable=False),
        sa.Column("auth_profile", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("requested_reasoning", sa.Text(), nullable=False),
        sa.Column("request_fingerprint", sa.Text(), nullable=False),
        sa.Column("policy_fingerprint", sa.Text(), nullable=False),
        sa.Column("output_schema_fingerprint", sa.Text(), nullable=False),
        sa.Column("session_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_detail", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=True),
        sa.Column("cache_read_input_tokens", sa.Integer(), nullable=True),
        sa.Column("cache_write_input_tokens", sa.Integer(), nullable=True),
        sa.Column("sdk_version", sa.Text(), nullable=True),
        sa.Column("runtime_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_kind",
            "owner_id",
            "turn_seq",
            name="uq_agent_turns_owner_turn_seq",
        ),
    )

    op.execute("DELETE FROM llm_calls WHERE owner_kind = 'media_enrichment'")
    op.drop_constraint("ck_llm_calls_owner_kind", "llm_calls", type_="check")
    op.create_check_constraint(
        "ck_llm_calls_owner_kind",
        "llm_calls",
        "owner_kind IN ('chat_run', 'oracle_reading', 'artifact_build', "
        "'artifact_learn_request', 'media_summary', 'synapse_scan', 'dawn_write')",
    )
    op.execute(
        "UPDATE background_jobs "
        "SET payload = jsonb_set(payload, '{capacity_wait_index}', '0'::jsonb, true), "
        "max_attempts = 2 "
        "WHERE kind = 'enrich_metadata'"
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0216 is an irreversible hard cutover: deleted metadata call history "
        "cannot be reconstructed"
    )
