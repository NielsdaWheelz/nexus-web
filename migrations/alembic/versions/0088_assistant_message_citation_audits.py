"""Add assistant message citation audit ledger.

Revision ID: 0088
Revises: 0087
Create Date: 2026-05-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0088"
down_revision: str | None = "0087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "assistant_message_citation_audits",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("verifier_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("supported_claim_count", sa.Integer(), nullable=False),
        sa.Column("supported_claims_with_valid_offsets_count", sa.Integer(), nullable=False),
        sa.Column("supported_claims_with_citation_count", sa.Integer(), nullable=False),
        sa.Column("missing_locator_count", sa.Integer(), nullable=False),
        sa.Column("missing_source_version_count", sa.Integer(), nullable=False),
        sa.Column("supported_claims_have_valid_offsets", sa.Boolean(), nullable=False),
        sa.Column("supported_claims_have_citation_placement", sa.Boolean(), nullable=False),
        sa.Column("claim_evidence_has_required_locators", sa.Boolean(), nullable=False),
        sa.Column("claim_evidence_has_source_versions", sa.Boolean(), nullable=False),
        sa.Column(
            "details",
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
            """
            supported_claim_count >= 0
            AND supported_claims_with_valid_offsets_count >= 0
            AND supported_claims_with_citation_count >= 0
            AND missing_locator_count >= 0
            AND missing_source_version_count >= 0
            """,
            name="ck_assistant_citation_audits_counts",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(details) = 'object'",
            name="ck_assistant_citation_audits_details_object",
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["chat_run_id"], ["chat_runs.id"]),
        sa.ForeignKeyConstraint(
            ["verifier_run_id"],
            ["assistant_message_verifier_runs.id"],
        ),
        sa.UniqueConstraint("message_id", name="uix_assistant_citation_audits_message"),
    )
    op.create_index(
        "idx_assistant_citation_audits_chat_run",
        "assistant_message_citation_audits",
        ["chat_run_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_assistant_citation_audits_chat_run",
        table_name="assistant_message_citation_audits",
    )
    op.drop_table("assistant_message_citation_audits")
