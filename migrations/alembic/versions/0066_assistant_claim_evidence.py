"""Add assistant claim/evidence citation tables.

Revision ID: 0066
Revises: 0065
Create Date: 2026-05-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0066"
down_revision: str | None = "0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("message_retrievals", sa.Column("source_title", sa.Text(), nullable=True))
    op.add_column("message_retrievals", sa.Column("section_label", sa.Text(), nullable=True))
    op.add_column("message_retrievals", sa.Column("exact_snippet", sa.Text(), nullable=True))
    op.add_column("message_retrievals", sa.Column("snippet_prefix", sa.Text(), nullable=True))
    op.add_column("message_retrievals", sa.Column("snippet_suffix", sa.Text(), nullable=True))
    op.add_column("message_retrievals", sa.Column("locator", postgresql.JSONB(), nullable=True))
    op.add_column(
        "message_retrievals",
        sa.Column("retrieval_status", sa.Text(), server_default="retrieved", nullable=False),
    )
    op.add_column(
        "message_retrievals",
        sa.Column(
            "included_in_prompt",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column("message_retrievals", sa.Column("source_version", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_message_retrievals_locator_object",
        "message_retrievals",
        "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
    )
    op.create_check_constraint(
        "ck_message_retrievals_status",
        "message_retrievals",
        """
        retrieval_status IN (
            'attached_context',
            'retrieved',
            'selected',
            'included_in_prompt',
            'excluded_by_budget',
            'excluded_by_scope',
            'web_result'
        )
        """,
    )

    op.create_table(
        "assistant_message_evidence_summaries",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("scope_type", sa.Text(), nullable=False),
        sa.Column("scope_ref", postgresql.JSONB(), nullable=True),
        sa.Column("retrieval_status", sa.Text(), nullable=False),
        sa.Column("support_status", sa.Text(), nullable=False),
        sa.Column("verifier_status", sa.Text(), nullable=False),
        sa.Column("claim_count", sa.Integer(), nullable=False),
        sa.Column("supported_claim_count", sa.Integer(), nullable=False),
        sa.Column("unsupported_claim_count", sa.Integer(), nullable=False),
        sa.Column("not_enough_evidence_count", sa.Integer(), nullable=False),
        sa.Column("prompt_assembly_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "scope_type IN ('general', 'media', 'library')",
            name="ck_assistant_evidence_summaries_scope_type",
        ),
        sa.CheckConstraint(
            "scope_ref IS NULL OR scope_ref = 'null'::jsonb OR jsonb_typeof(scope_ref) = 'object'",
            name="ck_assistant_evidence_summaries_scope_ref_object",
        ),
        sa.CheckConstraint(
            """
            retrieval_status IN (
                'attached_context',
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_assistant_evidence_summaries_retrieval_status",
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
            name="ck_assistant_evidence_summaries_support_status",
        ),
        sa.CheckConstraint(
            "verifier_status IN ('verified', 'failed')",
            name="ck_assistant_evidence_summaries_verifier_status",
        ),
        sa.CheckConstraint(
            """
            claim_count >= 0
            AND supported_claim_count >= 0
            AND unsupported_claim_count >= 0
            AND not_enough_evidence_count >= 0
            """,
            name="ck_assistant_evidence_summaries_counts",
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["prompt_assembly_id"],
            ["chat_prompt_assemblies.id"],
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("message_id", name="uix_assistant_evidence_summaries_message"),
    )

    op.create_table(
        "assistant_message_claims",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("claim_text", sa.Text(), nullable=False),
        sa.Column("answer_start_offset", sa.Integer(), nullable=True),
        sa.Column("answer_end_offset", sa.Integer(), nullable=True),
        sa.Column("claim_kind", sa.Text(), nullable=False),
        sa.Column("support_status", sa.Text(), nullable=False),
        sa.Column("verifier_status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_assistant_claims_ordinal"),
        sa.CheckConstraint(
            "char_length(btrim(claim_text)) BETWEEN 1 AND 50000",
            name="ck_assistant_claims_text_length",
        ),
        sa.CheckConstraint(
            """
            (
                answer_start_offset IS NULL
                AND answer_end_offset IS NULL
            )
            OR (
                answer_start_offset >= 0
                AND answer_end_offset > answer_start_offset
            )
            """,
            name="ck_assistant_claims_offsets",
        ),
        sa.CheckConstraint(
            "claim_kind IN ('answer', 'insufficient_evidence')",
            name="ck_assistant_claims_kind",
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
            name="ck_assistant_claims_support_status",
        ),
        sa.CheckConstraint(
            "verifier_status IN ('verified', 'failed')",
            name="ck_assistant_claims_verifier_status",
        ),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("message_id", "ordinal", name="uix_assistant_claims_message_ordinal"),
    )
    op.create_index(
        "idx_assistant_claims_message",
        "assistant_message_claims",
        ["message_id", "ordinal"],
    )

    op.create_table(
        "assistant_message_claim_evidence",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("claim_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("evidence_role", sa.Text(), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(), nullable=False),
        sa.Column("retrieval_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("context_ref", postgresql.JSONB(), nullable=True),
        sa.Column("result_ref", postgresql.JSONB(), nullable=True),
        sa.Column("exact_snippet", sa.Text(), nullable=True),
        sa.Column("snippet_prefix", sa.Text(), nullable=True),
        sa.Column("snippet_suffix", sa.Text(), nullable=True),
        sa.Column("locator", postgresql.JSONB(), nullable=True),
        sa.Column("deep_link", sa.Text(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("retrieval_status", sa.Text(), nullable=False),
        sa.Column("selected", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("included_in_prompt", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("source_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_assistant_claim_evidence_ordinal"),
        sa.CheckConstraint(
            "evidence_role IN ('supports', 'contradicts', 'context', 'scope_boundary')",
            name="ck_assistant_claim_evidence_role",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_assistant_claim_evidence_source_ref_object",
        ),
        sa.CheckConstraint(
            "context_ref IS NULL OR context_ref = 'null'::jsonb OR jsonb_typeof(context_ref) = 'object'",
            name="ck_assistant_claim_evidence_context_ref_object",
        ),
        sa.CheckConstraint(
            "result_ref IS NULL OR result_ref = 'null'::jsonb OR jsonb_typeof(result_ref) = 'object'",
            name="ck_assistant_claim_evidence_result_ref_object",
        ),
        sa.CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_assistant_claim_evidence_locator_object",
        ),
        sa.CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_assistant_claim_evidence_score",
        ),
        sa.CheckConstraint(
            """
            retrieval_status IN (
                'attached_context',
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_assistant_claim_evidence_retrieval_status",
        ),
        sa.CheckConstraint(
            """
            evidence_role NOT IN ('supports', 'contradicts')
            OR exact_snippet IS NOT NULL
            """,
            name="ck_assistant_claim_evidence_snippet_required",
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"],
            ["assistant_message_claims.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["retrieval_id"],
            ["message_retrievals.id"],
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("claim_id", "ordinal", name="uix_assistant_claim_evidence_ordinal"),
    )
    op.create_index(
        "idx_assistant_claim_evidence_claim",
        "assistant_message_claim_evidence",
        ["claim_id", "ordinal"],
    )
    op.create_index(
        "idx_assistant_claim_evidence_retrieval",
        "assistant_message_claim_evidence",
        ["retrieval_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_assistant_claim_evidence_retrieval",
        table_name="assistant_message_claim_evidence",
    )
    op.drop_index(
        "idx_assistant_claim_evidence_claim",
        table_name="assistant_message_claim_evidence",
    )
    op.drop_table("assistant_message_claim_evidence")
    op.drop_index("idx_assistant_claims_message", table_name="assistant_message_claims")
    op.drop_table("assistant_message_claims")
    op.drop_table("assistant_message_evidence_summaries")

    op.drop_constraint("ck_message_retrievals_status", "message_retrievals", type_="check")
    op.drop_constraint(
        "ck_message_retrievals_locator_object",
        "message_retrievals",
        type_="check",
    )
    op.drop_column("message_retrievals", "source_version")
    op.drop_column("message_retrievals", "included_in_prompt")
    op.drop_column("message_retrievals", "retrieval_status")
    op.drop_column("message_retrievals", "locator")
    op.drop_column("message_retrievals", "snippet_suffix")
    op.drop_column("message_retrievals", "snippet_prefix")
    op.drop_column("message_retrievals", "exact_snippet")
    op.drop_column("message_retrievals", "section_label")
    op.drop_column("message_retrievals", "source_title")
